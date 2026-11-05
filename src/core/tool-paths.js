import { posix, win32 } from 'node:path';
import { homedir } from 'node:os';
import { readdir } from 'node:fs/promises';
import { readdirSync } from 'node:fs';

export function nativeToolPath(env = process.env, platform = process.platform, home = homedir()) {
  const path = platform === 'win32' ? win32 : posix, separator = platform === 'win32' ? ';' : ':';
  const current = env.PATH ?? Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  const extra = [];
  if (platform === 'win32') {
    const programFiles = env.ProgramFiles ?? (process.platform === 'win32' ? process.env.ProgramFiles : null);
    if (programFiles) extra.push(path.join(programFiles, 'nodejs'), path.join(programFiles, 'Git', 'cmd'));
  } else {
    extra.push('/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local', 'bin'), path.join(home, '.volta', 'bin'));
    const root = path.join(home, '.nvm', 'versions', 'node');
    try { for (const version of readdirSync(root).filter(name => /^v\d+\.\d+\.\d+$/.test(name)).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}))) extra.push(path.join(root,version,'bin')); } catch {}
  }
  return [...new Set([...current.split(separator), ...extra].filter(Boolean))].join(separator);
}

export function withToolPath(environment) {
  const value = nativeToolPath(environment);
  return { ...Object.fromEntries(Object.entries(environment).filter(([key])=>key.toUpperCase()!=='PATH')), PATH:value };
}

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
