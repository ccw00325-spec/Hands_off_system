import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { deviceBinding } from "./device-binding.js";

export async function atomicWrite(path, content) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export class Store {
  constructor(directory, encryption, identity = deviceBinding) {
    this.directory = directory;
    this.encryption = encryption;
    this.queue = Promise.resolve();
    this.identity = identity;
    this.securityNotice = null;
    this.foreignVault = null;
  }
  async init() {
    await mkdir(this.directory, { recursive: true });
  }
  async read(name, fallback) {
    try {
      return JSON.parse(
        await readFile(join(this.directory, `${name}.json`), "utf8"),
      );
    } catch (error) {
      if (error.code === "ENOENT") return fallback;
      throw error;
    }
  }
  async write(name, value) {
    await atomicWrite(
      join(this.directory, `${name}.json`),
      JSON.stringify(value, null, 2),
    );
  }
  async remove(name) {
    await rm(join(this.directory, `${name}.json`), { force: true });
  }
  available() {
    return (
      this.encryption.isEncryptionAvailable() &&
      this.encryption.getSelectedStorageBackend?.() !== "basic_text"
    );
  }
  async secrets() {
    let buffer;
    try {
      buffer = await readFile(join(this.directory, "vault.enc"));
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
    if (!this.available())
      throw new Error(
        "OS 보안 저장소를 사용할 수 없습니다. 인증정보를 읽지 않았습니다.",
      );
    let envelope;
    try {
      envelope = JSON.parse(buffer.toString("utf8"));
    } catch {}
    if (envelope?.version === 2) {
      if (envelope.binding !== (await this.identity())) {
        this.securityNotice =
          "다른 기기 또는 OS 계정의 저장된 인증은 재사용하지 않았습니다. 이 PC의 CLI 계정으로 연결하세요.";
        this.foreignVault = buffer;
        return {};
      }
      buffer = Buffer.from(envelope.encrypted, "base64");
    }
    try {
      return JSON.parse(this.encryption.decryptString(buffer));
    } catch {
      this.securityNotice =
        "저장된 인증을 현재 OS 계정에서 복원하지 못했습니다. 이 PC에서 다시 연결하세요.";
      this.foreignVault =
        envelope?.version === 2
          ? Buffer.from(JSON.stringify(envelope))
          : buffer;
      return {};
    }
  }
  mutateSecrets(change) {
    const operation = this.queue.then(async () => {
      if (!this.available())
        throw new Error("OS 보안 저장소를 사용할 수 없어 저장을 중단했습니다.");
      const value = await this.secrets();
      const result = await change(value);
      if (this.foreignVault) {
        await atomicWrite(
          join(this.directory, `vault.foreign.${randomUUID()}.enc`),
          this.foreignVault,
        );
        this.foreignVault = null;
      }
      await atomicWrite(
        join(this.directory, "vault.enc"),
        JSON.stringify({
          version: 2,
          binding: await this.identity(),
          encrypted: this.encryption
            .encryptString(JSON.stringify(value))
            .toString("base64"),
        }),
      );
      return result;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
