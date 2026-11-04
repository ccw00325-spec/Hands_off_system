import {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  shell,
  session,
  dialog,
} from "electron";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Store } from "./core/store.js";
import { ChatGPTAuth, PLAN_SCOPE } from "./core/oauth.js";
import { ImageService } from "./core/images.js";
import { ClaudeConnection } from "./core/claude.js";
import { Projects } from "./core/projects.js";
import { publicError } from "./core/http.js";
import { Workspace } from "./core/workspace.js";
import { listCheckpoints, restoreCheckpoint, verifiedCheckpoint } from "./core/checkpoints.js";
import { Workflow } from "./core/workflow.js";
import { GPTProvider, ClaudeProvider } from "./core/providers.js";
import { CursorProvider } from "./core/cursor-provider.js";
import { CursorConnection } from "./core/cursor.js";
import { GeminiConnection, GeminiProvider } from "./core/gemini.js";
import { RoleAssignments, roleProviders } from "./core/roles.js";
import { validateProject } from "./core/validation.js";
import { PersistentSession } from "./core/session.js";
import { BrowserOpener } from "./core/browser.js";
import { CodexUsage, UsageService } from "./core/usage.js";
import { CodexConnection } from "./core/codex.js";
import { validateModelId } from "./core/team.js";
import { Preferences } from "./core/preferences.js";
import { Conversations } from "./core/conversations.js";
import { AgentChat } from "./core/agent-chat.js";
import { AuxiliaryServices } from "./core/services.js";

const directory = dirname(fileURLToPath(import.meta.url));
app.setName("CW_Handsoff_sys");
// Preserve the original install's sign-ins and projects when the product name changes.
if (app.isPackaged)
  app.setPath("userData", join(app.getPath("appData"), "agent-control-tower"));
const profileDirectory = app.commandLine.getSwitchValue("user-data-dir");
if (app.isPackaged && profileDirectory && isAbsolute(profileDirectory))
  app.setPath("userData", resolve(profileDirectory));
if (!app.isPackaged) app.setPath("userData", resolve(directory, "../.runtime"));
// This switch is for local automated tests only and never changes production authentication.
if (!app.isPackaged && process.env.TOWER_TEST_USER_DATA)
  app.setPath("userData", resolve(process.env.TOWER_TEST_USER_DATA));
const rendererPath = join(directory, "renderer/index.html");
const rendererURL = pathToFileURL(rendererPath).href;
let window,
  store,
  auth,
  images,
  claude,
  projects,
  workspace,
  workflow,
  grok,
  gemini,
  codex,
  roles,
  persistentSession,
  browser,
  usage;
let preferences, conversations, agentChat, auxiliary;
let restorePromise;
let gptRestoreState = null;
const once = new Set();
const allowedLinks = {
  keys: "https://platform.openai.com/api-keys",
  geminiKeys: "https://aistudio.google.com/apikey",
  usage: "https://platform.openai.com/usage",
  chatgpt: "https://chatgpt.com/#settings",
  claude: "https://code.claude.com/docs/en/setup",
  gemini: "https://geminicli.com/docs/",
  grok: "https://cursor.com/docs/cli/installation",
  cursorUsage: "https://cursor.com/dashboard?tab=usage",
  codex: "https://learn.chatgpt.com/docs/cli",
  claudeUsage: "https://claude.ai/settings/usage",
  grokUsage: "https://grok.com/?_s=usage",
  gptUsage: "https://chatgpt.com/#settings",
  codexUsage: "https://chatgpt.com/codex/settings/usage",
};

function notify(value) {
  if (window && !window.isDestroyed())
    window.webContents.send("tower:event", value);
}
function handle(channel, action) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame.url !== rendererURL
    )
      return { ok: false, error: "허용되지 않은 요청입니다." };
    try {
      return { ok: true, value: await action(...args) };
    } catch (error) {
      return { ok: false, error: publicError(error) };
    }
  });
}
async function exclusive(key, action) {
  if (once.has(key)) throw new Error("작업이 이미 진행 중입니다.");
  once.add(key);
  try {
    return await action();
  } finally {
    once.delete(key);
  }
}
function generateDesignImage(id, prompt, provider = "gpt", signal) {
  return exclusive("image", async () => {
          const grant = await workspace.grant(id);
          const result = await images.generate(prompt, provider, signal);
          signal?.throwIfAborted();
          const name = `${randomUUID()}.png`;
          const saved = await workspace.write(
            id,
            `design/${name}`,
            result.buffer,
            { grantId: grant.grantId, newOnly: true },
          );
          const index = await store.read("image-index", {});
          index[id] = {
            artifactId: name,
            path: saved.path,
            grantId: grant.grantId,
          };
          await store.write("image-index", index);
          return {
            dataUrl: result.dataUrl,
            artifactId: name,
            projectId: id,
            path: saved.path,
            hash: saved.hash,
          };
        });
}
async function executionOptions(id) {
  const current = await status();
  const settings = await preferences.get();
  const delivery = projects.find(await projects.list(), id).delivery;
  return {
    deliveryRevision: delivery?.revision,
    suggestRepositoryName:
      delivery?.github === true && !delivery.name && !delivery.resolvedName,
    maxRepairRounds: settings.maxRepairRounds,
    maxAgentCalls: settings.maxAgentCalls,
    maxConcurrentAgents: settings.maxConcurrentAgents,
    apiBudgetUsd: settings.apiBudgetUsd,
    apiInputRate: settings.apiInputRate,
    apiOutputRate: settings.apiOutputRate,
    apiRateModel: settings.apiRateModel,
    crossReview: true,
    designApproval: settings.designApproval,
    validationScript: settings.validationScript,
    allowExecution: settings.allowExecution,
    unattended: settings.unattended,
    funContract: true,
    team: await roles.getTeam(id),
    roles: await roles.get(id),
    gptSource: current.gpt.source,
    gptModel: current.gpt.modelId ?? "",
    grokRoute: await grok.selection(),
    geminiModel: (await store.read("gemini-model", {})).modelId ?? null,
  };
}
async function status() {
  const vault = await store.secrets();
  const accounts = (vault.accounts ?? []).map((account) => ({
    id: account.id,
    label: account.label,
    signedIn: Boolean(account.accessToken),
    planEnabled:
      Boolean(account.accessToken && account.scopes.includes(PLAN_SCOPE)) &&
      !(
        gptRestoreState?.accountId === account.id && !gptRestoreState.connected
      ),
    needsReconnect: Boolean(
      gptRestoreState?.accountId === account.id && !gptRestoreState.connected,
    ),
    active: account.id === vault.activeAccountId,
  }));
  const [claudeState, grokState, geminiState, codexState] = await Promise.all([
    claude.status(),
    grok.status(),
    gemini.status(),
    codex.status(),
  ]);
  const execution = await store.read("execution-config", {});
  const source =
    execution.gptSource ??
    (codexState.connected
      ? "codex"
      : accounts.some((account) => account.active && account.planEnabled)
        ? "api"
        : "codex");
  return {
    secureStorage: store.available(),
    appVersion: app.getVersion(),
    accounts,
    waiting: Boolean(auth.pending),
    image: {
      saved: Boolean(vault.imageKey),
      geminiSaved: Boolean(vault.geminiImageKey),
      verifiedAt: vault.imageKeyVerifiedAt ?? null,
    },
    claude: claudeState,
    grok: grokState,
    codex: codexState,
    gpt: {
      source,
      connected:
        source === "codex"
          ? codexState.connected
          : accounts.some((account) => account.active && account.planEnabled),
      modelId: execution.gptModel ?? null,
    },
    securityNotice: store.securityNotice,
    gemini: {
      ...geminiState,
      modelId: (await store.read("gemini-model", {})).modelId ?? null,
    },
    session: persistentSession.state(),
  };
}
async function restoreConnections() {
  if (restorePromise) return restorePromise;
  restorePromise = (async () => {
    const session = persistentSession.state();
    const vault = await store.secrets();
    const active = vault.accounts?.find(
      (account) => account.id === vault.activeAccountId,
    );
    let gpt = {
      configured: Boolean(active?.accessToken),
      connected: false,
      state: "not-connected",
    };
    if (active?.accessToken) {
      try {
        await auth.access({ forceRefresh: session.recheckRequired });
        gpt = { configured: true, connected: true, state: "connected" };
      } catch {
        gpt = {
          configured: true,
          connected: false,
          state: "verification-failed",
        };
      }
    }
    gptRestoreState = { ...gpt, accountId: active?.id };
    const [claudeState, grokState, geminiState, codexState] = await Promise.all(
      [
        claude.status({ force: true }),
        grok.status({ force: true }),
        gemini.status({ force: true }),
        codex.status({ force: true }),
      ],
    );
    const failed =
      gpt.state === "verification-failed" ||
      [claudeState, grokState, geminiState, codexState].some((item) =>
        ["unknown", "verification-failed"].includes(item.state),
      );
    if (!failed) await persistentSession.verified();
    const execution = await store.read("execution-config", {});
    if (execution.gptSource !== "api" && codexState.connected)
      gpt = {
        configured: true,
        connected: true,
        state: "connected",
        source: "codex",
      };
    return {
      gpt,
      codex: codexState,
      claude: claudeState,
      grok: grokState,
      gemini: geminiState,
      session: persistentSession.state(),
      browser: await browser.settings(),
    };
  })().finally(() => {
    restorePromise = null;
  });
  return restorePromise;
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  app.whenReady().then(async () => {
    try {
      store = new Store(app.getPath("userData"), safeStorage);
      await store.init();
      persistentSession = new PersistentSession(store);
      await persistentSession.open();
      browser = new BrowserOpener(store, (url) => shell.openExternal(url));
      codex = new CodexConnection(store.directory, notify, {
        open: (url) => browser.open(url),
      });
      auth = new ChatGPTAuth(
        store,
        (url) => browser.open(url),
        (event) => {
          if (event.type === "auth" && event.state === "connected")
            gptRestoreState = null;
          notify(event);
        },
      );
      images = new ImageService(store);
      claude = new ClaudeConnection(notify);
      projects = new Projects(store);
      workspace = new Workspace(projects);
      auxiliary = new AuxiliaryServices(store, projects, workspace, notify);
      preferences = new Preferences(store);
      conversations = new Conversations(store, projects);
      grok = new CursorProvider(
        store,
        notify,
        new CursorConnection(notify, {
          cwd: store.directory,
          open: (url) => browser.open(url),
        }),
      );
      gemini = new GeminiConnection(store.directory, notify, {
        open: (url) => browser.open(url),
        developmentRoot: !app.isPackaged
          ? resolve(directory, "../.tools/gemini")
          : null,
      });
      roles = new RoleAssignments(projects);
      const codexUsage = new CodexUsage((response) =>
        usage?.pushCodex(response),
      );
      usage = new UsageService({
        claude,
        codex: codexUsage,
        cwd: app.getPath("userData"),
        notify,
        auto: !(!app.isPackaged && process.env.TOWER_TEST_USER_DATA),
      });
      workflow = new Workflow(
        workspace,
        roleProviders({
          gpt: new GPTProvider(auth, join(directory, "skills/fun.md"), codex),
          grok,
          claude: new ClaudeProvider(claude),
          gemini: new GeminiProvider(gemini),
        }),
        (event) => {
          notify(event);
          if (event.type === "workflow")
            void agentChat?.finishedRun(event.state).catch(() => {});
          if (event.type === "workflow" && event.state.status === "completed")
            void auxiliary.publish(event.state).catch(() => {});
        },
        async (context) =>
          validateProject(workspace, {
            ...context,
            options: {
              ...context.options,
              allowExecution:
                context.options.allowExecution === true &&
                (await preferences.get()).allowExecution,
            },
          }),
      );
      workflow.designGenerator = generateDesignImage;
      agentChat = new AgentChat({
        conversations,
        workspace,
        workflow,
        optionsFor: async (id, conversationId) => {
          const active = workflow.runs.get(id)?.state;
          if (
            workflow.isActive(id) &&
            active?.options.conversationId === conversationId
          ) {
            const frozen = structuredClone(active.options);
            delete frozen.conversationHistory;
            return frozen;
          }
          return executionOptions(id);
        },
        notify,
      });
      session.defaultSession.setPermissionRequestHandler(
        (_webContents, _permission, callback) => callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      handle("tower:status", status);
      handle("tower:restore-connections", restoreConnections);
      handle("tower:activity", async () => {
        await persistentSession.touch();
        return persistentSession.state();
      });
      handle("tower:usage", () => usage.snapshot());
      handle("tower:refresh-usage", () => usage.refresh({ force: true }));
      handle("tower:poll-usage", () =>
        usage.auto ? usage.refresh() : usage.snapshot(),
      );
      handle("tower:browser-settings", () => browser.settings());
      handle("tower:set-browser", (preferred) =>
        browser.setPreferred(preferred),
      );
      handle("tower:login", (id) => exclusive("account", () => auth.start(id)));
      handle("tower:cancel-login", () => auth.cancel());
      handle("tower:select-account", (id) =>
        exclusive("account", () => auth.select(id)),
      );
      handle("tower:sign-out", () =>
        exclusive("account", () => auth.signOut()),
      );
      handle("tower:claude-login", (forceLogin) =>
        claude.connect({ forceLogin: forceLogin === true }),
      );
      handle("tower:grok-login", (forceLogin) =>
        grok.connect({ forceLogin: forceLogin === true }),
      );
      handle("tower:grok-models", () => grok.models({ force: true }));
      handle("tower:select-grok-model", (modelId) => grok.selectModel(modelId));
      handle("tower:gemini-login", () => gemini.connect());
      handle("tower:codex-login", (force) =>
        codex.connect({ forceLogin: force === true }),
      );
      handle("tower:set-gpt-source", (source) =>
        exclusive("gpt-config", async () => {
          if (!["api", "codex"].includes(source))
            throw new Error("GPT 연결 경로가 올바르지 않습니다.");
          const value = await store.read("execution-config", {});
          value.gptSource = source;
          delete value.gptModel;
          await store.write("execution-config", value);
          return value;
        }),
      );
      handle("tower:save-gpt-model", (model) =>
        exclusive("gpt-config", async () => {
          validateModelId(model);
          const value = await store.read("execution-config", {});
          value.gptModel = model;
          await store.write("execution-config", value);
          return value;
        }),
      );
      handle("tower:install-gemini", () => gemini.install());
      handle("tower:gemini-models", () => gemini.models({ force: true }));
      handle("tower:select-gemini-model", async (modelId) => {
        if (!(await gemini.models()).some((row) => row.id === modelId))
          throw new Error("현재 Gemini 목록의 모델을 선택하세요.");
        await store.write("gemini-model", { modelId });
        return { modelId };
      });
      handle("tower:roles", (id) => roles.get(id));
      handle("tower:set-roles", (id, value) => roles.set(id, value));
      handle("tower:team", (id) => roles.getTeam(id));
      handle("tower:set-team", (id, value) => roles.setTeam(id, value));
      const signIn = (provider) => {
        if (provider === "claude") return claude.login;
        if (provider === "grok") return grok.login;
        if (provider === "gemini") return gemini.login;
        if (provider === "codex") return codex.login;
        throw new Error("지원하지 않는 로그인 공급자입니다.");
      };
      handle("tower:login-browser", (provider) =>
        signIn(provider).openBrowser((url) => browser.open(url)),
      );
      handle("tower:login-code", (provider, code) =>
        signIn(provider).code(code),
      );
      handle("tower:cancel-cli-login", (provider) => signIn(provider).cancel());
      handle("tower:save-key", (key, provider) =>
        exclusive("key", () => images.saveKey(key, provider)),
      );
      handle("tower:remove-key", (provider) =>
        exclusive("key", () => images.removeKey(provider)),
      );
      handle("tower:projects", () => projects.list());
      handle("tower:services-status", (id) => auxiliary.status(id));
      handle("tower:services-result", (id) => auxiliary.result(id));
      handle("tower:services-answer", async (id, answer) => {
        const state = await workflow.current(id);
        if (
          !state ||
          !answer ||
          !(await auxiliary.publish(state, true, answer))
        )
          throw new Error("현재 완료 작업의 승인 요청을 다시 확인하세요.");
        return true;
      });
      handle("tower:services-login", (service) => auxiliary.login(service));
      handle("tower:services-save", (id, input) =>
        exclusive(`delivery:${id}`, () => auxiliary.save(id, input)),
      );
      handle("tower:services-retry", async (id) => {
        const prior = await auxiliary.result(id);
        if (!prior?.runId || !["failed", "running"].includes(prior.status))
          throw new Error("다시 시도할 릴리스가 없습니다.");
        const state = await workflow.current(id, prior.runId);
        if (state?.status !== "completed" || !state.options.deliveryRevision)
          throw new Error("자동 릴리스가 설정된 완료 작업이 필요합니다.");
        const config = projects.find(await projects.list(), id).delivery;
        if (config?.revision !== state.options.deliveryRevision)
          throw new Error(
            "설정이 변경됐습니다. 새 작업을 완료한 뒤 배포하세요.",
          );
        if (!(await auxiliary.publish(state, true)) && auxiliary.running.has(id))
          throw new Error("릴리스가 이미 진행 중입니다.");
        return true;
      });
      handle("tower:preferences", () => preferences.get());
      handle("tower:save-preferences", (value) =>
        exclusive("preferences", async () => {
          const saved = await preferences.save(value);
          if (!saved.allowExecution)
            for (const [id, run] of workflow.runs)
              if (run.state.status === "validating")
                await workflow.stopAndWait(id);
          return saved;
        }),
      );
      handle("tower:conversation-index", () => conversations.list());
      handle("tower:conversation-history", (id, conversationId, action) =>
        exclusive(`history:${id}`, async () => {
          if (workflow.isActive(id) || [...agentChat.sending, ...agentChat.pending.keys()].some((key) => key.startsWith(id + ":")))
            throw new Error("프로젝트 작업이나 AI 응답이 끝난 뒤 정리하세요.");
          return conversations.updateHistory(id, conversationId, action);
        }),
      );
      handle("tower:export-conversation", async (id, conversationId) => {
        const chat = await conversations.read(id, conversationId);
        const run = chat.runId ? await workflow.current(id, chat.runId) : null;
        const markdown = await conversations.markdown(id, conversationId, run);
        const { canceled, filePath } = await dialog.showSaveDialog(window, {
          defaultPath: "hands-off-" + chat.id.slice(0, 8) + ".md",
          filters: [{ name: "Markdown", extensions: ["md"] }],
        });
        if (canceled || !filePath) return false;
        await writeFile(filePath, markdown, { encoding: "utf8", mode: 0o600 });
        return true;
      });
      handle("tower:create-conversation", (id) => conversations.create(id));
      handle("tower:conversation", async (id, conversationId) => {
        let conversation = conversationId
          ? await conversations.select(id, conversationId)
          : await conversations.active(id);
        if (!conversation) {
          const legacy = (await conversations.index()).managed?.[id] ? null : await workflow.current(id);
          conversation = await conversations.create(
            id,
            legacy?.request?.slice(0, 60) ?? "새 대화",
            legacy?.id ?? null,
          );
          if (legacy?.request) {
            await conversations.append(
              id,
              conversation.id,
              "gpt",
              "user",
              legacy.request,
            );
            conversation = await conversations.read(id, conversation.id);
          }
        }
        return {
          conversation,
          run: conversation.runId
            ? await workflow.current(id, conversation.runId)
            : null,
        };
      });
      handle(
        "tower:send-message",
        (id, conversationId, agentId, message, mode, mutation, imageProvider) =>
          exclusive(`chat:${id}:${agentId}`, () => {
            if (once.has(`history:${id}`)) throw new Error("대화 기록을 정리하는 중입니다.");
            return agentChat.send(id, conversationId, agentId, message, mode, mutation, imageProvider);
          }),
      );
      handle("tower:stop-message", (id, agentId) =>
        agentChat.cancel(id, agentId),
      );
      handle("tower:rerun-tests", async (id, runId) =>
        exclusive(`tests:${id}`, async () =>
          workflow.revalidate(id, runId, await preferences.get()),
        ),
      );
      handle("tower:test-report", async (id, runId) => {
        const run = await workflow.current(id, runId);
        if (!run?.testing) throw new Error("테스트 보고서가 없습니다.");
        return (
          await workspace.read(
            id,
            `.control-tower/runs/${run.id}/test-report.md`,
            { internal: true },
          )
        ).toString();
      });
      handle("tower:choose-project-folder", async () => {
        const result = await dialog.showOpenDialog(window, {
          title: "새 프로젝트 폴더 선택",
          defaultPath: app.getPath("documents"),
          properties: ["openDirectory", "createDirectory"],
        });
        if (result.canceled || !result.filePaths[0]) return null;
        return workspace.prepare(null, result.filePaths[0]);
      });
      handle("tower:create-project", (title) => projects.create(title));
      handle("tower:rename-project", (id, title) => projects.rename(id, title));
      handle("tower:select-project", (id) => projects.select(id));
      handle("tower:choose-folder", async (id) => {
        projects.find(await projects.list(), id);
        if (workflow.isActive(id))
          throw new Error("작업을 중지한 후 폴더를 변경하세요.");
        const result = await dialog.showOpenDialog(window, {
          title: "프로젝트 작업 폴더 선택",
          defaultPath: app.getPath("documents"),
          properties: ["openDirectory", "createDirectory"],
        });
        if (result.canceled || !result.filePaths[0]) return null;
        return workspace.prepare(id, result.filePaths[0]);
      });
      handle("tower:grant-folder", async (id, ticket, consent) => {
        if (workflow.isActive(id))
          throw new Error("작업을 중지한 후 폴더를 변경하세요.");
        return workspace.consent(id, ticket, consent);
      });
      handle("tower:revoke-folder", async (id) => {
        for (const agentId of ["gpt", "grok", "claude", "reviewer"])
          agentChat.cancel(id, agentId);
        await workflow.stopAndWait(id);
        return workspace.serialize(id, () => projects.revoke(id));
      });
      handle("tower:folder-tree", (id) => workspace.tree(id));
      handle("tower:read-file", async (id, file) => {
        const buffer = await workspace.read(id, file);
        if (buffer.includes(0))
          throw new Error("바이너리 파일은 미리보기를 제공하지 않습니다.");
        return buffer.toString("utf8");
      });
      handle("tower:open-folder", async (id) => {
        const grant = await workspace.grant(id);
        const error = await shell.openPath(grant.root);
        if (error) throw new Error("폴더를 열지 못했습니다.");
      });
      handle("tower:start-workflow", async (id, options) => {
        if (once.has(`history:${id}`)) throw new Error("대화 기록을 정리하는 중입니다.");
        const conversation =
          (await conversations.active(id)) ?? (await conversations.create(id));
        return (
          await agentChat.send(
            id,
            conversation.id,
            "gpt",
            options.request,
            "work",
          )
        ).state;
      });
      handle("tower:verified-checkpoint", async (id) => {
        const grant = await workspace.grant(id);
        const marker = await verifiedCheckpoint(workspace, id, grant.grantId);
        return marker ? { at: marker.at } : null;
      });
      handle("tower:checkpoints", async (id) => {
        const grant = await workspace.grant(id);
        return listCheckpoints(workspace, id, grant.grantId);
      });
      handle("tower:restore-checkpoint", async (id, checkpoint, confirmation) => {
        if (workflow.isActive(id) || auxiliary.running.has(id))
          throw new Error("작업이나 배포가 끝난 후 복원하세요.");
        if (confirmation != null && (typeof confirmation !== "string" || !/^[0-9a-f]{64}$/.test(confirmation)))
          throw new Error("유효한 복원 미리보기가 필요합니다.");
        workflow.starting.add(id);
        auxiliary.running.add(id);
        try {
          const grant = await workspace.grant(id);
          const result = await restoreCheckpoint(workspace, id, grant.grantId, checkpoint, confirmation);
          if (result.id) await workflow.invalidateAfterRestore(id);
          return result;
        } finally {
          workflow.starting.delete(id);
          auxiliary.running.delete(id);
        }
      });
      handle("tower:workflow", (id) => workflow.current(id));
      handle("tower:stop-workflow", async (id) => {
        await workflow.stopAndWait(id);
        return workflow.current(id);
      });
      handle("tower:models", async () => {
        const current = await status();
        if (current.gpt.source === "codex") return codex.models();
        const token = await auth.access();
        const response = await fetch("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${token}` },
          redirect: "error",
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok)
          throw new Error(
            `모델 목록을 불러오지 못했습니다. HTTP ${response.status}`,
          );
        const body = await response.json();
        if (!Array.isArray(body.models))
          throw new Error("공식 로그인 모델 목록 형식을 확인하지 못했습니다.");
        return body.models
          .filter((model) => model.visibility === "list")
          .map((model) => ({ id: model.slug, name: model.display_name }));
      });
      handle("tower:generate-image", (id, prompt, provider, conversationId) =>
        workflow.runs.get(id)?.state.status === "awaiting_design"
          ? workflow.reviseDesign(id, prompt, provider, conversationId)
          : generateDesignImage(id, prompt, provider),
      );
      handle("tower:latest-image", async (id) => {
        const project = projects.find(await projects.list(), id);
        const entry = (await store.read("image-index", {}))[id];
        if (entry && typeof entry === "object") {
          if (!project.workspace) return null;
          const grant = await workspace.grant(id);
          if (entry.grantId !== grant.grantId) return null;
          const buffer = await workspace.read(id, entry.path, {
            grantId: grant.grantId,
            maxBytes: 30000000,
          });
          return {
            dataUrl: `data:image/png;base64,${buffer.toString("base64")}`,
            artifactId: entry.artifactId,
            projectId: id,
            path: entry.path,
          };
        }
        const artifactId = entry;
        if (
          typeof artifactId !== "string" ||
          !/^[0-9a-f-]{36}\.png$/.test(artifactId)
        )
          return null;
        try {
          const buffer = await readFile(
            join(app.getPath("userData"), "artifacts", id, artifactId),
          );
          return {
            dataUrl: `data:image/png;base64,${buffer.toString("base64")}`,
            artifactId,
            projectId: id,
          };
        } catch (error) {
          if (error.code === "ENOENT") return null;
          throw error;
        }
      });
      handle("tower:export-image", async (id, artifactId) => {
        projects.find(await projects.list(), id);
        if (
          typeof artifactId !== "string" ||
          !/^[0-9a-f-]{36}\.png$/.test(artifactId)
        )
          throw new Error("이미지를 찾지 못했습니다.");
        const { canceled, filePath } = await dialog.showSaveDialog(window, {
          defaultPath: "ui-mockup.png",
          filters: [{ name: "PNG", extensions: ["png"] }],
        });
        if (canceled || !filePath) return { saved: false };
        const entry = (await store.read("image-index", {}))[id];
        if (typeof entry === "object" && entry?.artifactId === artifactId) {
          const buffer = await workspace.read(id, entry.path, {
            grantId: entry.grantId,
            maxBytes: 30000000,
          });
          await writeFile(filePath, buffer);
        } else {
          const { copyFile } = await import("node:fs/promises");
          await copyFile(
            join(app.getPath("userData"), "artifacts", id, artifactId),
            filePath,
          );
        }
        return { saved: true };
      });
      handle("tower:open-link", async (key) => {
        if (!Object.hasOwn(allowedLinks, key))
          throw new Error("허용되지 않은 링크입니다.");
        await browser.open(allowedLinks[key]);
      });
      window = new BrowserWindow({
        width: 1600,
        height: 1040,
        minWidth: 900,
        minHeight: 700,
        title: "CW_Handsoff_sys",
        icon: join(directory, "renderer/assets/mascot.png"),
        backgroundColor: "#0b0d0f",
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
          preload: join(directory, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event, url) => {
        if (url !== rendererURL) event.preventDefault();
      });
      window.webContents.on("will-attach-webview", (event) =>
        event.preventDefault(),
      );
      window.once("ready-to-show", () => window.show());
      await window.loadFile(rendererPath);
    } catch (error) {
      dialog.showErrorBox("CW_Handsoff_sys", publicError(error));
      app.quit();
    }
  });
  app.on("before-quit", () => {
    auth?.cancel();
    claude?.cancel();
    grok?.cancel();
    gemini?.cancel();
    codex?.close();
    workflow?.stopAll();
    usage?.close();
    agentChat?.close();
  });
  app.on("window-all-closed", () => app.quit());
}
