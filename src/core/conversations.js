import { randomUUID } from "node:crypto";
import { SLOT_IDS, PROVIDERS } from "./team.js";
const validId = (id) => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id);
export class Conversations {
  constructor(store, projects) {
    this.store = store;
    this.projects = projects;
    this.queue = Promise.resolve();
  }
  async index() {
    return this.store.read("conversation-index", { items: [], active: {} });
  }
  mutate(action) {
    const operation = this.queue.then(action);
    this.queue = operation.catch(() => {});
    return operation;
  }
  async list() {
    const index = await this.index();
    return structuredClone(index);
  }
  async read(projectId, id) {
    this.projects.find(await this.projects.list(), projectId);
    if (!validId(id)) throw new Error("대화 ID가 올바르지 않습니다.");
    const row = (await this.index()).items.find(
      (row) => row.id === id && row.projectId === projectId,
    );
    if (!row) throw new Error("이 프로젝트의 대화를 찾지 못했습니다.");
    const data = await this.store.read(`conversation-${id}`, null);
    if (!data || data.projectId !== projectId)
      throw new Error("대화 기록을 읽지 못했습니다.");
    return data;
  }
  async create(projectId, title = "새 대화", runId = null) {
    return this.mutate(async () => {
      this.projects.find(await this.projects.list(), projectId);
      const index = await this.index();
      if (runId) {
        const old = index.items.find(
          (row) => row.projectId === projectId && row.runId === runId,
        );
        if (old) return this.read(projectId, old.id);
      }
      const now = new Date().toISOString();
      const row = {
        id: randomUUID(),
        projectId,
        title: String(title).trim().slice(0, 80) || "새 대화",
        createdAt: now,
        updatedAt: now,
        runId,
      };
      await this.store.write(`conversation-${row.id}`, {
        ...row,
        messages: [],
      });
      index.items.unshift(row);
      index.active[projectId] = row.id;
      await this.store.write("conversation-index", index);
      return { ...row, messages: [] };
    });
  }
  async select(projectId, id) {
    return this.mutate(async () => {
      const data = await this.read(projectId, id);
      const index = await this.index();
      index.active[projectId] = id;
      await this.store.write("conversation-index", index);
      return data;
    });
  }
  async active(projectId) {
    const index = await this.index();
    const id = index.active[projectId];
    return id ? this.read(projectId, id) : null;
  }
  async bind(projectId, id, runId) {
    if (!validId(runId)) throw new Error("작업 ID가 올바르지 않습니다.");
    return this.mutate(async () => {
      const data = await this.read(projectId, id);
      const index = await this.index();
      const row = index.items.find((row) => row.id === id);
      data.runId = runId;
      row.runId = runId;
      await this.store.write(`conversation-${id}`, data);
      await this.store.write("conversation-index", index);
      return data;
    });
  }
  async append(
    projectId,
    id,
    agentId,
    role,
    content,
    status = "complete",
    meta = {},
  ) {
    if (
      !SLOT_IDS.includes(agentId) ||
      !["user", "assistant", "system"].includes(role) ||
      typeof content !== "string" ||
      !content.trim() ||
      content.length > 30000
    )
      throw new Error("대화 내용 또는 담당 패널을 확인하세요.");
    return this.mutate(async () => {
      const data = await this.read(projectId, id);
      if (data.messages.length >= 2000)
        throw new Error(
          "이 대화의 기록이 많습니다. 새 대화를 만들어 계속하세요.",
        );
      const message = {
        id: randomUUID(),
        agentId,
        role,
        content: content.trim(),
        status,
        ...(Object.hasOwn(PROVIDERS, meta.provider)
          ? { provider: meta.provider }
          : {}),
        at: new Date().toISOString(),
      };
      data.messages.push(message);
      data.updatedAt = message.at;
      const index = await this.index();
      const row = index.items.find((row) => row.id === id);
      if (role === "user" && data.title === "새 대화") {
        data.title = content.trim().replace(/\s+/g, " ").slice(0, 60);
        row.title = data.title;
      }
      row.updatedAt = message.at;
      await this.store.write(`conversation-${id}`, data);
      await this.store.write("conversation-index", index);
      return message;
    });
  }
}
