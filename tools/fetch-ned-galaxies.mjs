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

const [step, rawDir = 'vr/universe/raw'] = process.argv.slice(2);
const TAP = 'https://ned.ipac.caltech.edu/tap/async';
const LOOKUP = 'https://ned.ipac.caltech.edu/srs/ObjectLookup';
const MIN_REFS = 10;                                    // "well studied": cited by at least this many papers
const MAX_LOOKUPS = 6 * 3600 / 2;                       // six hours at about two seconds a lookup
const sleep = ms => new Promise(res => setTimeout(res, ms));

async function galaxies() {
    const out = path.join(rawDir, 'ned_galaxies.csv'), jobFile = path.join(rawDir, 'ned_job.txt');
    let job = fs.existsSync(jobFile) ? fs.readFileSync(jobFile, 'utf8').trim() : '';
    if (job) console.log(`resuming ${job}`);
    else {
        const named = ['Messier', 'NGC', 'IC', 'Arp', 'UGC', 'MRK'].map(p => `prefname LIKE '${p} %'`).join(' OR ');
        const query = 'SELECT prefname, ra, dec, z, n_crosref FROM NEDTAP.objdir ' +
            `WHERE prefphytype = 'G' AND z BETWEEN 0.001 AND 1.7 AND (n_crosref >= ${MIN_REFS} OR ${named})`;
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
else {
    console.error('usage: node tools/fetch-ned-galaxies.mjs galaxies|aliases [raw-dir]');
    process.exit(1);
}
