#!/usr/bin/env node
/*
 * Packs the galaxy datasets universe.html can switch between into one format, and writes the
 * manifest the page reads (vr/universe/datasets.json).
 *
 *   node tools/pack-universe-datasets.mjs [raw-dir = vr/universe/raw] [out-dir = vr/universe]
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
 *   sdss, boss  SDSS DR17 spectroscopic galaxies (raw/sdss_sample.csv, raw/boss_eboss_100k.csv), ~100k
 *               each, downloaded from SkyServer with the queries in SDSS_QUERIES below.
 *
 * Surveys are placed as we see them: the Milky Way at the origin, celestial north up (+y), RA 0 along
 * +x and RA 6h along −z, at the comoving distance of each redshift in the Millennium cosmology
 * (flat, Ωm = 0.25, ΩΛ = 0.75). A survey galaxy's w is matched to the simulation by rank: the galaxy at
 * luminosity percentile p gets the Millennium weight at percentile p, so every dataset glows on one scale.
 * Luminosity comes from the apparent magnitude and the luminosity distance (1 + z)·D_C.
 *
 * Each survey also gets <out>/datasets/<id>.sky.f32 (float32 × 3 per galaxy, same order: RA, Dec J2000
 * degrees, redshift), the exact sky place the page's pointer shows and looks images up by.
 *
 * Labels: with raw/ned_galaxies.csv (tools/fetch-ned-galaxies.mjs), each survey also gets
 * datasets/<id>.labels.json, its galaxies that NED knows by a familiar name (M, NGC, IC, Arp, UGC, Mrk …),
 * matched by position and redshift. Then `fetch-ned-galaxies.mjs aliases` and a second run here find the
 * familiar names NED doesn't prefer (see writeLabels).
 *
 * Raw files are not committed (raw/ is gitignored): CfA from the CfA Redshift Catalog (ZCAT, Huchra et al.)
 * and 2dFGRS from the 2dFGRS final data release (Colless et al. 2001, 2003), www.2dfgrs.net.
 */
import fs from 'node:fs';
import path from 'node:path';

const [rawDir = 'vr/universe/raw', outDir = 'vr/universe'] = process.argv.slice(2);
const datasetsDir = path.join(outDir, 'datasets');
fs.mkdirSync(datasetsDir, { recursive: true });

const SCALE = 0.1;                                      // metres per Mpc/h: the Millennium box is 50 m across
const C_KMS = 299792.458;
const HUBBLE_DISTANCE = C_KMS / 100;                    // c/H0 in Mpc/h
const OMEGA_M = 0.25, OMEGA_L = 0.75;                   // the Millennium Simulation's cosmology

// ─── Cosmology ──────────────────────────────────────────────────────────────
// Comoving distance D_C(z) = (c/H0) ∫ dz' / E(z'), tabulated once (Simpson's rule) and interpolated.
const Z_MAX = 2, Z_STEPS = 20000;                       // DESI's emission-line galaxies reach z ≈ 1.6
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
const unit = (raDeg, decDeg) => {
    const a = raDeg * Math.PI / 180, b = decDeg * Math.PI / 180;
    return [Math.cos(b) * Math.cos(a), Math.cos(b) * Math.sin(a), Math.sin(b)];
};
// B1950 (FK4) → J2000 (FK5), the standard rotation without the E-terms (good to about half an arcsecond)
function precessB1950(raDeg, decDeg) {
    const v = unit(raDeg, decDeg), M = [
        [0.9999256782, -0.0111820611, -0.0048579477],
        [0.0111820610, 0.9999374784, -0.0000271765],
        [0.0048579479, -0.0000271474, 0.9999881997]];
    const [x, y, z] = M.map(r => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
    return [((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360, Math.asin(z) * 180 / Math.PI];
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
    // Galaxies without a magnitude (a few DESI targets lack photometry) take the median weight
    const ranked = logL.map((_, i) => i).filter(i => Number.isFinite(logL[i])).sort((a, b) => logL[a] - logL[b]);
    const w = new Float64Array(galaxies.length).fill(weightAt(0.5));
    ranked.forEach((i, rank) => { w[i] = weightAt((rank + 0.5) / ranked.length); });

    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const g of galaxies) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], g.p[k]); max[k] = Math.max(max[k], g.p[k]); }
    for (let k = 0; k < 3; k++) { min[k] = Math.floor(min[k]); max[k] = Math.ceil(max[k]); }
    const q = new Uint16Array(galaxies.length * 4);
    galaxies.forEach((g, i) => {
        for (let k = 0; k < 3; k++) q[i * 4 + k] = Math.round((g.p[k] - min[k]) / (max[k] - min[k]) * 65535);
        q[i * 4 + 3] = Math.round(w[i] * 65535);
    });
    fs.writeFileSync(path.join(datasetsDir, `${id}.u16`), Buffer.from(q.buffer));
    // The sky place of each galaxy, in the same order, for the page's pointer (fetched only when a galaxy is
    // picked): float32 × 3, RA and Dec (J2000 degrees, to ~0.05″) and redshift. The .u16 positions alone
    // give the direction only to ~20–80″, too coarse to centre an image or a NED search on the galaxy.
    const sky = new Float32Array(galaxies.length * 3);
    galaxies.forEach((g, i) => sky.set([g.ra, g.dec, g.z], i * 3));
    fs.writeFileSync(path.join(datasetsDir, `${id}.sky.f32`), Buffer.from(sky.buffer));
    const zs = galaxies.map(g => g.z).sort((a, b) => a - b);
    console.log(`${id.padEnd(10)} ${galaxies.length.toLocaleString().padStart(9)} galaxies   z ${zs[0].toFixed(4)} … ${zs[zs.length - 1].toFixed(3)} (median ${zs[zs.length >> 1].toFixed(3)})   ${(q.byteLength / 1024).toFixed(0)} KB`);
    return { count: galaxies.length, min, max, zMax: +zs[zs.length - 1].toFixed(3), sky: `datasets/${id}.sky.f32` };
}

// ─── CfA (ZCAT fixed-width) ─────────────────────────────────────────────────
//   cols 0–10 name, 11–18 RA hhmmss.s, 19 Dec sign, 20–25 Dec ddmmss, then the magnitude and the velocity
//   (km/s, right-aligned to col 35). The magnitude is "15.2" for most, but "10.30" (two decimals) for the
//   brightest galaxies, which runs into col 30: fixed columns read M87's "10.30 1292" as a velocity of 0 and
//   dropped it with M49, NGC 4889 and the rest of the brightest. So cols 26–35 are split by pattern instead.
// The catalogue's own names, as NED would write them, for writeLabels: its name column codes NGC, IC and UGC
// galaxies as N4486, I3446, U07663 (a suffix such as N4493NW marks a component, left out), and its comments
// carry Messier and Arp numbers ("…*Liner,M87,Arp152,VIRGO A"; the reference code before them, e.g. M04039,
// has too many digits to read as one).
// The catalogue gives Messier numbers for only a few galaxies, so the Messier galaxies' NGC numbers are
// listed here (M102 left out: which galaxy it is, is disputed).
const MESSIER_NGC = {
    224: 31, 221: 32, 598: 33, 628: 74, 1068: 77, 3031: 81, 3034: 82, 5236: 83, 4374: 84, 4382: 85, 4406: 86,
    4486: 87, 4501: 88, 4552: 89, 4569: 90, 4548: 91, 3351: 95, 3368: 96, 4192: 98, 4254: 99, 4321: 100,
    5457: 101, 4594: 104, 3379: 105, 4258: 106, 3556: 108, 3992: 109, 205: 110, 4472: 49, 5194: 51, 4579: 58,
    4621: 59, 4649: 60, 4303: 61, 5055: 63, 4826: 64, 3623: 65, 3627: 66, 4736: 94,
};
function cfaNames(line) {
    const names = [], code = line.slice(0, 11).trim();
    const m = code.match(/^([NIU])0*(\d+)([A-Z]?)$/);
    if (m) names.push(`${{ N: 'NGC', I: 'IC', U: 'UGC' }[m[1]]} ${m[2]}${m[3]}`);
    if (m?.[1] === 'N' && !m[3] && MESSIER_NGC[m[2]]) names.push(`Messier ${MESSIER_NGC[m[2]]}`);
    for (const [, n] of line.slice(36).matchAll(/\bM(\d{1,3})\b/g)) names.push(`Messier ${n}`);
    for (const [, n] of line.slice(36).matchAll(/\bArp ?(\d{1,3})\b/gi)) names.push(`Arp ${n}`);
    return names;
}

function readCfA(file) {
    const galaxies = [];
    let skipped = 0, far = 0;
    for (const line of fs.readFileSync(file, 'latin1').split(/\r?\n/)) {
        if (line.length < 36 || !/^\d{6}\.\d$/.test(line.slice(11, 19))) continue;    // header and blank lines
        const ra = line.slice(11, 19), dec = line.slice(20, 26);
        const raH = +ra.slice(0, 2) + +ra.slice(2, 4) / 60 + +ra.slice(4) / 3600;
        const decD = (line[19] === '-' ? -1 : 1) * (+dec.slice(0, 2) + +dec.slice(2, 4) / 60 + +dec.slice(4, 6) / 3600);
        const mv = line.slice(26, 36).match(/^\s*(\d{1,2}\.\d{1,2})?\s+(\d+)\s*$/) ?? line.slice(26, 36).match(/^\s*(\d{1,2}\.\d{1,2})?(\d+)?/);
        const m = parseFloat(mv?.[1]), v = parseFloat(mv?.[2]);
        // Within a few Mpc peculiar motions swamp the expansion: a redshift there is no distance
        if (!(v > 500) || !Number.isFinite(m) || !Number.isFinite(raH) || !Number.isFinite(decD)) { skipped++; continue; }
        // The surveys reach ~15,000 km/s; the catalogue also lists a few quasars and background objects
        // far beyond them, which would stretch the survey's box to no purpose
        if (v > 45000) { far++; continue; }
        const z = v / C_KMS, [raJ, decJ] = precessB1950(raH * 15, decD);   // to J2000, as the other surveys
        galaxies.push({ p: place(raJ / 15, decJ, comoving(z)), z, m, ra: raJ, dec: decJ, names: cfaNames(line) });
    }
    console.log(`  ${path.basename(file)}: ${skipped} rows without a usable velocity (≤ 500 km/s) or magnitude, ${far} beyond 45,000 km/s, skipped`);
    return galaxies;
}

// ─── 2dFGRS (best-observation catalogue) ────────────────────────────────────
// Object lines: seq, nspec, name, UKST plate, RA/Dec B1950 (h m s, d m s), RA/Dec J2000 (read here), 7
// magnitude columns (bJ selection magnitude first), then nobs?, z, z_helio, quality, run. Spectrum lines
// carry the name second instead.
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
        galaxies.push({ p: place(raH, decD, comoving(z)), z, m: bJ, ra: raH * 15, dec: decD });
    }
    console.log(`  ${path.basename(file)}: ${objects.toLocaleString()} objects, ${poor.toLocaleString()} without a quality ≥ 3 redshift, ${out.toLocaleString()} stars or beyond z 0.5`);
    return galaxies;
}

// ─── SDSS (SkyServer CSV) ───────────────────────────────────────────────────
// A "#Table1" line, then a header "ra,dec,z,mag" (J2000 degrees, redshift, a magnitude); see SDSS_QUERIES.
function readSDSS(file) {
    const galaxies = [];
    let bad = 0;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    if (lines[1] !== 'ra,dec,z,mag') throw new Error(`${file}: expected SkyServer CSV with ra,dec,z,mag (got "${lines[0].slice(0, 60)}")`);
    for (const line of lines.slice(2)) {
        if (!line) continue;
        const [ra, dec, z, m] = line.split(',').map(Number);
        if (!(z > 0 && z < Z_MAX) || ![ra, dec, m].every(Number.isFinite) || m <= 0) { bad++; continue; }
        galaxies.push({ p: place(ra / 15, dec, comoving(z)), z, m, ra, dec });
    }
    console.log(`  ${path.basename(file)}: ${galaxies.length.toLocaleString()} rows, ${bad} without a usable redshift or magnitude skipped`);
    return galaxies;
}
// How the two SDSS files were made: SkyServer DR17 SQL search (skyserver.sdss.org/dr17, Search → SQL,
// output CSV). Every 6th / 17th fibre keeps about 100k galaxies spread evenly over each survey's sky.
export const SDSS_QUERIES = {
    sdss: "SELECT ra, dec, z, petroMag_r AS mag FROM SpecPhoto WHERE survey='sdss' AND class='GALAXY' AND zWarning=0 AND z BETWEEN 0.002 AND 0.4 AND petroMag_r < 17.77 AND fiberID % 6 = 0",
    boss: "SELECT ra, dec, z, cModelMag_i AS mag FROM SpecPhoto WHERE survey IN ('boss','eboss') AND class='GALAXY' AND zWarning=0 AND z BETWEEN 0.05 AND 1.2 AND fiberID % 17 = 0",
};

// ─── DESI (DR1 redshift extract + Legacy Surveys photometry) ────────────────
// raw/desi_200k.csv: targetid, mean_fiber_ra, mean_fiber_dec, z, zerr, zwarn, spectype (J2000 degrees).
// It has no magnitudes; raw/desi_photometry.csv (tools/fetch-desi-photometry.mjs) adds flux_r in
// nanomaggies and the Milky Way transmission, giving the dereddened r = 22.5 − 2.5 log10(flux_r / T).
// Galaxies only, with clean redshifts (zwarn 0): the extract's stars aren't large-scale structure, and its
// quasars would stretch the scene out to z ≈ 6.
function readDESI(file, photometryFile) {
    const flux = new Map();
    if (fs.existsSync(photometryFile)) {
        for (const line of fs.readFileSync(photometryFile, 'utf8').split(/\r?\n/).slice(1)) {
            const [id, f, t] = line.split(',');
            if (id && +f > 0 && +t > 0) flux.set(id, +f / +t);
        }
    } else console.warn(`  ${path.basename(photometryFile)} missing: run tools/fetch-desi-photometry.mjs; brightness falls back to the median`);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const header = lines[0].split(','), col = name => header.indexOf(name);
    const [iId, iRa, iDec, iZ, iWarn, iType] = ['targetid', 'mean_fiber_ra', 'mean_fiber_dec', 'z', 'zwarn', 'spectype'].map(col);
    const galaxies = [];
    let other = 0, poor = 0, noFlux = 0;
    for (const line of lines.slice(1)) {
        if (!line) continue;
        const c = line.split(',');
        if (c[iType] !== 'GALAXY') { other++; continue; }
        const z = +c[iZ];
        if (c[iWarn] !== '0' || !(z > 0.002 && z < Z_MAX)) { poor++; continue; }
        const f = flux.get(c[iId]);
        if (!f) noFlux++;
        // With no flux, r = NaN: writeSurvey gives it the median weight rather than ranking it
        galaxies.push({ p: place(+c[iRa] / 15, +c[iDec], comoving(z)), z, m: f ? 22.5 - 2.5 * Math.log10(f) : NaN, ra: +c[iRa], dec: +c[iDec] });
    }
    console.log(`  ${path.basename(file)}: ${other.toLocaleString()} stars and quasars, ${poor.toLocaleString()} galaxies with a flagged redshift skipped; ${noFlux} kept without photometry`);
    return galaxies;
}

// ─── Names from NED ─────────────────────────────────────────────────────────
// raw/ned_galaxies.csv and raw/ned_aliases.json come from tools/fetch-ned-galaxies.mjs. A survey galaxy is
// NED's galaxy if they lie within MATCH_ARCSEC on the sky and agree in redshift to 0.002(1 + z); of several,
// the one with a familiar name, then the most cited. Only familiar names become labels: the catalogues in
// NAMED, most familiar first (a galaxy in several shows the first). NED's other designations (SDSS J…,
// WISEA J…, 2MASX J…) label nothing a viewer would recognise.
const NAMED = [
    [/^Messier\s+0*(\d+)$/i, d => `M${d}`],
    [/^NGC\s+0*(\d+[A-Z]?)$/i, d => `NGC ${d}`],
    [/^IC\s+0*(\d+[A-Z]?)$/i, d => `IC ${d}`],
    [/^Arp\s+0*(\d+[A-Z]?)$/i, d => `Arp ${d}`],
    [/^UGC\s+0*(\d+[A-Z]?)$/i, d => `UGC ${d}`],
    [/^UGCA\s+0*(\d+[A-Z]?)$/i, d => `UGCA ${d}`],
    [/^(?:MRK|Markarian)\s+0*(\d+[A-Z]?)$/i, d => `Mrk ${d}`],
    [/^3C\s+0*(\d+(?:\.\d+)?[A-Z]?)$/i, d => `3C ${d}`],
];
// The best familiar name among a galaxy's names, as [rank, label], or null
function familiar(names) {
    let best = null;
    for (const n of names) {
        const s = n.trim().replace(/\s+/g, ' ');
        NAMED.forEach(([re, f], rank) => {
            const m = s.match(re);
            if (m && (!best || rank < best[0])) best = [rank, f(m[1])];
        });
    }
    return best;
}
const MATCH_ARCSEC = { cfa1: 20, cfa2: 20 };            // CfA's photographic positions; fibre surveys: 5″
const ALIAS_REFS = 30;                                  // cited this often but oddly named: ask NED for its other names
const ned = (() => {
    const file = path.join(rawDir, 'ned_galaxies.csv');
    if (!fs.existsSync(file)) { console.warn(`ned_galaxies.csv missing: run tools/fetch-ned-galaxies.mjs galaxies; no labels`); return null; }
    const aliasFile = path.join(rawDir, 'ned_aliases.json');
    const aliases = fs.existsSync(aliasFile) ? JSON.parse(fs.readFileSync(aliasFile, 'utf8')) : {};
    const rows = [];
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(1)) {
        const m = line.match(/^"(.*)",([^,]*),([^,]*),([^,]*),([^,]*)$/);
        if (!m) continue;
        const [, name, ra, dec, z, refs] = m;
        rows.push({ name, v: unit(+ra, +dec), z: +z, refs: +refs, label: familiar([name, ...(aliases[name] ?? [])]) });
    }
    // Grid on the unit sphere, cells wider than any match radius, so a match is in a cell next to its own
    const CELL = 1e-3, key = v => v.map(c => Math.floor(c / CELL)).join(',');
    const cells = new Map();
    for (const r of rows) { const k = key(r.v); (cells.get(k) ?? cells.set(k, []).get(k)).push(r); }
    console.log(`NED: ${rows.length.toLocaleString()} galaxies, ${rows.filter(r => r.label).length.toLocaleString()} with familiar names (${Object.keys(aliases).length.toLocaleString()} alias lookups cached)`);
    return {
        near(v, radius) {
            const c = v.map(x => Math.floor(x / CELL)), out = [];
            for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
                for (const r of cells.get(`${c[0] + i},${c[1] + j},${c[2] + k}`) ?? []) {
                    const d = Math.hypot(r.v[0] - v[0], r.v[1] - v[1], r.v[2] - v[2]);
                    if (d <= radius) out.push([r, d]);
                }
            }
            return out;
        },
    };
})();
const unnamed = new Map();                              // well-cited matches without a familiar name: NED name → refs

// Galaxies the survey's own catalogue names (g.names, CfA) but NED gave no familiar name for, until NED's full
// list is in. Without citation counts they are ranked by apparent brightness, scaled to read like citations:
// CATALOGUE_REFS at magnitude 15, ×10 every 2.5 magnitudes brighter (M87, m = 10.3: ~2,300; NED gives 3,798).
const CATALOGUE_REFS = 30;
const catalogueRefs = m => Math.round(CATALOGUE_REFS * 10 ** (0.4 * (15 - m)));

// galaxies (with ra, dec in J2000 degrees) → datasets/<id>.labels.json:
// [label, x, y, z (Mpc/h), refs, survey index, NED name], most cited first. Names from NED first; then, for
// galaxies NED did not name, the survey catalogue's own (CfA's NGC/IC/UGC/Messier/Arp), each name used once.
function writeLabels(id, galaxies) {
    const best = ned ? nedLabels(id, galaxies) : new Map();
    const labels = [...best].map(([r, { g, i }]) => [r.label[1], ...g.p.map(v => +v.toFixed(2)), r.refs, i, r.name]);
    const used = new Set(labels.map(l => l[0])), labelled = new Set(labels.map(l => l[5]));
    let fromCatalogue = 0;
    // Brightest first, so where a name repeats (a pair listed twice) the brighter one keeps it
    for (const i of [...galaxies.keys()].filter(i => galaxies[i].names?.length).sort((a, b) => galaxies[a].m - galaxies[b].m)) {
        const g = galaxies[i], name = familiar(g.names)?.[1];
        if (!name || used.has(name) || labelled.has(i)) continue;
        used.add(name);
        labels.push([name, ...g.p.map(v => +v.toFixed(2)), catalogueRefs(g.m), i, g.names[0]]);
        fromCatalogue++;
    }
    if (!labels.length && !ned) return null;
    labels.sort((a, b) => b[4] - a[4]);
    const file = `datasets/${id}.labels.json`;
    fs.writeFileSync(path.join(outDir, file), JSON.stringify({ format: 'universe-labels@1', labels }));
    console.log(`  ${labels.length.toLocaleString()} named galaxies, ${fromCatalogue.toLocaleString()} by the catalogue's own names (${labels.slice(0, 5).map(l => l[0]).join(', ')}${labels.length > 5 ? ' …' : ''})`);
    return { labels: file, labelCount: labels.length };
}

// NED's familiar names matched to survey galaxies: NED galaxy → { g, i, d }
function nedLabels(id, galaxies) {
    const radius = (MATCH_ARCSEC[id] ?? 5) / 206265;
    const best = new Map();                             // NED galaxy → its nearest survey galaxy, so each label is used once
    for (const [i, g] of galaxies.entries()) {
        let pick = null;
        for (const [r, d] of ned.near(unit(g.ra, g.dec), radius)) {
            if (!(Math.abs(r.z - g.z) <= 0.002 * (1 + g.z))) continue;
            const better = !pick || (!!r.label !== !!pick[0].label ? !!r.label : r.refs !== pick[0].refs ? r.refs > pick[0].refs : d < pick[1]);
            if (better) pick = [r, d];
        }
        if (!pick) continue;
        const [r, d] = pick;
        if (!r.label) { if (r.refs >= ALIAS_REFS) unnamed.set(r.name, r.refs); continue; }
        if (!best.has(r) || d < best.get(r).d) best.set(r, { g, i, d });
    }
    return best;
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
    { id: 'sdss', title: 'SDSS main galaxy sample', file: 'sdss_sample.csv', read: () => readSDSS(path.join(rawDir, 'sdss_sample.csv')),
        description: 'A sixth of the Sloan survey’s flux-limited galaxies (r < 17.77) to z ≈ 0.3, 2000–08',
        credit: 'Sloan Digital Sky Survey DR17 (Abdurro’uf et al. 2022), main galaxy sample (Strauss et al. 2002); SDSS is funded by the Alfred P. Sloan Foundation, the participating institutions and the US DOE Office of Science' },
    { id: 'boss', title: 'SDSS BOSS / eBOSS', file: 'boss_eboss_100k.csv', read: () => readSDSS(path.join(rawDir, 'boss_eboss_100k.csv')),
        description: 'Luminous red and emission-line galaxies from BOSS and eBOSS, out to z ≈ 1.1, 2009–19',
        credit: 'Sloan Digital Sky Survey DR17 (Abdurro’uf et al. 2022): BOSS (Dawson et al. 2013) and eBOSS (Dawson et al. 2016); SDSS is funded by the Alfred P. Sloan Foundation, the participating institutions and the US DOE Office of Science' },
    { id: 'desi', title: 'DESI DR1', file: 'desi_200k.csv', read: () => readDESI(path.join(rawDir, 'desi_200k.csv'), path.join(rawDir, 'desi_photometry.csv')),
        description: 'Bright, luminous red and emission-line galaxies from the Dark Energy Spectroscopic Instrument, out to z ≈ 1.6, 2021–22',
        credit: 'DESI Data Release 1 (DESI Collaboration 2025), photometry from the DESI Legacy Imaging Surveys DR9, via NOIRLab’s Astro Data Lab; DESI is supported by the US DOE Office of Science and the participating institutions' },
];
for (const s of surveys) {
    const file = path.join(rawDir, s.file ?? (s.id === '2dfgrs' ? '2dfgrs.idz' : `${s.id}.txt`));
    if (!fs.existsSync(file)) { console.warn(`${s.id}: ${file} missing, left out of the manifest`); continue; }
    const galaxies = s.read();
    const packed = writeSurvey(s.id, galaxies);
    const labels = writeLabels(s.id, galaxies);
    datasets.push({ id: s.id, title: s.title, kind: 'survey', description: s.description, file: `datasets/${s.id}.u16`, ...packed, mirrorZ: false, credit: s.credit, ...labels });
}
if (ned) {
    // For tools/fetch-ned-galaxies.mjs aliases, most cited first
    const list = [...unnamed].sort((a, b) => b[1] - a[1]).map(([n]) => n);
    fs.writeFileSync(path.join(rawDir, 'ned_unnamed.txt'), list.join('\n') + '\n');
    console.log(`${list.length.toLocaleString()} matched galaxies cited ≥ ${ALIAS_REFS} times have no familiar NED name: listed in ned_unnamed.txt for the alias lookup`);
}
const manifest = {
    format: 'universe-datasets@1',
    scale: SCALE,
    units: 'Mpc/h',
    cosmology: { omegaM: OMEGA_M, omegaL: OMEGA_L, h: 0.73 },     // h only for the pointer's look-back times
    // NED's required acknowledgement, shown with the labels
    labelCredit: 'This research has made use of the NASA/IPAC Extragalactic Database (NED), which is funded by the National Aeronautics and Space Administration and operated by the California Institute of Technology',
    datasets,
};
fs.writeFileSync(path.join(outDir, 'datasets.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Wrote ${path.join(outDir, 'datasets.json')} (${datasets.length} datasets)`);
