import { createHash } from 'node:crypto';
import { mkdir, readFile, lstat } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { atomicWrite } from './store.js';

export const WINDOWS_APP_ID = 'dev.agent.controltower.desktop';
export const WINDOWS_DEV_APP_ID = 'dev.agent.controltower.development';
export const LEGACY_WINDOWS_APP_ID = 'dev.agent.controltower';
export const windowsAppId = packaged => packaged ? WINDOWS_APP_ID : WINDOWS_DEV_APP_ID;

function localWindowsPath(value) {
  if (typeof value !== 'string' || !/^[A-Za-z]:[\\/]/.test(value) || !win32.isAbsolute(value) || /["\r\n\0]/.test(value))
    throw new Error('로컬 Windows 실행 경로를 확인할 수 없습니다.');
  return value;
}

export function windowsTaskbarDetails({ packaged, executable, appPath, iconPath, profileDirectory }) {
  localWindowsPath(executable); localWindowsPath(iconPath);
  const args = (packaged ? '' : ` "${localWindowsPath(appPath)}"`) + (profileDirectory ? ` --user-data-dir="${localWindowsPath(profileDirectory)}"` : '');
  return {
    appId: windowsAppId(packaged), appIconPath: iconPath, appIconIndex: 0,
    relaunchCommand: `"${executable}"${args}`, relaunchDisplayName: 'CW_Handsoff_sys',
  };
}

// Explorer must not depend on a portable app's disposable extraction directory.
// Content-addressing also gives changed artwork a fresh Windows icon cache key.
export async function cacheWindowsIcon(source, userData) {
  const bytes = await readFile(source);
  if (bytes.length < 6 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1 || !bytes.readUInt16LE(4))
    throw new Error('캐릭터 ICO 파일을 확인할 수 없습니다.');
  const directory = join(userData, 'branding');
  await mkdir(directory, { recursive: true });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
    throw new Error('아이콘 저장 폴더를 확인할 수 없습니다.');
  const path = join(directory, `mascot-${createHash('sha256').update(bytes).digest('hex').slice(0, 20)}.ico`);
  const info = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error('아이콘 저장 파일을 확인할 수 없습니다.');
  if (!info || !(await readFile(path)).equals(bytes)) await atomicWrite(path, bytes);
  return path;
}
