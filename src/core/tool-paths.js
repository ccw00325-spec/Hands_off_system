import { posix, win32 } from 'node:path';
import { homedir } from 'node:os';
import { readdir } from 'node:fs/promises';

export async function toolRoots(name, { platform = process.platform, env = process.env, home = homedir() } = {}) {
  const path = platform === 'win32' ? win32 : posix;
  const roots = [path.join(home, '.local', 'bin'), path.join(home, `.${name}`, 'bin')];
  if (platform === 'win32') {
    if (env.ProgramFiles) roots.push(path.join(env.ProgramFiles, 'nodejs'), path.join(env.ProgramFiles, 'Git', 'cmd'), path.join(env.ProgramFiles, 'Docker', 'Docker', 'resources', 'bin'));
  } else {
    // Finder-launched apps do not inherit a terminal's Homebrew/nvm PATH.
    roots.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', path.join(home, '.volta', 'bin'));
    const nvm = path.join(home, '.nvm', 'versions', 'node');
    for (const name of (await readdir(nvm).catch(() => [])).filter(n => /^v\d+\.\d+\.\d+$/.test(n)).sort((a,b) => b.localeCompare(a, undefined, {numeric:true}))) roots.push(path.join(nvm, name, 'bin'));
  }
  roots.push(...(env.PATH || '').split(platform === 'win32' ? ';' : ':'));
  return [...new Set(roots.filter(root => root && path.isAbsolute(root)))];
}
