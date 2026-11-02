import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { terminateTree } from './processes.js';

export class RpcProcess {
  constructor(executable, args, options = {}) {
    this.pending = new Map(); this.sequence = 0; this.closed = false;
    this.onNotification = options.onNotification ?? (() => {});
    this.child = (options.spawn ?? spawn)(executable, args, { cwd: options.cwd, env:options.env??process.env, windowsHide: true, shell: false, stdio: ['pipe','pipe',options.onOutput?'pipe':'ignore'] });
    if(options.onOutput){this.child.stdout.on('data',options.onOutput);this.child.stderr.on('data',options.onOutput);}
    this.lines = createInterface({ input: this.child.stdout });
    this.child.stdin.on('error', () => {});
    this.child.once('error', () => this.fail(new Error('공식 CLI를 실행할 수 없습니다.')));
    this.child.once('close', () => this.fail(new Error('공식 CLI 연결이 종료되었습니다.')));
    this.lines.on('line', line => {
      if (line.length > 1_000_000) { this.close(); return; }
      try {
        const message = JSON.parse(line);
        if (message.method && Object.hasOwn(message,'id')) {
          if(['session/request_permission','cursor/ask_question','cursor/create_plan'].includes(message.method))this.send({jsonrpc:'2.0',id:message.id,result:{outcome:{outcome:'cancelled'}}});
          else this.send({ jsonrpc:'2.0',id:message.id,error:{ code:-32601,message:'Client tools are disabled. Return a file manifest only.' } });
        } else if (message.method) this.onNotification(message.method, message.params);
        else if (this.pending.has(message.id)) {
          const request = this.pending.get(message.id); this.pending.delete(message.id);
          if (message.error) { const error = new Error('공식 CLI가 요청을 처리하지 못했습니다.'); error.rpcCode = message.error.code; error.rpcMessage=String(message.error.message??'').slice(0,500);request.reject(error); }
          else request.resolve(message.result);
        }
      } catch { /* Some CLI versions print non-JSON startup messages. Never forward them. */ }
    });
  }
  send(message) { if (!this.closed && !this.child.stdin.destroyed) this.child.stdin.write(`${JSON.stringify(message)}\n`); }
  notify(method, params = {}) { this.send({ jsonrpc:'2.0',method,params }); }
  request(method, params = {}, timeout = 15000) {
    return new Promise((resolve,reject) => {
      if (this.closed) { reject(new Error('공식 CLI 연결이 종료되었습니다.')); return; }
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('공식 CLI 응답 시간이 초과되었습니다.')); }, timeout);
      this.pending.set(id,{ resolve:value => { clearTimeout(timer); resolve(value); }, reject:error => { clearTimeout(timer); reject(error); } });
      this.send({ jsonrpc:'2.0',id,method,params });
    });
  }
  fail(error) { this.closed = true; for (const request of this.pending.values()) request.reject(error); this.pending.clear(); }
  close() { this.fail(new Error('공식 CLI 연결을 정리했습니다.')); this.lines.close(); if(this.child.pid)void terminateTree(this.child);else this.child.kill(); }
}
