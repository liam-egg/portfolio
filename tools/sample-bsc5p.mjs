#!/usr/bin/env node
/*
 * Builds a representative star sample from the Bright Star Catalogue (BSC5P, via
 * https://github.com/frostoven/BSC5P-JSON-XYZ, CC BY 4.0) as a ROOT VR "PointCloud" dataset.
 *
 *   node tools/sample-bsc5p.mjs [out.txt] [--count 3000]
 *
 * The sample keeps every star brighter than roughly magnitude 4 (so the constellations stay
 * recognisable), every star within 15 pc (so zooming in on Earth still resolves neighbours),
 * then fills the rest with a seeded uniform draw from the catalogue so the distance
 * distribution stays true to the whole. Non-stellar entries (clusters, galaxies) have no
 * colour in the catalogue and are skipped, as are the few with parallax-noise distances.
 *
 * PointCloud format (one value per line, like the ROOT VR server's /get_data):
 *   PointCloud
 *   <x title> <y title> <z title>
 *   <n>
 *   <xmin> <xmax> <ymin> <ymax> <zmin> <zmax>
 *   <focus x> <focus y> <focus z> <focus label>      the point zoom closes in on
 *   n × { x y z r g b size name }                     rgb in 0–1 sRGB, size in 0–1, name may be empty
 */
import fs from 'node:fs';
import path from 'node:path';

const COMMIT = '36b238ffb1964c858b419130e67858ad9adbd24e';
const BASE = `https://raw.githubusercontent.com/frostoven/BSC5P-JSON-XYZ/${COMMIT}/catalogs`;

const args = process.argv.slice(2);
const countAt = args.indexOf('--count');
const COUNT = countAt >= 0 ? +args.splice(countAt, 2)[1] : 3000;
const outFile = path.resolve(args[0] || 'vr/root-vr/examples/BSC5P-stars.txt');

const BRIGHT_MAG = 4.0;
const NEAR_PC = 15;

const fetchJson = async name => {
    const r = await fetch(`${BASE}/${name}`);
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    return r.json();
};
const [stars, names] = await Promise.all([fetchJson('bsc5p_3d_min.json'), fetchJson('bsc5p_names_min.json')]);

// Readable names: a proper name if SIMBAD has one, else the Bayer/Flamsteed designation, else HD.
const GREEK = {
    alf: 'α', bet: 'β', gam: 'γ', del: 'δ', eps: 'ε', zet: 'ζ', eta: 'η', tet: 'θ', iot: 'ι', kap: 'κ', lam: 'λ', mu: 'μ',
    nu: 'ν', ksi: 'ξ', omi: 'ο', pi: 'π', rho: 'ρ', sig: 'σ', tau: 'τ', ups: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ', ome: 'ω',
};
const nameById = new Map(names.map(e => [e.i, e.n]));
function displayName(star) {
    const aliases = nameById.get(star.i) || [];
    // Prefer a one-word proper name ("Sirius" over its alias "Dog Star")
    const propers = aliases.filter(a => a.startsWith('NAME ')).map(a => a.slice(5));
    const proper = propers.find(n => !n.includes(' ')) ?? propers[0];
    if (proper) return proper;
    const bayer = aliases.map(a => a.match(/^\* (\w+?)(\d*) (\w{3})$/)).find(m => m && GREEK[m[1]]);
    if (bayer) return `${GREEK[bayer[1]]}${bayer[2] ? toSuperscript(bayer[2]) : ''} ${bayer[3]}`;
    const flamsteed = aliases.map(a => a.match(/^\* (\d+) (\w{3})$/)).find(Boolean);
    if (flamsteed) return `${flamsteed[1]} ${flamsteed[2]}`;
    return String(star.n || '').replace(/^HD(\d)/, 'HD $1');
}
const toSuperscript = s => s.replace(/\d/g, d => '⁰¹²³⁴⁵⁶⁷⁸⁹'[d]);

// Apparent magnitude from the catalogue's naive luminosity N (L☉) and distance p (pc):
// m = M☉ − 2.5·log10(N) + 5·log10(p / 10), with M☉ = 4.83.
const apparentMag = s => 4.83 - 2.5 * Math.log10(s.N) + 5 * Math.log10(s.p / 10);

// Beyond MAX_PC the catalogue's distances come from near-zero parallaxes (one reads 200 kpc);
// no naked-eye star is that far, and they would dominate the zoom range.
const MAX_PC = 10000;
const usable = stars.filter(s => s.K && s.p > 0 && s.p < MAX_PC && s.N > 0);
const picked = new Set(usable.filter(s => apparentMag(s) <= BRIGHT_MAG || s.p <= NEAR_PC));
let seed = 0x5eed;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const rest = usable.filter(s => !picked.has(s));
for (let i = rest.length - 1; i > 0; i--) {             // seeded Fisher–Yates
    const j = Math.floor(rnd() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
}
for (const s of rest) { if (picked.size >= COUNT) break; picked.add(s); }
const sample = [...picked].sort((a, b) => a.i - b.i);

// Size by apparent brightness: magnitude 6.5 (naked-eye limit) → 0, magnitude −1.5 (Sirius) → 1.
const size = s => Math.min(1, Math.max(0, (6.5 - apparentMag(s)) / 8));
const ext = k => [Math.min(...sample.map(s => s[k])), Math.max(...sample.map(s => s[k]))];
const f6 = v => v.toFixed(6);

const out = ['PointCloud', 'x [pc]', 'y [pc]', 'z [pc]', sample.length,
    ...ext('x').map(f6), ...ext('y').map(f6), ...ext('z').map(f6),
    f6(0), f6(0), f6(0), 'Earth'];
for (const s of sample) out.push(f6(s.x), f6(s.y), f6(s.z), s.K.r, s.K.g, s.K.b, size(s).toFixed(3), displayName(s));

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, out.join('\n') + '\n');
const bright = sample.filter(s => apparentMag(s) <= BRIGHT_MAG).length, near = sample.filter(s => s.p <= NEAR_PC).length;
console.log(`Wrote ${path.relative(process.cwd(), outFile)}: ${sample.length} of ${usable.length} stars ` +
    `(${bright} brighter than mag ${BRIGHT_MAG}, ${near} within ${NEAR_PC} pc), ${(fs.statSync(outFile).size / 1024).toFixed(0)} KB`);
