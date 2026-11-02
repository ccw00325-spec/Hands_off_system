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
let restorePromise;
let gptRestoreState = null;
const once = new Set();
const allowedLinks = {
  keys: "https://platform.openai.com/api-keys",
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
    accounts,
    waiting: Boolean(auth.pending),
    image: {
      saved: Boolean(vault.imageKey),
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
        notify,
        (context) => validateProject(workspace, context),
      );
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
      handle("tower:save-key", (key) =>
        exclusive("key", () => images.saveKey(key)),
      );
      handle("tower:remove-key", () =>
        exclusive("key", () => images.removeKey()),
      );
      handle("tower:projects", () => projects.list());
      handle("tower:create-project", (title) => projects.create(title));
      handle("tower:rename-project", (id, title) => projects.rename(id, title));
      handle("tower:select-project", (id) => projects.select(id));
      handle("tower:choose-folder", async (id) => {
        projects.find(await projects.list(), id);
        if (workflow.isActive(id))
          throw new Error("작업을 중지한 후 폴더를 변경하세요.");
        const result = await dialog.showOpenDialog(window, {
          title: "프로젝트 작업 폴더 선택",
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
        const current = await status();
        return workflow.start(id, {
          ...options,
          funContract: true,
          unattended: options.unattended === true,
          team: await roles.getTeam(id),
          roles: await roles.get(id),
          gptSource: current.gpt.source,
          gptModel: options.gptModel || current.gpt.modelId || "",
          grokRoute: await grok.selection(),
          geminiModel: (await store.read("gemini-model", {})).modelId ?? null,
        });
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
      handle("tower:generate-image", (id, prompt) =>
        exclusive("image", async () => {
          const grant = await workspace.grant(id);
          const result = await images.generate(prompt);
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
          };
        }),
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
  });
  app.on("window-all-closed", () => app.quit());
}
