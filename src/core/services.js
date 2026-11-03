import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, delimiter, isAbsolute, join } from "node:path";
import { homedir, tmpdir, devNull } from "node:os";
import { randomUUID } from "node:crypto";
import { findExecutable } from "./providers.js";
import { nodeRuntime } from "./node-runtime.js";
import { nativeEnvironment } from "./child-env.js";
import { digest, relativeFile } from "./workspace.js";

const execute = promisify(execFile);
const services = ["github", "vercel", "supabase"];
const slug = /^[a-z0-9][a-z0-9-]{0,62}$/i;

export function repositoryName(title, id) {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 45)
    .replace(/-$/, "");
  return `${base || "hands-off-project"}-${id.slice(0, 8)}`;
}

async function commandFor(service) {
  const name = service === "github" ? "gh" : service;
  const executable = await findExecutable(name);
  if (executable) return [executable];
  if (service !== "vercel") return null;
  const node = await nodeRuntime();
  if (!node) return null;
  for (const root of (process.env.PATH ?? "")
    .split(delimiter)
    .filter(isAbsolute)) {
    const manifest = join(root, "node_modules", "vercel", "dist", "index.js");
    if (
      await access(manifest).then(
        () => true,
        () => false,
      )
    )
      return [node, manifest];
  }
  return null;
}

function serviceEnvironment() {
  const env = nativeEnvironment();
  for (const key of Object.keys(env))
    if (/^(?:GH_|VERCEL_|SUPABASE_)/i.test(key)) delete env[key];
  return env;
}

async function run(
  command,
  args,
  { cwd = homedir(), env = serviceEnvironment(), timeout = 25000 } = {},
) {
  const { stdout } = await execute(command[0], [...command.slice(1), ...args], {
    cwd,
    env,
    timeout,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

export class AuxiliaryServices {
  constructor(store, projects, workspace, notify) {
    Object.assign(this, { store, projects, workspace, notify });
    this.running = new Set();
  }

  async account(service, command) {
    if (service === "github")
      return run(command, [
        "api",
        "--hostname",
        "github.com",
        "user",
        "--jq",
        ".login",
      ]);
    if (service === "vercel") return run(command, ["whoami"]);
    await run(command, ["projects", "list", "--output", "json"]);
    return "연결됨";
  }

  async status(id) {
    const project = this.projects.find(await this.projects.list(), id);
    const accounts = Object.fromEntries(
      await Promise.all(
        services.map(async (service) => {
          const command = await commandFor(service);
          const account = command
            ? await this.account(service, command).catch(() => null)
            : null;
          return [service, { installed: Boolean(command), account }];
        }),
      ),
    );
    return {
      accounts,
      config: project.delivery ?? null,
      name: repositoryName(project.title, id),
      result: await this.store.read(`delivery-${id}`, null),
    };
  }

  async login(service) {
    if (!services.includes(service))
      throw new Error("지원하지 않는 서비스입니다.");
    const command = await commandFor(service);
    if (!command) throw new Error("공식 CLI를 설치하고 앱을 다시 열어 주세요.");
    const args =
      service === "github"
        ? [
            "auth",
            "login",
            "--hostname",
            "github.com",
            "--web",
            "--git-protocol",
            "https",
          ]
        : ["login"];
    // Login needs a visible console for official prompts and device codes.
    const quote = (value) => `'${value.replaceAll("'", "''")}'`;
    const script = `& ${[...command, ...args].map(quote).join(" ")}; Read-Host '로그인 창을 닫으려면 Enter'`;
    const shell = join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const launch = `$ErrorActionPreference = 'Stop'; Start-Process -FilePath ${quote(shell)} -ArgumentList @('-NoProfile','-EncodedCommand','${encoded}') -WindowStyle Normal`;
    try {
      await run(
        [shell],
        [
          "-NoProfile",
          "-EncodedCommand",
          Buffer.from(launch, "utf16le").toString("base64"),
        ],
      );
    } catch {
      throw new Error(
        "로그인 창을 열지 못했습니다. 공식 CLI로 로그인한 뒤 다시 확인하세요.",
      );
    }
    return true;
  }

  async save(id, input) {
    if (this.running.has(id)) throw new Error("자동 릴리스가 진행 중입니다.");
    const grant = await this.workspace.grant(id);
    const project = this.projects.find(await this.projects.list(), id);
    const github = input.github === true;
    const vercel = input.vercel === true;
    const name = String(input.name ?? "")
      .trim()
      .toLowerCase();
    const scope = String(input.scope ?? "").trim();
    const target = String(input.target ?? "").trim();
    if (
      (github && name && !slug.test(name)) ||
      (vercel && (!slug.test(scope) || !slug.test(target)))
    )
      throw new Error(
        "저장소 이름, Vercel 범위와 프로젝트 이름에 영문·숫자·하이픈을 사용하세요.",
      );
    const accounts = { github: project.delivery?.accounts.github };
    for (const service of ["github", "vercel"]) {
      if (!(service === "github" ? github : vercel)) continue;
      const command = await commandFor(service);
      accounts[service] =
        command && (await this.account(service, command).catch(() => null));
      if (!accounts[service])
        throw new Error(`${service} 로그인 상태를 확인하세요.`);
    }
    if (accounts.github && !slug.test(accounts.github))
      throw new Error("GitHub 계정을 확인할 수 없습니다.");
    const prior = project.delivery;
    const config = {
      revision: randomUUID(),
      grantId: grant.grantId,
      github,
      vercel,
      name,
      scope,
      target,
      production: input.production === true,
      accounts,
      repoId:
        prior?.grantId === grant.grantId &&
        prior?.name === name &&
        prior?.accounts.github === accounts.github
          ? prior.repoId
          : undefined,
      resolvedName:
        prior?.grantId === grant.grantId &&
        prior?.name === name &&
        prior?.accounts.github === accounts.github
          ? prior.resolvedName
          : undefined,
      lastCommit:
        prior?.grantId === grant.grantId &&
        prior?.name === name &&
        prior?.accounts.github === accounts.github
          ? prior.lastCommit
          : undefined,
    };
    await this.projects.mutate((data) => {
      if (this.running.has(id)) throw new Error("자동 릴리스가 진행 중입니다.");
      this.projects.find(data, id).delivery = config;
    });
    return config;
  }

  async publish(state, retry = false) {
    const id = state.projectId;
    const revision = state.options?.deliveryRevision;
    if (
      state.status !== "completed" ||
      !state.validation?.passed ||
      !revision ||
      this.running.has(id)
    )
      return;
    this.running.add(id);
    let temp;
    let result;
    const report = async (status, message) => {
      Object.assign(result, { status, message });
      await this.store.write(`delivery-${id}`, result);
      this.notify({
        type: "delivery",
        projectId: id,
        result: structuredClone(result),
      });
    };
    try {
      const project = this.projects.find(await this.projects.list(), id);
      const config = project.delivery;
      if (
        config?.revision !== revision ||
        config.grantId !== state.grantId ||
        (!config.github && !config.vercel)
      )
        return;
      const prior = await this.store.read(`delivery-${id}`, null);
      if (prior?.runId === state.id && !retry) return;
      result = prior?.runId === state.id ? prior : { runId: state.id };
      if (result.status === "completed") return;
      await report("running", "검증된 파일을 배포용으로 준비 중…");
      const snapshot = await this.workspace.snapshot(id);
      if (
        snapshot.grantId !== state.grantId ||
        snapshot.hash !== state.snapshotHash ||
        snapshot.truncated
      )
        throw new Error("검증 이후 파일이 달라졌습니다. 다시 검증하세요.");
      temp = await mkdtemp(join(tmpdir(), "hands-off-delivery-"));
      const files = snapshot.files.filter(
        (file) => !relativeFile(file.path).some((part) => part.startsWith(".")),
      );
      if (!files.length) throw new Error("배포할 검증 파일이 없습니다.");
      for (const file of files) {
        if (
          digest(file.content) !== file.hash ||
          /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:ghp_|github_pat_|sk-[A-Za-z0-9])[A-Za-z0-9_-]{16,}/.test(
            file.content,
          )
        )
          throw new Error(`배포할 수 없는 파일입니다: ${file.path}`);
        const target = join(temp, ...relativeFile(file.path));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.content, { flag: "wx" });
      }
      if (config.github && !result.github) {
        await this.workspace.grant(id, state.grantId);
        await report("running", "GitHub에 커밋·푸시 중…");
        result.github = await this.pushGitHub(
          id,
          config,
          temp,
          state.repositoryName || project.title,
        );
        await report("running", "GitHub 푸시 완료");
      }
      if (config.vercel && !result.vercel) {
        await this.workspace.grant(id, state.grantId);
        await report("running", "Vercel 배포 중…");
        const cli = await commandFor("vercel");
        if (
          !cli ||
          (await this.account("vercel", cli).catch(() => null)) !==
            config.accounts.vercel
        )
          throw new Error("저장한 Vercel 계정으로 로그인하세요.");
        const options = { cwd: temp, timeout: 10 * 60 * 1000 };
        try {
          await run(
            cli,
            [
              "link",
              "--yes",
              "--scope",
              config.scope,
              "--project",
              config.target,
            ],
            options,
          );
          const output = await run(
            cli,
            [
              "deploy",
              "--yes",
              "--scope",
              config.scope,
              ...(config.production ? ["--prod"] : []),
            ],
            options,
          );
          const url = output
            .split(/\s+/)
            .find((part) =>
              /^https:\/\/[a-z0-9-]+\.vercel\.app\/?$/i.test(part),
            );
          result.vercel = { url: url ?? null, production: config.production };
        } catch {
          throw new Error(
            "Vercel 배포에 실패했습니다. 프로젝트 범위와 Vercel 빌드 로그를 확인하세요.",
          );
        }
      }
      await report("completed", "자동 릴리스 완료");
    } catch (error) {
      if (result) await report("failed", error.message).catch(() => {});
    } finally {
      try {
        if (temp)
          await rm(temp, {
            recursive: true,
            force: true,
            maxRetries: 4,
            retryDelay: 150,
          });
      } finally {
        this.running.delete(id);
      }
    }
  }

  async pushGitHub(id, config, cwd, suggestedName) {
    const gh = await commandFor("github");
    const git = await findExecutable("git");
    if (
      !gh ||
      !git ||
      (await this.account("github", gh).catch(() => null)) !==
        config.accounts.github
    )
      throw new Error("Git과 저장한 GitHub 계정의 CLI 로그인이 필요합니다.");
    const name =
      config.resolvedName || config.name || repositoryName(suggestedName, id);
    const repo = `${config.accounts.github}/${name}`;
    const view = async () =>
      JSON.parse(
        await run(gh, [
          "repo",
          "view",
          repo,
          "--json",
          "id,isPrivate,nameWithOwner",
        ]),
      );
    try {
      if (!config.repoId) {
        await run(gh, ["repo", "create", repo, "--private"]);
        const created = await view();
        config.repoId = created.id;
        await this.projects.mutate((data) => {
          const stored = this.projects.find(data, id).delivery;
          if (stored?.revision !== config.revision)
            throw new Error("배포 설정이 변경됐습니다.");
          stored.repoId = created.id;
          stored.resolvedName = name;
        });
      }
      const current = await view();
      if (
        !current.isPrivate ||
        current.id !== config.repoId ||
        current.nameWithOwner.toLowerCase() !== repo.toLowerCase()
      )
        throw new Error("Unexpected repository identity");
      const token = await run(gh, [
        "auth",
        "token",
        "--hostname",
        "github.com",
      ]);
      const env = nativeEnvironment();
      for (const key of Object.keys(env))
        if (/^GIT_/i.test(key)) delete env[key];
      Object.assign(env, {
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: devNull,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
      });
      const url = `https://github.com/${repo}.git`;
      const gitRun = (...args) =>
        run([git], args, { cwd, env, timeout: 90000 });
      await gitRun("init", "--initial-branch=main", "--template=");
      let parent;
      if (await gitRun("ls-remote", url, "refs/heads/main")) {
        await gitRun("fetch", "--no-tags", url, "refs/heads/main");
        await gitRun("reset", "--soft", "FETCH_HEAD");
        parent = await gitRun("rev-parse", "HEAD");
      }
      await gitRun("add", "--all", "--", ".");
      // Compare the staged tree to the parent so retries do not create duplicate commits.
      if (await gitRun("status", "--porcelain")) {
        if (parent !== config.lastCommit)
          throw new Error("Unexpected remote revision");
        await gitRun(
          "-c",
          `user.name=${config.accounts.github}`,
          "-c",
          `user.email=${config.accounts.github}@users.noreply.github.com`,
          "commit",
          "-m",
          "Publish verified Hands off project",
        );
      }
      await gitRun("push", url, "HEAD:refs/heads/main");
      const commit = await gitRun("rev-parse", "HEAD");
      await this.projects.mutate((data) => {
        const stored = this.projects.find(data, id).delivery;
        if (stored?.revision === config.revision) stored.lastCommit = commit;
      });
      return {
        url: `https://github.com/${repo}`,
        commit,
      };
    } catch {
      throw new Error(
        "GitHub 푸시에 실패했습니다. 로그인, 저장소 이름 중복, 비공개 권한과 원격 변경을 확인하세요.",
      );
    }
  }
}
