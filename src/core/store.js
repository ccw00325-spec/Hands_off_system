import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function atomicWrite(path, content) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export class Store {
  constructor(directory, encryption) {
    this.directory = directory;
    this.encryption = encryption;
    this.queue = Promise.resolve();
  }
  async init() { await mkdir(this.directory, { recursive: true }); }
  async read(name, fallback) {
    try { return JSON.parse(await readFile(join(this.directory, `${name}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  }
  async write(name, value) { await atomicWrite(join(this.directory, `${name}.json`), JSON.stringify(value, null, 2)); }
  available() {
    return this.encryption.isEncryptionAvailable() && this.encryption.getSelectedStorageBackend?.() !== 'basic_text';
  }
  async secrets() {
    let buffer;
    try { buffer = await readFile(join(this.directory, 'vault.enc')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
    if (!this.available()) throw new Error('OS 보안 저장소를 사용할 수 없습니다. 인증정보를 읽지 않았습니다.');
    return JSON.parse(this.encryption.decryptString(buffer));
  }
  mutateSecrets(change) {
    const operation = this.queue.then(async () => {
      if (!this.available()) throw new Error('OS 보안 저장소를 사용할 수 없어 저장을 중단했습니다.');
      const value = await this.secrets();
      const result = await change(value);
      await atomicWrite(join(this.directory, 'vault.enc'), this.encryption.encryptString(JSON.stringify(value)));
      return result;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
