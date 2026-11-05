import { redact } from "./secrets.js";
import { randomUUID } from "node:crypto";
import { SLOT_IDS, PROVIDERS, validateTeam, teamFor } from "./team.js";
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
  async updateHistory(projectId, id, action) {
    if (!["archive", "restore", "delete"].includes(action)) throw new Error("기록 작업을 확인하세요.");
    return this.mutate(async () => {
      const data = await this.read(projectId, id);
      const index = await this.index();
      const previous = structuredClone(index);
      const row = index.items.find((item) => item.id === id);
      index.managed ??= {};
      index.managed[projectId] = true;
      if (action === "delete") index.items = index.items.filter((item) => item.id !== id);
      else if (action === "archive") row.archived = true;
      else delete row.archived;
      if (action !== "restore" && index.active[projectId] === id)
        index.active[projectId] = index.items.find((item) => item.projectId === projectId && !item.archived)?.id ?? null;
      await this.store.write("conversation-index", index);
      if (action === "delete") {
        try { await this.store.remove(`conversation-${data.id}`); }
        catch (error) {
          await this.store.write("conversation-index", previous);
          throw error;
        }
      }
      return index;
    });
  }
  async markdown(projectId, id, run) {
    const chat = await this.read(projectId, id);
    const lines = ["# " + chat.title, "", "## 대화"];
    for (const item of chat.messages)
      lines.push("", `### ${item.at} · ${item.agentId} · ${item.role}`, "", item.content);
    if (run && run.id === chat.runId) {
      lines.push("", "## 실행 요약", "", `상태: ${run.status}`, `수정 횟수: ${run.round}`);
      for (const event of (run.events ?? []).slice(-150)) lines.push(`- ${event.at} · ${event.actor} · ${event.message}`);
    }
    return redact(lines.join("\n")) + "\n";
  }
  async select(projectId, id) {
    return this.mutate(async () => {
      const data = await this.read(projectId, id);
      const index = await this.index();
      if (index.items.find((row) => row.id === id)?.archived) throw new Error("보관된 대화를 먼저 다시 열어 주세요.");
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
  async setRouting(projectId, id, options, usage) {
    const team = validateTeam(options.team);
    teamFor({ team, runtimeRoutes: options.runtimeRoutes });
    return this.mutate(async () => {
      const data = await this.read(projectId, id);
      data.routing = { teamKey: JSON.stringify(team), team,
        runtimeRoutes: structuredClone(options.runtimeRoutes ?? {}),
        ...(usage ? { usage: structuredClone(usage) } : {}) };
      await this.store.write(`conversation-${id}`, data);
      return data.routing;
    });
  }
}
