import { PROVIDERS } from "../core/team.js";
const openFolders = new Map();
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
export function conversationTree(projects, index, activeId, actions) {
  const root = document.querySelector("#sidebar-projects");
  root.replaceChildren();
  const query = document
    .querySelector("#sidebar-file-search")
    .value.toLowerCase();
  for (const project of projects.items) {
    const rows = (index?.items ?? [])
      .filter((row) => row.projectId === project.id && !row.archived)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const matching = rows.filter(
      (row) =>
        !query ||
        row.title.toLowerCase().includes(query) ||
        project.title.toLowerCase().includes(query),
    );
    if (query && !matching.length) continue;
    const group = el("section", undefined, "project-group");
    group.dataset.project = project.id;
    const heading = el("div", undefined, "folder-heading");
    const expanded =
      Boolean(query) ||
      (openFolders.get(project.id) ?? project.id === projects.activeId);
    const arrow = el("button", expanded ? "⌄" : "›", "folder-toggle");
    arrow.setAttribute("aria-label", project.title + " 대화 목록");
    arrow.setAttribute("aria-expanded", String(!!expanded));
    arrow.onclick = () => {
      openFolders.set(project.id, !expanded);
      conversationTree(projects, index, activeId, actions);
    };
    const folder = el("button", "▱ " + project.title, "project-folder");
    folder.title = project.workspace?.root ?? "작업 폴더 연결 필요";
    folder.classList.toggle("selected", project.id === projects.activeId);
    folder.onclick = () => {
      openFolders.set(project.id, true);
      actions.project(project.id);
    };
    const add = el("button", "＋", "folder-add-chat");
    add.title = project.title + "에 새 대화";
    add.onclick = () => actions.create(project.id);
    heading.append(arrow, folder, add);
    group.append(heading);
    if (expanded) {
      const list = el("div", undefined, "conversation-list");
      for (const row of matching) {
        const button = el("button", row.title, "conversation-row");
        button.dataset.conversation = row.id;
        button.classList.toggle("selected", row.id === activeId);
        button.title = new Date(row.updatedAt).toLocaleString("ko-KR");
        button.onclick = () => actions.conversation(project.id, row.id);
        list.append(button);
      }
      if (!matching.length)
        list.append(el("p", "대화를 시작해 보세요.", "hint"));
      group.append(list);
    }
    root.append(group);
  }
}
export function terminalFeed(container, events, messages, provider) {
  const follow =
    container.scrollHeight - container.scrollTop - container.clientHeight < 70;
  const expanded = new Set(
    [...container.querySelectorAll("details[open]")].map(
      (node) => node.dataset.key,
    ),
  );
  const entries = [
    ...events.map((event, index) => ({
      ...event,
      kind: "event",
      key: `event:${event.at}:${index}`,
    })),
    ...messages.map((message) => ({
      ...message,
      kind: "chat",
      key: message.id,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  container.replaceChildren();
  container.hidden = !entries.length;
  for (const item of entries) {
    const row = el(
      "div",
      undefined,
      `terminal-entry ${item.kind === "chat" ? "chat-" + item.role : "work-event"}`,
    );
    row.dataset.key = item.key;
    const meta = el("div", undefined, "terminal-entry-meta");
    const time = el(
      "time",
      new Date(item.at).toLocaleTimeString("ko-KR", { hour12: false }),
    );
    const who =
      item.kind === "chat"
        ? item.role === "user"
          ? "나"
          : item.role === "assistant"
            ? (PROVIDERS[item.provider] ?? provider)
            : "시스템"
        : item.actor === "system"
          ? "SYSTEM"
          : (PROVIDERS[item.provider] ?? provider);
    meta.append(time, el("span", who));
    row.append(meta);
    row.append(
      el(
        "p",
        item.kind === "chat" ? item.content : item.message,
        "terminal-entry-text",
      ),
    );
    if (item.questions?.length)
      row.append(el("pre", item.questions.join("\n")));
    if (item.issues?.length)
      row.append(
        el(
          "pre",
          item.issues
            .map((issue) => `${issue.taskId} · ${issue.description}`)
            .join("\n"),
        ),
      );
    if (item.preview !== undefined) {
      const details = el("details", undefined, "code-preview");
      details.dataset.key = item.key;
      details.open = expanded.has(item.key);
      details.append(
        el(
          "summary",
          `↳ ${item.path} · 저장한 코드${item.previewTruncated ? " (일부)" : ""}`,
        ),
        el("pre", item.preview),
      );
      row.append(details);
    }
    container.append(row);
  }
  if (follow) container.scrollTop = container.scrollHeight;
  return entries.length;
}
export function testingInspector(run) {
  const status = document.querySelector("#testing-status"),
    summary = document.querySelector("#testing-summary"),
    list = document.querySelector("#testing-cases");
  list.replaceChildren();
  const testing = run?.testing;
  status.textContent =
    {
      planned: "설계 완료",
      writing: "코드 작성 중",
      ready: "실행 준비",
      running: "실행 중",
      permission: "실행 동의 필요",
      passed: "통과",
      failed: "실패·미확인",
      cancelled: "중지됨",
    }[testing?.status] ?? "미선택";
  summary.textContent = testing
    ? `${testing.plan.cases.length}개 시나리오 · ${testing.plan.files.length}개 테스트 파일${testing.stale ? " · 코드 변경 후 재검증이 필요합니다." : testing.result ? " · " + testing.result.summary : ""}`
    : "역할 설정에서 테스트를 체크하면 시나리오·코드·재현 절차를 준비합니다.";
  for (const row of testing?.plan.cases ?? []) {
    const result =
      testing.stale ||
      ["writing", "running", "planned", "ready"].includes(testing.status)
        ? null
        : testing.result?.cases?.find((item) => item.id === row.id);
    const item = el("li", undefined, "test-case-row");
    const detail = el("details");
    detail.append(
      el(
        "summary",
        `${result?.status === "passed" ? "✓" : result?.status === "failed" ? "✕" : "○"} ${row.id} ${row.title}`,
      ),
      el("p", `기대 결과: ${row.expected}`),
    );
    const steps = el("ol");
    for (const step of row.steps) steps.append(el("li", step));
    detail.append(steps);
    item.append(detail);
    list.append(item);
  }
  document.querySelector("#show-test-report").hidden = !testing?.result;
  document.querySelector("#show-test-report").textContent = testing?.stale
    ? "이전 결과·재현 절차 ↗"
    : "결과·재현 절차 ↗";
  document.querySelector("#test-permissions").hidden =
    !testing?.result?.requiresConsent;
  document.querySelector("#rerun-tests").hidden =
    run?.options?.mutation === true ||
    !testing?.result ||
    [
      "planning",
      "building",
      "testing",
      "validating",
      "repairing",
      "reviewing",
      "final_review",
    ].includes(run.status);
}
