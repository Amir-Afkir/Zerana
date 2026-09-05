import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';

export const LEGACY_COMMIT = '0e06c350b6c3d07699600e0003609790d60661c4';
export const LEGACY_PATHS = ['src', 'public', 'index.html', 'package.json', 'package-lock.json', 'vite.config.js'];
export const SITE_PREFIX = '/Zerana/';
export const PREVIEW_PREFIX = '/Zerana/v2/';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function directoryHashes(directory) {
  const root = resolve(directory), result = Object.create(null);
  function visit(path) {
    const stat = lstatSync(path);
    assert(!stat.isSymbolicLink(), 'Static site must not contain symlinks');
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(resolve(path, name));
    } else {
      assert(stat.isFile(), 'Static site must contain only regular files');
      result[relative(root, path).split(sep).join('/')] = sha256(readFileSync(path));
    }
  }
  visit(root);
  return result;
}
export function assertLegacyUnchanged(before, after) {
  for (const [path, hash] of Object.entries(before)) {
    assert.equal(after[path], hash, `Legacy build changed while adding preview: ${path}`);
  }
  for (const path of Object.keys(after)) {
    assert(Object.hasOwn(before, path) || path.startsWith('v2/'), `Unexpected root addition: ${path}`);
  }
}
export function verifyEntrypoint(siteDirectory, entry, prefix) {
  const root = resolve(siteDirectory);
  const html = readFileSync(resolve(root, entry), 'utf8');
  const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(match => match[1]);
  assert(assets.length >= 2, `Missing JS/CSS entry assets for ${entry}`);
  for (const asset of assets) {
    assert(asset.startsWith(prefix), `Invalid asset prefix for ${entry}`);
    const path = resolve(root, asset.slice(SITE_PREFIX.length));
    const within = relative(root, path);
    assert(within && !within.startsWith('..') && !within.startsWith(sep), 'Asset escapes site root');
    assert(lstatSync(path).isFile(), 'Referenced asset is not a file');
  }
  return assets;
}
