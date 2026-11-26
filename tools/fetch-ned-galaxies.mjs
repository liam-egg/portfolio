#!/usr/bin/env node
/*
 * Fetches galaxy names from the NASA/IPAC Extragalactic Database (NED), so universe.html can label the
 * survey galaxies that have familiar names (Messier, NGC, IC, UGC, Arp …). Two steps, each resumable:
 *
 *   node tools/fetch-ned-galaxies.mjs galaxies [raw-dir = vr/universe/raw]
 *       One asynchronous TAP query over NED's object directory (NEDTAP.objdir): every galaxy with a
 *       redshift that is either well studied (cited by ≥ MIN_REFS papers) or already goes by a catalogue
 *       name. → raw/ned_galaxies.csv (prefname, ra, dec, z, n_crosref; J2000 degrees). The query scans
 *       the whole directory, so it can wait in NED's queue for a long time: the job's URL is kept in
 *       raw/ned_job.txt, and running the step again picks the same job up instead of submitting another.
 *
 *       NED's asynchronous jobs stop after 60 minutes, which this one needs longer than; NED has offered
 *       a token for a longer run.
 *
 *   node tools/fetch-ned-galaxies.mjs region <ra0> <ra1> <dec0> <dec1> [raw-dir = vr/universe/raw]
 *       The same query over one small patch of sky (J2000 degrees), for testing on real data meanwhile,
 *       as NED suggested. The patch is covered by overlapping cones (see TILE, CONE), each a synchronous
 *       query well inside NED's 60 s limit, one at a time. Rows are merged into raw/ned_galaxies.csv (a full
 *       `galaxies` run replaces the file); cones done are kept in raw/ned_tiles.txt, so a rerun skips them.
 *
 *   node tools/fetch-ned-galaxies.mjs aliases [raw-dir = vr/universe/raw]
 *       NED's preferred name is not always the familiar one (at NGC 4889's position it is
 *       "NGC 4886:[WLQ2016] X0001"). tools/pack-universe-datasets.mjs lists the matched galaxies whose
 *       preferred name is no use as a label in raw/ned_unnamed.txt; this step looks each up in NED's
 *       ObjectLookup service for all its other names. → raw/ned_aliases.json (cached; run the packer
 *       again afterwards).
 *
 * NED's guidelines for automated queries (ned.ipac.caltech.edu/Documents/Guides/Interface/QueryAuto):
 * one request at a time, at least a second between a reply and the next request, and ask the helpdesk
 * first about anything running longer than six hours. Both steps keep to that; the alias step stops at
 * MAX_LOOKUPS a run.
 *
 * Any use of the result must carry NED's acknowledgement: "This research has made use of the NASA/IPAC
 * Extragalactic Database (NED), which is funded by the National Aeronautics and Space Administration and
 * operated by the California Institute of Technology."
 */
import fs from 'node:fs';
import path from 'node:path';

const [step] = process.argv.slice(2);
let rawDir = (step === 'region' ? null : process.argv[3]) ?? 'vr/universe/raw';
const TAP = 'https://ned.ipac.caltech.edu/tap/async';
const LOOKUP = 'https://ned.ipac.caltech.edu/srs/ObjectLookup';
const MIN_REFS = 10;                                    // "well studied": cited by at least this many papers
const MAX_LOOKUPS = 6 * 3600 / 2;                       // six hours at about two seconds a lookup
const sleep = ms => new Promise(res => setTimeout(res, ms));

const SYNC = 'https://ned.ipac.caltech.edu/tap/sync';
// Cone queries (CONTAINS … CIRCLE) use NED's position index: 0.5° at the heart of the Coma cluster, NED's
// densest kind of sky, took 18 s. Plain RA/Dec ranges do not, and time out even over 1.5° squares.
const TILE = 0.8, CONE = 0.6;                           // degrees: grid spacing, cone radius (≥ TILE/√2)
// Every galaxy with a redshift that is well studied or goes by a catalogue name (`where` narrows it)
function galaxyQuery(where = '') {
    const named = ['Messier', 'NGC', 'IC', 'Arp', 'UGC', 'MRK'].map(p => `prefname LIKE '${p} %'`).join(' OR ');
    return 'SELECT prefname, ra, dec, z, n_crosref FROM NEDTAP.objdir ' +
        `WHERE prefphytype = 'G' AND z BETWEEN 0.001 AND 1.7 AND (n_crosref >= ${MIN_REFS} OR ${named})${where}`;
}

async function region(ra0, ra1, dec0, dec1) {
    if (![ra0, ra1, dec0, dec1].every(Number.isFinite) || ra1 <= ra0 || dec1 <= dec0)
        throw new Error('usage: region <ra0> <ra1> <dec0> <dec1> (J2000 degrees, ra0 < ra1, dec0 < dec1)');
    const out = path.join(rawDir, 'ned_galaxies.csv'), tilesFile = path.join(rawDir, 'ned_tiles.txt');
    const done = new Set(fs.existsSync(tilesFile) ? fs.readFileSync(tilesFile, 'utf8').split(/\r?\n/).filter(Boolean) : []);
    // Existing rows by name, so overlapping patches don't repeat a galaxy
    const rows = new Map();
    if (fs.existsSync(out)) for (const line of fs.readFileSync(out, 'utf8').split(/\r?\n/).slice(1)) if (line) rows.set(line.split('",')[0], line);
    // Cones on a square grid TILE apart (in RA, widened by 1/cos dec), of radius CONE ≥ TILE/√2, so they
    // overlap and leave no gaps
    const cones = [];
    for (let dec = dec0 + TILE / 2; dec - TILE / 2 < dec1; dec += TILE) {
        const step = TILE / Math.cos(dec * Math.PI / 180);
        for (let ra = ra0 + step / 2; ra - step / 2 < ra1; ra += step) cones.push([+ra.toFixed(4), +dec.toFixed(4)]);
    }
    for (const [ra, dec] of cones) {
        const key = `${ra},${dec},${CONE}`;
        if (done.has(key)) continue;
        const t0 = Date.now();
        const r = await fetch(SYNC, { method: 'POST', body: new URLSearchParams({ REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv',
            QUERY: galaxyQuery(` AND CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', ${ra}, ${dec}, ${CONE})) = 1`) }) });
        const text = await r.text();
        if (!r.ok || !text.startsWith('prefname,')) throw new Error(`tile ${key}: HTTP ${r.status} ${text.slice(0, 500)}`);
        const lines = text.split(/\r?\n/).slice(1).filter(Boolean);
        for (const line of lines) rows.set(line.split('",')[0], line);
        fs.writeFileSync(out, ['prefname,ra,dec,z,n_crosref', ...rows.values()].join('\n') + '\n');
        fs.appendFileSync(tilesFile, key + '\n');
        console.log(`  tile ${key}: ${lines.length} galaxies in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
        await sleep(1100);                              // at least a second after each reply
    }
    console.log(`wrote ${out}: ${rows.size.toLocaleString()} galaxies`);
}

async function galaxies() {
    const out = path.join(rawDir, 'ned_galaxies.csv'), jobFile = path.join(rawDir, 'ned_job.txt');
    let job = fs.existsSync(jobFile) ? fs.readFileSync(jobFile, 'utf8').trim() : '';
    if (job) console.log(`resuming ${job}`);
    else {
        const query = galaxyQuery();
        const r = await fetch(TAP, {
            method: 'POST', redirect: 'manual',
            body: new URLSearchParams({ REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv', PHASE: 'RUN', QUERY: query }),
        });
        job = r.headers.get('location');
        if (!job) throw new Error(`NED TAP did not create a job (HTTP ${r.status}): ${(await r.text()).slice(0, 500)}`);
        fs.writeFileSync(jobFile, job + '\n');
        console.log(`submitted ${job}\n  ${query}`);
    }
    // Waiting costs NED nothing; a poll a minute is plenty for a job that can queue for hours
    for (let t = 0; ; t++) {
        // A dropped connection or DNS hiccup over hours of waiting is no reason to give up the job
        const phase = await fetch(`${job}/phase`).then(r => r.text()).then(s => s.trim()).catch(e => {
            console.warn(`  poll failed (${e.cause?.code ?? e.message}), trying again`);
            return 'QUEUED';
        });
        if (phase === 'COMPLETED') break;
        if (!['PENDING', 'QUEUED', 'EXECUTING'].includes(phase)) {
            fs.rmSync(jobFile);
            throw new Error(`job ${job} ended ${phase}; run the step again to submit a new one\n${(await (await fetch(job)).text()).slice(0, 1500)}`);
        }
        if (t % 10 === 0) console.log(`  ${new Date().toISOString().slice(11, 19)}  ${phase}`);
        await sleep(60000);
    }
    const text = await (await fetch(`${job}/results/result`)).text();
    if (!text.startsWith('prefname,')) throw new Error(`unexpected result: ${text.slice(0, 500)}`);
    fs.writeFileSync(out, text);
    fs.rmSync(jobFile);
    console.log(`wrote ${out}: ${(text.split('\n').filter(Boolean).length - 1).toLocaleString()} galaxies`);
}

async function aliases() {
    const listFile = path.join(rawDir, 'ned_unnamed.txt'), out = path.join(rawDir, 'ned_aliases.json');
    if (!fs.existsSync(listFile)) throw new Error(`${listFile} missing: run tools/pack-universe-datasets.mjs first`);
    const cache = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : {};
    const todo = fs.readFileSync(listFile, 'utf8').split(/\r?\n/).filter(n => n && !(n in cache));
    console.log(`${todo.length.toLocaleString()} names to look up${todo.length > MAX_LOOKUPS ? `, the first ${MAX_LOOKUPS.toLocaleString()} this run` : ''}`);
    let done = 0;
    for (const name of todo.slice(0, MAX_LOOKUPS)) {
        let result = null;
        for (let attempt = 1; attempt <= 3 && !result; attempt++) {
            try {
                const r = await fetch(LOOKUP, { method: 'POST', body: new URLSearchParams({ json: JSON.stringify({ name: { v: name }, aliases: { v: true } }) }) });
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                result = await r.json();
            } catch (e) {
                if (attempt === 3) console.warn(`  ${name}: ${e.message}`);
                await sleep(5000 * attempt);
            }
        }
        if (result) cache[name] = result.Aliases ?? [];
        if (++done % 50 === 0) { fs.writeFileSync(out, JSON.stringify(cache)); console.log(`  ${done.toLocaleString()} / ${todo.length.toLocaleString()}`); }
        await sleep(1100);                              // at least a second after each reply
    }
    fs.writeFileSync(out, JSON.stringify(cache));
    console.log(`wrote ${out}: ${Object.keys(cache).length.toLocaleString()} galaxies' names`);
}

if (step === 'galaxies') await galaxies();
else if (step === 'aliases') await aliases();
else if (step === 'region') {
    const [, ra0, ra1, dec0, dec1, dir] = process.argv.slice(2);
    if (dir) rawDir = dir;
    await region(+ra0, +ra1, +dec0, +dec1);
} else {
    console.error('usage: node tools/fetch-ned-galaxies.mjs galaxies|aliases [raw-dir]\n       node tools/fetch-ned-galaxies.mjs region <ra0> <ra1> <dec0> <dec1> [raw-dir]');
    process.exit(1);
}
