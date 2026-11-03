#!/usr/bin/env node
/*
 * Writes a demo session for g4xr.html in the exact files the G4Xr driver (vr/g4xr-master,
 * source/visualization/Xr) produces, so the page has something to show without a Geant4 build:
 *
 *   node tools/make-g4xr-demo.mjs [out-dir = vr/g4xr/B1] [--events 40] [--seed 7]
 *
 *   trial.glb  the detector, as G4XrSceneHandler::ConvertMeshToGLB writes it: one glTF mesh per
 *              physical volume (G4Polyhedron triangles, mm), material = LV colour with alpha 0.1
 *              and alphaMode BLEND, one scene node per placement (translation + rotation).
 *   run0.bin   trajectories, as G4XrSceneHandler::WriteTrackBinary writes them ("G4TK" v2):
 *                header   char[4] "G4TK", u32 version = 2, u32 stringCount, u32 trackCount
 *                track    i32 trackID, i32 eventID, u16 nameID, f64 charge, f32 r, g, b, u32 n,
 *                         f32[n] x, y, z, time (ps), edep (MeV), px, py, pz (MeV), energy (MeV),
 *                         u16[n] processID, volumeID
 *                strings  stringCount × { u16 length, bytes }   (particle, process, volume names)
 *
 * The geometry is Geant4's basic example B1 (examples/basic/B1/src/DetectorConstruction.cc), with
 * B1's vis.mac choices: World hidden, Envelope coloured blue. The trajectories are NOT Geant4 output:
 * they come from a small toy transport of B1's beam (6 MeV gammas along +z from the envelope face) —
 * Klein–Nishina Compton scattering sampled as G4KleinNishinaCompton does, a rough pair-production
 * term, and electrons/positrons slowed by a CSDA stopping power with Highland multiple scattering.
 * Good enough to look like a run; run the real driver for physics.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = { events: 40, seed: 7 };
const positional = [];
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--events') opt.events = +args[++i];
    else if (args[i] === '--seed') opt.seed = +args[++i];
    else positional.push(args[i]);
}
const out = positional[0] ?? 'vr/g4xr/B1';
fs.mkdirSync(out, { recursive: true });

// ─── Seeded RNG (mulberry32) ────────────────────────────────────────────────
let s = opt.seed >>> 0;
const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());

// ─── B1 geometry (mm) ───────────────────────────────────────────────────────
const cm = 10;
const env = { hx: 10 * cm, hy: 10 * cm, hz: 15 * cm };
const world = { hx: 1.2 * env.hx, hy: 1.2 * env.hy, hz: 1.2 * env.hz };
const shape1 = { pos: [0, 2 * cm, -7 * cm], rminA: 0, rmaxA: 2 * cm, rminB: 0, rmaxB: 4 * cm, hz: 3 * cm };
const shape2 = { pos: [0, -1 * cm, 7 * cm], dxa: 12 * cm, dxb: 12 * cm, dya: 10 * cm, dyb: 16 * cm, dz: 6 * cm };

// ρ (g/cm³), electrons per gram, radiation length (g/cm²), pair-production scale vs water
const MATERIALS = {
    G4_AIR: { rho: 0.00120479, ne: 3.006e23, X0: 36.62, pair: 1.0 },
    G4_WATER: { rho: 1.0, ne: 3.343e23, X0: 36.08, pair: 1.0 },
    'G4_A-150_TISSUE': { rho: 1.127, ne: 3.31e23, X0: 37.2, pair: 0.95 },
    G4_BONE_COMPACT_ICRU: { rho: 1.85, ne: 3.19e23, X0: 27.9, pair: 1.45 },
};
const VOLUMES = [   // innermost first
    { name: 'Shape1', mat: 'G4_A-150_TISSUE', inside: ([x, y, z]) => {
        const lz = z - shape1.pos[2];
        if (Math.abs(lz) > shape1.hz) return false;
        const r = shape1.rmaxA + (shape1.rmaxB - shape1.rmaxA) * (lz + shape1.hz) / (2 * shape1.hz);
        return Math.hypot(x - shape1.pos[0], y - shape1.pos[1]) <= r;
    } },
    { name: 'Shape2', mat: 'G4_BONE_COMPACT_ICRU', inside: ([x, y, z]) => {
        const lz = z - shape2.pos[2], hz = shape2.dz / 2;
        if (Math.abs(lz) > hz) return false;
        const t = (lz + hz) / shape2.dz;
        const hx = (shape2.dxa + (shape2.dxb - shape2.dxa) * t) / 2, hy = (shape2.dya + (shape2.dyb - shape2.dya) * t) / 2;
        return Math.abs(x - shape2.pos[0]) <= hx && Math.abs(y - shape2.pos[1]) <= hy;
    } },
    { name: 'Envelope', mat: 'G4_WATER', inside: ([x, y, z]) => Math.abs(x) <= env.hx && Math.abs(y) <= env.hy && Math.abs(z) <= env.hz },
    { name: 'World', mat: 'G4_AIR', inside: ([x, y, z]) => Math.abs(x) <= world.hx && Math.abs(y) <= world.hy && Math.abs(z) <= world.hz },
];
const volumeAt = p => VOLUMES.find(v => v.inside(p)) ?? null;

// ─── Polyhedra, as G4Polyhedron facets (outward, counter-clockwise) ─────────
function boxMesh(hx, hy, hz) {
    const v = [];
    for (const z of [-hz, hz]) for (const y of [-hy, hy]) for (const x of [-hx, hx]) v.push([x, y, z]);
    const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
    return { v, quads, tris: [] };
}
function trdMesh(dx1, dx2, dy1, dy2, dz) {
    const v = [];
    for (const [z, dx, dy] of [[-dz, dx1, dy1], [dz, dx2, dy2]]) for (const y of [-dy, dy]) for (const x of [-dx, dx]) v.push([x, y, z]);
    const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
    return { v, quads, tris: [] };
}
function consMesh(rA, rB, hz, segments = 24) {      // rmin = 0: two rings, two cap centres
    const v = [];
    for (const [z, r] of [[-hz, rA], [hz, rB]]) for (let i = 0; i < segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        v.push([r * Math.cos(a), r * Math.sin(a), z]);
    }
    const c0 = v.push([0, 0, -hz]) - 1, c1 = v.push([0, 0, hz]) - 1;
    const quads = [], tris = [];
    for (let i = 0; i < segments; i++) {
        const j = (i + 1) % segments;
        quads.push([i, j, segments + j, segments + i]);
        tris.push([c0, j, i], [c1, segments + i, segments + j]);
    }
    return { v, quads, tris };
}
const PLACEMENTS = [   // what /vis/drawVolume hands the driver: visible physical volumes
    { name: 'Envelope', colour: [0, 0, 1], mesh: boxMesh(env.hx, env.hy, env.hz), pos: [0, 0, 0] },
    { name: 'Shape1', colour: [0.5, 0.5, 0.5], mesh: consMesh(shape1.rmaxA, shape1.rmaxB, shape1.hz), pos: shape1.pos },
    { name: 'Shape2', colour: [0.5, 0.5, 0.5], mesh: trdMesh(shape2.dxa / 2, shape2.dxb / 2, shape2.dya / 2, shape2.dyb / 2, shape2.dz / 2), pos: shape2.pos },
];

// ─── GLB ────────────────────────────────────────────────────────────────────
function writeGLB(file) {
    const gltf = { asset: { version: '2.0', generator: 'make-g4xr-demo (G4Xr ConvertMeshToGLB layout)' },
        scene: 0, scenes: [{ name: 'G4Scene', nodes: [] }], nodes: [], meshes: [], materials: [], accessors: [], bufferViews: [], buffers: [] };
    const chunks = [];
    let offset = 0;
    const push = buf => {
        const pad = (4 - (buf.length % 4)) % 4;
        chunks.push(buf, Buffer.alloc(pad));
        const at = offset;
        offset += buf.length + pad;
        return at;
    };
    for (const p of PLACEMENTS) {
        const { v, quads, tris } = p.mesh;
        const idx = [];
        for (const t of tris) idx.push(...t);
        for (const [a, b, c, d] of quads) idx.push(a, b, c, a, c, d);   // as ConvertMeshToGLB splits quads
        const pos = Buffer.from(new Float32Array(v.flat()).buffer);
        const ind = Buffer.from(new Uint16Array(idx).buffer);
        const min = [0, 1, 2].map(k => Math.min(...v.map(q => q[k]))), max = [0, 1, 2].map(k => Math.max(...v.map(q => q[k])));
        const pv = gltf.bufferViews.push({ buffer: 0, byteOffset: push(pos), byteLength: pos.length, target: 34962 }) - 1;
        const iv = gltf.bufferViews.push({ buffer: 0, byteOffset: push(ind), byteLength: ind.length, target: 34963 }) - 1;
        const pa = gltf.accessors.push({ bufferView: pv, componentType: 5126, count: v.length, type: 'VEC3', min, max }) - 1;
        const ia = gltf.accessors.push({ bufferView: iv, componentType: 5123, count: idx.length, type: 'SCALAR' }) - 1;
        const mat = gltf.materials.push({ pbrMetallicRoughness: { baseColorFactor: [...p.colour, 0.1] }, alphaMode: 'BLEND' }) - 1;
        const mesh = gltf.meshes.push({ name: p.name, primitives: [{ attributes: { POSITION: pa }, indices: ia, material: mat, mode: 4 }] }) - 1;
        const node = gltf.nodes.push({ mesh, translation: p.pos, rotation: [0, 0, 0, 1], scale: [1, 1, 1] }) - 1;
        gltf.scenes[0].nodes.push(node);
    }
    const bin = Buffer.concat(chunks);
    gltf.buffers.push({ byteLength: bin.length });
    let json = Buffer.from(JSON.stringify(gltf));
    json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
    const header = Buffer.alloc(12);
    header.write('glTF', 0, 'ascii'); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
    const ch = (type, data) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, data]); };
    fs.writeFileSync(file, Buffer.concat([header, ch(0x4e4f534a, json), ch(0x004e4942, bin)]));
}

// ─── Toy transport ──────────────────────────────────────────────────────────
const ME = 0.51099895, C_MM_PER_PS = 0.299792458, RE_CM = 2.8179403e-13;
const vec = { add: (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k], norm: a => { const n = Math.hypot(...a); return a.map(x => x / n); } };
function orthonormal(d) {
    const a = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = vec.norm([d[1] * a[2] - d[2] * a[1], d[2] * a[0] - d[0] * a[2], d[0] * a[1] - d[1] * a[0]]);
    const w = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
    return [u, w];
}
function rotate(d, cosT, phi) {          // turn d by polar angle θ about a random azimuth φ
    const [u, w] = orthonormal(d), sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
    return vec.norm([0, 1, 2].map(k => d[k] * cosT + sinT * (Math.cos(phi) * u[k] + Math.sin(phi) * w[k])));
}
function kleinNishina(E) {               // total cross section per electron, cm²
    const k = E / ME, l = Math.log(1 + 2 * k);
    return 2 * Math.PI * RE_CM * RE_CM * ((1 + k) / (k * k) * (2 * (1 + k) / (1 + 2 * k) - l / k) + l / (2 * k) - (1 + 3 * k) / ((1 + 2 * k) ** 2));
}
// Linear attenuation (per mm): Compton from Klein–Nishina; pair ≈ 0.0007 (E − 2mₑ) cm²/g in water.
function mu(mat, E) {
    const m = MATERIALS[mat];
    const compt = kleinNishina(E) * m.ne * m.rho / 10;
    const pair = E > 2 * ME ? 0.0007 * (E - 2 * ME) * m.pair * m.rho / 10 : 0;
    return { compt, pair, total: compt + pair };
}
function sampleCompton(E) {              // G4KleinNishinaCompton::SampleSecondaries
    const k = E / ME, eps0 = 1 / (1 + 2 * k), eps0sq = eps0 * eps0;
    const alpha1 = -Math.log(eps0), alpha2 = alpha1 + 0.5 * (1 - eps0sq);
    let eps, epssq, onecost, greject;
    do {
        if (alpha1 > alpha2 * rand()) { eps = Math.exp(-alpha1 * rand()); epssq = eps * eps; }
        else { epssq = eps0sq + (1 - eps0sq) * rand(); eps = Math.sqrt(epssq); }
        onecost = (1 - eps) / (eps * k);
        const sint2 = onecost * (2 - onecost);
        greject = 1 - eps * sint2 / (1 + epssq);
    } while (greject < rand());
    return { eps, cosT: 1 - onecost };
}
// Collision stopping power of water-like media, MeV cm²/g (≈ ESTAR's 1.85–2.0 above 1 MeV).
const stopping = T => 1.85 + 0.38 / Math.pow(Math.max(T, 0.01), 0.75);

const strings = [], stringIndex = new Map();
const sid = str => { if (!stringIndex.has(str)) { stringIndex.set(str, strings.length); strings.push(str); } return stringIndex.get(str); };
const tracks = [];
const COLOURS = { '-1': [1, 0, 0], 0: [0, 1, 0], 1: [0, 0, 1] };     // drawByCharge defaults

function newTrack(event, id, name, charge, mass, pos, dir, E, t0) {
    const P = Math.sqrt(Math.max(0, (E + mass) ** 2 - mass * mass));
    const tr = { trackID: id, eventID: event, name, charge, rgb: COLOURS[charge], points: [],
        p: dir.map(d => d * P), energy: Math.sqrt(P * P + mass * mass) };
    tr.add = (p, t, edep, proc, vol) => tr.points.push({ p: [...p], t, edep, proc, vol });
    tr.add(pos, t0, 0, 'initStep', volumeAt(pos)?.name ?? 'World');
    tracks.push(tr);
    return tr;
}

function runEvent(event) {
    let nextID = 1;
    const queue = [];
    const x0 = 0.8 * 2 * env.hx * (rand() - 0.5), y0 = 0.8 * 2 * env.hy * (rand() - 0.5);
    queue.push({ kind: 'gamma', pos: [x0, y0, -env.hz], dir: [0, 0, 1], E: 6, t: 0, id: nextID++ });

    while (queue.length) {
        const q = queue.shift();
        if (q.kind === 'gamma') transportGamma(q);
        else transportCharged(q);
    }

    function transportGamma({ pos, dir, E, t, id }) {
        const tr = newTrack(event, id, 'gamma', 0, 0, pos, dir, E, t);
        let p = pos, vol = volumeAt(p);
        while (vol) {
            // Step 0.5 mm at a time, accumulating optical depth against a sampled -ln(u).
            let tau = -Math.log(1 - rand()), done = false;
            const h = 0.5;
            while (!done) {
                const att = mu(vol.mat, E);
                const next = vec.add(p, dir, h);
                const nv = volumeAt(next);
                t += h / C_MM_PER_PS;
                tau -= att.total * h;
                if (tau <= 0) {                                  // interaction inside this step
                    p = next;
                    if (E < 0.03) { tr.add(p, t, E, 'phot', vol.name); return; }
                    if (rand() < att.pair / att.total) {
                        tr.add(p, t, 0, 'conv', vol.name);
                        const T = E - 2 * ME, f = 0.15 + 0.7 * rand();
                        for (const [name, share] of [['e-', f], ['e+', 1 - f]]) {
                            const d = rotate(dir, Math.cos(ME / Math.max(E, 1) * Math.abs(gauss())), rand() * 2 * Math.PI);
                            queue.push({ kind: name, pos: p, dir: d, E: T * share, t, id: nextID++ });
                        }
                        return;
                    }
                    const { eps, cosT } = sampleCompton(E);
                    const phi = rand() * 2 * Math.PI;
                    const newDir = rotate(dir, cosT, phi);
                    const Ee = E * (1 - eps);
                    // electron momentum = incoming − outgoing photon momentum
                    const pe = vec.norm([0, 1, 2].map(k => dir[k] * E - newDir[k] * E * eps));
                    tr.add(p, t, 0, 'compt', vol.name);
                    if (Ee > 0.01) queue.push({ kind: 'e-', pos: p, dir: pe, E: Ee, t, id: nextID++ });
                    dir = newDir; E *= eps;
                    done = true;
                } else if (nv !== vol) {                         // boundary crossing
                    tr.add(next, t, 0, 'Transportation', vol.name);
                    p = next; vol = nv; done = true;
                    if (!vol) return;                            // left the world
                } else p = next;
            }
            // Geant4 keeps the photon's track ID across Compton scatters, so the line just continues.
        }
    }

    function transportCharged({ kind, pos, dir, E, t, id }) {
        const charge = kind === 'e+' ? 1 : -1;
        const tr = newTrack(event, id, kind, charge, ME, pos, dir, E, t);
        let p = pos, T = E, vol = volumeAt(p);
        while (vol && T > 0.01) {
            const m = MATERIALS[vol.mat];
            const S = stopping(T) * m.rho / 10;                  // MeV per mm
            const h = Math.min(1.0, 0.08 * T / S + 0.05) * (m.rho < 0.01 ? 20 : 1);
            const dE = Math.min(T, S * h);
            const g = 1 + T / ME, beta = Math.sqrt(1 - 1 / (g * g)), pc = Math.sqrt(T * (T + 2 * ME));
            const x = (h / 10) * m.rho / m.X0;                   // radiation lengths
            const theta0 = (13.6 / (beta * pc)) * Math.sqrt(x) * (1 + 0.038 * Math.log(x));
            const next = vec.add(p, dir, h), nv = volumeAt(next);
            t += h / (beta * C_MM_PER_PS);
            T -= dE;
            tr.add(next, t, dE, nv === vol ? (rand() < 0.6 ? 'eIoni' : 'msc') : 'Transportation', vol.name);
            dir = rotate(dir, Math.cos(Math.abs(theta0 * gauss())), rand() * 2 * Math.PI);
            p = next; vol = nv;
        }
        if (vol && kind === 'e+') {                              // at rest: two back-to-back 511 keV photons
            tr.points[tr.points.length - 1].proc = 'annihil';
            const d = rotate([0, 0, 1], 2 * rand() - 1, rand() * 2 * Math.PI);
            queue.push({ kind: 'gamma', pos: p, dir: d, E: ME, t, id: nextID++ });
            queue.push({ kind: 'gamma', pos: p, dir: d.map(c => -c), E: ME, t, id: nextID++ });
        }
    }
}

for (let e = 0; e < opt.events; e++) runEvent(e);

// ─── run0.bin ───────────────────────────────────────────────────────────────
function writeTracks(file) {
    const parts = [];
    const header = Buffer.alloc(16);
    header.write('G4TK', 0, 'ascii');
    header.writeUInt32LE(2, 4);
    parts.push(header);
    for (const tr of tracks) {
        const n = tr.points.length;
        const head = Buffer.alloc(4 + 4 + 2 + 8 + 12 + 4);
        let o = 0;
        head.writeInt32LE(tr.trackID, o); o += 4;
        head.writeInt32LE(tr.eventID, o); o += 4;
        head.writeUInt16LE(sid(tr.name), o); o += 2;
        head.writeDoubleLE(tr.charge, o); o += 8;
        for (const c of tr.rgb) { head.writeFloatLE(c, o); o += 4; }
        head.writeUInt32LE(n, o);
        parts.push(head);
        const f32 = get => Buffer.from(new Float32Array(tr.points.map(get)).buffer);
        parts.push(f32(q => q.p[0]), f32(q => q.p[1]), f32(q => q.p[2]), f32(q => q.t), f32(q => q.edep),
            f32(() => tr.p[0]), f32(() => tr.p[1]), f32(() => tr.p[2]), f32(() => tr.energy));
        parts.push(Buffer.from(new Uint16Array(tr.points.map(q => sid(q.proc))).buffer));
        parts.push(Buffer.from(new Uint16Array(tr.points.map(q => sid(q.vol))).buffer));
    }
    for (const str of strings) {
        const b = Buffer.from(str, 'utf8'), len = Buffer.alloc(2);
        len.writeUInt16LE(b.length);
        parts.push(len, b);
    }
    header.writeUInt32LE(strings.length, 8);
    header.writeUInt32LE(tracks.length, 12);
    fs.writeFileSync(file, Buffer.concat(parts));
}

writeGLB(path.join(out, 'trial.glb'));
writeTracks(path.join(out, 'run0.bin'));
const points = tracks.reduce((s, t) => s + t.points.length, 0);
console.log(`${out}/trial.glb  ${PLACEMENTS.length} volumes`);
console.log(`${out}/run0.bin   ${opt.events} events, ${tracks.length} tracks, ${points} points, ${strings.length} strings`);
