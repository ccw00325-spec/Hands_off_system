import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { findExecutable } from './providers.js';
import { projectEnvironment } from './child-env.js';
import { redact, secretFinding } from './secrets.js';
import { validationResult } from './validation-result.js';

const execute = promisify(execFile);
const IMAGE = /^[a-z0-9][a-z0-9./_:-]*(?:@sha256:[a-f0-9]{64})?$/;
const REPORT_MARKER = 'CW_MUTATION_REPORT_BASE64:';
const WRAPPER = 'cp -R /input/. /workspace/; if [ -d /opt/node_modules ]; then ln -s /opt/node_modules /workspace/node_modules; fi; "$@"; result=$?; if [ -n "$TOWER_MUTATION_REPORT" ]; then node -e \'const fs=require("node:fs");try{const p=process.env.TOWER_MUTATION_REPORT,s=fs.lstatSync(p);if(s.isFile()&&!s.isSymbolicLink()&&s.size<=524288)process.stdout.write("\\nCW_MUTATION_REPORT_BASE64:"+fs.readFileSync(p).toString("base64")+"\\n");}catch{}\'; fi; exit "$result"';
export function dockerArgs({ name, image, input, command, report = false, uid = 1000, gid = 1000 }) {
  if (!IMAGE.test(image) || !/^cw-test-[a-f0-9-]{36}$/.test(name)) throw new Error('격리 실행 설정이 올바르지 않습니다.');
  if (!isAbsolute(input) || /[,\r\n\0]/.test(input)) throw new Error('격리 복사 경로가 올바르지 않습니다.');
  return ['run', '--rm', '--pull=never', '--name', name, '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=1g', '--cpus=2', '--user', `${uid}:${gid}`,
    '--tmpfs', `/workspace:rw,nosuid,nodev,size=536870912,uid=${uid},gid=${gid}`,
    '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=134217728,uid=${uid},gid=${gid}`,
    '--mount', `type=bind,src=${input},dst=/input,readonly`,
    '--workdir', '/workspace', ...(report ? ['--env', 'TOWER_MUTATION_REPORT=/tmp/cw-mutation.json'] : []),
    image, 'sh', '-c', WRAPPER, '--', ...command];
}

export async function validateInDocker(workspace, context, { find = findExecutable, exec = execute } = {}) {
  const { projectId, grantId, options, signal, onOutput, environment } = context;
  const setup = summary => ({configured:true, passed:false, requiresSetup:true, backend:'docker', summary});
  const docker = await find('docker');
  if (!docker) return setup('Docker를 설치하고 엔진을 실행하세요. 격리 모드에서는 PC에서 대신 실행하지 않습니다.');
  const image = options.dockerImage ?? 'node:24-bookworm-slim';
  if (!IMAGE.test(image)) throw new Error('격리 이미지 이름이 올바르지 않습니다.');
  const hostOptions = { env: projectEnvironment(), windowsHide:true, shell:false, timeout:5000, maxBuffer:32000 };
  try {
    const endpoint = (await exec(docker, ['context', 'inspect', '--format', '{{(index .Endpoints "docker").Host}}'], hostOptions)).stdout.trim();
    if (!/^(?:unix:\/\/\/|npipe:\/\/)/.test(endpoint)) return setup('로컬 Docker 엔진만 허용합니다. 원격·SSH·TCP Docker 컨텍스트를 사용할 수 없습니다.');
    const os = (await exec(docker, ['image', 'inspect', '--format', '{{.Os}}', image], hostOptions)).stdout.trim();
    if (os !== 'linux') return setup('Linux용 격리 이미지를 준비하세요. Docker Desktop은 Linux 컨테이너 모드가 필요합니다.');
  } catch { return setup(`Docker 엔진과 로컬 이미지 ${image}를 준비하세요. 앱은 이미지를 자동 다운로드하지 않습니다.`); }
  await workspace.grant(projectId, grantId);
  const parent = await realpath(tmpdir()), root = await mkdtemp(join(parent, 'cw-docker-'));
  const input = join(root, 'input');
  const name = 'cw-test-' + randomUUID();
  let launched = false;
  try {
    await mkdir(input);
    const tree = await workspace.tree(projectId);
    if (tree.omitted) throw new Error('프로젝트가 격리 복사 범위를 넘었습니다. 일부만 검사하지 않고 중지합니다.');
    let bytes = 0;
    for (const row of tree.files.filter(row => row.type === 'file')) {
      signal?.throwIfAborted();
      const buffer = await workspace.read(projectId, row.path, {grantId, maxBytes:4_000_000});
      bytes += buffer.length;
      if (bytes > 32_000_000) throw new Error('격리 복사 크기 한도를 초과했습니다.');
      if (!buffer.includes(0) && secretFinding(buffer.toString('utf8'))) throw new Error('비밀값이 포함된 소스는 격리 복사 전에 정리하세요.');
      const target = join(input, row.path); await mkdir(dirname(target), {recursive:true}); await writeFile(target, buffer, {mode:0o644});
    }
    const mutationReport = environment?.TOWER_MUTATION_REPORT;
    if (mutationReport && !/^\.control-tower\/mutation-[a-f0-9-]{36}\.json$/.test(mutationReport)) throw new Error('격리 보고서 경로를 확인하지 못했습니다.');
    const command = options.testPlan?.runner === 'node-test' ? ['node', '--test', '--test-reporter=tap', ...options.testPlan.files] : ['npm', '--ignore-scripts', 'run', options.validationScript];
    const args = dockerArgs({name, image, input, command, report:Boolean(mutationReport), uid:process.getuid?.() ?? 1000, gid:process.getgid?.() ?? 1000});
    const startedAt = new Date().toISOString();
    onOutput?.({kind:'validation-start', command:'Docker · ' + command.join(' '), text:''});
    let result;
    try {
      launched = true;
      result = {...await exec(docker, args, {...hostOptions, signal, timeout:300000, maxBuffer:2_000_000}), code:0};
    } catch (error) {
      signal?.throwIfAborted();
      if (error.killed) return {configured:true, passed:false, backend:'docker', summary:'격리 실행 제한 시간 또는 출력 한도에 도달했습니다.'};
      result = { code:Number.isInteger(error.code) ? error.code : -1, stdout:error.stdout ?? '', stderr:error.stderr ?? '' };
    }
    signal?.throwIfAborted(); await workspace.grant(projectId, grantId);
    const reportLine = result.stdout.split('\n').findLast(line => line.startsWith(REPORT_MARKER));
    const output = redact(result.stdout.split('\n').filter(line => !line.startsWith(REPORT_MARKER)).join('\n') + '\n' + result.stderr).slice(-30000);
    onOutput?.({kind:'validation-output', text:output});
    if (mutationReport && result.code === 0) {
      if (!reportLine || reportLine.length > 710000) throw new Error('격리 변이 보고서가 없거나 크기 한도를 넘었습니다.');
      const report = Buffer.from(reportLine.slice(REPORT_MARKER.length), 'base64'); JSON.parse(report.toString('utf8'));
      await workspace.write(projectId, mutationReport, report, {internal:true, grantId, newOnly:true});
    }
    return validationResult({ code:result.code, output, testPlan:options.testPlan, command:'Docker · ' + command.join(' '), startedAt, backend:'docker' });
  } finally {
    if (launched) await exec(docker, ['rm', '--force', name], hostOptions).catch(() => {});
    const actual = await realpath(root).catch(() => null), part = actual && relative(parent, actual);
    if (actual && part && !isAbsolute(part) && !part.startsWith('..') && part.startsWith('cw-docker-')) await rm(actual, {recursive:true, force:true, maxRetries:5});
  }
}
