import { spawn } from "node:child_process";
import { access, lstat, readdir, readFile, realpath } from "node:fs/promises";
import { parseEnv } from "node:util";
import { join, dirname } from "node:path";
import { terminateTree } from "./processes.js";
import { projectEnvironment } from "./child-env.js";
import { redact } from "./secrets.js";
import { nodeRuntime } from "./node-runtime.js";
import { validateInDocker } from './docker-execution.js';
import { validationResult } from './validation-result.js';

async function projectSecretValues(root) {
  const values = new Set();
  const entries = await readdir(root).catch(() => []);
  for (const name of entries.filter((entry) => /^\.env(?:\.[\w.-]+)?$/i.test(entry)).slice(0, 20)) {
    const path = join(root, name);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.nlink !== 1 || info.size > 128 * 1024) continue;
      for (const value of Object.values(parseEnv(await readFile(path, "utf8"))))
        if (value.length >= 8) values.add(value);
    } catch {}
  }
  return [...values].sort((a, b) => b.length - a.length);
}

export async function validateProject(
  workspace,
  { projectId, grantId, options, signal, onOutput, environment },
) {
  const testPlan = options.testPlan;
  if (!options.validationScript && !testPlan)
    return {
      configured: false,
      passed: false,
      summary: "실행 검증 명령이 설정되지 않았습니다.",
    };
  if (options.allowExecution !== true)
    return {
      configured: true,
      passed: false,
      requiresConsent: true,
      summary:
        "테스트 코드는 준비됐습니다. 설정에서 프로젝트 코드 실행에 동의한 뒤 테스트를 실행하세요.",
    };
  const direct = testPlan?.runner === "node-test";
  if (
    !direct &&
    !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,79}$/.test(options.validationScript)
  )
    throw new Error(
      "검증 명령 실행 동의와 유효한 npm 스크립트 이름이 필요합니다.",
    );
  const grant = await workspace.grant(projectId, grantId);
  let manifest;
  if (!direct) {
    try {
      manifest = JSON.parse(
        (
          await workspace.read(projectId, "package.json", { grantId })
        ).toString(),
      );
    } catch {
      return {
        configured: true,
        passed: false,
        summary:
          "package.json을 읽지 못했습니다. 테스트 역할을 선택하거나 실행할 npm 스크립트를 확인하세요.",
      };
    }
  }
  if (
    !direct &&
    typeof manifest.scripts?.[options.validationScript] !== "string"
  )
    return {
      configured: true,
      passed: false,
      summary: `package.json에 ${options.validationScript} 스크립트가 없습니다.`,
    };
  if (testPlan) for (const file of testPlan.files) {
    if (!/^tests?\//.test(file)) throw new Error('허용되지 않은 테스트 파일 경로입니다.');
    await workspace.read(projectId, file, {grantId});
  }
  if (options.executionBackend === 'docker') return validateInDocker(workspace, {projectId, grantId, options, signal, onOutput, environment});
  const executable = await nodeRuntime(grant.root);
  if (!executable)
    return {
      configured: true,
      passed: false,
      summary: "검증을 실행하려면 이 PC에 Node.js와 npm을 설치하세요.",
    };
  let npm;
  if (!direct) {
    const bin = dirname(await realpath(executable));
    const candidates = [
      join(bin, "node_modules", "npm", "bin", "npm-cli.js"),
      join(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
      join(bin, "..", "share", "nodejs", "npm", "bin", "npm-cli.js"),
    ];
    for (const candidate of candidates) {
      if (await access(candidate).then(() => true, () => false)) {
        npm = candidate;
        break;
      }
    }
    if (!npm) return { configured: true, passed: false, summary: "신뢰할 수 있는 Node.js 설치에서 npm을 찾지 못했습니다." };
  }
  if (testPlan)
    for (const file of testPlan.files) {
      if (!/^tests?\//.test(file))
        throw new Error("허용되지 않은 테스트 파일 경로입니다.");
      await workspace.read(projectId, file, { grantId });
    }
  const args = direct
    ? ["--test", "--test-reporter=tap", ...testPlan.files]
    : [npm, "--ignore-scripts", "run", options.validationScript];
  const commandDisplay = direct
    ? `node ${args.join(" ")}`
    : `npm --ignore-scripts run ${options.validationScript}`;
  const secretValues = await projectSecretValues(grant.root);
  const startedAt = new Date().toISOString();
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const windows = process.platform === "win32";
    const command = executable;
    const child = spawn(command, args, {
      cwd: grant.root,
      env: projectEnvironment(environment),
      windowsHide: true,
      shell: false,
      detached: !windows,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let rawOutput = "", outputOverflow = false,
      output = "",
      settled = false,
      stopping = false;
    const abort = () => {
      stopping = true;
      void terminateTree(child).then(() =>
        finish(new Error("검증 실행을 중지했습니다.")),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => {
      stopping = true;
      void terminateTree(child).then(() =>
        finish(null, {
          configured: true,
          passed: false,
          summary: "검증 실행 제한 시간에 도달했습니다.",
          output,
        }),
      );
    }, 300000);
    const capture = (chunk) => {
      if (outputOverflow) return;
      rawOutput += chunk.toString();
      if (rawOutput.length > 2_000_000) { rawOutput = ""; outputOverflow = true; }
    };
    const publishOutput = () => {
      output = outputOverflow ? "출력이 검증 한도를 초과했습니다." :
        redact(secretValues.reduce((text, value) => text.replaceAll(value, "[보호된 비밀값]"), rawOutput)).slice(-30000);
      if (output) onOutput?.({ kind: "validation-output", text: output });
    };
    child.once("spawn", () =>
      onOutput?.({
        kind: "validation-start",
        text: "",
        command: commandDisplay,
      }),
    );
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", () =>
      finish(new Error("검증 명령을 실행하지 못했거나 중지되었습니다.")),
    );
    child.once("close", (code) => {
      if (!stopping) {
        publishOutput();
        finish(null, validationResult({code, output, overflow:outputOverflow, testPlan, command:commandDisplay, startedAt}));
      }
    });
  });
}
