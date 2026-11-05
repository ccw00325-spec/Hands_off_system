import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { access } from 'node:fs/promises';
import { nodeRuntime } from './node-runtime.js';
import { findExecutable } from './providers.js';
import { projectEnvironment } from './child-env.js';

export const INSTALL_SITES = Object.freeze({
  node: 'https://nodejs.org/en/download',
  git: process.platform === 'darwin' ? 'https://git-scm.com/install/mac' : process.platform === 'win32' ? 'https://git-scm.com/install/windows' : 'https://git-scm.com/install/linux',
  gpt: 'https://developers.openai.com/codex/cli',
  claude: 'https://code.claude.com/docs/en/setup',
  grok: 'https://cursor.com/docs/cli/installation',
  gemini: 'https://geminicli.com/docs/get-started/installation/',
  docker: 'https://docs.docker.com/get-started/get-docker/',
});

export function probeTool(executable, args, timeout = 5000) {
  return new Promise(resolve => {
    const child = spawn(executable, args, { cwd: homedir(), shell: false, windowsHide: true, env: projectEnvironment(), stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '', done = false;
    const finish = (code = -1) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, output }); };
    const timer = setTimeout(() => { child.kill(); finish(); }, timeout);
    child.stdout.on('data', chunk => { output += chunk.toString(); if (output.length > 32000) { child.kill(); finish(); } });
    child.once('error', () => finish()); child.once('close', finish);
  });
}

export class Prerequisites {
  constructor({ find = findExecutable, node = nodeRuntime, probe = probeTool } = {}) { Object.assign(this, { find, node, probe }); this.current = null; }
  async scan(status, { providers = ['gpt', 'grok', 'claude'], executionBackend = 'docker', dockerImage = 'node:24-bookworm-slim' } = {}) {
    const [node, git, docker] = await Promise.all([this.node(), this.find('git'), this.find('docker')]);
    const gitStub = process.platform === 'darwin' && git === '/usr/bin/git' && (await this.probe('/usr/bin/xcode-select', ['-p'])).code !== 0;
    const [nodeInfo, gitInfo, dockerInfo] = await Promise.all([
      node ? this.probe(node, ['--version']) : null,
      git && !gitStub ? this.probe(git, ['--version']) : null,
      docker ? this.probe(docker, ['info', '--format', '{{.ServerVersion}}'], 5000) : null,
    ]);
    const imageReady = dockerInfo?.code === 0 && (await this.probe(docker, ['image', 'inspect', '--format', '{{.Os}}', dockerImage])).code === 0;
    const version = row => row?.code === 0 ? row.output.match(/\d+\.\d+(?:\.\d+)?/)?.[0] ?? null : null;
    const nodeVersion = version(nodeInfo);
    let npm = false;
    if (node) for (const suffix of ['node_modules/npm/bin/npm-cli.js', '../lib/node_modules/npm/bin/npm-cli.js', '../share/nodejs/npm/bin/npm-cli.js'])
      if (await access(join(dirname(node), suffix)).then(() => true, () => false)) { npm = true; break; }
    const rows = [
      { id: 'node', label: 'Node.js 24+ · npm', state: !node ? 'missing' : !nodeVersion ? 'unknown' : Number(nodeVersion.split('.')[0]) < 24 ? 'outdated' : !npm ? 'npm-missing' : 'ready', version: nodeVersion, required: true, purpose: '프로젝트 테스트·빌드와 일부 AI CLI' },
      { id: 'git', label: 'Git', state: !git || gitStub ? 'missing' : version(gitInfo) ? 'ready' : 'unknown', version: version(gitInfo), required: true, purpose: 'GitHub 커밋·푸시' },
      { id: 'docker', label: 'Docker', state: !docker ? 'missing' : dockerInfo?.code !== 0 ? 'not-running' : imageReady ? 'ready' : 'image-missing', version: version(dockerInfo), required: executionBackend === 'docker', purpose: '프로젝트 테스트·빌드 격리 실행 · 로컬 이미지 ' + dockerImage },
      ...Object.entries({ gpt: 'GPT · Codex CLI', claude: 'Claude Code', grok: 'Cursor Agent CLI', gemini: 'Gemini CLI' }).map(([id, label]) => ({ id, label, state: status?.[id]?.installed ? 'ready' : 'missing', required: providers.includes(id), purpose: providers.includes(id) ? '현재 팀에 배정한 AI' : '선택 사항 · 이 AI를 사용할 때 설치', version: null })),
    ];
    this.current = { checkedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, rows, needsAttention: rows.some(row => row.required && row.state !== 'ready') };
    return structuredClone(this.current);
  }
}
