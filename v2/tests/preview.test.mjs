import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPublicMapboxToken, resolveMapboxToken } from '../demo/site-token.mjs';
import { directoryHashes, assertLegacyUnchanged, verifyEntrypoint, SITE_PREFIX, PREVIEW_PREFIX } from '../../scripts/pages-lib.mjs';

function sandbox(fn) { const path = mkdtempSync(join(tmpdir(), 'zerana-pages-')); try { fn(path); } finally { rmSync(path, { recursive: true, force: true }); } }
test('Public site credential fallback and manual override are explicit', () => {
  assert.equal(resolveMapboxToken('', ' pk.site-token '), 'pk.site-token');
  assert.equal(resolveMapboxToken(' pk.manual ', 'pk.site-token'), 'pk.manual');
});
test('Secret/invalid manual credentials never fall back to a configured credential', () => {
  for (const token of ['sk.secret', 'http://token', 'pk.hello&extra', 'pk.']) {
    assert(!isPublicMapboxToken(token));
    assert.throws(() => resolveMapboxToken(token, 'pk.valid'), /^Error: PUBLIC_MAPBOX_TOKEN_REQUIRED$/);
  }
});
test('Missing site credential is supported until real loading is requested', () => {
  assert(!isPublicMapboxToken(undefined)); assert(!isPublicMapboxToken(''));
  assert.throws(() => resolveMapboxToken('', ''), /PUBLIC_MAPBOX_TOKEN_REQUIRED/);
});
test('Adding an isolated preview preserves all V1 file hashes', () => {
  assertLegacyUnchanged({ 'index.html': 'a', 'assets/game.js': 'b' }, { 'index.html': 'a', 'assets/game.js': 'b', 'v2/index.html': 'c' });
});
test('Overwrite, deletion and unexpected root addition fail closed', () => {
  for (const after of [{ 'index.html': 'b' }, {}, { 'index.html': 'a', 'other.html': 'c' }]) {
    assert.throws(() => assertLegacyUnchanged({ 'index.html': 'a' }, after));
  }
});
test('Directory hashes are deterministic and cover nested files', () => sandbox(root => {
  mkdirSync(join(root, 'v2')); writeFileSync(join(root, 'index.html'), 'legacy'); writeFileSync(join(root, 'v2/index.html'), 'preview');
  const hashes = directoryHashes(root); assert.deepEqual(hashes, directoryHashes(root));
  assert.equal(Object.keys(hashes).length, 2); assert.match(hashes['index.html'], /^[0-9a-f]{64}$/);
}));
test('Static site symlinks are rejected', () => sandbox(root => {
  writeFileSync(join(root, 'a'), 'a'); symlinkSync(join(root, 'a'), join(root, 'b')); assert.throws(() => directoryHashes(root), /symlinks/);
}));
test('Both entrypoints use their own absolute Pages prefix', () => sandbox(root => {
  for (const [entry, prefix, dir] of [['index.html', SITE_PREFIX, 'assets'], ['v2/index.html', PREVIEW_PREFIX, 'v2/assets']]) {
    mkdirSync(join(root, dir), { recursive: true });
    for (const name of ['entry.js', 'entry.css']) writeFileSync(join(root, dir, name), 'ok');
    writeFileSync(join(root, entry), `<script src="${prefix}assets/entry.js"></script><link href="${prefix}assets/entry.css">`);
    assert.equal(verifyEntrypoint(root, entry, prefix).length, 2);
  }
}));
test('Invalid prefix and missing entry asset fail before publishing', () => sandbox(root => {
  writeFileSync(join(root, 'index.html'), '<script src="/assets/a.js"></script><link href="/assets/a.css">');
  assert.throws(() => verifyEntrypoint(root, 'index.html', SITE_PREFIX));
  writeFileSync(join(root, 'index.html'), '<script src="/Zerana/assets/a.js"></script><link href="/Zerana/assets/a.css">');
  assert.throws(() => verifyEntrypoint(root, 'index.html', SITE_PREFIX));
}));
