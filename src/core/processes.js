import { spawn } from 'node:child_process';
import { join } from 'node:path';
export function terminateTree(child) {
  if (!child?.pid || child.exitCode !== null) return Promise.resolve();
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); }
    return Promise.resolve();
  }
  return new Promise(resolve => {
    const killer = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide:true,shell:false,stdio:'ignore' });
    const timer = setTimeout(() => { killer.kill(); child.kill(); resolve(); },10000);
    const done = () => { clearTimeout(timer); resolve(); };
    killer.once('error',done); killer.once('close',done);
  });
}
