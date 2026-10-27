#!/usr/bin/env node
/*
 * Compiles a ROOT VR Unity project (e.g. ROOT_VR-3DGraph/) into a single JSON
 * bundle that root.html renders with three.js + WebXR.
 *
 *   node tools/compile-root-vr.mjs <unity-project-dir> [out.json] [--scene Assets/Scenes/X.unity] [--data dump.txt ...]
 *
 * What gets compiled:
 *   - every custom ShaderLab shader under Assets/ (Cg/HLSL -> GLSL ES 3.0)
 *   - every .mat that uses one of those shaders (property values)
 *   - the scene: mesh renderers using those materials, line renderers, 3D TextMeshPro labels
 *     (world matrices converted from Unity's left-handed space to three.js' right-handed space)
 *   - script bindings: data generator constants, axis label handler, grid zoom scripts
 *   - example datasets in the ROOT VR server's /get_data text format (from --data, or built-in demos)
 */
import fs from 'node:fs';
import path from 'node:path';

// ─── CLI ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = { data: [] };
const positional = [];
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--scene') flags.scene = args[++i];
    else if (args[i] === '--data') flags.data.push(args[++i]);
    else positional.push(args[i]);
}
if (!positional[0]) {
    console.error('usage: node tools/compile-root-vr.mjs <unity-project-dir> [out.json] [--scene <scene.unity>] [--data <get_data dump> ...]');
    process.exit(1);
}

// A project folder may be the Unity project itself or a wrapper around it (ROOT_VR-3DGraph/ROOT_VR-3DGraph).
function findUnityRoot(dir) {
    if (fs.existsSync(path.join(dir, 'Assets')) && fs.existsSync(path.join(dir, 'ProjectSettings'))) return dir;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        const sub = path.join(dir, e.name);
        if (fs.existsSync(path.join(sub, 'Assets')) && fs.existsSync(path.join(sub, 'ProjectSettings'))) return sub;
    }
    throw new Error(`No Unity project (Assets/ + ProjectSettings/) found in ${dir}`);
}

const inputDir = path.resolve(positional[0]);
const root = findUnityRoot(inputDir);
const assets = path.join(root, 'Assets');
const projectName = path.basename(inputDir);
const outFile = path.resolve(positional[1] || path.join('root-vr', `${projectName}.json`));

const warn = msg => console.warn(`  ! ${msg}`);

// Third-party packages vendored into Assets/ — their shaders target URP/Meta internals we can't translate.
const VENDOR_DIRS = new Set(['Oculus', 'MetaXR', 'TextMesh Pro', 'Samples', 'XR', 'XRI', 'CompositionLayers', 'Plugins', '_Recovery']);

function walk(dir, exts, out = [], top = true) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (top && VENDOR_DIRS.has(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, exts, out, false);
        else if (exts.some(x => e.name.endsWith(x))) out.push(p);
    }
    return out;
}

const metaGuid = file => {
    try { return fs.readFileSync(file + '.meta', 'utf8').match(/^guid:\s*(\w+)/m)?.[1] ?? null; }
    catch { return null; }
};
const rel = p => path.relative(root, p).split(path.sep).join('/');

// ─── Minimal Unity YAML reader ──────────────────────────────────────────────
// Unity's serialisation is a narrow, regular YAML subset: block maps, block lists
// (items at the same indent as their key), single-line flow maps, and quoted scalars
// that may span lines. That is all this handles.
function parseScalar(s) {
    s = s.trim();
    if (s.startsWith('{')) return parseFlow(s);
    if (s === '[]') return [];
    if (s.startsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
    if (s.startsWith('"')) return JSON.parse(s.replace(/\n\s*/g, ' '));
    return s;
}
function parseFlow(s) {
    const obj = {};
    const body = s.slice(1, -1);
    let depth = 0, start = 0;
    const parts = [];
    for (let i = 0; i <= body.length; i++) {
        const c = body[i];
        if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') depth--;
        else if ((c === ',' && depth === 0) || i === body.length) { parts.push(body.slice(start, i)); start = i + 1; }
    }
    for (const p of parts) {
        const k = p.indexOf(':');
        if (k > 0) obj[p.slice(0, k).trim()] = parseScalar(p.slice(k + 1));
    }
    return obj;
}
function yamlLines(text) {
    const raw = text.split(/\r?\n/);
    const out = [];
    for (let i = 0; i < raw.length; i++) {
        let line = raw[i];
        if (!line.trim()) continue;
        // join multi-line quoted scalars
        const m = line.match(/^(\s*(?:- )?[^:'"]+:\s)(['"])(.*)$/);
        if (m) {
            const q = m[2];
            const closed = s => q === "'" ? /(^|[^'])('')*'$/.test(s) && s.length > 0 : /(^|[^\\])"$/.test(s);
            let val = m[3];
            while (!closed(val) && i + 1 < raw.length) { val += '\n' + raw[++i].trim(); }
            line = m[1] + q + val;
        }
        out.push({ indent: line.match(/^ */)[0].length, text: line.trim() });
    }
    return out;
}
function parseYaml(text) {
    const lines = yamlLines(text);
    let i = 0;
    function block(indent) {
        if (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith('- ')) return list(indent);
        return map(indent);
    }
    function list(indent) {
        const arr = [];
        while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith('- ')) {
            const item = lines[i].text.slice(2);
            if (/^[^{'"][^:]*:(\s|$)/.test(item)) {
                // "- key: v" opens a map whose remaining keys sit at indent+2
                lines[i] = { indent: indent + 2, text: item };
                arr.push(map(indent + 2));
            } else { arr.push(parseScalar(item)); i++; }
        }
        return arr;
    }
    function map(indent) {
        const obj = {};
        while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith('- ')) {
            const t = lines[i].text;
            const k = t.indexOf(':');
            const key = t.slice(0, k), rest = t.slice(k + 1).trim();
            i++;
            if (rest) obj[key] = parseScalar(rest);
            else if (i < lines.length && (lines[i].indent > indent || (lines[i].indent === indent && lines[i].text.startsWith('- '))))
                obj[key] = block(lines[i].indent);
            else obj[key] = null;
        }
        return obj;
    }
    return block(lines[0]?.indent ?? 0);
}
// A Unity asset file is a stream of "--- !u!<classID> &<fileID>" documents.
function parseUnityFile(file) {
    const text = fs.readFileSync(file, 'utf8');
    const docs = new Map();
    const re = /^--- !u!(\d+) &(-?\d+)(?: stripped)?\s*$/gm;
    const heads = [...text.matchAll(re)];
    heads.forEach((h, n) => {
        const body = text.slice(h.index + h[0].length, n + 1 < heads.length ? heads[n + 1].index : text.length);
        const parsed = parseYaml(body);
        const type = Object.keys(parsed)[0];
        docs.set(h[2], { classID: +h[1], id: h[2], type, ...parsed[type] });
    });
    return docs;
}
const num = (v, d = 0) => (v === undefined || v === null || v === '' ? d : +v);
const vec = (o, keys = 'xyz') => [...keys].map(k => num(o?.[k]));
const col = o => [num(o?.r), num(o?.g), num(o?.b), num(o?.a, 1)];

// ─── ShaderLab -> GLSL ──────────────────────────────────────────────────────
const TYPE_MAP = [
    [/\b(?:float|half|fixed)4x4\b/g, 'mat4'], [/\b(?:float|half|fixed)3x3\b/g, 'mat3'],
    [/\b(?:float|half|fixed)([234])\b/g, 'vec$1'], [/\b(?:half|fixed)\b/g, 'float'],
    [/\buint([234])\b/g, 'uvec$1'], [/\bint([234])\b/g, 'ivec$1'],
];
const FUNC_MAP = [
    [/\bfrac\s*\(/g, 'fract('], [/\blerp\s*\(/g, 'mix('], [/\bfmod\s*\(/g, 'mod('],
    [/\brsqrt\s*\(/g, 'inversesqrt('], [/\bddx\s*\(/g, 'dFdx('], [/\bddy\s*\(/g, 'dFdy('],
    [/\batan2\s*\(/g, 'atan('], [/\btex2D\s*\(/g, 'texture('],
];

// Find the balanced (...) or {...} span starting at index `open`.
function balanced(src, open) {
    const o = src[open], c = o === '(' ? ')' : '}';
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === o) depth++;
        else if (src[i] === c && --depth === 0) return i;
    }
    throw new Error('unbalanced ' + o);
}
function splitArgs(s) {
    const out = []; let depth = 0, start = 0;
    for (let i = 0; i < s.length; i++) {
        if ('([{'.includes(s[i])) depth++;
        else if (')]}'.includes(s[i])) depth--;
        else if (s[i] === ',' && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
    }
    out.push(s.slice(start));
    return out.map(a => a.trim());
}
// Rewrite every call `name(args)` via fn(argsArray) -> string, innermost-safe by re-scanning.
function rewriteCalls(src, name, fn) {
    const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
    let m;
    while ((m = re.exec(src))) {
        const open = m.index + m[0].length - 1;
        const close = balanced(src, open);
        const repl = fn(splitArgs(src.slice(open + 1, close)));
        src = src.slice(0, m.index) + repl + src.slice(close + 1);
        re.lastIndex = m.index;
    }
    return src;
}
// GLSL ES has no implicit int->float promotion: turn bare integer literals into floats,
// except for array indices, int declarations, loop headers and integer-typed calls.
function floatLiterals(code) {
    return code.split('\n').map(line => {
        if (/\b(u?int|for|ivec\d|uvec\d)\b|\[/.test(line)) return line;
        return line.replace(/(^|[^\w.])(\d+)(?![\w.])/g, '$1$2.0');
    }).join('\n');
}
function stripComments(s) {
    return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}
function translateTypesAndFuncs(code) {
    for (const [re, to] of TYPE_MAP) code = code.replace(re, to);
    for (const [re, to] of FUNC_MAP) code = code.replace(re, to);
    code = rewriteCalls(code, 'saturate', ([x]) => `clamp(${x}, 0.0, 1.0)`);
    code = rewriteCalls(code, 'mul', ([a, b]) => `(${a} * ${b})`);
    return code;
}
function parseStruct(cg, name) {
    const m = cg.match(new RegExp(`struct\\s+${name}\\s*\\{([\\s\\S]*?)\\};`));
    if (!m) return [];
    return stripComments(m[1]).split(';').map(s => s.trim()).filter(Boolean)
        .map(s => s.match(/^(\w+)\s+(\w+)\s*(?::\s*(\w+))?$/)).filter(Boolean)
        .map(([, type, field, semantic]) => ({ type, field, semantic: (semantic || '').toUpperCase() }));
}
function extractFunction(cg, name) {
    const re = new RegExp(`(\\w+)\\s+${name}\\s*\\(([^)]*)\\)\\s*(?::\\s*\\w+)?\\s*\\{`);
    const m = re.exec(cg);
    if (!m) throw new Error(`function ${name} not found`);
    const open = m.index + m[0].length - 1;
    const close = balanced(cg, open);
    return { ret: m[1], params: splitArgs(m[2]), body: cg.slice(open + 1, close), start: m.index, end: close + 1 };
}

const ATTRIBUTE_FOR = { POSITION: 'vec4(position, 1.0)', TEXCOORD0: 'uv', NORMAL: 'normal', COLOR: 'color' };

function translateShader(file) {
    const src = fs.readFileSync(file, 'utf8');
    const clean = stripComments(src);
    const name = clean.match(/Shader\s+"([^"]+)"/)?.[1];
    if (!name) throw new Error('no Shader "name"');

    // Properties { _Name("Label", Type) = default }
    const properties = {};
    const propBlock = clean.match(/Properties\s*\{/);
    if (propBlock) {
        const open = propBlock.index + propBlock[0].length - 1;
        const body = clean.slice(open + 1, balanced(clean, open));
        for (const m of body.matchAll(/(\w+)\s*\(\s*"[^"]*"\s*,\s*(\w+)(?:\s*\([^)]*\))?\s*\)\s*=\s*([^\n]+)/g)) {
            const [, pname, ptype, def] = m;
            const t = ptype.toLowerCase();
            if (t === 'color' || t === 'vector') properties[pname] = { type: t, value: def.replace(/[()]/g, '').split(',').map(Number) };
            else if (t === 'float' || t === 'range' || t === 'int' || t === 'integer') properties[pname] = { type: 'float', value: parseFloat(def) };
            else properties[pname] = { type: t, value: null };
        }
    }

    // Render state (first pass wins; SubShader-level values are the fallback)
    const state = { cull: 'back', zwrite: true, blend: null, queue: 'Geometry' };
    const cullM = clean.match(/\bCull\s+(\w+)/); if (cullM) state.cull = cullM[1].toLowerCase();
    const zM = clean.match(/\bZWrite\s+(\w+)/); if (zM) state.zwrite = zM[1].toLowerCase() === 'on';
    const bM = clean.match(/\bBlend\s+(\w+)\s+(\w+)/); if (bM) state.blend = [bM[1], bM[2]];
    const qM = clean.match(/"Queue"\s*=\s*"(\w+)"/); if (qM) state.queue = qM[1];

    const cgM = src.match(/(?:CGPROGRAM|HLSLPROGRAM)([\s\S]*?)(?:ENDCG|ENDHLSL)/);
    if (!cgM) throw new Error('no CGPROGRAM block');
    let cg = stripComments(cgM[1]);
    const vertName = cg.match(/#pragma\s+vertex\s+(\w+)/)?.[1];
    const fragName = cg.match(/#pragma\s+fragment\s+(\w+)/)?.[1];
    if (!vertName || !fragName) throw new Error('missing #pragma vertex/fragment');

    const vertFn = extractFunction(cg, vertName);
    const fragFn = extractFunction(cg, fragName);
    const inName = vertFn.params[0].split(/\s+/)[0];      // appdata
    const outName = vertFn.ret;                           // v2f
    const inStruct = parseStruct(cg, inName);
    const outStruct = parseStruct(cg, outName);

    // Top-level globals: everything that isn't a #directive, struct or function.
    let globals = cg;
    for (const fn of [fragFn, vertFn].sort((a, b) => b.start - a.start)) globals = globals.slice(0, fn.start) + globals.slice(fn.end);
    globals = globals.replace(/struct\s+\w+\s*\{[\s\S]*?\};/g, '').replace(/^\s*#.*$/gm, '');

    // StructuredBuffers indexed by instance id become per-instance attributes.
    const buffers = {};
    for (const m of globals.matchAll(/StructuredBuffer\s*<\s*(\w+)\s*>\s*(\w+)\s*;/g)) buffers[m[2]] = m[1];
    const instanced = Object.keys(buffers).length > 0;
    const uniforms = [];
    for (const m of globals.replace(/StructuredBuffer[^;]*;/g, '').matchAll(/(?:uniform\s+)?(\w+)\s+(\w+)\s*;/g)) {
        uniforms.push({ type: m[1], name: m[2] });
    }

    const vary = f => `v_${f.field}`;
    const posField = outStruct.find(f => f.semantic === 'SV_POSITION' || f.semantic === 'POSITION');
    const varyings = outStruct.filter(f => f !== posField && f.semantic && !f.semantic.startsWith('UNITY'));

    // ── vertex body
    const outVar = vertFn.body.match(new RegExp(`\\b${outName}\\s+(\\w+)\\s*;`))?.[1];
    const inVar = vertFn.params[0].split(/\s+/)[1];
    const instIdParam = vertFn.params.find(p => /SV_InstanceID/i.test(p))?.split(/\s+/)[1];
    let vb = vertFn.body;
    vb = vb.replace(/^\s*UNITY_[A-Z_]+\s*\([^;]*\)\s*;?\s*$/gm, '')
           .replace(/^\s*InitIndirectDrawArgs\s*\([^)]*\)\s*;\s*$/gm, '')
           .replace(new RegExp(`^\\s*${outName}\\s+${outVar}\\s*;\\s*$`, 'm'), '')
           .replace(new RegExp(`^\\s*return\\s+${outVar}\\s*;\\s*$`, 'm'), '');
    // instance id plumbing: `uint id = GetIndirectInstanceID(svInstanceID);` -> drop, remember alias
    const idAliases = new Set(instIdParam ? [instIdParam] : []);
    vb = vb.replace(/^\s*u?int\s+(\w+)\s*=\s*(?:GetIndirectInstanceID|unity_InstanceID)\s*\(?[^;]*;\s*$/gm, (_, a) => { idAliases.add(a); return ''; });
    for (const bname of Object.keys(buffers)) {
        if (!new RegExp(`\\b${bname}\\b`).test(vb)) { delete buffers[bname]; continue; }
        vb = vb.replace(new RegExp(`\\b${bname}\\s*\\[\\s*\\w+\\s*\\]`, 'g'), `a${bname}`);
    }
    vb = vb.replace(/\bUnityObjectToClipPos\s*\(/g, 'unityObjectToClipPos(')
           .replace(/\bUNITY_MATRIX_VP\b/g, '(projectionMatrix * viewMatrix)')
           .replace(/\bUNITY_MATRIX_MVP\b/g, '(projectionMatrix * modelViewMatrix)')
           .replace(/\bUNITY_MATRIX_V\b/g, 'viewMatrix')
           .replace(/\bUNITY_MATRIX_P\b/g, 'projectionMatrix')
           .replace(/\bunity_ObjectToWorld\b/g, 'modelMatrix')
           .replace(/\b_WorldSpaceCameraPos\b/g, 'cameraPosition');
    for (const f of inStruct) {
        const attr = ATTRIBUTE_FOR[f.semantic];
        if (attr) vb = vb.replace(new RegExp(`\\b${inVar}\\.${f.field}\\b`, 'g'), attr);
    }
    if (posField) vb = vb.replace(new RegExp(`\\b${outVar}\\.${posField.field}\\b`, 'g'), 'gl_Position');
    for (const f of varyings) vb = vb.replace(new RegExp(`\\b${outVar}\\.${f.field}\\b`, 'g'), vary(f));

    // ── fragment body
    const fragIn = fragFn.params[0].split(/\s+/)[1];
    let fb = fragFn.body.replace(/^\s*UNITY_[A-Z_]+\s*\([^;]*\)\s*;?\s*$/gm, '');
    for (const f of varyings) fb = fb.replace(new RegExp(`\\b${fragIn}\\.${f.field}\\b`, 'g'), vary(f));

    const glType = t => translateTypesAndFuncs(t);
    const decls = uniforms.map(u => `uniform ${glType(u.type)} ${u.name};`).join('\n');
    const varyDecl = io => varyings.map(f => `${io} ${glType(f.type)} ${vary(f)};`).join('\n');
    const instDecl = Object.entries(buffers).map(([b, t]) => `in ${glType(t)} a${b};`).join('\n');

    const vertexShader = floatLiterals(translateTypesAndFuncs(
`${decls}
${instDecl}
${varyDecl('out')}
vec4 unityObjectToClipPos(vec4 p) { return projectionMatrix * modelViewMatrix * p; }
vec4 unityObjectToClipPos(vec3 p) { return projectionMatrix * modelViewMatrix * vec4(p, 1.0); }
void main() {${vb}}
`));
    const fragmentShader = floatLiterals(translateTypesAndFuncs(
`precision highp float;
${decls}
${varyDecl('in')}
out highp vec4 unity_FragColor;
vec4 unity_frag() {${fb}}
void main() {
    vec4 c = unity_frag();
#ifdef UNITY_LINEAR
    c = linearToOutputTexel(c);
#endif
    unity_FragColor = c;
}
`));

    // Buffers the runtime must fill per instance, keyed by GLSL attribute name.
    const instanceAttributes = Object.fromEntries(Object.entries(buffers).map(([b, t]) => [`a${b}`, { buffer: b, type: glType(t) }]));
    return { name, file: rel(file), properties, state, instanced, instanceAttributes, vertexShader, fragmentShader };
}

// ─── C# scripts: constants and simple runtime bindings ──────────────────────
function scanScripts() {
    const scripts = {};
    for (const file of walk(assets, ['.cs'])) {
        const src = stripComments(fs.readFileSync(file, 'utf8'));
        const cls = src.match(/class\s+(\w+)\s*:\s*MonoBehaviour/)?.[1];
        const constants = {};
        for (const m of src.matchAll(/const\s+(?:float|int|double)\s+(\w+)\s*=\s*(-?[\d.]+)f?\s*;/g)) constants[m[1]] = parseFloat(m[2]);
        for (const m of src.matchAll(/(?:private|public)?\s*(?:const\s+)?float\s+(\w+)\s*=\s*(-?[\d.]+)f?\s*;/g)) constants[m[1]] ??= parseFloat(m[2]);
        // Grid zoom pattern: material.SetFloat("_LayerN", max - camera.position.<axis>)
        let zoom = null;
        const zm = src.match(/transform\.position\.([xyz])/);
        if (zm && /SetFloat\s*\(\s*"_Layer/.test(src)) {
            const axis = zm[1];
            const sign = new RegExp(`max\\d\\s*\\+\\s*\\w+`).test(src) ? +1 : -1;
            const layers = [...src.matchAll(/SetFloat\s*\(\s*"(\w+)"\s*,\s*(\w+)/g)].map(m => {
                const sf = m[2];
                const maxName = src.match(new RegExp(`${sf}\\s*=\\s*(max\\d)`))?.[1];
                return { uniform: m[1], max: maxName };
            });
            zoom = { axis, sign, layers };
        }
        scripts[metaGuid(file)] = { file: rel(file), class: cls, constants, zoom, source: src };
    }
    return scripts;
}

// ─── Scene ──────────────────────────────────────────────────────────────────
const BUILTIN_MESH = { 10202: 'Cube', 10206: 'Cylinder', 10207: 'Sphere', 10208: 'Capsule', 10209: 'Plane', 10210: 'Quad' };
const BUILTIN_MATERIAL = { 10306: 'Sprites-Default', 10303: 'Default-Material', 10754: 'Default-Line' };

// Unity is left-handed (+z forward); three.js is right-handed. World matrices are
// converted with M' = S·M·S, S = diag(1, 1, -1); geometry is built in three's frame.
function trs(p, q, s) {
    const [x, y, z, w] = q;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
    // column-major 4x4
    return [
        (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
        (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
        (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
        p[0], p[1], p[2], 1,
    ];
}
function mat4mul(a, b) {
    const o = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    return o;
}
const toThree = m => m.map((v, i) => ((i % 4 === 2) !== (Math.floor(i / 4) === 2) ? -v : v));
const round = (v, d = 6) => +v.toFixed(d);

function compileScene(sceneFile, materialsByGuid, scripts) {
    const docs = parseUnityFile(sceneFile);
    const byId = id => docs.get(String(id?.fileID ?? id));
    const goOf = c => byId(c.m_GameObject);
    const componentsOf = go => (go?.m_Component || []).map(c => byId(c.component)).filter(Boolean);
    const transformOf = go => componentsOf(go).find(c => c.type === 'Transform' || c.type === 'RectTransform');

    // RectTransforms serialise x/y as an anchored offset inside the parent's rect.
    function rectSize(t) {
        if (t?.type !== 'RectTransform') return [0, 0];
        const parent = rectSize(byId(t.m_Father));
        const aMin = vec(t.m_AnchorMin, 'xy'), aMax = vec(t.m_AnchorMax, 'xy'), sd = vec(t.m_SizeDelta, 'xy');
        return [0, 1].map(k => sd[k] + (aMax[k] - aMin[k]) * parent[k]);
    }
    function localPosition(t) {
        const p = vec(t.m_LocalPosition);
        if (t.type !== 'RectTransform') return p;
        const father = byId(t.m_Father);
        const size = rectSize(father);
        const fPivot = father?.type === 'RectTransform' ? vec(father.m_Pivot, 'xy') : [0.5, 0.5];
        const aMin = vec(t.m_AnchorMin, 'xy'), aMax = vec(t.m_AnchorMax, 'xy'), pivot = vec(t.m_Pivot, 'xy');
        const ap = vec(t.m_AnchoredPosition, 'xy');
        const xy = [0, 1].map(k => -fPivot[k] * size[k] + (aMin[k] + (aMax[k] - aMin[k]) * pivot[k]) * size[k] + ap[k]);
        return [xy[0], xy[1], p[2]];
    }

    const worldCache = new Map();
    function world(t) {
        if (!t) return trs([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
        if (worldCache.has(t.id)) return worldCache.get(t.id);
        const local = trs(localPosition(t), vec(t.m_LocalRotation, 'xyzw'), vec(t.m_LocalScale));
        const father = byId(t.m_Father);
        const m = father ? mat4mul(world(father), local) : local;
        worldCache.set(t.id, m);
        return m;
    }
    function activeInHierarchy(go) {
        for (let t = transformOf(go); t; t = byId(t.m_Father)) {
            const g = goOf(t);
            if (g && num(g.m_IsActive, 1) === 0) return false;
        }
        return true;
    }
    const nameOf = go => go?.m_Name ?? '';
    const pathOf = go => {
        const parts = [];
        for (let t = transformOf(go); t; t = byId(t.m_Father)) parts.unshift(nameOf(goOf(t)));
        return parts.join('/');
    };
    const matrixOut = t => toThree(world(t)).map(v => round(v));

    // The XR rig (camera, controllers, their rays) is rebuilt by root.html from WebXR input.
    const rootOf = t => { while (byId(t?.m_Father)) t = byId(t.m_Father); return t; };
    const rigRoots = new Set([...docs.values()].filter(d => d.type === 'Camera').map(c => rootOf(transformOf(goOf(c)))?.id));
    const inRig = go => rigRoots.has(rootOf(transformOf(go))?.id);
    const meshes = [], lines = [], texts = [];
    const scriptOf = mb => scripts[mb.m_Script?.guid];

    for (const d of docs.values()) {
        if (d.type === 'MeshRenderer') {
            const go = goOf(d);
            if (!go || inRig(go) || !activeInHierarchy(go) || num(d.m_Enabled, 1) === 0) continue;
            const comps = componentsOf(go);
            const filter = comps.find(c => c.type === 'MeshFilter');
            const isText = comps.some(c => c.type === 'MonoBehaviour' && c.m_text !== undefined);
            if (isText || !filter) continue;
            const mesh = BUILTIN_MESH[filter.m_Mesh?.fileID];
            if (!mesh) { warn(`skip ${pathOf(go)}: non-builtin mesh`); continue; }
            const matRef = (d.m_Materials || [])[0];
            const material = materialsByGuid[matRef?.guid]?.name ?? BUILTIN_MATERIAL[matRef?.fileID] ?? null;
            meshes.push({ name: pathOf(go), mesh, material, matrix: matrixOut(transformOf(go)) });
        } else if (d.type === 'LineRenderer') {
            const go = goOf(d);
            if (!go || inRig(go) || !activeInHierarchy(go) || num(d.m_Enabled, 1) === 0) continue;
            const params = d.m_Parameters || {};
            const widthCurve = params.widthCurve?.m_Curve?.[0]?.value;
            lines.push({
                name: pathOf(go),
                worldSpace: num(d.m_UseWorldSpace, 1) === 1,
                matrix: matrixOut(transformOf(go)),
                positions: (d.m_Positions || []).map(p => { const v = vec(p); return [v[0], v[1], -v[2]]; }),
                width: num(params.widthMultiplier, 1) * num(widthCurve, 1),
                color: col(params.colorGradient?.key0),
                loop: num(d.m_Loop) === 1,
            });
        } else if (d.type === 'MonoBehaviour' && d.m_text !== undefined) {
            const go = goOf(d);
            if (!go || inRig(go) || !activeInHierarchy(go) || num(d.m_Enabled, 1) === 0) continue;
            const comps = componentsOf(go);
            if (!comps.some(c => c.type === 'MeshRenderer')) continue;   // UGUI text lives on canvases; root.html draws its own HUD
            const t = transformOf(go);
            texts.push({
                id: go.id,
                name: pathOf(go),
                text: String(d.m_text).replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).trim(),
                fontSize: num(d.m_fontSize, 36),
                color: col(d.m_fontColor),
                align: { h: num(d.m_HorizontalAlignment, 1), v: num(d.m_VerticalAlignment, 256) },
                size: vec(t?.m_SizeDelta, 'xy'),
                pivot: t?.m_Pivot ? vec(t.m_Pivot, 'xy') : [0.5, 0.5],
                matrix: matrixOut(t),
            });
        }
    }

    // Script bindings
    const bindings = { generator: null, axisLabels: null, zoom: [], camera: null };
    const childrenOf = go => (transformOf(go)?.m_Children || []).map(c => goOf(byId(c))).filter(Boolean);
    for (const d of docs.values()) {
        if (d.type !== 'MonoBehaviour') continue;
        const s = scriptOf(d);
        if (!s) continue;
        if (d.data_mesh_GPUI !== undefined) {
            bindings.generator = {
                script: s.file,
                constants: s.constants,
                mesh: BUILTIN_MESH[d.data_mesh_GPUI?.fileID] ?? 'Cube',
                material: materialsByGuid[d.data_mesh_material_GPUI?.guid]?.name ?? null,
            };
        } else if (d.number_label_objs !== undefined) {
            const textIds = go => childrenOf(go).map(c => c.id);
            bindings.axisLabels = {
                script: s.file,
                numbers: (d.number_label_objs || []).map(r => textIds(byId(r))),
                units: (d.unit_label_objs || []).map(r => byId(r)?.id ?? null),
            };
        } else if (s.zoom && d.material) {
            const mat = materialsByGuid[d.material?.guid]?.name;
            if (!mat) continue;
            bindings.zoom.push({
                script: s.file, material: mat, axis: s.zoom.axis, sign: s.zoom.sign,
                layers: s.zoom.layers.map(l => ({ uniform: l.uniform, max: num(d[l.max], s.constants[l.max]) })),
            });
        }
    }
    for (const d of docs.values()) {
        if (d.type === 'Camera' && num(d.m_Enabled, 1)) {
            const go = goOf(d);
            const m = toThree(world(transformOf(go)));
            // XR camera's parent rig decides where the floor-relative origin sits
            let rigT = transformOf(go);
            while (byId(rigT?.m_Father)) rigT = byId(rigT.m_Father);
            const rm = toThree(world(rigT));
            bindings.camera = {
                name: pathOf(go),
                position: [m[12], m[13], m[14]].map(v => round(v)),
                forward: [-m[8], -m[9], -m[10]].map(v => round(v)),   // three cameras look down local -z
                rig: [rm[12], rm[13], rm[14]].map(v => round(v)),
                fov: num(d['field of view'], 60),
                background: num(d.m_ClearFlags, 1) === 2 ? col(d.m_BackGroundColor) : null,
            };
            break;
        }
    }
    return { file: rel(sceneFile), meshes, lines, texts, bindings };
}

// ─── Example data (ROOT VR /get_data text format) ───────────────────────────
const f6 = v => v.toFixed(6);   // std::to_string(double)
function demoGraph3D() {
    // The VRGraph3D example from DOCS.MD: a hyperbolic paraboloid whose width depends on w.
    const nx = 20, ny = 20, nw = 20, pts = [];
    for (let iw = 0; iw < nw; iw++) {
        const w = iw / nw + 0.5;
        for (let ix = 0; ix < nx; ix++) for (let iy = 0; iy < ny; iy++) {
            const x = ix / (nx - 1), y = iy / (ny - 1);
            pts.push([x, y, ((x / w - 1) ** 2 - (y - 1) ** 2) + 0.5, w]);
        }
    }
    const ext = k => [Math.min(...pts.map(p => p[k])), Math.max(...pts.map(p => p[k]))];
    const [x0, x1] = ext(0), [y0, y1] = ext(1), [z0, z1] = ext(2), [w0, w1] = ext(3);
    return ['TGraph3', 'x', 'y', 'z', pts.length, x0, x1, y0, y1, z0, z1, w0, w1].map((v, i) => i > 4 ? f6(v) : v)
        .concat(pts.flatMap(p => p.map(f6))).join('\n') + '\n';
}
function demoHist2() {
    // A TH2F filled with a 2D Gaussian (deterministic LCG so builds are reproducible).
    const nx = 24, ny = 24, lo = -3, hi = 3, bins = new Float64Array(nx * ny);
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
    for (let n = 0; n < 40000; n++) {
        const x = gauss() * 0.9, y = gauss() * 0.9 + 0.35 * x;
        const ix = Math.floor((x - lo) / (hi - lo) * nx), iy = Math.floor((y - lo) / (hi - lo) * ny);
        if (ix >= 0 && ix < nx && iy >= 0 && iy < ny) bins[ix * ny + iy]++;
    }
    const out = ['TH2', 'px [GeV]', 'py [GeV]', nx, f6(lo), f6(hi), ny, f6(lo), f6(hi)];
    for (const c of bins) { const e = f6(Math.sqrt(c)); out.push(f6(c), `err:${e}l${e}u`); }
    return out.join('\n') + '\n';
}

// ─── Main ───────────────────────────────────────────────────────────────────
console.log(`Compiling ${rel(root) || path.basename(root)} (${root})`);

const shaders = {};
const shadersByGuid = {};
for (const file of walk(assets, ['.shader'])) {
    try {
        const s = translateShader(file);
        shaders[s.name] = s;
        shadersByGuid[metaGuid(file)] = s.name;
        console.log(`  shader   ${s.name.padEnd(12)} ${s.file}${s.instanced ? ' (instanced)' : ''}`);
    } catch (e) { warn(`shader ${rel(file)}: ${e.message}`); }
}

const materials = {};
const materialsByGuid = {};
for (const file of walk(assets, ['.mat'])) {
    const doc = [...parseUnityFile(file).values()].find(d => d.type === 'Material');
    const shaderName = shadersByGuid[doc?.m_Shader?.guid];
    const name = doc?.m_Name || path.basename(file, '.mat');
    const props = doc?.m_SavedProperties || {};
    const flat = list => Object.assign({}, ...(list || []).map(o => (typeof o === 'object' ? o : {})));
    if (!shaderName) {
        // Built-in shader: keep its main colour so the viewer can draw a plain material.
        materials[name] = { file: rel(file), shader: null, color: col(flat(props.m_Colors)._Color) };
    } else {
        const declared = shaders[shaderName].properties;
        const floats = flat(props.m_Floats), colors = flat(props.m_Colors);
        const values = {};
        for (const [p, def] of Object.entries(declared)) {
            if (def.type === 'float') values[p] = num(floats[p], def.value);
            else if (def.type === 'color' || def.type === 'vector') values[p] = colors[p] ? col(colors[p]) : def.value;
        }
        materials[name] = { file: rel(file), shader: shaderName, values };
        console.log(`  material ${name.padEnd(20)} -> ${shaderName}`);
    }
    materialsByGuid[metaGuid(file)] = { name };
}

const scripts = scanScripts();
const sceneFile = flags.scene ? path.resolve(root, flags.scene)
    : walk(path.join(assets, 'Scenes'), ['.unity'])[0];
if (!sceneFile) throw new Error('No scene found under Assets/Scenes');
const scene = compileScene(sceneFile, materialsByGuid, scripts);
console.log(`  scene    ${scene.file}: ${scene.meshes.length} meshes, ${scene.lines.length} lines, ${scene.texts.length} labels`);
if (!scene.bindings.generator) warn('no data generator (data_mesh_GPUI) MonoBehaviour found in scene');

const examples = flags.data.length
    ? flags.data.map(f => ({ name: path.basename(f).replace(/\.\w+$/, ''), data: fs.readFileSync(f, 'utf8') }))
    : [{ name: 'VRGraph3D · DOCS example', data: demoGraph3D() }, { name: 'VRHist2F · Gaussian', data: demoHist2() }];

const readme = (() => { try { return fs.readFileSync(path.join(root, 'README.md'), 'utf8'); } catch { return ''; } })();
const bundle = {
    format: 'root-vr-bundle@1',
    project: projectName,
    version: readme.match(/Version\s+([\w.-]+)/)?.[1] ?? null,
    colorSpace: /m_ActiveColorSpace:\s*1/.test(fs.readFileSync(path.join(root, 'ProjectSettings', 'ProjectSettings.asset'), 'utf8')) ? 'linear' : 'gamma',
    unity: fs.readFileSync(path.join(root, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8').match(/m_EditorVersion:\s*(\S+)/)?.[1] ?? null,
    compiledAt: new Date().toISOString(),
    shaders, materials, scene, examples,
};
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(bundle));
console.log(`Wrote ${path.relative(process.cwd(), outFile)} (${(fs.statSync(outFile).size / 1024).toFixed(1)} KB)`);
