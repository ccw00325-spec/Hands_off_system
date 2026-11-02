import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
export class BrowserOpener {
  constructor(store, openDefault) { this.store=store; this.openDefault=openDefault; }
  async chromePath() {
    if (process.platform !== 'win32') return null;
    const paths=[process.env.PROGRAMFILES,process.env['PROGRAMFILES(X86)'],process.env.LOCALAPPDATA].filter(Boolean).map(root=>join(root,'Google','Chrome','Application','chrome.exe'));
    for (const path of paths) { try { await access(path); return path; } catch {} }
    return null;
  }
  async settings() { return { preferred:(await this.store.read('browser-settings',{ preferred:'default' })).preferred,chromeAvailable:Boolean(await this.chromePath()) }; }
  async setPreferred(preferred) {
    if (!['default','chrome'].includes(preferred)) throw new Error('지원하지 않는 브라우저 선택입니다.');
    if (preferred==='chrome' && !await this.chromePath()) throw new Error('설치된 Chrome을 찾지 못했습니다.');
    await this.store.write('browser-settings',{ preferred }); return this.settings();
  }
  async open(url) {
    const { preferred }=await this.settings();
    if (preferred!=='chrome') return this.openDefault(url);
    const executable=await this.chromePath(); if (!executable) throw new Error('Chrome이 없어 브라우저 설정을 변경해야 합니다.');
    await new Promise((resolve,reject)=>{
      const child=spawn(executable,['--new-window',url],{ shell:false,windowsHide:true,stdio:'ignore',detached:true });
      child.once('spawn',()=>{child.unref();resolve();});child.once('error',()=>reject(new Error('Chrome을 열지 못했습니다. 기본 브라우저를 선택하세요.')));
    });
  }
}
