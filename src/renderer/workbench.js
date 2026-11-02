import {
  CAPABILITIES,
  PROVIDERS,
  SLOT_IDS,
  resizeTeam,
  validateTeam,
  defaultTeam,
} from "../core/team.js";
const $ = (selector) => document.querySelector(selector);
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
export function renderTeamEditor(team, catalog) {
  $("#agent-count").value = String(team.length);
  const container = $("#team-editor");
  container.replaceChildren();
  for (const [index, agent] of team.entries()) {
    const field = node("fieldset", undefined, "role-setting team-member");
    field.dataset.agent = agent.id;
    field.append(
      node(
        "legend",
        `${String(index + 1).padStart(2, "0")} · ${index ? "작업 세션" : "컨트롤 타워"}`,
      ),
    );
    const label = node("label", "사용할 AI");
    label.htmlFor = `role-${agent.id}`;
    const select = node("select");
    select.id = `role-${agent.id}`;
    select.append(
      ...Object.entries(PROVIDERS).map(([id, name]) => new Option(name, id)),
    );
    select.value = agent.provider;
    field.append(label, select);
    const modelLabel = node("label", "이 패널의 모델");
    modelLabel.htmlFor = `panel-model-${agent.id}`;
    const models = node("select");
    models.id = `panel-model-${agent.id}`;
    models.className = "panel-model";
    models.append(new Option("공급자 기본 설정 사용", ""));
    if (agent.modelId) {
      models.append(new Option(agent.modelId, agent.modelId));
      models.value = agent.modelId;
    }
    const load = node("button", "모델 조회 ↻", "text-button");
    load.type = "button";
    const status = node(
      "p",
      "현재 계정이 제공하는 목록을 조회합니다. Claude는 공식 CLI 별칭입니다.",
      "hint",
    );
    select.addEventListener("change", () => {
      models.replaceChildren(new Option("공급자 기본 설정 사용", ""));
      status.textContent =
        "AI를 변경했습니다. 모델을 선택하거나 기본 설정을 사용하세요.";
    });
    load.addEventListener("click", async () => {
      const provider = select.value;
      load.disabled = true;
      status.textContent = "모델 목록을 확인하고 있습니다…";
      try {
        const rows = (await catalog?.(provider)) ?? [];
        if (select.value !== provider) return;
        const current = models.value;
        models.replaceChildren(
          new Option("공급자 기본 설정 사용", ""),
          ...rows.map((row) => new Option(row.name ?? row.id, row.id)),
        );
        if (rows.some((row) => row.id === current)) models.value = current;
        status.textContent = rows.length
          ? `${rows.length}개 모델 · 실제 사용 권한과 한도는 실행 시 확인됩니다.`
          : "목록이 없습니다. 계정 연결을 확인하세요.";
      } catch (error) {
        status.textContent = error.message;
      } finally {
        load.disabled = false;
      }
    });
    const modelRow = node("div", undefined, "action-row");
    modelRow.append(models, load);
    field.append(modelLabel, modelRow, status);
    const checks = node("div", undefined, "role-checks");
    for (const [role, name] of Object.entries(CAPABILITIES)) {
      const wrapper = node("label", undefined, "check-label");
      const input = node("input");
      input.type = "checkbox";
      input.value = role;
      input.checked = agent.roles.includes(role);
      input.disabled = role === "control";
      wrapper.append(input, document.createTextNode(name));
      checks.append(wrapper);
    }
    field.append(checks);
    container.append(field);
  }
}
export function readTeamEditor() {
  return validateTeam(
    [...$("#team-editor").querySelectorAll("[data-agent]")].map((field) => ({
      id: field.dataset.agent,
      provider: field.querySelector("select").value,
      roles: [...field.querySelectorAll("input:checked")].map(
        (input) => input.value,
      ),
      ...(field.querySelector(".panel-model").value
        ? { modelId: field.querySelector(".panel-model").value }
        : {}),
    })),
  );
}
export function resizeEditor(count, catalog) {
  let current;
  try {
    current = readTeamEditor();
  } catch {
    current = [...$("#team-editor").querySelectorAll("[data-agent]")].map(
      (field) => ({
        id: field.dataset.agent,
        provider: field.querySelector("select").value,
        roles:
          field.dataset.agent === "gpt"
            ? ["control", "debug"]
            : ["feature", "ui"],
      }),
    );
  }
  const value = resizeTeam(current, count);
  renderTeamEditor(value, catalog);
  return value;
}
export function renderPanelTeam(team) {
  const workers = document.querySelector(".workers");
  workers.dataset.count = String(team.length - 1);
  document.body.dataset.agents = String(team.length);
  for (const id of SLOT_IDS) {
    const panel =
      id === "gpt" ? $(".planner") : $(`[data-agent-panel="${id}"]`);
    if (!panel) continue;
    const agent = team.find((row) => row.id === id);
    panel.hidden = !agent;
    if (!agent) continue;
    const heading = panel.querySelector("h2 strong");
    heading.textContent = PROVIDERS[agent.provider];
    panel.querySelector(".agent-icon").textContent = {
      gpt: "G",
      grok: "/",
      claude: "✳",
      gemini: "✦",
    }[agent.provider];
    panel.querySelector("h2 span").textContent = agent.roles
      .map((role) => CAPABILITIES[role])
      .join(" · ");
    if (id !== "gpt") {
      panel.querySelector(".worker-empty .secondary").textContent =
        `${PROVIDERS[agent.provider]}의 독립 세션 · ${agent.roles.map((role) => CAPABILITIES[role]).join(" / ")}`;
    }
  }
}
export function renderInspector(run) {
  $("#inspector-state").textContent = run?.status ?? "대기";
  const tasks = $("#inspector-tasks");
  tasks.replaceChildren();
  for (const task of run?.tasks ?? []) {
    const item = node("li", undefined, "inspector-task");
    item.append(
      node("span", task.status, "task-state"),
      node("strong", task.title || task.id),
      node("small", `${task.owner} · ${task.kind ?? "작업"}`),
    );
    tasks.append(item);
  }
  if (!tasks.children.length)
    tasks.append(
      node("li", "명세가 준비되면 작업 단위와 담당자가 표시됩니다.", "hint"),
    );
  const requirements = $("#inspector-requirements");
  requirements.textContent = run
    ? `${run.requirements?.length ?? 0}개 기능 · ${run.decisions?.length ?? 0}개 결정 · ${run.governance?.contractVersion ? "Fun 계약 검증" : "기존 명세"}`
    : "Context · Trigger · Reaction과 완료 기준을 확인합니다.";
  for (const requirement of run?.requirements ?? []) {
    const detail = node("details");
    detail.append(node("summary", `${requirement.id} · ${requirement.title}`));
    for (const [name, value] of [
      ["조건", requirement.context],
      ["입력", requirement.trigger],
      ["반응", requirement.reaction],
    ])
      detail.append(node("p", `${name}: ${value}`));
    const criteria = node("ul");
    for (const item of requirement.acceptanceCriteria ?? [])
      criteria.append(node("li", item));
    detail.append(criteria);
    requirements.append(detail);
  }
  for (const decision of run?.decisions ?? [])
    requirements.append(
      node(
        "p",
        `${decision.source === "user" ? "사용자 입력" : "구현 가정"} · ${decision.description}`,
      ),
    );
  const review = $("#inspector-review");
  review.replaceChildren();
  for (const item of run?.reviewItems ?? [])
    review.append(node("li", item.description));
  if (!review.children.length)
    review.append(
      node(
        "li",
        run
          ? "검토할 미정 항목이 없습니다."
          : "실행 후 검토 항목을 표시합니다.",
        "hint",
      ),
    );
  const changes = $("#inspector-changes");
  changes.replaceChildren();
  const paths = [
    ...new Set((run?.events ?? []).map((event) => event.path).filter(Boolean)),
  ];
  for (const path of paths) changes.append(node("li", path));
  if (!paths.length)
    changes.append(node("li", "아직 저장된 변경 없음", "hint"));
}
export function renderSidebarProjects(data, onSelect) {
  const list = $("#sidebar-projects");
  list.replaceChildren();
  for (const project of data.items) {
    const button = node("button", project.title, "sidebar-project");
    button.classList.toggle("selected", project.id === data.activeId);
    button.addEventListener("click", () => onSelect(project.id));
    list.append(button);
  }
}
export function renderSidebarFiles(tree, onFile) {
  const list = $("#sidebar-files");
  list.replaceChildren();
  const query = $("#sidebar-file-search").value.toLowerCase();
  for (const file of tree?.files ?? []) {
    if (file.type === "directory" || !file.path.toLowerCase().includes(query))
      continue;
    const button = node("button", file.path, "sidebar-file");
    button.title = file.path;
    button.addEventListener("click", () => onFile(file.path));
    list.append(button);
  }
  if (!list.children.length)
    list.append(
      node(
        "p",
        tree
          ? "표시할 파일이 없습니다."
          : "폴더를 연결하면 파일을 볼 수 있습니다.",
        "hint",
      ),
    );
}
export { resizeTeam, defaultTeam };
