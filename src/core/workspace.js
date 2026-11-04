import {
  realpath,
  lstat,
  stat,
  mkdir,
  readdir,
  readFile,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { resolve, relative, join, isAbsolute, parse, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID, createHash } from "node:crypto";
import { deviceBinding } from "./device-binding.js";

const SKIP = new Set([
  "node_modules",
  ".git",
  ".control-tower",
  ".runtime",
  ".tools",
  ".codex",
  ".claude",
  ".gemini",
  ".cursor",
  ".ssh",
  ".aws",
  ".azure",
  "release",
  "dist",
  "target",
  ".next",
  ".venv",
  "venv",
  "artifacts",
]);
const PRIVATE =
  /^(\.env(?:\..*)?|vault(?:\..*)?\.enc|credentials(?:\..*)?|auth\.json|oauth_creds\.json|secrets?(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.gitconfig|\.gitmodules|id_(?:rsa|ed25519)(?:\..*)?|.*\.(?:pem|key|pfx))$/i;
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");

export function relativeFile(value, internal = false) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 500 ||
    isAbsolute(value) ||
    /[\x00-\x1f:]/.test(value) ||
    /^[\\/]/.test(value)
  )
    throw new Error("프로젝트 안의 상대 경로가 필요합니다.");
  const parts = value.replaceAll("\\", "/").split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[. ]$/.test(part) ||
        /[<>"|?*]/.test(part) ||
        /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part) ||
        PRIVATE.test(part) ||
        [
          ".git",
          ".runtime",
          ".codex",
          ".claude",
          ".gemini",
          ".cursor",
          ".ssh",
          ".aws",
          ".azure",
        ].includes(part.toLowerCase()) ||
        (!internal && part.toLowerCase() === ".control-tower"),
    )
  )
    throw new Error("허용되지 않은 파일 경로입니다.");
  return parts;
}
export function inside(root, target) {
  const path = relative(root, target);
  return (
    path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
  );
}

export class Workspace {
  constructor(projects, identity = deviceBinding) {
    this.projects = projects;
    this.identity = identity;
    this.tickets = new Map();
    this.queues = new Map();
  }
  async privateRoot() {
    if (!this.projects.store?.directory) return null;
    return (this.privateDirectory ??= await realpath(
      this.projects.store.directory,
    ));
  }
  async prepare(projectId, folder) {
    if (projectId !== null)
      this.projects.find(await this.projects.list(), projectId);
    const root = await realpath(folder);
    const privateRoot = await this.privateRoot();
    if (privateRoot && inside(privateRoot, root))
      throw new Error(
        "앱의 대화·인증 데이터 폴더는 작업 폴더로 사용할 수 없습니다.",
      );
    const info = await stat(root);
    if (!info.isDirectory() || root === parse(root).root)
      throw new Error("드라이브 전체 대신 프로젝트 폴더를 선택하세요.");
    const ticket = randomUUID();
    this.tickets.set(ticket, {
      projectId,
      root,
      dev: String(info.dev),
      ino: String(info.ino),
      createdAt: Date.now(),
    });
    return { ticket, root, projectId };
  }
  async consent(projectId, ticket, consent) {
    const pending = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (
      !pending ||
      pending.projectId !== projectId ||
      Date.now() - pending.createdAt > 10 * 60 * 1000 ||
      consent !== true
    )
      throw new Error("폴더 동의가 완료되지 않았습니다. 다시 선택하세요.");
    const info = await stat(pending.root);
    if (
      (await realpath(pending.root)) !== pending.root ||
      String(info.dev) !== pending.dev ||
      String(info.ino) !== pending.ino
    )
      throw new Error("선택한 폴더가 바뀌었습니다. 다시 선택하세요.");
    const grant = {
      root: pending.root,
      dev: pending.dev,
      ino: pending.ino,
      deviceBinding: await this.identity(),
      grantId: randomUUID(),
      consentedAt: new Date().toISOString(),
    };
    if (projectId === null) {
      const name = pending.root
        .split(/[\\/]/)
        .filter(Boolean)
        .at(-1)
        .slice(0, 80);
      return this.projects.create(name, grant);
    }
    return this.projects.grant(projectId, grant);
  }
  async grant(projectId, expectedGrantId) {
    const data = await this.projects.list();
    const project = this.projects.find(data, projectId);
    const grant = project.workspace;
    if (!grant || (expectedGrantId && grant.grantId !== expectedGrantId))
      throw new Error("프로젝트 폴더 접근이 해제되었거나 변경되었습니다.");
    if (grant.deviceBinding !== (await this.identity()))
      throw new Error(
        "이 PC·OS 사용자에게 승인된 폴더가 아닙니다. 폴더를 다시 연결하고 동의하세요.",
      );
    let info, root;
    try {
      root = await realpath(grant.root);
      info = await stat(root);
    } catch {
      throw new Error(
        "작업 폴더에 접근할 수 없습니다. 폴더 위치와 권한을 확인하세요.",
      );
    }
    if (
      root !== grant.root ||
      String(info.dev) !== grant.dev ||
      String(info.ino) !== grant.ino
    )
      throw new Error(
        "작업 폴더가 교체되었습니다. 폴더를 다시 선택하고 동의하세요.",
      );
    return grant;
  }
  async locate(
    projectId,
    file,
    { internal = false, create = false, grantId } = {},
  ) {
    const grant = await this.grant(projectId, grantId);
    const parts = relativeFile(file, internal);
    let target = grant.root;
    for (let index = 0; index < parts.length; index++) {
      target = join(target, parts[index]);
      const privateRoot = await this.privateRoot();
      if (privateRoot && inside(privateRoot, target))
        throw new Error(
          "앱의 대화·설정 데이터에는 프로젝트 작업으로 접근할 수 없습니다.",
        );
      try {
        const info = await lstat(target);
        if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1))
          throw new Error(
            "심볼릭 링크·정션·하드 링크를 통해 접근할 수 없습니다.",
          );
        if (index < parts.length - 1 && !info.isDirectory())
          throw new Error("파일 경로의 상위 항목이 폴더가 아닙니다.");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (create && index < parts.length - 1) await mkdir(target);
        else if (index < parts.length - 1) throw error;
      }
    }
    if (!inside(grant.root, target))
      throw new Error("프로젝트 폴더 밖에는 접근할 수 없습니다.");
    return { target, grant };
  }
  serialize(projectId, action) {
    const operation = (this.queues.get(projectId) ?? Promise.resolve()).then(
      action,
    );
    this.queues.set(
      projectId,
      operation.catch(() => {}),
    );
    return operation;
  }
  async read(projectId, file, options = {}) {
    const { target } = await this.locate(projectId, file, options);
    const info = await stat(target);
    const limit = options.maxBytes ?? 2 * 1024 * 1024;
    if (!info.isFile() || info.size > limit)
      throw new Error("파일이 미리보기 처리 한도를 초과했습니다.");
    return readFile(target);
  }
  async write(projectId, file, content, options = {}) {
    return this.serialize(projectId, () => this.writeUnlocked(projectId, file, content, options));
  }
  async writeUnlocked(projectId, file, content, options = {}) {
      const { target, grant } = await this.locate(projectId, file, {
        ...options,
        create: true,
      });
      let current = null;
      try {
        current = await readFile(target);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const hash = current === null ? null : digest(current);
      if (Object.hasOwn(options, "baseHash") && options.baseHash !== hash)
        throw new Error(`파일이 외부에서 변경되었습니다: ${file}`);
      if (options.newOnly && current !== null)
        throw new Error(`이미 존재하는 파일입니다: ${file}`);
      const temporary = `${target}.${randomUUID()}.tmp`;
      let handle;
      try {
        handle = await open(temporary, "wx", 0o600);
        await handle.writeFile(content);
        await handle.close();
        handle = null;
        for (let attempt = 0; ; attempt++) {
          await this.locate(projectId, file, { ...options, grantId: grant.grantId });
          const latest = await readFile(target).catch((error) => {
            if (error.code !== "ENOENT") throw error;
            return null;
          });
          if ((latest === null ? null : digest(latest)) !== hash)
            throw new Error(`파일이 외부에서 변경되었습니다: ${file}`);
          try {
            await rename(temporary, target);
            break;
          } catch (error) {
            if (process.platform !== "win32" || !["EPERM", "EBUSY", "EACCES"].includes(error.code) || attempt >= 5)
              throw error;
            await delay(25 * (attempt + 1));
          }
        }
      } finally {
        await handle?.close();
        await rm(temporary, { force: true });
      }
      return { path: file, hash: digest(content), absolutePath: target };
  }
  async tree(projectId) {
    const grant = await this.grant(projectId);
    const files = [];
    let omitted = 0;
    const walk = async (directory, prefix, depth) => {
      if (depth > 12) {
        omitted++;
        return;
      }
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (SKIP.has(entry.name.toLowerCase()) || PRIVATE.test(entry.name))
          continue;
        const privateRoot = await this.privateRoot();
        if (privateRoot && inside(privateRoot, join(directory, entry.name)))
          continue;
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (files.length >= 500) {
          omitted++;
          continue;
        }
        const info = await lstat(join(directory, entry.name));
        if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1))
          continue;
        if (info.isDirectory()) {
          files.push({ path, type: "directory" });
          await walk(join(directory, entry.name), path, depth + 1);
        } else if (info.isFile())
          files.push({ path, type: "file", size: info.size });
      }
    };
    await walk(grant.root, "", 0);
    await this.grant(projectId, grant.grantId);
    return { root: grant.root, grantId: grant.grantId, files, omitted };
  }
  async snapshot(projectId) {
    const tree = await this.tree(projectId);
    const files = [];
    const omitted = [];
    let size = 0;
    for (const entry of tree.files.filter((entry) => entry.type === "file")) {
      if (
        !/\.(?:[cm]?[jt]sx?|json|md|html|css|scss|py|rs|go|toml|yaml|yml|txt|svg|sql)$/i.test(
          entry.path,
        ) ||
        /(?:^|\/)(?:package-lock|yarn\.lock|pnpm-lock)/.test(entry.path)
      )
        continue;
      if (entry.size > 200000 || size + entry.size > 500000) {
        omitted.push(entry.path);
        continue;
      }
      const buffer = await this.read(projectId, entry.path, {
        grantId: tree.grantId,
      });
      if (buffer.includes(0)) {
        omitted.push(entry.path);
        continue;
      }
      files.push({
        path: entry.path,
        content: buffer.toString("utf8"),
        hash: digest(buffer),
      });
      size += buffer.length;
    }
    return {
      root: tree.root,
      grantId: tree.grantId,
      files,
      omitted,
      truncated: tree.omitted > 0 || omitted.length > 0,
      hash: digest(JSON.stringify(files.map((file) => [file.path, file.hash]))),
    };
  }
}
