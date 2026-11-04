import {
  conversationTree,
  terminalFeed,
  testingInspector,
} from "./conversation-view.js";
import { fillPreferences, readPreferences } from "./settings-view.js";
import { quotaWindows } from "../core/quota-view.js";
import { createMascot } from "./mascot.js";
import { CAPABILITIES, SLOT_IDS, defaultTeam } from "../core/team.js";
import {
  renderTeamEditor,
  readTeamEditor,
  resizeEditor,
  renderPanelTeam,
  renderInspector,
  renderSidebarProjects,
  renderSidebarFiles,
} from "./workbench.js";
const $ = (selector) => document.querySelector(selector);
const mascot = createMascot($("#mascot-stage"));
const api = window.tower;
let projectData,
  connection,
  editingProject = false,
  resultImage = null,
  toastTimer;
let generationProject = null;
let folderTicket = null,
  linkedFolder = null,
  currentRun = null;
const ACTIVE_RUN = new Set([
  "planning",
  "awaiting_design",
  "building",
  "testing",
  "validating",
  "reviewing",
  "repairing",
  "final_review",
]);
const resultCache = new Map();
let usageData = null,
  usageProvider = "claude",
  restoring = false,
  lastActivity = 0;
const usageRunStates = new Map();
const AI_NAMES = {
  gpt: "GPT",
  grok: "Grok · Cursor",
  claude: "Claude",
  gemini: "Gemini",
};
const ROLE_LABELS = {
  gpt: "컨트롤 타워",
  grok: "작업 02",
  claude: "작업 03",
  reviewer: "작업 04",
};
let roleAssignments = null,
  rolesProjectId = null,
  rolesDialogProjectId = null,
  roleSaving = false;
let teamConfig = null;
let preferences = null,
  currentConversation = null,
  conversationIndex = null,
  conversationSerial = 0,
  autoQuestion = false;
const activeRuns = new Map(),
  pendingChats = new Map(),
  liveBuffers = new Map();

function toast(message, type = "") {
  $("#toast").textContent = message;
  $("#toast").className = `toast ${type}`;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $("#toast").hidden = true;
  }, 6500);
  $("#footer-status").textContent = message;
}
async function call(promise) {
  const result = await promise;
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
function message(selector, text, type = "") {
  $(selector).textContent = text;
  $(selector).className = `hint ${type}`;
}
function pill(selector, text, good = false) {
  $(selector).textContent = text;
  $(selector).className = `status-pill${good ? " connected" : ""}`;
}
async function busy(button, text, task) {
  const previous = button.textContent;
  button.disabled = true;
  button.textContent = text;
  button.setAttribute("aria-busy", "true");
  try {
    return await task();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = previous;
    button.removeAttribute("aria-busy");
    if (button.id === "chatgpt-login" && connection) {
      button.disabled = connection.waiting || !connection.secureStorage;
      button.textContent = connection.waiting
        ? "브라우저에서 승인 대기 중…"
        : connection.accounts.length
          ? "다른 계정 연결 ↗"
          : "Continue with ChatGPT ↗";
    }
    updateReadiness();
  }
}
function openConnections() {
  if (!$("#connections").open) $("#connections").showModal();
}
function activeProject() {
  return projectData.items.find(
    (project) => project.id === projectData.activeId,
  );
}
function renderProjects(data) {
  projectData = data;
  roleAssignments = null;
  rolesProjectId = null;
  const roleProject = data.activeId;
  teamConfig = null;
  void call(api.team(roleProject))
    .then((value) => {
      if (projectData.activeId !== roleProject) return;
      teamConfig = value;
      roleAssignments = Object.fromEntries(
        value.map((agent) => [agent.id, agent.provider]),
      );
      rolesProjectId = roleProject;
      renderAssignedRoles();
      updateReadiness();
    })
    .catch((error) => toast(error.message, "error"));
  currentConversation = null;
  conversationSerial++;
  $("#conversation-title").textContent = "새 대화";
  void refreshConversationIndex();
  $("#project-select").replaceChildren(
    ...data.items.map((project) => new Option(project.title, project.id)),
  );
  $("#project-select").value = data.activeId;
  $("#project-title").textContent = activeProject().title;
  document.title = `${activeProject().title} — CW_Handsoff_sys`;
  resultImage = resultCache.get(data.activeId) ?? null;
  renderImage();
  linkedFolder = null;
  currentRun = null;
  void refreshWorkspace();
  void loadConversation();
  void call(api.servicesResult(roleProject))
    .then((result) => {
      if (projectData?.activeId === roleProject) renderDelivery(result);
    })
    .catch(() => {});
  const id = data.activeId;
  void refreshVerifiedCheckpoint(id);
  if (!resultImage)
    void call(api.latestImage(id))
      .then((result) => {
        if (result) resultCache.set(id, result);
        if (projectData.activeId === id && result) {
          resultImage = result;
          renderImage();
        }
      })
      .catch((error) => toast(error.message, "error"));
}
function renderImage() {
  const currentGenerating = generationProject === projectData?.activeId;
  $("#image-empty").hidden = Boolean(resultImage);
  $("#generated-image").hidden = !resultImage;
  $("#image-result").hidden = !resultImage;
  if (resultImage) $("#generated-image").src = resultImage.dataUrl;
  else $("#generated-image").removeAttribute("src");
  $("#image-empty h3").textContent = currentGenerating
    ? "시안을 생성하고 있습니다…"
    : "시안을 이곳에서 확인합니다.";
  $("#image-empty p").textContent = currentGenerating
    ? "응답을 기다리고 있습니다. 완료 전까지 생성 완료로 표시하지 않습니다."
    : "생성이 완료되면 현재 프로젝트에 저장됩니다.";
}
async function refreshStatus() {
  const status = await call(api.status());
  connection = status;
  $("#app-version").textContent = `LOCAL / ${status.appVersion}`;
  const account = status.accounts.find((item) => item.active);
  const usable = account?.planEnabled === true;
  const gptUsable = status.gpt.connected;
  pill(
    "#gpt-status",
    usable ? "권한 승인됨" : account?.signedIn ? "사용 권한 필요" : "미연결",
    usable,
  );
  pill(
    "#auth-status",
    usable ? "권한 승인됨" : account?.signedIn ? "로그인만 완료" : "미연결",
    usable,
  );
  if (account?.needsReconnect) {
    pill("#gpt-status", "연결 재확인 필요");
    pill("#auth-status", "연결 재확인 필요");
  }
  pill(
    "#key-status",
    status.image.saved ? "등록됨" : "미등록",
    status.image.saved,
  );
  pill(
    "#claude-status",
    status.claude.connected ? "CLI 로그인됨" : "미연결",
    status.claude.connected,
  );
  pill(
    "#claude-auth-status",
    status.claude.connected
      ? "CLI 로그인됨"
      : status.claude.installed
        ? "미연결"
        : "설치 필요",
    status.claude.connected,
  );
  $("#claude-login").disabled =
    !status.claude.installed || status.claude.connected;
  $("#connection-count").textContent =
    Number(gptUsable) +
    Number(status.claude.connected) +
    Number(status.grok.connected) +
    Number(status.gemini.connected);
  $("#connection-dot").classList.toggle(
    "mint-dot",
    gptUsable ||
      status.claude.connected ||
      status.grok.connected ||
      status.gemini.connected,
  );
  $("#storage-status").textContent = status.secureStorage
    ? "✓ OS 암호화 저장소 사용 가능"
    : "OS 보안 저장소 사용 불가 · 저장 차단";
  $("#save-key").disabled = !status.secureStorage;
  $("#chatgpt-login").disabled = status.waiting || !status.secureStorage;
  $("#chatgpt-login").textContent = status.waiting
    ? "브라우저에서 승인 대기 중…"
    : status.accounts.length
      ? "다른 계정 연결 ↗"
      : "Continue with ChatGPT ↗";
  $("#cancel-login").hidden = !status.waiting;
  renderImageKey(status);
  $("#image-key-hint").textContent = imageKeyReady(selectedImageProvider(), status)
    ? "✓ 이미지 API 키 등록됨 · 실제 생성 시 권한과 잔액 확인"
    : "연결 설정에서 이미지 API 키를 등록하세요.";
  $("#generate-image").disabled =
    !imageKeyReady(selectedImageProvider(), status) || !linkedFolder || generationProject !== null;
  $("#account-section").hidden = !status.accounts.length;
  const previousSelected = $("#account-select").value;
  $("#account-select").replaceChildren(
    ...status.accounts.map(
      (item) =>
        new Option(
          `${item.label}${item.active ? " · 현재 사용" : ""}${!item.signedIn ? " · 재로그인 필요" : ""}`,
          item.id,
        ),
    ),
  );
  $("#account-select").value = status.accounts.some(
    (item) => item.id === previousSelected,
  )
    ? previousSelected
    : (account?.id ?? status.accounts[0]?.id ?? "");
  $("#sign-out").disabled = !account?.signedIn;
  if (account)
    message(
      "#auth-message",
      usable
        ? `${account.label} · 사용 권한을 승인했습니다. 실제 모델 접근은 요청 시 확인됩니다.`
        : "로그인은 완료됐지만 AI 사용 권한은 없습니다. 다시 승인으로 권한을 연결하세요.",
      usable ? "success" : "",
    );
  if (status.claude.connected)
    message(
      "#claude-message",
      "터미널에 저장된 Claude 로그인을 사용합니다. 다시 로그인할 필요가 없습니다.",
      "success",
    );
  else if (!status.claude.installed)
    message(
      "#claude-message",
      "공식 Claude Code를 설치한 후 상태 다시 확인을 눌러주세요.",
    );
  pill(
    "#grok-auth-status",
    status.grok.connected
      ? "CLI 로그인됨"
      : status.grok.installed
        ? "연결 필요"
        : "설치 필요",
    status.grok.connected,
  );
  if (!currentRun)
    pill(
      "#grok-status",
      status.grok.connected
        ? "CLI 로그인됨"
        : status.grok.installed
          ? "연결 확인 필요"
          : "설치 필요",
      status.grok.connected,
    );
  if (status.grok.connected)
    message(
      "#grok-message",
      "기존 Cursor Agent 로그인을 사용합니다. 아래에서 Grok 모델을 선택하세요. Cursor 계정의 이용 한도가 적용됩니다.",
      "success",
    );
  else if (!status.grok.installed)
    message(
      "#grok-message",
      "Cursor Agent CLI 설치 후 연결하기를 누르세요. 로그인 정보는 원본 CLI가 보관합니다.",
    );
  const model = status.grok.modelId;
  if (
    model &&
    !Array.from($("#grok-model").options).some(
      (option) => option.value === model,
    )
  )
    $("#grok-model").append(new Option(model, model));
  $("#grok-model").value = model ?? "";
  $("#grok-model-label").textContent = model ?? "Grok 모델 미선택";
  $("#load-grok-models").disabled = !status.grok.connected;
  for (const provider of ["claude", "grok"])
    renderCliLogin(provider, status[provider]);
  renderGeminiConnection(status.gemini);
  renderAssignedRoles();
  renderCodexConnection(status);
  if (usageData) renderUsage(usageData);
  updateReadiness();
  return status;
}

$("#open-connections").addEventListener("click", openConnections);
document
  .querySelectorAll(".connect-shortcut")
  .forEach((button) => button.addEventListener("click", openConnections));
$("#close-connections").addEventListener("click", () => {
  $("#connections").close();
  $("#image-api-key").value = "";
});
$("#finish-connections").addEventListener("click", () => {
  $("#connections").close();
  $("#image-api-key").value = "";
});
$("#connections").addEventListener("close", () => {
  $("#image-api-key").value = "";
});
document
  .querySelectorAll("[data-link]")
  .forEach((button) =>
    button.addEventListener("click", () =>
      busy(button, "여는 중…", () => call(api.openLink(button.dataset.link))),
    ),
  );

async function login(accountId) {
  try {
    await call(api.login(accountId));
    message(
      "#auth-message",
      "공식 브라우저에서 로그인하고 사용 권한을 승인하세요. 비밀번호는 이 앱에 입력하지 않습니다.",
    );
  } catch (error) {
    message("#auth-message", error.message, "error");
  }
  await refreshStatus();
}
$("#chatgpt-login").addEventListener("click", () =>
  busy($("#chatgpt-login"), "로그인 준비 중…", () => login()),
);
$("#reauth-account").addEventListener("click", () =>
  busy($("#reauth-account"), "준비 중…", () =>
    login($("#account-select").value),
  ),
);
$("#cancel-login").addEventListener("click", () =>
  busy($("#cancel-login"), "취소 중…", async () => {
    await call(api.cancelLogin());
    await refreshStatus();
  }),
);
$("#use-account").addEventListener("click", () =>
  busy($("#use-account"), "전환 중…", async () => {
    await call(api.selectAccount($("#account-select").value));
    await refreshStatus();
    toast("선택한 계정으로 전환했습니다.", "success");
  }),
);
$("#sign-out").addEventListener("click", () =>
  busy($("#sign-out"), "로그아웃 중…", async () => {
    const result = await call(api.signOut());
    await refreshStatus();
    message(
      "#auth-message",
      result.message,
      result.remoteRevoked ? "" : "error",
    );
    toast(result.message);
  }),
);
$("#claude-login").addEventListener("click", () => connectCLI("claude"));
$("#grok-login").addEventListener("click", () => connectCLI("grok", true));
$("#refresh-status").addEventListener("click", () =>
  busy($("#refresh-status"), "확인 중…", async () => {
    await restoreSavedConnections();
    await refreshStatus();
    toast("공식 CLI와 저장된 연결 상태를 확인했습니다.");
  }),
);

$("#key-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#image-api-key");
  const provider = imageKeyProvider;
  const key = input.value;
  input.value = "";
  input.removeAttribute("aria-invalid");
  await busy($("#save-key"), "키 확인 중…", async () => {
    try {
      const result = await call(api.saveKey(key, provider));
      await refreshStatus();
      message("#key-message", result.message, "success");
      toast("이미지 API 키를 암호화해 저장했습니다.", "success");
    } catch (error) {
      input.setAttribute("aria-invalid", "true");
      message("#key-message", error.message, "error");
    }
  });
});
$("#delete-key").addEventListener("click", () =>
  busy($("#delete-key"), "삭제 중…", async () => {
    await call(api.removeKey(imageKeyProvider));
    await refreshStatus();
    message("#key-message", "저장된 API 키를 삭제했습니다.");
  }),
);

$("#project-select").addEventListener("change", async (event) => {
  try {
    renderProjects(await call(api.selectProject(event.target.value)));
  } catch (error) {
    toast(error.message, "error");
  }
});
$("#new-project").addEventListener("click", () =>
  busy($("#new-project"), "폴더 선택 중…", async () => {
    const ticket = await call(api.chooseProjectFolder());
    if (!ticket) return;
    folderTicket = ticket;
    $("#consent-path").textContent = ticket.root;
    $("#folder-consent-check").checked = false;
    $("#folder-consent").showModal();
  }),
);
$("#edit-title").addEventListener("click", () => {
  editingProject = true;
  $("#project-dialog-title").textContent = "프로젝트 제목 편집";
  $("#project-name").value = activeProject().title;
  $("#project-dialog").showModal();
});
$("#cancel-project").addEventListener("click", () =>
  $("#project-dialog").close(),
);
$("#project-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await busy($("#project-form button[type=submit]"), "저장 중…", async () => {
    const name = $("#project-name").value;
    renderProjects(
      await call(
        editingProject
          ? api.renameProject(projectData.activeId, name)
          : api.createProject(name),
      ),
    );
    $("#project-dialog").close();
    toast(
      editingProject
        ? "프로젝트 제목을 변경했습니다."
        : "프로젝트를 만들었습니다.",
      "success",
    );
  });
});

let imageKeyProvider = "gpt";
const selectedImageProvider = () => $("#image-provider").value;
const imageKeyReady = (provider = selectedImageProvider(), status = connection) =>
  Boolean(provider === "gemini" ? status?.image?.geminiSaved : status?.image?.saved);
function renderImageKey(status) {
  const isGemini = imageKeyProvider === "gemini";
  $("#image-key-model").textContent = isGemini ? "GEMINI FLASH IMAGE" : "GPT IMAGE 2";
  $("#image-key-label").textContent = isGemini ? "Google AI Studio API 키" : "OpenAI 개인 API 키";
  $("#image-api-key").placeholder = imageKeyReady(imageKeyProvider, status) ? "교체하려면 새 키를 입력하세요." : isGemini ? "AIza…" : "sk-…";
  $("#image-key-link").dataset.link = isGemini ? "geminiKeys" : "keys";
  $("#image-usage-link").hidden = isGemini;
  $("#delete-key").hidden = !imageKeyReady(imageKeyProvider, status);
  pill("#key-status", imageKeyReady(imageKeyProvider, status) ? "등록됨" : "미등록", imageKeyReady(imageKeyProvider, status));
}
function connectImageProvider() {
  imageKeyProvider = selectedImageProvider();
  openConnections();
  renderImageKey(connection);
  $("#key-form").scrollIntoView({ block: "center" });
  $("#image-api-key").focus();
  if (imageKeyProvider === "gemini" && connection?.gemini?.installed && !connection.gemini.connected)
    $("#gemini-login").click();
}
$("#connect-image-provider").addEventListener("click", connectImageProvider);
$("#image-provider").addEventListener("change", () => {
  $("#image-model-label").textContent = selectedImageProvider() === "gemini" ? "Gemini Flash Image" : "GPT Image 2";
  $("#image-key-hint").textContent = imageKeyReady() ? "이미지 API 키 등록됨" : "이미지 API 키를 연결하세요.";
  updateReadiness();
  if (!imageKeyReady() || (selectedImageProvider() === "gemini" && connection?.gemini?.installed && !connection.gemini.connected))
    connectImageProvider();
});
$("#open-run-design").addEventListener("click", () => view(true));
function view(images) {
  $("#workspace-view").hidden = images;
  $("#images-view").hidden = !images;
  $("#tab-workspace").classList.toggle("selected", !images);
  $("#tab-workspace").setAttribute("aria-selected", String(!images));
  $("#tab-images").classList.toggle("selected", images);
  $("#tab-images").setAttribute("aria-selected", String(images));
}
$("#tab-workspace").addEventListener("click", () => view(false));
$("#tab-images").addEventListener("click", () => view(true));
$("#image-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (generationProject !== null) return;
  const projectId = projectData.activeId;
  generationProject = projectId;
  renderImage();
  await busy($("#generate-image"), "시안 생성 중…", async () => {
    try {
      const result = await call(
        api.generateImage(projectId, $("#image-prompt").value, selectedImageProvider(), currentConversation?.id),
      );
      resultCache.set(projectId, result);
      if (projectData.activeId === projectId) resultImage = result;
      toast("시안 생성이 완료되어 요청한 프로젝트에 저장했습니다.", "success");
    } finally {
      generationProject = null;
      renderImage();
    }
  });
  $("#generate-image").disabled = !imageKeyReady() || !linkedFolder;
  await refreshWorkspace();
});
$("#export-image").addEventListener("click", () =>
  busy($("#export-image"), "내보내는 중…", async () => {
    if (!resultImage) return;
    const result = await call(
      api.exportImage(resultImage.projectId, resultImage.artifactId),
    );
    if (result.saved) toast("PNG 파일을 내보냈습니다.", "success");
  }),
);
$("#model-button").addEventListener("click", () =>
  busy($("#model-button"), "목록 확인 중…", async () => {
    if (teamConfig?.[0].provider !== "gpt") {
      await openRoles("gpt");
      return;
    }
    $("#model-list").replaceChildren();
    $("#models-dialog").showModal();
    const rows = await call(api.models());
    const selected = $("#gpt-model").value;
    $("#gpt-model").replaceChildren(
      new Option("GPT 모델 선택", ""),
      ...rows.map((item) => new Option(item.name, item.id)),
    );
    if (rows.some((item) => item.id === selected))
      $("#gpt-model").value = selected;
    for (const item of rows) {
      const row = document.createElement("button");
      row.className = "model-row";
      const name = document.createElement("strong");
      name.textContent = item.name;
      const slug = document.createElement("span");
      slug.textContent = item.id;
      row.append(name, slug);
      $("#model-list").append(row);
      row.addEventListener("click", () => {
        $("#gpt-model").value = item.id;
        void call(api.saveGptModel(item.id)).catch((error) =>
          toast(error.message, "error"),
        );
        $("#models-dialog").close();
        updateReadiness();
      });
    }
    if (!rows.length)
      $("#model-list").textContent = "이 계정에서 표시할 모델이 없습니다.";
  }),
);
$("#close-models").addEventListener("click", () => $("#models-dialog").close());

async function initialize() {
  if (!api) {
    toast(
      "이 화면은 데스크톱 앱에서 실행하세요. 프로젝트 폴더에서 npm start를 실행하면 됩니다.",
      "error",
    );
  } else {
    api.onEvent(async (event) => {
      if (
        event.type === "delivery" &&
        event.projectId === projectData?.activeId
      ) {
        renderDelivery(event.result);
        toast(
          event.result.message,
          event.result.status === "failed" ? "error" : "",
        );
        return;
      }
      if (event.type === "chat-updated") {
        if (event.projectId === projectData?.activeId) {
          for (const id of SLOT_IDS) pendingChats.delete(id);
          for (const job of event.pending ?? [])
            pendingChats.set(job.agentId, job.conversationId);
          if (event.conversationId === currentConversation?.id)
            void loadConversation(currentConversation.id);
          else void refreshConversationIndex();
        }
        return;
      }
      if (event.type === "agent-progress") {
        if (
          event.projectId !== projectData?.activeId ||
          event.conversationId !== currentConversation?.id
        )
          return;
        const key = currentConversation.id + ":" + event.agentId;
        liveBuffers.set(
          key,
          (liveBuffers.get(key) ?? "") +
            (event.command ? "$ " + event.command + "\n" : "") +
            event.text,
        );
        const box = $("#" + event.agentId + "-progress");
        if (box) {
          box.textContent = liveBuffers.get(key).slice(-20000);
          box.hidden = false;
          box.scrollTop = box.scrollHeight;
        }
        return;
      }
      if (event.type === "usage") {
        renderUsage(event.usage);
        return;
      }
      if (event.type === "workflow") {
        activeRuns.set(event.projectId, event.state);
        if (
          event.projectId === projectData?.activeId &&
          (!event.state.options.conversationId ||
            event.state.options.conversationId === currentConversation?.id)
        ) {
          if (
            currentConversation &&
            event.state.options.conversationId === currentConversation.id
          )
            currentConversation.runId = event.state.id;
          renderWorkflow(event.state);
        } else updateReadiness();
        const previous = usageRunStates.get(event.projectId);
        usageRunStates.set(event.projectId, event.state.status);
        if (
          previous !== event.state.status &&
          !ACTIVE_RUN.has(event.state.status)
        ) {
          void refreshUsage(false);
          if (event.projectId === projectData?.activeId) {
            void refreshWorkspace();
            void refreshVerifiedCheckpoint(event.projectId);
          }
        }
        return;
      }
      if (event.type === "auth")
        message(
          "#auth-message",
          event.message,
          event.state === "error" ? "error" : "",
        );
      if (event.type === "codex")
        message(
          "#codex-message",
          event.message,
          event.state === "error" ? "error" : "",
        );
      if (event.type === "claude")
        message(
          "#claude-message",
          event.message,
          event.state === "error" ? "error" : "",
        );
      if (event.type === "grok")
        message(
          "#grok-message",
          event.message,
          event.state === "error" ? "error" : "",
        );
      if (["claude", "grok"].includes(event.type) && event.login)
        renderCliLogin(event.type, {
          ...connection?.[event.type],
          login: event.login,
        });
      if (event.type === "gemini") {
        message(
          "#gemini-message",
          event.message,
          event.state === "error" ? "error" : "",
        );
        if (event.login)
          renderGeminiConnection({ ...connection?.gemini, login: event.login });
      }
      if (event.state !== "waiting")
        toast(event.message, event.state === "error" ? "error" : "");
      try {
        await refreshStatus();
      } catch (error) {
        toast(error.message, "error");
      }
    });
    try {
      const startup = $("#startup-dialog");
      const progress = $("#startup-progress");
      const statusLine = $("#startup-status");
      startup.showModal();
      const arrival = Promise.allSettled(
        startup
          .querySelector("img")
          .getAnimations()
          .map((animation) => animation.finished),
      );
      try {
        renderProjects(await call(api.projects()));
        progress.value = 1;
        statusLine.textContent =
          "프로젝트 선반을 정리했어요. 설정을 확인하는 중…";
        preferences = await call(api.preferences());
        fillPreferences(preferences);
        progress.value = 2;
        statusLine.textContent = "상자를 내려놓고 작업대를 여는 중…";
        await arrival;
        progress.value = 3;
      } finally {
        startup.close();
      }
      if (!localStorage.getItem("tower-tour-v1")) startTour();
      else if (!preferences.onboardingComplete) $("#settings-dialog").showModal();
      const restored = await restoreSavedConnections();
      const status = await refreshStatus();
      $("#footer-status").textContent =
        "연결 상태 확인 완료 · 프로젝트 폴더에서 작업합니다.";
      const connected =
        status.gpt.connected ||
        status.claude.connected ||
        status.grok.connected ||
        status.gemini.connected;
      if (
        preferences.onboardingComplete &&
        !$("#settings-dialog").open &&
        !$("#first-run-tour").open &&
        restored?.session.firstLaunch &&
        !connected
      )
        openConnections();
      renderUsage(await call(api.usage()));
      void refreshUsage(false);
    } catch (error) {
      toast(error.message, "error");
    }
  }
}

function updateReadiness() {
  const active =
    ACTIVE_RUN.has(activeRuns.get(projectData?.activeId)?.status) ||
    ACTIVE_RUN.has(currentRun?.status);
  const mode = $("#controller-mode");
  mode.querySelector("option[value=work]").disabled = active;
  if (active && mode.value === "work") {
    mode.value = "question";
    autoQuestion = true;
  } else if (!active && autoQuestion) {
    mode.value = "work";
    autoQuestion = false;
  }
  const question = mode.value === "question";
  const needed = [];
  if (!linkedFolder) needed.push("프로젝트 폴더 연결");
  if (!teamConfig || roleSaving) needed.push("역할 배치 확인");
  const participants = question
    ? (teamConfig ?? []).slice(0, 1)
    : (teamConfig ?? []);
  for (const agent of participants) {
    const provider = agent.provider;
    if (provider === "gpt") {
      if (!connection?.gpt.connected) needed.push("GPT 로그인");
      if (
        connection?.gpt.source === "api" &&
        !agent.modelId &&
        !$("#gpt-model").value
      )
        needed.push("GPT 모델 선택");
    } else {
      if (!connection?.[provider]?.connected)
        needed.push(AI_NAMES[provider] + " 로그인");
      if (
        ["grok", "gemini"].includes(provider) &&
        !agent.modelId &&
        !connection?.[provider]?.modelId
      )
        needed.push(AI_NAMES[provider] + " 모델 선택");
    }
  }
  const pending = pendingChats.get("gpt") === currentConversation?.id;
  $("#stop-controller-chat").hidden = !pending;
  $("#start-workflow").disabled =
    needed.length > 0 || pending || !$("#planner-input").value.trim();
  $("#start-workflow").textContent = currentRun?.status === "awaiting_design" && /^이대로\s*적용[.!]?$/.test($("#planner-input").value.trim()) ? "시안 승인 ↑" : question ? "질문 보내기 ↑" : "작업 요청 ↑";
  $("#stop-workflow").hidden = !active;
  $("#choose-folder").disabled = active;
  $("#restore-verified").disabled = active;
  $("#open-checkpoints").disabled = active;
  $("#run-readiness").textContent = needed.length
    ? "연결 필요: " + [...new Set(needed)].join(" · ")
    : currentRun?.status === "awaiting_design"
      ? "UI 시안 승인 대기 · 시안을 보고 ‘이대로 적용’이라고 입력하세요."
      : active
      ? "작업 진행 중 · 질문은 별도 응답합니다. 변경 요청은 작업 종료 또는 중지 후 보낼 수 있습니다."
      : question
        ? "프로젝트 질문 · 파일을 수정하지 않는 대화입니다."
        : "Enter로 작업 요청 · 실행 권한과 자동 수정은 우측 상단 설정에서 관리합니다.";
  $("#generate-image").disabled =
    !imageKeyReady() || !linkedFolder || generationProject !== null;
}
async function refreshWorkspace() {
  if (!projectData) return;
  const id = projectData.activeId;
  const project = activeProject();
  linkedFolder = null;
  if (!project.workspace) {
    $("#folder-path").textContent = "작업 폴더를 연결하세요.";
    pill("#folder-permission", "접근 동의 필요");
    for (const selector of ["#show-files", "#open-folder", "#revoke-folder"])
      $(selector).hidden = true;
    renderSidebarFiles(null, viewSidebarFile);
    renderWorkflow(null);
    updateReadiness();
    return;
  }
  $("#folder-path").textContent = project.workspace.root;
  $("#revoke-folder").hidden = false;
  try {
    const tree = await call(api.folderTree(id));
    if (projectData.activeId !== id) return;
    linkedFolder = tree;
    pill("#folder-permission", "읽기 · 생성 · 수정 동의됨", true);
    $("#show-files").hidden = false;
    $("#open-folder").hidden = false;
    $("#choose-folder").textContent = "폴더 변경";
    renderFileList(tree);
    const run = await call(api.workflow(id));
    if (projectData.activeId === id) {
      activeRuns.set(id, run);
      if (currentConversation) void loadConversation(currentConversation.id);
    }
  } catch (error) {
    if (projectData.activeId !== id) return;
    pill("#folder-permission", "접근 확인 필요");
    $("#show-files").hidden = true;
    $("#open-folder").hidden = true;
    toast(error.message, "error");
    renderWorkflow(null);
  }
  updateReadiness();
}
function renderFileList(tree) {
  renderSidebarFiles(tree, viewSidebarFile);
  $("#file-list").replaceChildren();
  $("#file-preview").textContent = "";
  $("#preview-filename").textContent =
    "파일을 선택하면 내용을 읽기 전용으로 표시합니다.";
  for (const entry of tree.files) {
    const button = document.createElement("button");
    button.className = `file-entry ${entry.type}`;
    button.textContent = `${entry.type === "directory" ? "▸ " : "  "}${entry.path}`;
    button.disabled = entry.type === "directory";
    const projectId = projectData.activeId;
    button.addEventListener("click", () =>
      busy(button, "읽는 중…", async () => {
        const text = await call(api.readFile(projectId, entry.path));
        if (projectId !== projectData.activeId) return;
        $("#preview-filename").textContent = entry.path;
        $("#file-preview").textContent = text;
      }),
    );
    $("#file-list").append(button);
  }
  if (!tree.files.length)
    $("#file-list").textContent =
      "빈 폴더입니다. 생성된 파일이 여기에 나타납니다.";
  if (tree.omitted) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "표시 한도를 넘는 파일이 있습니다.";
    $("#file-list").append(p);
  }
}
const RUN_LABELS = {
  testing: "테스트 코드 작성 중",
  planning: "명세 작성 중",
  building: "기능·UI 구현 중",
  validating: "검증 실행 중",
  reviewing: "컨트롤 타워 검토 중",
  repairing: "담당 AI 수정 중",
  final_review: "3역할 최종 검토 중",
  completed: "전체 완료",
  awaiting_validation: "실행 검증 필요",
  needs_input: "사용자 답변 필요",
  awaiting_design: "UI 시안 승인 대기",
  needs_attention: "확인 필요",
  cancelled: "중지됨",
  interrupted: "이전 작업 중단됨",
};
let pendingDesignArtifact;
async function loadApprovedPreview(run) {
  if (pendingDesignArtifact === run.design.artifactId) return;
  pendingDesignArtifact = run.design.artifactId;
  try {
    const result = await call(api.latestImage(run.projectId));
    if (projectData?.activeId === run.projectId && currentRun?.design?.artifactId === result?.artifactId) {
      resultCache.set(run.projectId, result);
      resultImage = result;
      renderImage();
    }
  } catch (error) {
    toast(error.message, "error");
  } finally {
    pendingDesignArtifact = null;
  }
}
function renderWorkflow(run) {
  currentRun = run;
  const awaitingDesign = run?.status === "awaiting_design";
  $("#design-approval-banner").hidden = !awaitingDesign;
  $("#design-approval-status").textContent = ({
    ready: "UI 시안을 한번 확인해 주시겠습니까? 마음에 들면 ‘이대로 적용’이라고 입력해 주세요.",
    error: "시안을 만들지 못했습니다. UI 시안에서 API 키를 연결하거나 다시 생성하세요.",
  })[run?.design?.status] ?? "UI 시안을 만드는 중입니다.";
  if (awaitingDesign && run.design?.status === "ready" && resultImage?.artifactId !== run.design.artifactId)
    void loadApprovedPreview(run);
  $("#rollback-banner").hidden = !(run?.batchRollback && ["needs_attention", "awaiting_validation", "cancelled", "interrupted"].includes(run.status) &&
    run.tasks?.some((task) => task.report?.changed?.length || task.status === "reported"));
  $("#rollback-reason").textContent = run?.status === "awaiting_validation" ? (run.validation?.requiresConsent ? "검증 권한 필요" : "검증 실패") : RUN_LABELS[run?.status] ?? "작업 확인 필요";
  const usage = run?.usage;
  const cost = usage?.estimatedUsd === undefined ? "" : ` · 추정 $${usage.estimatedUsd.toFixed(4)}${usage.costUnknown ? " (일부)" : ""}`;
  $("#work-usage-summary").textContent = usage
    ? `이번 작업 · 호출 ${usage.calls}${run.options.maxAgentCalls ? "/" + run.options.maxAgentCalls : ""} · 수정 ${run.round}회${cost}`
    : "이번 작업 사용량 · 대기";
  $("#work-usage-panels").replaceChildren(...Object.entries(usage?.byPanel ?? {}).map(([id, row]) => {
    const item = document.createElement("li");
    const team = run.options.team?.find((agent) => agent.id === id);
    const label = team ? `${AI_NAMES[team.provider]} · ${team.roles.map((role) => CAPABILITIES[role]).join(" / ")}` : id;
    const tokens = row.measured ? `입력 ${row.input.toLocaleString()} · 출력 ${row.output.toLocaleString()} (${row.measured}/${row.calls}건 집계)` : "토큰 조회 미지원";
    item.textContent = `${label} · ${row.calls}회 · ${tokens} · 누적 ${((row.elapsedMs ?? 0) / 1000).toFixed(1)}초` + (row.estimatedUsd === undefined ? "" : ` · 추정 $${row.estimatedUsd.toFixed(4)}`);
    return item;
  }));
  const mutation = $("#mutation-summary");
  $("#mutation-details").hidden = !run?.options?.mutation;
  mutation.textContent = "뮤테이션 테스트 · " + (run?.mutation?.summary ?? "기본 테스트 후 실행 대기");
  $("#mutation-command").textContent = [run?.mutation?.command, run?.mutation?.reportPath].filter(Boolean).join(" · ");
  $("#mutation-findings").replaceChildren(...(run?.mutation?.findings ?? []).map((finding) => {
    const item = document.createElement("li");
    item.textContent = `${finding.status} · ${finding.file}:${finding.line ?? "?"} · ${finding.replacement}`;
    return item;
  }));
  mascot.update(run, teamConfig ?? roleAssignments ?? undefined);
  renderInspector(run);
  $("#project-state").textContent = run
    ? (RUN_LABELS[run.status] ?? run.status)
    : "작업 대기";
  $("#run-state-dot").classList.toggle("mint-dot", run?.status === "completed");
  $("#round-indicator").textContent = run
    ? `수정 ${run.round} / ${run.options.maxRepairRounds}회`
    : "수정 라운드 —";
  renderConversationPanels(run);
  renderAssignedRoles();
  if (run?.status === "needs_input")
    $("#run-readiness").textContent =
      "컨트롤 타워의 질문에 대한 답을 요청에 포함해 다시 시작하세요.";
  updateReadiness();
}
$("#choose-folder").addEventListener("click", () =>
  busy($("#choose-folder"), "폴더 선택 중…", async () => {
    const ticket = await call(api.chooseFolder(projectData.activeId));
    if (!ticket) return;
    folderTicket = ticket;
    $("#consent-path").textContent = ticket.root;
    $("#folder-consent-check").checked = false;
    $("#folder-consent").showModal();
  }),
);
$("#cancel-folder-consent").addEventListener("click", () => {
  folderTicket = null;
  $("#folder-consent").close();
});
$("#folder-consent-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!folderTicket) return;
  await busy($("#confirm-folder"), "연결 중…", async () => {
    const data = await call(
      api.grantFolder(
        folderTicket.projectId,
        folderTicket.ticket,
        $("#folder-consent-check").checked,
      ),
    );
    resultCache.delete(folderTicket.projectId);
    folderTicket = null;
    $("#folder-consent").close();
    renderProjects(data);
    toast("선택한 폴더와 하위 폴더를 프로젝트에 연결했습니다.", "success");
  });
});
$("#revoke-folder").addEventListener("click", () =>
  busy($("#revoke-folder"), "접근 해제 중…", async () => {
    const id = projectData.activeId;
    const data = await call(api.revokeFolder(id));
    resultCache.delete(id);
    renderProjects(data);
    toast(
      "작업을 중지하고 폴더 접근 동의를 해제했습니다. 생성물은 폴더에 남아 있습니다.",
    );
  }),
);
$("#open-folder").addEventListener("click", () =>
  busy($("#open-folder"), "여는 중…", () =>
    call(api.openFolder(projectData.activeId)),
  ),
);
$("#show-files").addEventListener("click", () =>
  busy($("#show-files"), "읽는 중…", async () => {
    await refreshWorkspace();
    $("#files-dialog").showModal();
  }),
);
$("#close-files").addEventListener("click", () => $("#files-dialog").close());
$("#start-workflow").addEventListener("click", () =>
  busy($("#start-workflow"), "전송 중…", async () => {
    const projectId = projectData.activeId;
    if (!currentConversation) await loadConversation();
    const conversationId = currentConversation.id;
    const message = $("#planner-input").value.trim();
    if (!message) return;
    const result = await call(
      api.sendMessage(
        projectId,
        conversationId,
        "gpt",
        message,
        $("#controller-mode").value,
        $("#mutation-option").checked,
        selectedImageProvider(),
      ),
    );
    $("#planner-input").value = "";
    if (result.state) {
      $("#mutation-option").checked = false;
      activeRuns.set(projectId, result.state);
      if (
        projectData.activeId === projectId &&
        currentConversation?.id === conversationId
      ) {
        currentConversation.runId = result.state.id;
        renderWorkflow(result.state);
      }
    }
    await loadConversation(conversationId);
    if (currentRun?.status === "awaiting_design" && /마음에\s*안|다시\s*만들|시안\s*수정/.test(message)) view(true);
  }),
);
$("#stop-workflow").addEventListener("click", () =>
  busy($("#stop-workflow"), "중지 중…", async () => {
    renderWorkflow(await call(api.stopWorkflow(projectData.activeId)));
    await refreshWorkspace();
  }),
);
function renderCliLogin(provider, status = {}) {
  const login = status.login ?? {};
  const connected = status.connected === true;
  $(`#${provider}-login`).disabled =
    !status.installed || (connected && provider !== "grok") || login.waiting;
  $(`#${provider}-login`).textContent = login.waiting
    ? "공식 로그인 대기 중…"
    : provider === "grok" && status.installed
      ? "Cursor 로그인 ↗"
      : connected
        ? "터미널 로그인 연결됨"
        : status.installed
          ? "연결하기 ↗"
          : "공식 CLI 설치 필요";
  $(`#${provider}-reauth`).hidden = !connected;
  $(`#${provider}-reauth`).disabled = Boolean(login.waiting);
  $(`#${provider}-login-flow`).hidden = !login.waiting;
  $(`#${provider}-login-browser`).hidden = !login.hasBrowserLink;
  $(`#${provider}-code-form`).hidden = !login.codeRequired;
  if (!login.waiting) $(`#${provider}-code`).value = "";
  if (provider === "grok") $("#grok-reauth").textContent = "기존 연결 확인";
}
async function connectCLI(provider, force = false) {
  const button = $(`#${provider}-${force ? "reauth" : "login"}`);
  await busy(button, "저장된 연결 확인 중…", async () => {
    const result = await call(
      provider === "claude" ? api.claudeLogin(force) : api.grokLogin(force),
    );
    message(
      `#${provider}-message`,
      result.reused
        ? result.message
        : "공식 브라우저에서 로그인과 승인을 완료하세요.",
      result.reused ? "success" : "",
    );
    await refreshStatus();
  });
  if (connection?.[provider]) renderCliLogin(provider, connection[provider]);
}
async function restoreSavedConnections() {
  if (restoring) return null;
  restoring = true;
  $("#session-status").dataset.restoring = "true";
  $("#session-status").textContent = "저장된 연결 확인 중…";
  try {
    const result = await call(api.restoreConnections());
    const count =
      Number(result.gpt.connected) +
      Number(result.claude.connected) +
      Number(result.grok.connected) +
      Number(result.gemini.connected);
    $("#session-status").textContent = count
      ? `${count}개 AI 연결 확인 · 저장된 로그인 사용`
      : "로그인 연결을 선택하세요.";
    $("#session-policy").textContent = result.session.recheckRequired
      ? "7일 미사용 후 재확인 중 일부 연결을 확인하지 못했습니다. 기존 로그인은 유지되며 다시 확인할 수 있습니다."
      : "한 번 연결하면 다음 실행에도 유지합니다. 7일 미사용 후에는 상태를 재확인하고 유효하면 로그인 없이 계속합니다.";
    $("#login-browser").value = result.browser.preferred;
    $("#login-browser option[value=chrome]").disabled =
      !result.browser.chromeAvailable;
    return result;
  } catch (error) {
    $("#session-status").textContent = "저장된 연결 확인이 필요합니다.";
    toast(error.message, "error");
    return null;
  } finally {
    restoring = false;
    $("#session-status").dataset.restoring = "false";
  }
}
for (const provider of ["claude", "grok"]) {
  $(`#${provider}-reauth`).addEventListener("click", () =>
    connectCLI(provider, provider !== "grok"),
  );
  $(`#${provider}-login-browser`).addEventListener("click", () =>
    busy($(`#${provider}-login-browser`), "브라우저 여는 중…", () =>
      call(api.loginBrowser(provider)),
    ),
  );
  $(`#${provider}-cancel-login`).addEventListener("click", () =>
    busy($(`#${provider}-cancel-login`), "취소 중…", async () => {
      await call(api.cancelCliLogin(provider));
      await refreshStatus();
    }),
  );
  $(`#${provider}-code-form`).addEventListener("submit", (event) => {
    event.preventDefault();
    const value = $(`#${provider}-code`).value;
    $(`#${provider}-code`).value = "";
    void busy($(`#${provider}-code-form button`), "확인 중…", async () => {
      await call(api.loginCode(provider, value));
      toast("승인 코드를 공식 CLI에 전달했습니다.");
      await refreshStatus();
    });
  });
}
$("#restore-connections").addEventListener("click", () =>
  busy($("#restore-connections"), "확인 중…", async () => {
    await restoreSavedConnections();
    await refreshStatus();
  }),
);
$("#login-browser").addEventListener("change", async (event) => {
  try {
    await call(api.setBrowser(event.target.value));
    toast("로그인 브라우저 설정을 저장했습니다.");
  } catch (error) {
    toast(error.message, "error");
    $("#login-browser").value = (await call(api.browserSettings())).preferred;
  }
});
$("#load-grok-models").addEventListener("click", () =>
  busy($("#load-grok-models"), "조회 중…", async () => {
    const rows = await call(api.grokModels());
    const selected = connection?.grok.modelId;
    $("#grok-model").replaceChildren(
      new Option("Grok 모델 선택", ""),
      ...rows.map((row) => new Option(row.name, row.id)),
    );
    if (rows.some((row) => row.id === selected))
      $("#grok-model").value = selected;
    if (!rows.length) toast("이 Cursor 계정에서 Grok 모델을 찾지 못했습니다.");
  }),
);
$("#grok-model").addEventListener("change", async (event) => {
  if (!event.target.value) return;
  try {
    await call(api.selectGrokModel(event.target.value));
    await refreshStatus();
    toast(
      "Cursor의 Grok 모델을 저장했습니다. 실행 중인 작업은 시작할 때 선택한 모델을 유지합니다.",
    );
  } catch (error) {
    toast(error.message, "error");
    await refreshStatus();
  }
});
const usageNames = {
  gpt: "GPT · 이 앱의 직접 로그인",
  claude: "Claude · 공식 /usage",
  grok: "Grok · Cursor 계정 사용 한도",
  codex: "Codex CLI · 별도 계정 참고 한도",
  gemini: "Gemini · 공식 한도 확인",
};
const usageLinks = {
  gpt: "gptUsage",
  claude: "claudeUsage",
  grok: "cursorUsage",
  codex: "codexUsage",
  gemini: "gemini",
};
function displayedUsage(provider) {
  if (provider === "gpt" && connection?.gpt.source === "codex") {
    const data = usageData.providers.codex;
    return {
      ...data,
      message:
        "현재 GPT 실행에 사용하는 Codex ChatGPT 계정의 공식 사용 한도입니다. " +
        data.message.replace(
          "이 앱의 GPT 직접 로그인 계정과 같다고 가정하지 않습니다.",
          "",
        ),
    };
  }
  return (
    usageData.providers[provider] ?? {
      state: "unsupported",
      meters: [],
      remainingPercent: null,
      message:
        "이 경로에서 확인된 5시간·주간 잔여 비율이 없습니다. 공식 안내에서 계정 한도를 확인하세요.",
    }
  );
}
function renderUsage(value) {
  usageData = value;
  const nativeGpt = connection?.gpt.source === "codex";
  usageNames.gpt = nativeGpt
    ? "GPT · Codex ChatGPT 실행 계정"
    : "GPT · 이 앱의 직접 로그인";
  $("[data-usage=gpt] small").textContent = nativeGpt
    ? "Codex 실행 계정"
    : "직접 로그인";
  $("[data-usage=codex] small").textContent = nativeGpt
    ? "GPT와 동일 출처"
    : "별도 계정 · 참고";
  for (const provider of ["gpt", "claude", "grok", "gemini", "codex"]) {
    const data = displayedUsage(provider);
    const numeric =
      typeof data.remainingPercent === "number" &&
      Number.isFinite(data.remainingPercent) &&
      data.remainingPercent >= 0 &&
      data.remainingPercent <= 100;
    const windows = quotaWindows(data);
    $("#quota-" + provider).textContent = windows.available
      ? windows.text
      : data.state === "unsupported"
        ? "조회 미지원"
        : "—/—";
    const button = $(`[data-usage=${provider}]`);
    button.hidden =
      provider === "codex"
        ? nativeGpt
        : teamConfig
          ? !teamConfig.some((agent) => agent.provider === provider)
          : false;
    button.classList.toggle("has-quota", numeric);
    button.title = `5시간 / 주간 · ${data.message}${data.checkedAt ? " · " + new Date(data.checkedAt).toLocaleTimeString("ko-KR") : ""}`;
    button.setAttribute(
      "aria-label",
      `${usageNames[provider]} ${$(`#quota-${provider}`).textContent}`,
    );
  }
  $("#usage-refresh-state").textContent = value.checkedAt
    ? `10초 갱신 · ${new Date(value.checkedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false })} 확인`
    : "확인된 값만 표시";
  if ($("#usage-dialog").open) renderUsageDetail();
}
async function refreshUsage(manual) {
  try {
    const value = await call(manual ? api.refreshUsage() : api.pollUsage());
    renderUsage(value);
  } catch {
    if (manual)
      toast("사용량 조회에 실패했습니다. 공급자 연결을 확인하세요.", "error");
  }
}
function renderUsageDetail() {
  if (!usageData) return;
  const data = displayedUsage(usageProvider);
  if (!data) return;
  $("#usage-title").textContent = usageNames[usageProvider];
  $("#usage-description").textContent =
    `${data.message}${data.accountLabel ? " · 계정: " + data.accountLabel : ""}`;
  $("#usage-checked-at").textContent = data.checkedAt
    ? `최근 확인: ${new Date(data.checkedAt).toLocaleString("ko-KR")}`
    : "아직 조회하지 않았습니다.";
  $("#usage-meters").replaceChildren();
  for (const meter of data.meters ?? []) {
    const row = document.createElement("div");
    row.className = "usage-meter-row";
    const text = document.createElement("p");
    text.textContent = `${meter.label}${meter.model ? " · " + meter.model : ""}${meter.surface ? " · " + meter.surface : ""}${meter.windowMinutes ? " · " + meter.windowMinutes + "분 창" : ""}${meter.active === false ? " · 현재 미적용" : ""}`;
    const number = document.createElement("strong");
    number.textContent = `${meter.remainingPercent}% 잔여`;
    const bar = document.createElement("meter");
    bar.min = 0;
    bar.max = 100;
    bar.value = meter.remainingPercent;
    bar.setAttribute("aria-label", `${text.textContent} 잔여 비율`);
    const reset = document.createElement("p");
    reset.className = "hint";
    reset.textContent = meter.resetsAt
      ? `초기화: ${new Date(meter.resetsAt).toLocaleString("ko-KR")}`
      : "초기화 시각 미제공";
    row.append(text, number, bar, reset);
    $("#usage-meters").append(row);
  }
}
document.querySelectorAll("[data-usage]").forEach((button) =>
  button.addEventListener("click", () => {
    usageProvider = button.dataset.usage;
    renderUsageDetail();
    $("#usage-dialog").showModal();
  }),
);
$("#close-usage").addEventListener("click", () => $("#usage-dialog").close());
$("#official-usage-page").addEventListener("click", () =>
  busy($("#official-usage-page"), "여는 중…", () =>
    call(
      api.openLink(
        usageProvider === "gpt" && connection?.gpt.source === "codex"
          ? "codexUsage"
          : usageLinks[usageProvider],
      ),
    ),
  ),
);
$("#refresh-usage").addEventListener("click", () =>
  busy($("#refresh-usage"), "조회 중…", () => refreshUsage(true)),
);
async function noteActivity() {
  if (!api || Date.now() - lastActivity < 30000) return;
  lastActivity = Date.now();
  try {
    const session = await call(api.activity());
    if (session.recheckRequired && !restoring) {
      await restoreSavedConnections();
      await refreshStatus();
    }
  } catch {}
}
document.addEventListener(
  "pointerdown",
  () => {
    void noteActivity();
  },
  { passive: true },
);
document.addEventListener("keydown", () => {
  void noteActivity();
});
window.addEventListener("focus", () => {
  void noteActivity();
  void refreshUsage(false);
});
setInterval(() => {
  if (document.visibilityState === "visible") void refreshUsage(false);
}, 10000);
function renderAssignedRoles() {
  if (usageData) renderUsage(usageData);
  const selected = ACTIVE_RUN.has(currentRun?.status)
    ? (currentRun.options.team ?? defaultTeam(currentRun.options.roles))
    : teamConfig;
  if (!selected) return;
  renderPanelTeam(selected);
  mascot.update(currentRun, teamConfig ?? selected);
  $("#role-summary").textContent = (teamConfig ?? selected)
    .map(
      (agent, index) =>
        String(index + 1).padStart(2, "0") +
        " " +
        AI_NAMES[agent.provider] +
        " · " +
        agent.roles.map((role) => CAPABILITIES[role]).join("/"),
    )
    .join("  |  ");
  for (const agent of selected) {
    const ready =
      agent.provider === "gpt"
        ? connection?.gpt.connected
        : connection?.[agent.provider]?.connected;
    if (!ACTIVE_RUN.has(currentRun?.status))
      pill("#" + agent.id + "-status", ready ? "연결됨" : "연결 필요", ready);
    else if (agent.id === "gpt")
      pill("#gpt-status", RUN_LABELS[currentRun.status] ?? "작업 중", true);
    if (pendingChats.get(agent.id) === currentConversation?.id)
      pill("#" + agent.id + "-status", "응답 중", false);
    if (agent.id !== "gpt") {
      const panel = document.querySelector(
        '[data-agent-panel="' + agent.id + '"]',
      );
      panel.querySelector(".agent-name p").textContent =
        AI_NAMES[agent.provider] + " · 독립 실행 세션";
      const label = panel.querySelector(".worker-footer>span");
      if (label) label.textContent = agent.modelId || "공급자 기본 모델";
    }
  }
  const feature = selected.find((agent) => agent.id === "grok");
  if (feature) {
    const provider = feature.provider;
    const model =
      feature.modelId ||
      (provider === "grok"
        ? connection?.grok.modelId
        : provider === "gemini"
          ? connection?.gemini.modelId
          : provider === "gpt"
            ? $("#gpt-model").value
            : "Claude CLI 기본 모델");
    $("#grok-model-label").textContent =
      model ||
      (provider === "gpt" && connection?.gpt.source === "codex"
        ? "Codex CLI 기본 모델"
        : AI_NAMES[provider] + " 모델 선택 필요");
  }
}
async function openRoles(role = "gpt") {
  if (!projectData) return;
  const id = projectData.activeId;
  try {
    const selected = await call(api.team(id));
    if (projectData.activeId !== id) return;
    rolesDialogProjectId = id;
    renderTeamEditor(selected, panelModelCatalog);
    $("#roles-dialog").showModal();
    document.querySelector("#role-" + role)?.focus();
  } catch (error) {
    toast(error.message, "error");
  }
}
async function panelModelCatalog(provider) {
  if (provider === "gpt") return call(api.models());
  if (provider === "grok") return call(api.grokModels());
  if (provider === "gemini") return call(api.geminiModels());
  return ["sonnet", "opus", "haiku"].map((id) => ({
    id,
    name: `${id} · Claude CLI 공식 별칭`,
  }));
}
$("#open-roles").addEventListener("click", () => openRoles());
document
  .querySelectorAll(".change-role")
  .forEach((button) =>
    button.addEventListener("click", () => openRoles(button.dataset.role)),
  );
for (const id of ["#close-roles", "#close-roles-outside"])
  $(id).addEventListener("click", () => $("#roles-dialog").close());
$("#roles-connections").addEventListener("click", () => {
  $("#roles-dialog").close();
  openConnections();
});
$("#agent-count").addEventListener("change", (event) => {
  try {
    resizeEditor(Number(event.target.value), panelModelCatalog);
  } catch (error) {
    toast(error.message, "error");
  }
});
$("#roles-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const id = rolesDialogProjectId;
  let selection;
  try {
    selection = readTeamEditor();
  } catch (error) {
    toast(error.message, "error");
    return;
  }
  roleSaving = true;
  void busy($("#save-roles"), "저장 중…", async () => {
    const saved = await call(api.setTeam(id, selection));
    if (projectData.activeId === id) {
      teamConfig = saved;
      roleAssignments = Object.fromEntries(
        saved.map((agent) => [agent.id, agent.provider]),
      );
      rolesProjectId = id;
      renderAssignedRoles();
    }
    $("#roles-dialog").close();
    toast("팀 구성을 저장했습니다. 현재 실행은 시작 당시 배치를 유지합니다.");
  }).finally(() => {
    roleSaving = false;
    updateReadiness();
  });
});
function renderGeminiConnection(status = {}) {
  const login = status.login ?? {};
  pill(
    "#gemini-auth-status",
    status.connected
      ? "Google 연결됨"
      : login.waiting
        ? "승인 대기"
        : status.installed
          ? "연결 필요"
          : "설치 필요",
    status.connected,
  );
  $("#gemini-login").disabled = !status.installed || !!login.waiting;
  $("#gemini-login").textContent = login.waiting
    ? "Google 승인 대기 중…"
    : status.connected
      ? "기존 Google 연결 확인"
      : "Google 로그인 ↗";
  $("#gemini-install").hidden = !!status.installed;
  $("#gemini-login-flow").hidden = !login.waiting;
  $("#gemini-login-browser").hidden = !login.hasBrowserLink;
  $("#load-gemini-models").disabled = !status.connected;
  if (
    status.modelId &&
    !Array.from($("#gemini-model").options).some(
      (option) => option.value === status.modelId,
    )
  )
    $("#gemini-model").append(new Option(status.modelId, status.modelId));
  $("#gemini-model").value = status.modelId ?? "";
  if (status.connected)
    message(
      "#gemini-message",
      "Gemini CLI의 Google 인증을 사용합니다. 실행할 모델을 선택하세요.",
      "success",
    );
  else if (!status.installed)
    message(
      "#gemini-message",
      "Node.js 20 이상과 공식 Gemini CLI가 필요합니다. 설치 버튼으로 이 앱의 도구 폴더에 설치할 수 있습니다.",
    );
}
$("#gemini-login").addEventListener("click", async () => {
  await busy($("#gemini-login"), "Google 연결 준비 중…", async () => {
    const result = await call(api.geminiLogin());
    if (result.reused) message("#gemini-message", result.message, "success");
    await refreshStatus();
  });
  if (connection?.gemini) renderGeminiConnection(connection.gemini);
});
$("#gemini-install").addEventListener("click", () =>
  busy($("#gemini-install"), "Gemini CLI 설치 중…", async () => {
    await call(api.installGemini());
    await refreshStatus();
    toast("공식 Gemini CLI를 설치했습니다. Google 로그인을 누르세요.");
  }),
);
$("#gemini-login-browser").addEventListener("click", () =>
  busy($("#gemini-login-browser"), "여는 중…", () =>
    call(api.loginBrowser("gemini")),
  ),
);
$("#gemini-cancel-login").addEventListener("click", () =>
  busy($("#gemini-cancel-login"), "취소 중…", async () => {
    await call(api.cancelCliLogin("gemini"));
    await refreshStatus();
  }),
);
$("#load-gemini-models").addEventListener("click", () =>
  busy($("#load-gemini-models"), "조회 중…", async () => {
    const rows = await call(api.geminiModels());
    const selected = connection?.gemini.modelId;
    $("#gemini-model").replaceChildren(
      new Option("Gemini 모델 선택", ""),
      ...rows.map((row) => new Option(row.name, row.id)),
    );
    if (rows.some((row) => row.id === selected))
      $("#gemini-model").value = selected;
    if (!rows.length) toast("Gemini CLI가 모델 목록을 제공하지 않았습니다.");
  }),
);
$("#gemini-model").addEventListener("change", async (event) => {
  if (!event.target.value) return;
  try {
    await call(api.selectGeminiModel(event.target.value));
    await refreshStatus();
    toast("Gemini 모델을 저장했습니다.");
  } catch (error) {
    toast(error.message, "error");
    await refreshStatus();
  }
});
$("#gpt-model").addEventListener("change", () => {
  renderAssignedRoles();
  updateReadiness();
});
function viewSidebarFile(path) {
  void busy($("#show-files"), "읽는 중…", async () => {
    $("#files-dialog").showModal();
    $("#preview-filename").textContent = path;
    $("#file-preview").textContent = await call(
      api.readFile(projectData.activeId, path),
    );
  });
}
$("#sidebar-file-search").addEventListener("input", () =>
  renderConversationTree(),
);
function toggleSidebar() {
  const visible =
    getComputedStyle(document.querySelector(".project-sidebar")).display !==
    "none";
  document.body.dataset.sidebar = visible ? "off" : "on";
  $("#toggle-sidebar").setAttribute("aria-expanded", String(!visible));
}
$("#toggle-sidebar").addEventListener("click", toggleSidebar);
$("#planner-input").addEventListener("keydown", (event) => {
  if (
    event.key === "Enter" &&
    !event.shiftKey &&
    event.currentTarget.value.trim().toLowerCase() === "/model"
  ) {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.value = "";
    $("#model-button").click();
  }
});
$("#planner-input").addEventListener("keydown", (event) => {
  if (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.isComposing &&
    !event.defaultPrevented
  ) {
    event.preventDefault();
    if (!$("#start-workflow").disabled) $("#start-workflow").click();
  }
});
document.addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey)) return;
  if (event.key === "Enter" && !document.querySelector("dialog[open]")) {
    event.preventDefault();
    if (!$("#start-workflow").disabled) $("#start-workflow").click();
  }
  if (event.key.toLowerCase() === "b") {
    event.preventDefault();
    toggleSidebar();
  }
});

function renderConversationTree() {
  if (!projectData) return;
  conversationTree(projectData, conversationIndex, currentConversation?.id, {
    project: async (id) => {
      try {
        renderProjects(await call(api.selectProject(id)));
      } catch (error) {
        toast(error.message, "error");
      }
    },
    conversation: async (id, conversationId) => {
      try {
        if (projectData.activeId !== id)
          renderProjects(await call(api.selectProject(id)));
        await loadConversation(conversationId);
      } catch (error) {
        toast(error.message, "error");
      }
    },
    create: createConversation,
  });
}
async function refreshConversationIndex() {
  try {
    conversationIndex = await call(api.conversationIndex());
    renderConversationTree();
  } catch (error) {
    toast(error.message, "error");
  }
}
async function loadConversation(id) {
  if (!projectData) return;
  const projectId = projectData.activeId;
  const serial = ++conversationSerial;
  try {
    const data = await call(api.conversation(projectId, id));
    if (projectData.activeId !== projectId || serial !== conversationSerial)
      return;
    currentConversation = data.conversation;
    $("#conversation-title").textContent = currentConversation.title;
    renderWorkflow(data.run);
    await refreshConversationIndex();
  } catch (error) {
    if (serial === conversationSerial) toast(error.message, "error");
  }
}
async function createConversation(projectId = projectData.activeId) {
  try {
    if (projectData.activeId !== projectId)
      renderProjects(await call(api.selectProject(projectId)));
    const data = await call(api.createConversation(projectId));
    await loadConversation(data.id);
    $("#planner-input").focus();
  } catch (error) {
    toast(error.message, "error");
  }
}
function renderConversationPanels(run) {
  for (const actor of SLOT_IDS) {
    const provider =
      AI_NAMES[
        (run?.options?.team ?? teamConfig)?.find((agent) => agent.id === actor)
          ?.provider
      ] ?? "AI";
    const events =
      run?.events?.filter(
        (event) =>
          event.actor === actor ||
          (actor === "gpt" && event.actor === "system"),
      ) ?? [];
    const messages =
      currentConversation?.messages.filter(
        (message) => message.agentId === actor,
      ) ?? [];
    const count = terminalFeed(
      $(actor === "gpt" ? "#planner-events" : "#" + actor + "-events"),
      events,
      messages,
      provider,
    );
    $("#" + (actor === "gpt" ? "planner" : actor) + "-empty").hidden =
      count > 0;
    const pending = pendingChats.get(actor) === currentConversation?.id;
    if (actor !== "gpt") {
      const button = document.querySelector(
        '.send-agent-chat[data-agent="' + actor + '"]',
      );
      button.disabled = pending || !linkedFolder;
      document.querySelector(
        '.stop-agent-chat[data-agent="' + actor + '"]',
      ).hidden = !pending;
    }
    const progress = $("#" + actor + "-progress");
    const buffer = liveBuffers.get(currentConversation?.id + ":" + actor);
    progress.hidden = !buffer;
    if (buffer) progress.textContent = buffer.slice(-20000);
    if (actor !== "gpt" && run) {
      const tasks = run.tasks.filter((task) => task.owner === actor);
      pill(
        "#" + actor + "-status",
        pending
          ? "응답 중"
          : tasks.some((task) => task.status === "working")
            ? "작업 중"
            : tasks.filter((task) => task.status === "reported").length +
              "/" +
              tasks.length +
              " 보고",
        false,
      );
    }
  }
  testingInspector(run);
}
$("#new-conversation").addEventListener("click", () => createConversation());
for (const form of document.querySelectorAll(".agent-chat-form")) {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const actor = form.dataset.agent;
    void busy(form.querySelector(".send-agent-chat"), "전송 중…", async () => {
      if (!currentConversation) await loadConversation();
      const input = $("#" + actor + "-input");
      const message = input.value.trim();
      if (!message) return;
      await call(
        api.sendMessage(
          projectData.activeId,
          currentConversation.id,
          actor,
          message,
          "question",
        ),
      );
      input.value = "";
      await loadConversation(currentConversation.id);
    });
  });
  form.querySelector("textarea").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
}
document
  .querySelectorAll(".stop-agent-chat")
  .forEach((button) =>
    button.addEventListener("click", () =>
      call(api.stopMessage(projectData.activeId, button.dataset.agent)),
    ),
  );
$("#planner-input").addEventListener("input", updateReadiness);
$("#controller-mode").addEventListener("change", () => {
  autoQuestion = false;
  $("#mutation-option").disabled = $("#controller-mode").value !== "work";
  updateReadiness();
});
$("#open-settings").addEventListener("click", async () => {
  preferences = await call(api.preferences());
  fillPreferences(preferences);
  $("#settings-dialog").showModal();
});
let checkpointProject;
let checkpointToken;
async function previewCheckpoint() {
  const id = $("#checkpoint-select").value;
  checkpointToken = null;
  $("#confirm-checkpoint").disabled = true;
  $("#checkpoint-preview").textContent = "";
  if (!id) return;
  const project = checkpointProject;
  const result = await call(api.restoreCheckpoint(project, id, null));
  if (project !== checkpointProject || id !== $("#checkpoint-select").value) return;
  const labels = { restore: "복원", delete: "생성 파일 삭제", conflict: "사용자 변경과 충돌", unchanged: "변경 없음" };
  $("#checkpoint-preview").textContent = result.preview.map((row) => `${labels[row.action]} · ${row.path}`).join("\n") || "되돌릴 변경이 없습니다.";
  checkpointToken = result.canRestore ? result.token : null;
  $("#confirm-checkpoint").disabled = !checkpointToken;
}
async function refreshVerifiedCheckpoint(id) {
  const marker = await call(api.verifiedCheckpoint(id)).catch(() => null);
  if (projectData?.activeId !== id) return;
  $("#verified-checkpoint-label").textContent = marker
    ? "마지막 검증 통과 · " + new Date(marker.at).toLocaleString()
    : "검증 통과 기록 없음";
  $("#restore-verified").hidden = !marker;
}
async function openCheckpoint(selection = "") {
  checkpointProject = projectData.activeId;
  const rows = await call(api.checkpoints(checkpointProject));
  const select = $("#checkpoint-select");
  select.replaceChildren(new Option("변경 묶음을 선택하세요", ""));
  for (const row of rows.filter((entry) => entry.status !== "reverted"))
    select.add(new Option(`${row.label} · ${new Date(row.at).toLocaleString()}${row.status === "committed" ? "" : " · 복구 확인"}`, row.id));
  if (selection) {
    select.add(new Option(selection === "verified" ? "마지막 검증 통과 상태" : "이 작업의 변경 전 상태", selection));
    select.value = selection;
  }
  await previewCheckpoint();
  if (!selection && !rows.length) $("#checkpoint-preview").textContent = "저장된 변경 묶음이 없습니다.";
  $("#checkpoints-dialog").showModal();
}
for (const [selector, scope] of [
  ["#open-checkpoints", () => ""],
  ["#restore-verified", () => "verified"],
  ["#rollback-run", () => "run:" + currentRun.id],
]) {
  $(selector).addEventListener("click", () => busy($(selector), "불러오는 중…", () => openCheckpoint(scope())));
}
$("#checkpoint-select").addEventListener("change", () => {
  previewCheckpoint().catch((error) => toast(error.message, "error"));
});
$("#close-checkpoints").addEventListener("click", () => $("#checkpoints-dialog").close());
$("#confirm-checkpoint").addEventListener("click", () => busy($("#confirm-checkpoint"), "복원 중…", async () => {
  const result = await call(api.restoreCheckpoint(checkpointProject, $("#checkpoint-select").value, checkpointToken));
  if (!result.id) {
    await previewCheckpoint();
    throw new Error("파일 상태가 바뀌어 복원하지 않았습니다.");
  }
  $("#checkpoints-dialog").close();
  await refreshWorkspace();
  toast("선택한 변경을 복원했습니다. 새 작업에서 다시 검증하세요.");
}));
$("#close-settings").addEventListener("click", () =>
  $("#settings-dialog").close(),
);
$("#settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void busy($("#save-settings"), "저장 중…", async () => {
    preferences = await call(api.savePreferences(readPreferences()));
    fillPreferences(preferences);
    $("#settings-dialog").close();
    toast("작업 환경 설정을 저장했습니다.");
    updateReadiness();
  });
});
$("#show-test-report").addEventListener("click", () =>
  busy($("#show-test-report"), "불러오는 중…", async () => {
    $("#test-report-content").textContent =
      (currentRun?.testing?.stale
        ? "이전 실행 결과입니다. 소스 변경 후 재검증 전까지 현재 코드의 통과로 인정하지 않습니다.\n\n"
        : "") +
      (await call(api.testReport(projectData.activeId, currentRun.id)));
    $("#test-report-dialog").showModal();
  }),
);
$("#stop-controller-chat").addEventListener("click", () =>
  call(api.stopMessage(projectData.activeId, "gpt")),
);
$("#close-test-report").addEventListener("click", () =>
  $("#test-report-dialog").close(),
);
$("#test-permissions").addEventListener("click", () =>
  $("#open-settings").click(),
);
$("#rerun-tests").addEventListener("click", () =>
  busy($("#rerun-tests"), "실행 중…", async () => {
    renderWorkflow(
      await call(api.rerunTests(projectData.activeId, currentRun.id)),
    );
  }),
);
let renderedGptSource = null;
function renderCodexConnection(status) {
  const cli = status.codex;
  $("#gpt-source").value = status.gpt.source;
  pill(
    "#codex-auth-status",
    cli.connected
      ? "현재 PC 로그인됨"
      : cli.installed
        ? "로그인 필요"
        : "설치 필요",
    cli.connected,
  );
  $("#codex-login").disabled = !cli.installed || cli.login?.waiting;
  $("#codex-reauth").disabled = !cli.installed || cli.login?.waiting;
  $("#codex-login-flow").hidden = !cli.login?.waiting;
  $("#codex-login-browser").hidden = !cli.login?.hasBrowserLink;
  $("#security-notice").textContent = status.securityNotice ?? "";
  if (cli.connected)
    message(
      "#codex-message",
      "현재 OS 사용자의 ChatGPT 구독을 사용합니다. 같은 GPT로 여러 패널을 배정해도 로그인은 한 번이면 됩니다.",
      "success",
    );
  if (renderedGptSource && renderedGptSource !== status.gpt.source)
    $("#gpt-model").replaceChildren(new Option("GPT 모델 선택", ""));
  renderedGptSource = status.gpt.source;
  if (
    status.gpt.modelId &&
    !Array.from($("#gpt-model").options).some(
      (option) => option.value === status.gpt.modelId,
    )
  )
    $("#gpt-model").append(new Option(status.gpt.modelId, status.gpt.modelId));
  if (status.gpt.modelId && !$("#gpt-model").value)
    $("#gpt-model").value = status.gpt.modelId;
}
async function connectCodex(force = false) {
  await busy(
    $(force ? "#codex-reauth" : "#codex-login"),
    "연결 확인 중…",
    async () => {
      const result = await call(api.codexLogin(force));
      message(
        "#codex-message",
        result.reused
          ? result.message
          : "공식 ChatGPT 브라우저에서 승인을 완료하세요.",
      );
      await refreshStatus();
    },
  );
  if (connection) renderCodexConnection(connection);
}
$("#codex-login").addEventListener("click", () => connectCodex());
$("#codex-reauth").addEventListener("click", () => connectCodex(true));
$("#codex-login-browser").addEventListener("click", () =>
  busy($("#codex-login-browser"), "여는 중…", () =>
    call(api.loginBrowser("codex")),
  ),
);
$("#codex-cancel-login").addEventListener("click", () =>
  busy($("#codex-cancel-login"), "취소 중…", async () => {
    await call(api.cancelCliLogin("codex"));
    await refreshStatus();
  }),
);
$("#gpt-source").addEventListener("change", (event) => {
  const source = event.target.value;
  void busy($("#codex-login"), "경로 저장 중…", async () => {
    await call(api.setGptSource(source));
    await refreshStatus();
  });
});
$("#gpt-model").addEventListener("change", () => {
  void call(api.saveGptModel($("#gpt-model").value)).catch((error) =>
    toast(error.message, "error"),
  );
});
$("#startup-dialog").addEventListener("cancel", (event) =>
  event.preventDefault(),
);
const tourSteps = [
  ["새 프로젝트", "상단 또는 왼쪽의 새 프로젝트에서 작업 폴더를 선택하세요. 왼쪽에서 프로젝트별 대화를 다시 열 수 있습니다."],
  ["계정 연결과 AI 역할 변경", "계정 연결에서 기존 CLI 연결을 확인하세요. AI 역할 변경에서 컨트롤 타워와 기능 구현, UI, 테스트 담당을 정합니다."],
  ["컨트롤 타워에서 작업 요청", "가장 위 패널에 원하는 기능을 입력하고 작업 요청을 누르세요. /fun이 요구사항과 완료 기준을 정리해 담당 AI에 전달합니다."],
  ["테스트와 진행 상황", "각 AI 패널에서 작업 출력을 보고 오른쪽에서 진행 상태를 확인하세요. 뮤테이션 테스트는 기본 테스트가 통과한 뒤 실행됩니다. 검증과 최종 검토가 끝나면 상단에 완료가 표시됩니다."],
];
const tourTargets = ["#new-project", "#open-roles", "#planner-input", "#inspector-state"];
let tourStep = 0;
function showTourStep() {
  document.querySelector(".tour-target")?.classList.remove("tour-target");
  $(tourTargets[tourStep])?.classList.add("tour-target");
  const [title, detail] = tourSteps[tourStep];
  $("#tour-count").textContent = `HANDSOFF GUIDE · ${tourStep + 1} / ${tourSteps.length}`;
  $("#tour-title").textContent = title;
  $("#tour-detail").textContent = detail;
  $("#tour-next").textContent = tourStep === tourSteps.length - 1 ? "마치기" : "다음 →";
}
function startTour() {
  tourStep = 0;
  showTourStep();
  $("#first-run-tour").showModal();
  $("#tour-next").focus();
}
function finishTour() {
  document.querySelector(".tour-target")?.classList.remove("tour-target");
  localStorage.setItem("tower-tour-v1", "complete");
  $("#first-run-tour").close();
  if (!preferences?.onboardingComplete) $("#settings-dialog").showModal();
}
$("#tour-next").addEventListener("click", () => {
  if (tourStep === tourSteps.length - 1) finishTour();
  else {
    tourStep++;
    showTourStep();
  }
});
$("#tour-skip").addEventListener("click", finishTour);
$("#first-run-tour").addEventListener("cancel", (event) => {
  event.preventDefault();
  finishTour();
});
$("#replay-tour").addEventListener("click", () => {
  $("#guide-dialog").close();
  startTour();
});
$("#open-guide").addEventListener("click", () =>
  $("#guide-dialog").showModal(),
);
$("#close-guide").addEventListener("click", () => $("#guide-dialog").close());
function renderDelivery(result) {
  $("#services-result").textContent = result
    ? [result.message, result.github?.url, result.vercel?.url]
        .filter(Boolean)
        .join(" · ")
    : "";
  $("#retry-delivery").hidden =
    !result || !["failed", "running"].includes(result.status);
  if (result?.pending) showReleaseApproval(result.pending);
}

let releaseApproval;
function showReleaseApproval(pending) {
  const dialog = $("#release-approval");
  if (dialog.open && releaseApproval?.id === pending.id) return;
  releaseApproval = { id: pending.id, projectId: projectData.activeId };
  $("#release-approval-title").textContent = `${pending.action}할까요?`;
  $("#release-approval-target").textContent =
    `${pending.projectTitle} → ${pending.target}`;
  $("#release-remember").checked = false;
  $("#release-remember-label").textContent =
    pending.service === "github"
      ? "이 프로젝트에서 다음부터 묻지 않고 커밋·푸시하기"
      : "이 프로젝트에서 다음부터 묻지 않고 배포하기";
  if (!dialog.open) dialog.showModal();
}

for (const yes of [false, true]) {
  $(yes ? "#release-yes" : "#release-no").addEventListener(
    "click",
    async () => {
      if (!releaseApproval) return;
      const { id, projectId } = releaseApproval;
      releaseApproval = null;
      const remember = yes && $("#release-remember").checked;
      $("#release-approval").close();
      try {
        await call(api.servicesAnswer(projectId, { id, yes, remember }));
      } catch (error) {
        toast(error.message, "error");
      }
    },
  );
}

let servicesProjectId;
async function loadServices() {
  const id = servicesProjectId;
  const { accounts, config, name, result } = await call(api.servicesStatus(id));
  if (id !== servicesProjectId) return;
  for (const [service, status] of Object.entries(accounts)) {
    $(`#service-${service}`).textContent =
      status.account ??
      (status.installed ? "로그인 필요" : "공식 CLI 설치 필요");
    $(`[data-service-login="${service}"]`).disabled = !status.installed;
  }
  $("#service-auto-github").checked = config?.github ?? false;
  $("#service-auto-vercel").checked = config?.vercel ?? false;
  $("#service-repo-name").value = config?.name || "";
  $("#service-repo-name").placeholder =
    config?.resolvedName || "AI가 이름 제안 · 예: " + name;
  $("#service-scope").value = config?.scope || accounts.vercel.account || "";
  $("#service-target").value = config?.target || name;
  $("#service-production").checked = config?.production ?? false;
  $("#service-supabase-ref").value = config?.supabaseRef ?? "";
  renderApprovalPolicy(config);
  renderDelivery(result);
}

function renderApprovalPolicy(config) {
  const automatic = [
    config?.always?.github && "GitHub",
    config?.always?.vercel && "Vercel",
  ].filter(Boolean);
  $("#service-approval-policy").textContent = automatic.length
    ? `${automatic.join(" · ")} 자동 승인 중 · 배포 대상이 바뀌면 다시 확인합니다.`
    : "검증이 끝나면 서비스마다 실행 여부를 확인합니다.";
  $("#reset-release-approval-label").hidden = !automatic.length;
  $("#reset-release-approval").checked = false;
}

$("#open-services").addEventListener("click", () => {
  const project = projectData?.items.find(
    (row) => row.id === projectData.activeId,
  );
  if (!project) return;
  servicesProjectId = project.id;
  $("#services-project").textContent = project.title;
  $("#save-services").disabled = true;
  $("#services-dialog").showModal();
  $("#refresh-services").click();
});
$("#close-services").addEventListener("click", () =>
  $("#services-dialog").close(),
);
$("#refresh-services").addEventListener("click", () =>
  busy($("#refresh-services"), "확인 중…", async () => {
    $("#save-services").disabled = true;
    await loadServices();
    $("#save-services").disabled = false;
  }),
);
for (const button of document.querySelectorAll("[data-service-login]")) {
  button.addEventListener("click", () =>
    busy(button, "여는 중…", async () => {
      await call(api.servicesLogin(button.dataset.serviceLogin));
      $("#services-result").textContent =
        "로그인 창에서 완료한 뒤 연결 상태를 다시 확인하세요.";
    }),
  );
}
$("#services-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void busy($("#save-services"), "저장 중…", async () => {
    try {
      const config = await call(
        api.servicesSave(servicesProjectId, {
          github: $("#service-auto-github").checked,
          vercel: $("#service-auto-vercel").checked,
          name: $("#service-repo-name").value,
          scope: $("#service-scope").value,
          target: $("#service-target").value,
          production: $("#service-production").checked,
          supabaseRef: $("#service-supabase-ref").value,
          resetApproval: $("#reset-release-approval").checked,
        }),
      );
      $("#services-result").textContent =
        "저장했습니다. 다음 작업부터 적용합니다.";
      renderApprovalPolicy(config);
    } catch (error) {
      $("#services-result").textContent = error.message;
    }
  });
});
$("#retry-delivery").addEventListener("click", () =>
  busy($("#retry-delivery"), "다시 시도 중…", async () => {
    try {
      await call(api.servicesRetry(servicesProjectId));
    } catch (error) {
      $("#services-result").textContent = error.message;
    }
  }),
);
await initialize();
