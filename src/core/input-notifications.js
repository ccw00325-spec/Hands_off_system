import { mkdir, lstat } from 'node:fs/promises';
import { join, dirname, isAbsolute } from 'node:path';
import { WINDOWS_APP_ID, WINDOWS_DEV_APP_ID, LEGACY_WINDOWS_APP_ID, windowsAppId } from './windows-branding.js';

export const NOTIFICATION_APP_ID = WINDOWS_APP_ID;
export const NOTIFICATION_CLSID = '{7A709E29-B21D-4D27-8344-B21C6A963D8E}';

export async function registerNotificationShortcut(app, shell, branding = {}) {
  if (process.platform !== 'win32') return;
  const target = app.isPackaged ? (process.env.PORTABLE_EXECUTABLE_FILE || process.execPath) : process.execPath;
  if (!isAbsolute(target) || !/^[A-Za-z]:[\\/]/.test(target) || /["\r\n\0]/.test(target) || !(await lstat(target)).isFile()) throw new Error('알림 실행 파일을 확인할 수 없습니다.');
  const folder = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  await mkdir(folder, { recursive: true });
  const shortcut = join(folder, 'CW_Handsoff_sys.lnk');
  const existing = await lstat(shortcut).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink() || ![WINDOWS_APP_ID, WINDOWS_DEV_APP_ID, LEGACY_WINDOWS_APP_ID, branding.appId].filter(Boolean).includes(shell.readShortcutLink(shortcut).appUserModelId))
      throw new Error('다른 바로가기를 덮어쓰지 않도록 알림 등록을 중단했습니다.');
  }
  const details = { target, cwd: dirname(target), description: 'Hands off 사용자 답변 알림',
    icon: branding.appIconPath ?? (app.isPackaged ? target : join(app.getAppPath(), 'build', 'app.ico')), iconIndex: 0,
    appUserModelId: branding.appId ?? windowsAppId(app.isPackaged), toastActivatorClsid: NOTIFICATION_CLSID,
    ...(!app.isPackaged ? { args: `"${app.getAppPath()}"` } : {}) };
  if (!shell.writeShortcutLink(shortcut, existing ? 'update' : 'create', details))
    throw new Error('Windows 알림 바로가기를 등록하지 못했습니다.');
  return { shortcut, details };
}

export class InputNotifications {
  constructor({ Notification, register = async () => {}, persist = async () => {}, activate = () => {}, failed = () => {} }) {
    Object.assign(this, { Notification, register, persist, activate, failed });
    this.seen = new Set();
    this.active = new Map();
    this.pending = new Map();
  }
  async observe(state) {
    if (!state?.id) return;
    this.pending.set(state.id, state.status === 'needs_input' ? state.questionBatchId : null);
    if (this.pending.size > 500) this.pending.delete(this.pending.keys().next().value);
    if (state.status !== 'needs_input' || !state.questionBatchId) {
      for (const [key, notification] of this.active) if (key.startsWith(`${state.id}:input:`)) {
        notification.close?.(); this.active.delete(key);
      }
      return;
    }
    const key = `${state.id}:input:${state.questionBatchId}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value);
    const scope = { projectId: state.projectId, conversationId: state.options.conversationId, action: 'questions' };
    const message = '요구사항에 답변이 필요합니다. 선택지를 고르거나 직접 입력해 주세요.';
    try {
      await this.persist({ ...scope, key, message });
      if (!this.Notification.isSupported()) throw new Error('unsupported');
      await this.register();
      if (this.pending.get(state.id) !== state.questionBatchId) return;
      const notification = new this.Notification({ title: 'CW_Handsoff_sys · 답변이 필요해요', body: message,
        silent: false, timeoutType: 'default' });
      this.active.set(key, notification);
      if (this.active.size > 64) { const oldest=this.active.keys().next().value; this.active.get(oldest).close?.(); this.active.delete(oldest); }
      notification.on('click', () => this.activate(scope));
      // Keep a bounded reference after the banner expires so an Action Center click still routes correctly.
      notification.on('failed', () => { this.active.delete(key); this.failed(scope); });
      notification.show();
    } catch { if (this.pending.get(state.id) === state.questionBatchId) this.failed(scope); }
  }
}
