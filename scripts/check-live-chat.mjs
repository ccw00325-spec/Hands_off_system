import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/core/store.js";
import { Projects } from "../src/core/projects.js";
import { Workspace } from "../src/core/workspace.js";
import { Conversations } from "../src/core/conversations.js";
import { AgentChat } from "../src/core/agent-chat.js";
import { Workflow } from "../src/core/workflow.js";
import { roleProviders } from "../src/core/roles.js";
import { CodexConnection } from "../src/core/codex.js";
import { GPTProvider } from "../src/core/providers.js";
const directory = resolve("artifacts", "live-chat-" + randomUUID());
await mkdir(directory, { recursive: true });
const root = join(directory, "project");
await mkdir(root);
await writeFile(
  join(root, "README.md"),
  "A local timer module for connection verification. No external network features.",
);
const store = new Store(join(directory, "data"), {});
await store.init();
const projects = new Projects(store),
  workspace = new Workspace(projects),
  id = (await projects.list()).activeId;
const ticket = await workspace.prepare(id, root);
await workspace.consent(id, ticket.ticket, true);
const conversations = new Conversations(store, projects);
const native = new CodexConnection(store.directory);
let chat;
try {
  const models = await native.models();
  const model = models.find((row) => /luna/.test(row.id)) ?? models[0];
  const options = {
    team: [
      { id: "gpt", provider: "gpt", roles: ["control", "debug"] },
      { id: "grok", provider: "gpt", roles: ["feature", "ui"] },
    ],
    gptSource: "codex",
    gptModel: model.id,
  };
  const workflow = new Workflow(
    workspace,
    roleProviders({
      gpt: new GPTProvider(null, resolve("src/skills/fun.md"), native),
    }),
  );
  chat = new AgentChat({
    conversations,
    workspace,
    workflow,
    optionsFor: async () => options,
  });
  const conversation = await conversations.create(id);
  for (const actor of ["gpt", "grok"]) {
    await chat.send(
      id,
      conversation.id,
      actor,
      "README에 적힌 앱의 목적을 한 문장으로 설명해 주세요.",
      "question",
    );
    await chat.pending.get(id + ":" + actor).promise;
  }
  const saved = await conversations.read(id, conversation.id);
  const replies = saved.messages.filter((row) => row.role === "assistant");
  const report = {
    passed:
      replies.length === 2 &&
      saved.messages.every((row) => row.status !== "error"),
    model: model.id,
    independentPanels: ["gpt", "grok"],
    messageCount: saved.messages.length,
    replies: replies.map((row) => ({
      panel: row.agentId,
      characters: row.content.length,
    })),
    filesModified: false,
    executionConsent: false,
  };
  await writeFile(
    resolve("artifacts/live-chat-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
} finally {
  chat?.close();
  native.close();
}
