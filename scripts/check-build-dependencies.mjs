import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// GHSA-g3hv-75wg-m249 affects minimatch >=7.0.0 <11.0.1.
// Older consumers keep their callable API; only affected majors are overridden.
const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url)));
function vulnerable(version) {
  const [major, minor, patch] = version.split('.').map(Number);
  return major >= 7 && (major < 11 || (major === 11 && minor === 0 && patch === 0));
}
const affected = Object.entries(lock.packages).filter(([path, entry]) => {
  if (!path.endsWith('node_modules/minimatch')) return false;
  return vulnerable(entry.version);
});
assert.deepEqual(affected.map(([path]) => path), [], 'Vulnerable minimatch in lockfile');

const require = createRequire(import.meta.url);
for (const consumer of ['app-builder-lib', '@electron/universal']) {
  const fromConsumer = createRequire(require.resolve(consumer));
  assert.equal(vulnerable(fromConsumer('minimatch/package.json').version), false, consumer);
  const { Minimatch, minimatch } = fromConsumer('minimatch');
  // Both consumers use named exports; universal also relies on matchBase.
  assert.equal(new Minimatch('src/**/*.{js,cjs}', { dot: true }).match('src/core/task.js'), true);
  assert.equal(new Minimatch('src/**/*.{js,cjs}', { dot: true }).match('src/.cache/task.cjs'), true);
  assert.equal(minimatch('Frameworks/Example.framework/Example', 'Example', { matchBase: true }), true);
  assert.equal(minimatch('Frameworks/Other.framework/Other', 'Example', { matchBase: true }), false);
}

// Exercise the builder's actual filtering, including credential exclusions.
const { FileMatcher } = require('app-builder-lib/out/fileMatcher.js');
const root = resolve('build-dependency-fixture');
const matcher = new FileMatcher(root, root, value => value, [
  'src/**/*.{js,cjs}', '!src/private/**', '!**/.env*',
]);
const filter = matcher.createFilter();
for (const [file, expected] of [
  ['src/main.js', true], ['src/core/task.cjs', true],
  ['src/private/token.js', false], ['src/.env.local', false],
  ['src/notes.txt', false], ['.runtime/auth.json', false],
]) {
  assert.equal(filter(resolve(root, file), { isDirectory: () => false }), expected, file);
}
console.log('Build dependency advisory and consumer compatibility checks passed.');
