#!/usr/bin/env node
/*
 * Fetches r-band photometry for the galaxies in a DESI redshift extract, so universe.html can draw them
 * with brightnesses like the other surveys (the extract itself has positions and redshifts only).
 *
 *   node tools/fetch-desi-photometry.mjs [in = vr/universe/raw/desi_200k.csv] [out = vr/universe/raw/desi_photometry.csv]
 *
 * Reads the extract's targetids for clean-redshift galaxies (spectype GALAXY, zwarn 0) and looks them up,
 * 1,000 at a time, in desi_dr1.photometry on NOIRLab's Astro Data Lab (anonymous TAP, ~2 s a batch).
 * Writes targetid, flux_r (nanomaggies, Legacy Surveys DR9) and mw_transmission_r (Milky Way dust), from
 * which tools/pack-universe-datasets.mjs takes the dereddened magnitude r = 22.5 − 2.5 log10(flux / T).
 */
import fs from 'node:fs';

const [input = 'vr/universe/raw/desi_200k.csv', output = 'vr/universe/raw/desi_photometry.csv'] = process.argv.slice(2);
const TAP = 'https://datalab.noirlab.edu/tap/sync';
const BATCH = 1000;

const lines = fs.readFileSync(input, 'utf8').split(/\r?\n/);
const header = lines[0].split(',');
const col = name => header.indexOf(name);
const [iId, iWarn, iType] = [col('targetid'), col('zwarn'), col('spectype')];
const ids = lines.slice(1).filter(Boolean).map(l => l.split(','))
    .filter(c => c[iType] === 'GALAXY' && c[iWarn] === '0').map(c => c[iId]);
console.log(`${ids.length.toLocaleString()} galaxies to look up in ${Math.ceil(ids.length / BATCH)} batches`);

async function query(sql, attempt = 1) {
    const body = new URLSearchParams({ REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv', QUERY: sql });
    try {
        const r = await fetch(TAP, { method: 'POST', body });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.text()).split(/\r?\n/).filter(Boolean).slice(1);
    } catch (e) {
        if (attempt >= 4) throw e;
        await new Promise(res => setTimeout(res, 2000 * attempt));
        return query(sql, attempt + 1);
    }
}

const rows = [];
for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    rows.push(...await query(`SELECT targetid, flux_r, mw_transmission_r FROM desi_dr1.photometry WHERE targetid IN (${batch.join(',')})`));
    if ((i / BATCH) % 10 === 0) process.stdout.write(`\r  ${Math.min(i + BATCH, ids.length).toLocaleString()} / ${ids.length.toLocaleString()}`);
}
fs.writeFileSync(output, 'targetid,flux_r,mw_transmission_r\n' + rows.join('\n') + '\n');
console.log(`\nWrote ${output}: ${rows.length.toLocaleString()} of ${ids.length.toLocaleString()} galaxies matched`);
