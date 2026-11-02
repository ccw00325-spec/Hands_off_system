import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (/\.(c?js|mjs)$/.test(path)) result.push(path);
  }
  return result;
}
for (const file of [...await files('src'), ...await files('test')]) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status) { process.stderr.write(result.stderr); process.exit(1); }
}
console.log('All source and test files passed syntax checks.');
