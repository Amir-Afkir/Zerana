/** Build V1 + isolated V2 into one Pages artifact; never deploy a preview alone. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { isPublicMapboxToken } from '../v2/demo/site-token.mjs';
import { LEGACY_COMMIT, LEGACY_PATHS, SITE_PREFIX, PREVIEW_PREFIX,
  directoryHashes, assertLegacyUnchanged, verifyEntrypoint } from './pages-lib.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
// Full history is fetched in CI. A missing baseline fails closed.
git(['diff', '--exit-code', LEGACY_COMMIT, '--', ...LEGACY_PATHS]);
assert.equal(git(['ls-files', '--others', '--exclude-standard', '--', ...LEGACY_PATHS]), '', 'Untracked V1 files');
const commit = git(['rev-parse', 'HEAD']);
assert(/^[0-9a-f]{40}$/.test(commit), 'Invalid build identity');
const token = (process.env.VITE_MAPBOX_API_KEY || '').trim();
assert(!token || isPublicMapboxToken(token), 'Only a public Mapbox token may enter a browser build');
const env = { ...process.env, GITHUB_ACTIONS: 'true', VITE_MAPBOX_API_KEY: token, VITE_BUILD_SHA: commit };
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function run(args) { execFileSync(npm, args, { cwd: root, env, stdio: 'inherit' }); }
run(['run', 'build']);
const site = resolve(root, 'dist'), before = directoryHashes(site);
assert(!existsSync(resolve(site, 'v2')), 'Refusing to overwrite an existing V1 v2 directory');
run(['--prefix', 'v2', 'run', 'demo:build']);
cpSync(resolve(root, 'v2/demo-dist'), resolve(site, 'v2'), { recursive: true, errorOnExist: true, force: false });
const buildInfo = { schemaVersion: 1, commit, legacyCommit: LEGACY_COMMIT,
  preview: true, altitudeAuthority: 'preview-only-for-mapbox', siteTokenConfigured: Boolean(token),
  sitePrefix: SITE_PREFIX, previewPrefix: PREVIEW_PREFIX };
writeFileSync(resolve(site, 'v2/build-info.json'), JSON.stringify(buildInfo, null, 2) + '\n');
const after = directoryHashes(site);
assertLegacyUnchanged(before, after);
verifyEntrypoint(site, 'index.html', SITE_PREFIX);
verifyEntrypoint(site, 'v2/index.html', PREVIEW_PREFIX);
const manifest = { ...buildInfo, legacyFiles: before, files: after };
writeFileSync(resolve(site, 'deployment-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Combined Pages artifact verified: ${Object.keys(before).length} V1 files unchanged, preview isolated, commit ${commit}.`);
