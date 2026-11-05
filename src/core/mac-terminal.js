import { isAbsolute } from 'node:path';
export function macLoginScript(command, args) {
  if (!Array.isArray(command) || !isAbsolute(command[0]) || [...command, ...args].some(value => typeof value !== 'string' || /[\x00-\x1f]/.test(value))) throw new Error('공식 로그인 명령을 확인하세요.');
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  return ['-e', 'tell application "Terminal" to activate', '-e', 'tell application "Terminal" to do script ' + JSON.stringify([...command, ...args].map(quote).join(' '))];
}
