import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { terminateTree } from "./processes.js";
import { nativeEnvironment } from "./child-env.js";
import { nodeRuntime } from "./node-runtime.js";

export async function validateProject(
  workspace,
  { projectId, grantId, options, signal, onOutput },
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
  const executable = await nodeRuntime(grant.root);
  if (!executable)
    return {
      configured: true,
      passed: false,
      summary: "검증을 실행하려면 이 PC에 Node.js와 npm을 설치하세요.",
    };
  const npm = join(
    dirname(executable),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
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
  const startedAt = new Date().toISOString();
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const windows = process.platform === "win32";
    const command = executable;
    const child = spawn(command, args, {
      cwd: grant.root,
      env: nativeEnvironment(),
      windowsHide: true,
      shell: false,
      detached: !windows,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
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
      const delta = chunk
        .toString()
        .replace(/sk-[A-Za-z0-9_-]+/g, "[보호된 키]");
      output = (output + chunk.toString())
        .slice(-30000)
        .replace(/sk-[A-Za-z0-9_-]+/g, "[보호된 키]");
      onOutput?.({
        kind: "validation-output",
        text: delta.slice(-5000),
      });
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
        const observed = [
          ...output.matchAll(/^(not ok|ok)\s+\d+\s+-\s+([^\r\n]+)/gm),
        ].map((match) => ({
          passed: match[1] === "ok" && !/\s#\s*(?:SKIP|TODO)\b/i.test(match[2]),
          skipped: /\s#\s*(?:SKIP|TODO)\b/i.test(match[2]),
          name: match[2],
        }));
        const cases = (testPlan?.cases ?? []).map((row) => {
          const matches = observed.filter(
            (item) =>
              item.name === row.id ||
              item.name.startsWith(row.id + " ") ||
              item.name.startsWith(row.id + ":"),
          );
          return {
            id: row.id,
            title: row.title,
            status: !matches.length
              ? "not-observed"
              : matches.some((item) => !item.passed && !item.skipped)
                ? "failed"
                : matches.some((item) => item.skipped)
                  ? "skipped"
                  : "passed",
          };
        });
        const complete = cases.every((row) => row.status === "passed");
        finish(null, {
          configured: true,
          passed: code === 0 && complete,
          exitCode: code,
          summary:
            code === 0 && complete
              ? "사용자가 지정한 검증 명령을 통과했습니다."
              : code === 0
                ? "명령은 종료했지만 계획한 테스트 일부가 생략됐거나 실행을 확인하지 못했습니다."
                : "검증 명령이 실패했습니다.",
          output,
          command: commandDisplay,
          startedAt,
          finishedAt: new Date().toISOString(),
          cases,
        });
      }
    });
  });
}
