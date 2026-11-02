import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { terminateTree } from "./processes.js";
import { nativeEnvironment } from "./child-env.js";
import { nodeRuntime } from "./node-runtime.js";

export async function validateProject(
  workspace,
  { projectId, grantId, options, signal },
) {
  if (!options.validationScript)
    return {
      configured: false,
      passed: false,
      summary: "실행 검증 명령이 설정되지 않았습니다.",
    };
  if (
    options.allowExecution !== true ||
    !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,79}$/.test(options.validationScript)
  )
    throw new Error(
      "검증 명령 실행 동의와 유효한 npm 스크립트 이름이 필요합니다.",
    );
  const grant = await workspace.grant(projectId, grantId);
  const manifest = JSON.parse(
    (await workspace.read(projectId, "package.json", { grantId })).toString(),
  );
  if (typeof manifest.scripts?.[options.validationScript] !== "string")
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
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const windows = process.platform === "win32";
    const command = executable;
    const args = [npm, "--ignore-scripts", "run", options.validationScript];
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
      output = (output + chunk.toString())
        .slice(-30000)
        .replace(/sk-[A-Za-z0-9_-]+/g, "[보호된 키]");
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", () =>
      finish(new Error("검증 명령을 실행하지 못했거나 중지되었습니다.")),
    );
    child.once("close", (code) => {
      if (!stopping)
        finish(null, {
          configured: true,
          passed: code === 0,
          exitCode: code,
          summary:
            code === 0
              ? "사용자가 지정한 검증 명령을 통과했습니다."
              : "검증 명령이 실패했습니다.",
          output,
        });
    });
  });
}
