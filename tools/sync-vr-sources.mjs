#!/usr/bin/env node
/*
 * Rebuilds the site's VR bundles from the lab repositories listed in vr/sources.json.
 * .github/workflows/sync-vr.yml runs this and turns the result into a pull request.
 *
 *   node tools/sync-vr-sources.mjs [--manifest vr/sources.json] [--pr-body out.md]
 *
 * Each manifest entry names:
 *   repo        git URL of the Unity project (its root must hold Assets/ and ProjectSettings/)
 *   ref         a branch name, or a tag glob such as "v*" to follow the newest matching tag
 *   scene       the scene to compile, relative to the project root
 *   output      the bundle to write; its file name is also the project name the page shows
 *   handPorted  C# files re-implemented by hand in a page, which a recompile can't update
 *
 * The commit a bundle was built from is stored in the bundle (source.commit), so merging the pull
 * request is what moves a source forward. A new upstream commit counts as a change only if it alters
 * the compiled output or touches a hand-ported file. Commit messages stay out of the pull request
 * because the lab repositories can be private while this one is public.
 *
 * VR_SOURCES_TOKEN, if set, is used to read private GitHub repositories. Nothing from the lab
 * repositories is executed: the compiler only parses their files.
 *
 * Exit code 1 means a source failed; sources that succeeded are still written and reported.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(toolsDir, '..');

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const manifestPath = path.resolve(option('--manifest') ?? path.join(siteRoot, 'vr', 'sources.json'));
const prBodyPath = option('--pr-body');

const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' };
if (process.env.VR_SOURCES_TOKEN) {
    // Passed through the environment so the token never appears in a command line or remote URL.
    const basic = Buffer.from(`x-access-token:${process.env.VR_SOURCES_TOKEN}`).toString('base64');
    Object.assign(gitEnv, {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    });
}
// Always called with a cwd outside this checkout: actions/checkout leaves its own auth header in
// .git/config, and a second one for github.com would be rejected.
const git = (gitArgs, cwd) => execFileSync('git', gitArgs, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function resolveRef(repo, ref, cwd) {
    const isGlob = ref.includes('*');
    const lsArgs = isGlob ? ['ls-remote', '--tags', '--sort=-v:refname', repo, `refs/tags/${ref}`] : ['ls-remote', repo, `refs/heads/${ref}`];
    let listing;
    try { listing = git(lsArgs, cwd); }
    catch (e) { throw new Error(`cannot read ${repo}; check it exists and VR_SOURCES_TOKEN can read it\n${e.stderr ?? e.message}`); }
    const rows = listing.split('\n').filter(Boolean).map(line => line.split('\t'));
    if (!rows.length) throw new Error(`${repo} has no ${isGlob ? 'tag matching' : 'branch'} ${ref}`);
    const full = rows[0][1].replace(/\^\{\}$/, '');
    const peeled = rows.find(([, name]) => name === `${full}^{}`);   // an annotated tag's commit
    return { commit: (peeled ?? rows[0])[0], name: full.replace(/^refs\/(heads|tags)\//, '') };
}

const readJson = text => { try { return JSON.parse(text); } catch { return null; } };
const withoutSource = bundle => JSON.stringify({ ...bundle, source: undefined });
const changedKeys = (a = {}, b = {}) => [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort();
const short = sha => sha.slice(0, 8);

function compareUrl(repo, from, to) {
    const m = repo.match(/^https:\/\/github\.com\/(.+?)(?:\.git)?$/);
    return m ? `https://github.com/${m[1]}/compare/${from}...${to}` : null;
}

function describeBundleChanges(before, after) {
    if (!before) return ['First build recorded from this repository.'];
    const lines = [];
    const add = (label, names) => { if (names.length) lines.push(`${label}: ${names.map(n => `\`${n}\``).join(', ')}`); };
    add('Shaders', changedKeys(before.shaders, after.shaders));
    add('Materials', changedKeys(before.materials, after.materials));
    add('Scene', changedKeys(before.scene, after.scene));
    add('Examples', changedKeys(Object.fromEntries((before.examples ?? []).map(e => [e.name, e.data])), Object.fromEntries((after.examples ?? []).map(e => [e.name, e.data]))));
    add('Bundle fields', ['format', 'project', 'version', 'colorSpace', 'unity'].filter(k => before[k] !== after[k]));
    return lines;
}

function syncSource(source, tmp) {
    const output = path.resolve(siteRoot, source.output);
    const previousBytes = fs.existsSync(output) ? fs.readFileSync(output) : null;
    const before = previousBytes ? readJson(previousBytes.toString('utf8')) : null;
    const last = before?.source?.commit ?? null;

    const head = resolveRef(source.repo, source.ref, tmp);
    if (head.commit === last) {
        console.log(`${source.id}: up to date at ${short(last)} (${head.name})`);
        return null;
    }

    // Blobless and without LFS: history for the diff, and only the files at the commit being built.
    const checkout = path.join(tmp, source.id, path.basename(output, '.json'));
    fs.mkdirSync(path.dirname(checkout), { recursive: true });
    git(['clone', '--quiet', '--filter=blob:none', '--no-checkout', source.repo, checkout], tmp);
    git(['checkout', '--quiet', '--detach', head.commit], checkout);

    let changedFiles = null, commitCount = null;
    if (last) {
        try {
            git(['cat-file', '-e', `${last}^{commit}`], checkout);
            changedFiles = new Set(git(['diff', '--name-only', '--no-renames', last, head.commit], checkout).split('\n').filter(Boolean));
            commitCount = Number(git(['rev-list', '--count', `${last}..${head.commit}`], checkout));
        } catch { /* history was rewritten upstream: treat it as having no baseline */ }
    }

    const compilerArgs = [path.join(toolsDir, 'compile-root-vr.mjs'), checkout, output, '--strict',
        '--scene', source.scene, '--source-commit', head.commit, '--source-ref', head.name];
    try {
        console.log(execFileSync(process.execPath, compilerArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim());
    } catch (e) {
        throw new Error(`compile failed at ${short(head.commit)}\n${[e.stdout, e.stderr].filter(Boolean).join('\n') || e.message}`);
    }

    const after = JSON.parse(fs.readFileSync(output, 'utf8'));
    const outputChanged = !before || withoutSource(before) !== withoutSource(after);
    const flagged = (source.handPorted ?? []).filter(h => !changedFiles || changedFiles.has(h.file));

    if (last && !outputChanged && !flagged.length) {
        fs.writeFileSync(output, previousBytes);
        console.log(`${source.id}: ${short(head.commit)} changes nothing the site uses`);
        return null;
    }

    const version = after.version ? `${after.version} ` : '';
    const compare = last && changedFiles ? compareUrl(source.repo, last, head.commit) : null;
    const span = commitCount === null ? 'no earlier build to compare with' : `${commitCount} commit${commitCount === 1 ? '' : 's'} since \`${short(last)}\``;
    const body = [
        `## ${source.title}`,
        '',
        `\`${head.name}\` is at \`${short(head.commit)}\` (${span})${compare ? `. [Compare](${compare})` : ''}`,
        '',
        '**Compiled output**',
        '',
        ...(outputChanged ? describeBundleChanges(before, after).map(l => `- ${l}`) : ['- Unchanged apart from the recorded commit.']),
    ];
    if (flagged.length) {
        body.push('', changedFiles
            ? '**Hand-ported code changed upstream.** A recompile does not update these, so compare them with the port:'
            : '**No baseline to compare against.** Check that these hand-ported files still match their ports:', '');
        for (const h of flagged) body.push(`- [ ] \`${h.file}\`: ${h.port}`);
    }
    return { title: `${source.title} to ${version}(${short(head.commit)})`, body: body.join('\n') };
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-sync-'));
const updates = [];
const failures = [];
try {
    for (const source of manifest.sources) {
        try {
            const update = syncSource(source, tmp);
            if (update) updates.push(update);
        } catch (e) {
            failures.push(source.id);
            console.error(`${source.id}: ${e.message}`);
        }
    }
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}

if (updates.length) {
    const body = `${updates.map(u => u.body).join('\n\n')}\n\nOpen the preview deployment and try each visual in the browser before merging.\n`;
    if (prBodyPath) fs.writeFileSync(prBodyPath, body);
    console.log(`\n${body}`);
}
if (process.env.GITHUB_OUTPUT) {
    const title = `Sync ${updates.map(u => u.title).join(', ')}`;
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${updates.length > 0}\ntitle=${title}\n`);
}
if (failures.length) {
    console.error(`Failed: ${failures.join(', ')}`);
    process.exit(1);
}
