import { randomUUID } from 'node:crypto';
const WEEK = 7*24*60*60*1000;
export class PersistentSession {
  constructor(store, now = () => Date.now()) { this.store = store; this.now = now; this.value = null; this.queue = Promise.resolve(); }
  async open() {
    const saved = await this.store.read('session-state',null); const now = this.now();
    this.value = { deviceId:saved?.deviceId ?? randomUUID(),lastActiveAt:saved?.lastActiveAt ?? null,lastVerifiedAt:saved?.lastVerifiedAt ?? null,
      idleDays:7,firstLaunch:!saved,recheckRequired:Boolean(saved?.verificationPending || (saved?.lastActiveAt && now - saved.lastActiveAt >= WEEK)),policy:'recheck-and-reuse' };
    await this.touch(); return this.state();
  }
  state() { return { ...this.value }; }
  persist() { return this.store.write('session-state', { deviceId:this.value.deviceId,lastActiveAt:this.value.lastActiveAt,lastVerifiedAt:this.value.lastVerifiedAt,verificationPending:this.value.recheckRequired }); }
  touch() {
    const operation = this.queue.then(async()=>{
      if (!this.value) return;
      if(this.value.lastActiveAt&&this.now()-this.value.lastActiveAt>=WEEK)this.value.recheckRequired=true;
      if (!this.value.lastActiveAt || this.now()-this.value.lastActiveAt >= 30000) { this.value.lastActiveAt=this.now(); await this.persist(); }
    });
    this.queue=operation.catch(()=>{}); return operation;
  }
  async verified() { await this.queue; this.value.lastVerifiedAt=this.now(); this.value.recheckRequired=false; await this.persist(); return this.state(); }
}
