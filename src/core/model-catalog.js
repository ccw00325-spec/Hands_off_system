import { validateModelId } from "./team.js";
import { publicError } from "./http.js";
export const MODEL_PROVIDERS = ["gpt", "claude", "grok", "gemini"];
export class ModelCatalog {
  constructor(loaders, { timeout = 60000, notify = () => {} } = {}) {
    this.loaders = loaders;
    this.timeout = timeout;
    this.notify = notify;
    this.entries = {};
    this.pending = new Map();
    this.generations = new Map();
  }
  snapshot() {
    return structuredClone(
      Object.fromEntries(
        MODEL_PROVIDERS.map((id) => [
          id,
          this.entries[id] ?? {
            state: "pending",
            rows: [],
            message: "시작 준비 중",
          },
        ]),
      ),
    );
  }
  rows(provider) {
    return structuredClone(this.entries[provider]?.rows ?? []);
  }
  invalidate(provider) {
    this.generations.set(provider, (this.generations.get(provider) ?? 0) + 1);
    this.pending.delete(provider);
    this.entries[provider] = {
      state: "pending",
      rows: [],
      message: "변경된 계정의 모델을 확인하는 중",
    };
    this.notify(this.snapshot());
  }
  refresh(provider) {
    if (!MODEL_PROVIDERS.includes(provider))
      throw new Error("알 수 없는 AI입니다.");
    if (this.pending.has(provider)) return this.pending.get(provider);
    const generation = (this.generations.get(provider) ?? 0) + 1;
    this.generations.set(provider, generation);
    this.entries[provider] = {
      ...this.entries[provider],
      state: "loading",
      rows: this.rows(provider),
      message: "모델 목록을 준비하는 중",
    };
    this.notify(this.snapshot());
    const promise = (async () => {
      let timer, entry;
      try {
        const loaded = await Promise.race([
          Promise.resolve().then(() => this.loaders[provider]()),
          new Promise((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    "모델 목록 확인 시간이 초과되었습니다. 계정 연결에서 다시 확인하세요.",
                  ),
                ),
              this.timeout,
            );
          }),
        ]);
        const raw = Array.isArray(loaded) ? loaded : loaded.rows;
        if (!Array.isArray(raw))
          throw new Error("모델 목록 형식을 확인하지 못했습니다.");
        const seen = new Set(),
          rows = [];
        for (const row of raw.slice(0, 300)) {
          try {
            validateModelId(row?.id);
          } catch {
            continue;
          }
          if (seen.has(row.id)) continue;
          seen.add(row.id);
          rows.push({
            id: row.id,
            name: String(row.name ?? row.id).slice(0, 200),
          });
        }
        entry = {
          state: loaded?.state ?? (rows.length ? "ready" : "empty"),
          rows,
          message:
            loaded?.message ??
            (rows.length
              ? `${rows.length}개 모델 준비 완료`
              : "사용 가능한 모델이 없습니다."),
          checkedAt: new Date().toISOString(),
        };
      } catch (error) {
        entry = {
          state: "error",
          rows: [],
          message: publicError(error),
          checkedAt: new Date().toISOString(),
        };
      } finally {
        clearTimeout(timer);
      }
      if (this.generations.get(provider) === generation) {
        this.entries[provider] = entry;
        this.notify(this.snapshot());
      }
      return structuredClone(entry);
    })().finally(() => {
      if (this.pending.get(provider) === promise) this.pending.delete(provider);
    });
    this.pending.set(provider, promise);
    return promise;
  }
  async refreshAll(onProgress = () => {}) {
    let done = 0;
    await Promise.all(
      MODEL_PROVIDERS.map(async (id) => {
        await this.refresh(id);
        onProgress(++done, MODEL_PROVIDERS.length, id);
      }),
    );
    return this.snapshot();
  }
}
