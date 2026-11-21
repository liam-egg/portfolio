#!/usr/bin/env node
/*
 * Packs the galaxy datasets universe-vr.html can switch between into one format, and writes the
 * manifest the page reads (vr/universe-vr/datasets.json).
 *
 *   node tools/pack-universe-datasets.mjs [raw-dir = vr/universe-vr/raw] [out-dir = vr/universe-vr]
 *
 * Every dataset is <out>/datasets/<id>.u16: uint16 × 4 per galaxy, {x, y, z, w}. Positions are quantised
 * over the per-axis range the manifest gives (Mpc/h); w (0.05–1) is how brightly the galaxy's sprite is
 * drawn. All datasets share one physical scale, so the surveys and the simulation can be compared
 * directly: SCALE metres per Mpc/h.
 *
 *   millennium  the Millennium Simulation galaxies UniverseVR shipped (tools/pack-universe-vr.mjs writes
 *               datasets/millennium.u16). Taken as the full 500 Mpc/h box: 849,274 galaxies there is
 *               6.8 × 10⁻³ h³ Mpc⁻³, a typical density for bright galaxies. Stored in D3D's left-handed
 *               frame, so the manifest flags it mirrorZ.
 *   cfa1, cfa2  the CfA redshift surveys (raw/cfa1.txt, raw/cfa2.txt: Huchra's fixed-width ZCAT format,
 *               B1950 RA/Dec, Zwicky magnitude, heliocentric velocity in km/s).
 *   2dfgrs      the 2dF Galaxy Redshift Survey final release (raw/2dfgrs.idz, the best-observation
 *               catalogue: one object line, then one line per spectrum). Redshifts of quality ≥ 3.
 *
 * Surveys are placed as we see them: the Milky Way at the origin, celestial north up (+y), RA 0 along
 * +x and RA 6h along −z, at the comoving distance of each redshift in the Millennium cosmology
 * (flat, Ωm = 0.25, ΩΛ = 0.75). A survey galaxy's w is matched to the simulation by rank: the galaxy at
 * luminosity percentile p gets the Millennium weight at percentile p, so every dataset glows on one scale.
 * Luminosity comes from the apparent magnitude and the luminosity distance (1 + z)·D_C.
 *
 * Raw files are not committed (raw/ is gitignored): CfA from the CfA Redshift Catalog (ZCAT, Huchra et al.)
 * and 2dFGRS from the 2dFGRS final data release (Colless et al. 2001, 2003), www.2dfgrs.net.
 */
import fs from 'node:fs';
import path from 'node:path';

const [rawDir = 'vr/universe-vr/raw', outDir = 'vr/universe-vr'] = process.argv.slice(2);
const datasetsDir = path.join(outDir, 'datasets');
fs.mkdirSync(datasetsDir, { recursive: true });

const SCALE = 0.1;                                      // metres per Mpc/h: the Millennium box is 50 m across
const C_KMS = 299792.458;
const HUBBLE_DISTANCE = C_KMS / 100;                    // c/H0 in Mpc/h
const OMEGA_M = 0.25, OMEGA_L = 0.75;                   // the Millennium Simulation's cosmology

// ─── Cosmology ──────────────────────────────────────────────────────────────
// Comoving distance D_C(z) = (c/H0) ∫ dz' / E(z'), tabulated once (Simpson's rule) and interpolated.
const Z_MAX = 0.6, Z_STEPS = 6000;
const comovingTable = (() => {
    const E = z => Math.sqrt(OMEGA_M * (1 + z) ** 3 + OMEGA_L);
    const t = new Float64Array(Z_STEPS + 1), dz = Z_MAX / Z_STEPS;
    for (let i = 1; i <= Z_STEPS; i++) {
        const a = (i - 1) * dz, b = i * dz;
        t[i] = t[i - 1] + dz / 6 * (1 / E(a) + 4 / E((a + b) / 2) + 1 / E(b));
    }
    return t;
})();
function comoving(z) {
    if (!(z >= 0 && z <= Z_MAX)) throw new Error(`redshift ${z} outside the table (0 … ${Z_MAX})`);
    const f = z / Z_MAX * Z_STEPS, i = Math.min(Math.floor(f), Z_STEPS - 1);
    return HUBBLE_DISTANCE * (comovingTable[i] + (comovingTable[i + 1] - comovingTable[i]) * (f - i));
}

// RA (hours) and Dec (degrees) at distance d → the page's right-handed, y-up frame
function place(raHours, decDeg, d) {
    const a = raHours * Math.PI / 12, b = decDeg * Math.PI / 180;
    return [d * Math.cos(b) * Math.cos(a), d * Math.sin(b), -d * Math.cos(b) * Math.sin(a)];
}

// ─── Millennium weights, for matching ───────────────────────────────────────
const millenniumFile = path.join(datasetsDir, 'millennium.u16');
const millennium = (() => {
    const b = fs.readFileSync(millenniumFile);
    const q = new Uint16Array(b.buffer, b.byteOffset, b.length / 2);
    const w = new Float64Array(q.length / 4);
    for (let i = 0; i < w.length; i++) w[i] = q[i * 4 + 3] / 65535;
    return { count: w.length, weights: w.sort() };
})();
const weightAt = p => millennium.weights[Math.min(millennium.count - 1, Math.floor(p * millennium.count))];

// ─── Writing ────────────────────────────────────────────────────────────────
// galaxies: [{ p: [x, y, z] (Mpc/h), z: redshift, m: apparent magnitude }]
function writeSurvey(id, galaxies) {
    // Luminosity from M = m − 5 log10(D_L / 10 pc); only its rank matters, so h drops out
    const logL = galaxies.map(g => -0.4 * (g.m - 5 * Math.log10((1 + g.z) * comoving(g.z) * 1e5)));
    const order = logL.map((_, i) => i).sort((a, b) => logL[a] - logL[b]);
    const w = new Float64Array(galaxies.length);
    order.forEach((i, rank) => { w[i] = weightAt((rank + 0.5) / galaxies.length); });

    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const g of galaxies) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], g.p[k]); max[k] = Math.max(max[k], g.p[k]); }
    for (let k = 0; k < 3; k++) { min[k] = Math.floor(min[k]); max[k] = Math.ceil(max[k]); }
    const q = new Uint16Array(galaxies.length * 4);
    galaxies.forEach((g, i) => {
        for (let k = 0; k < 3; k++) q[i * 4 + k] = Math.round((g.p[k] - min[k]) / (max[k] - min[k]) * 65535);
        q[i * 4 + 3] = Math.round(w[i] * 65535);
    });
    fs.writeFileSync(path.join(datasetsDir, `${id}.u16`), Buffer.from(q.buffer));
    const zs = galaxies.map(g => g.z).sort((a, b) => a - b);
    console.log(`${id.padEnd(10)} ${galaxies.length.toLocaleString().padStart(9)} galaxies   z ${zs[0].toFixed(4)} … ${zs[zs.length - 1].toFixed(3)} (median ${zs[zs.length >> 1].toFixed(3)})   ${(q.byteLength / 1024).toFixed(0)} KB`);
    return { count: galaxies.length, min, max, zMax: +zs[zs.length - 1].toFixed(3) };
}

// ─── CfA (ZCAT fixed-width) ─────────────────────────────────────────────────
//   cols 0–10 name, 11–18 RA hhmmss.s, 19 Dec sign, 20–25 Dec ddmmss, 26–29 magnitude, 30–35 velocity (km/s)
function readCfA(file) {
    const galaxies = [];
    let skipped = 0, far = 0;
    for (const line of fs.readFileSync(file, 'latin1').split(/\r?\n/)) {
        if (line.length < 36 || !/^\d{6}\.\d$/.test(line.slice(11, 19))) continue;    // header and blank lines
        const ra = line.slice(11, 19), dec = line.slice(20, 26);
        const raH = +ra.slice(0, 2) + +ra.slice(2, 4) / 60 + +ra.slice(4) / 3600;
        const decD = (line[19] === '-' ? -1 : 1) * (+dec.slice(0, 2) + +dec.slice(2, 4) / 60 + +dec.slice(4, 6) / 3600);
        const m = parseFloat(line.slice(26, 30)), v = parseFloat(line.slice(30, 36));
        // Within a few Mpc peculiar motions swamp the expansion: a redshift there is no distance
        if (!(v > 500) || !Number.isFinite(m) || !Number.isFinite(raH) || !Number.isFinite(decD)) { skipped++; continue; }
        // The surveys reach ~15,000 km/s; the catalogue also lists a few quasars and background objects
        // far beyond them, which would stretch the survey's box to no purpose
        if (v > 45000) { far++; continue; }
        const z = v / C_KMS;
        galaxies.push({ p: place(raH, decD, comoving(z)), z, m });
    }
    console.log(`  ${path.basename(file)}: ${skipped} rows without a usable velocity (≤ 500 km/s) or magnitude, ${far} beyond 45,000 km/s, skipped`);
    return galaxies;
}

// ─── 2dFGRS (best-observation catalogue) ────────────────────────────────────
// Object lines: seq, nspec, name, UKST plate, RA/Dec B1950 (h m s, d m s), RA/Dec J2000, 7 magnitude
// columns (bJ selection magnitude first), then nobs?, z, z_helio, quality, run. Spectrum lines carry the
// name second instead.
function read2dF(file) {
    const galaxies = [];
    let objects = 0, poor = 0, out = 0;
    for (const line of fs.readFileSync(file, 'latin1').split(/\r?\n/)) {
        const t = line.trim().split(/\s+/);
        if (t.length < 28 || !/^\d+$/.test(t[1])) continue;
        objects++;
        const z = parseFloat(t[24]), quality = +t[26], bJ = parseFloat(t[16]);
        if (!(quality >= 3)) { poor++; continue; }
        // Stars sit at z ≈ 0, and the few quasars far beyond the galaxies
        if (!(z > 0.002 && z < 0.5) || !Number.isFinite(bJ)) { out++; continue; }
        const raH = +t[10] + +t[11] / 60 + +t[12] / 3600;
        const decD = (t[13].startsWith('-') ? -1 : 1) * (Math.abs(+t[13]) + +t[14] / 60 + +t[15] / 3600);
        galaxies.push({ p: place(raH, decD, comoving(z)), z, m: bJ });
    }
    console.log(`  ${path.basename(file)}: ${objects.toLocaleString()} objects, ${poor.toLocaleString()} without a quality ≥ 3 redshift, ${out.toLocaleString()} stars or beyond z 0.5`);
    return galaxies;
}

// ─── Manifest ───────────────────────────────────────────────────────────────
// The page lists datasets in this order; credit is shown in its HUD while the dataset is on screen.
const datasets = [{
    id: 'millennium',
    title: 'Millennium Simulation',
    kind: 'simulation',
    description: 'A 500 Mpc/h cube of simulated galaxies, as UniverseVR showed it',
    file: 'datasets/millennium.u16',
    count: millennium.count,
    min: [-250, -250, -250], max: [250, 250, 250], mirrorZ: true,
    credit: 'Millennium Simulation, Max Planck Institute for Astrophysics (Springel et al. 2005; Lemson & Virgo Consortium 2006), as packaged in UniverseVR by Markus Lipp',
}];
const surveys = [
    { id: 'cfa1', title: 'CfA1 survey', read: () => readCfA(path.join(rawDir, 'cfa1.txt')),
        description: 'The first CfA redshift survey: the northern sky to m ≈ 14.5, 1977–82',
        credit: 'CfA Redshift Survey (Davis, Huchra, Latham & Tonry 1982; Huchra et al. 1983), via the CfA Redshift Catalog (ZCAT)' },
    { id: 'cfa2', title: 'CfA2 survey', read: () => readCfA(path.join(rawDir, 'cfa2.txt')),
        description: 'The second CfA survey, which found the Great Wall: to m ≈ 15.5, 1985–95',
        credit: 'CfA2 Redshift Survey (Geller & Huchra 1989; Huchra et al. 1990, 1995), via the CfA Redshift Catalog (ZCAT)' },
    { id: '2dfgrs', title: '2dF Galaxy Redshift Survey', read: () => read2dF(path.join(rawDir, '2dfgrs.idz')),
        description: 'Two thin wedges of sky to z ≈ 0.3, 1997–2002',
        credit: '2dF Galaxy Redshift Survey final data release (Colless et al. 2001, 2003), Anglo-Australian Observatory' },
];
for (const s of surveys) {
    const file = path.join(rawDir, s.id === '2dfgrs' ? '2dfgrs.idz' : `${s.id}.txt`);
    if (!fs.existsSync(file)) { console.warn(`${s.id}: ${file} missing, left out of the manifest`); continue; }
    const packed = writeSurvey(s.id, s.read());
    datasets.push({ id: s.id, title: s.title, kind: 'survey', description: s.description, file: `datasets/${s.id}.u16`, ...packed, mirrorZ: false, credit: s.credit });
}
const manifest = {
    format: 'universe-datasets@1',
    scale: SCALE,
    units: 'Mpc/h',
    cosmology: { omegaM: OMEGA_M, omegaL: OMEGA_L },
    datasets,
};
fs.writeFileSync(path.join(outDir, 'datasets.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Wrote ${path.join(outDir, 'datasets.json')} (${datasets.length} datasets)`);
