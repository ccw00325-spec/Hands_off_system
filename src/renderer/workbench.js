import {
  CAPABILITIES,
  PROVIDERS,
  SLOT_IDS,
  resizeTeam,
  validateTeam,
  defaultTeam,
} from "../core/team.js";
import { providerIcon } from "./provider-icon.js";
const $ = (selector) => document.querySelector(selector);
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
export { renderTeamEditor, readTeamEditor, resizeEditor, refreshEditorModels } from "./role-editor.js";
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
    panel.querySelector(".agent-icon").replaceChildren(providerIcon(agent.provider,28));
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
  $("#inspector-state").textContent =
    {
      planning: "명세 설계 중",
      building: "기능 구현 중",
      testing: "테스트 작성 중",
      validating: "테스트 실행 중",
      reviewing: "코드 검토 중",
      repairing: "문제 수정 중",
      awaiting_design: "UI 시안 승인 대기",
      final_review: "최종 검토 중",
      completed: "완료",
      awaiting_validation: "검증 대기",
      needs_attention: "확인 필요",
      needs_input: "추가 정보 필요",
      cancelled: "중지",
      interrupted: "중단됨",
    }[run?.status] ?? "대기";
  const tasks = $("#inspector-tasks");
  tasks.replaceChildren();
  for (const task of run?.tasks ?? []) {
    const item = node("li", undefined, "inspector-task");
    item.append(
      node(
        "span",
        {
          pending: "대기",
          working: "진행 중",
          reported: "완료 보고",
          failed: "오류로 중단",
          cancelled: "중지됨",
          blocked: "진행 차단",
        }[task.status] ?? task.status,
        "task-state",
      ),
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
