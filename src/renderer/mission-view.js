import { missionState, PHASE_LABELS } from "./mission-state.js";
import { PROVIDERS, CAPABILITIES } from "../core/team.js";

const $ = (selector) => document.querySelector(selector);
function element(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}
export function createMission({ onAction, onMode, onSelect }) {
  let input = {},
    model = missionState(null),
    selected = "gpt",
    selectedTask = null;
  let mode = "focus",
    signature = "",
    context = "",
    tabSignature = "";
  const graph = $("#mission-graph"),
    svg = $("#mission-edges");
  let drawing = false;
  function drawEdges() {
    if (drawing) return;
    drawing = true;
    requestAnimationFrame(() => {
      drawing = false;
      const bounds = graph.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      svg.setAttribute("viewBox", `0 0 ${bounds.width} ${bounds.height}`);
      svg.replaceChildren();
      const defs = document.createElementNS(svg.namespaceURI, "defs");
      const marker = document.createElementNS(svg.namespaceURI, "marker");
      for (const [name, value] of Object.entries({
        id: "mission-arrow",
        viewBox: "0 0 10 10",
        refX: "8",
        refY: "5",
        markerWidth: "5",
        markerHeight: "5",
        orient: "auto",
      }))
        marker.setAttribute(name, value);
      const tip = document.createElementNS(svg.namespaceURI, "polygon");
      tip.setAttribute("points", "0,0 10,5 0,10");
      marker.append(tip);
      defs.append(marker);
      svg.append(defs);
      const nodes = new Map(
        [...graph.querySelectorAll("[data-node]")].map((node) => [
          node.dataset.node,
          node,
        ]),
      );
      const link = (from, to) => {
        const a = nodes.get(from),
          b = nodes.get(to);
        if (!a || !b) return;
        const aa = a.getBoundingClientRect(),
          bb = b.getBoundingClientRect();
        const horizontal = Math.abs(aa.top - bb.top) < 10;
        const x1 =
          (horizontal ? aa.right : aa.left + aa.width / 2) - bounds.left;
        const y1 =
          (horizontal ? aa.top + aa.height / 2 : aa.bottom) - bounds.top;
        const x2 =
          (horizontal ? bb.left : bb.left + bb.width / 2) - bounds.left;
        const y2 = (horizontal ? bb.top + bb.height / 2 : bb.top) - bounds.top;
        const curve = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "path",
        );
        curve.setAttribute(
          "d",
          horizontal
            ? `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`
            : `M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`,
        );
        curve.setAttribute(
          "class",
          a.dataset.state === "done" || a.dataset.state === "reported"
            ? "edge-reported"
            : "",
        );
        curve.setAttribute("marker-end", "url(#mission-arrow)");
        svg.append(curve);
      };
      link("requirements", "design");
      const ids = new Set(model.tasks.map((task) => task.id));
      for (const task of model.tasks) {
        const dependencies = task.dependsOn.filter((id) => ids.has(id));
        if (!dependencies.length) link("design", "task-" + task.id);
        for (const id of dependencies) link("task-" + id, "task-" + task.id);
      }
      const leaves = model.tasks.filter(
        (task) => !model.tasks.some((row) => row.dependsOn.includes(task.id)),
      );
      if (model.tasks.length)
        for (const task of leaves) link("task-" + task.id, "testing");
      else {
        link("design", "implementation");
        link("implementation", "testing");
      }
      link("testing", "review");
      link("review", "complete");
    });
  }
  const resize = new ResizeObserver(drawEdges);
  resize.observe(graph);
  function focusPanel(actor, taskId = null, scroll = true) {
    selected = (input.team ?? []).some((row) => row.id === actor)
      ? actor
      : "gpt";
    selectedTask = taskId;
    if (mode !== "focus") setMode("focus");
    applyFocus();
    renderTask();
    if (onSelect && scroll) onSelect(selected, taskId);
    else if (scroll)
      $("#mission-output").scrollIntoView({ block: "start", behavior: "auto" });
  }
  function applyFocus() {
    document.body.dataset.missionMode = mode;
    document.body.dataset.missionPanel = selected;
    for (const panel of document.querySelectorAll("[data-agent-panel]"))
      panel.dataset.missionSelected = String(
        panel.dataset.agentPanel === selected,
      );
    for (const button of $("#mission-tabs").children)
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.actor === selected),
      );
    for (const button of graph.querySelectorAll("[data-task]"))
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.task === selectedTask),
      );
    const expanded = document.body.dataset.outputExpanded === "true";
    $("#mission-expand").setAttribute("aria-pressed", String(expanded));
    $("#mission-expand").textContent = expanded
      ? "흐름 함께 보기"
      : "출력 크게 보기";
  }
  function setMode(next) {
    mode = next;
    $("#mission-view-focus").setAttribute(
      "aria-pressed",
      String(mode === "focus"),
    );
    $("#mission-view-all").setAttribute("aria-pressed", String(mode === "all"));
    document.body.dataset.outputExpanded = "false";
    applyFocus();
    onMode();
    drawEdges();
  }
  function renderTask() {
    const task = input.run?.tasks?.find((row) => row.id === selectedTask);
    const detail = $("#mission-task");
    detail.hidden = !task;
    if (!task) return;
    detail.replaceChildren();
    detail.append(element("strong", task.title || task.id));
    const owners = input.team.find(
      (row) => row.id === task.owner,
    );
    detail.append(
      element(
        "p",
        `${owners ? PROVIDERS[owners.provider] : task.owner} · ${PHASE_LABELS[model.tasks.find((row) => row.id === task.id)?.state] ?? task.status}`,
        "hint",
      ),
    );
    const paths =
      task.report?.changed
        ?.map((row) => (typeof row === "string" ? row : row.path))
        .filter(Boolean) ??
      task.writePaths ??
      [];
    detail.append(
      element(
        "p",
        paths.length
          ? "변경 파일 · " + paths.join(" · ")
          : "변경 파일 보고 대기",
        "hint",
      ),
    );
    const events =
      input.run.events?.filter((event) => event.taskId === task.id).slice(-3) ??
      [];
    for (const event of events)
      detail.append(element("p", event.message, "mission-task-event"));
    if (task.report?.summary) detail.append(element("p", task.report.summary));
  }
  function node(row, handler, task = false) {
    const button = element("button", undefined, "mission-node");
    button.type = "button";
    button.dataset.node = task ? "task-" + row.id : row.id;
    if (task) button.dataset.task = row.id;
    if (row.actor) button.dataset.actor = row.actor;
    button.dataset.state = row.state;
    button.append(element("span", row.title, "mission-node-title"));
    if (row.label) button.append(element("small", row.label));
    button.append(
      element(
        "span",
        row.stateLabel ?? PHASE_LABELS[row.state],
        "mission-node-state",
      ),
    );
    button.addEventListener("click", handler);
    return button;
  }
  function renderGraph() {
    const focused = graph.querySelector(":focus")?.dataset.node;
    const content = $("#mission-nodes");
    content.replaceChildren();
    const planning = element(
      "div",
      undefined,
      "mission-phase-row mission-planning-row",
    );
    const verification = element("div", undefined, "mission-phase-row");
    content.append(planning);
    for (const phase of model.phases) {
      if (phase.id === "implementation") {
        const group = element("div", undefined, "mission-task-nodes");
        if (model.tasks.length) {
          // Dependencies determine rows so a dependent task is always below its prerequisite.
          const pending = new Map(model.tasks.map((task) => [task.id, task]));
          while (pending.size) {
            const ready = [...pending.values()].filter((task) =>
              task.dependsOn.every((id) => !pending.has(id)),
            );
            const batch = ready.length ? ready : [...pending.values()];
            const row = element("div", undefined, "mission-task-row");
            for (const task of batch) {
              row.append(
                node(task, () => focusPanel(task.actor, task.id), true),
              );
              pending.delete(task.id);
            }
            group.append(row);
          }
        } else group.append(node(phase, () => onAction("roles")));
        content.append(group);
      } else {
        const row = ["requirements", "design"].includes(phase.id)
          ? planning
          : verification;
        row.append(
          node(phase, () => {
            if (phase.id === "design")
              onAction(input.run?.design ? "design" : "settings");
            else if (["testing", "complete"].includes(phase.id))
              onAction("testing");
            else if (phase.id === "review") focusPanel("gpt");
            else focusPanel("gpt");
          }),
        );
      }
    }
    content.append(verification);
    if (focused)
      [...content.querySelectorAll("[data-node]")]
        .find((item) => item.dataset.node === focused)
        ?.focus({ preventScroll: true });
    drawEdges();
  }
  $("#mission-view-focus").addEventListener("click", () => setMode("focus"));
  $("#mission-view-all").addEventListener("click", () => setMode("all"));
  $("#mission-expand").addEventListener("click", () => {
    document.body.dataset.outputExpanded = String(
      document.body.dataset.outputExpanded !== "true",
    );
    applyFocus();
    $("#mission-output").scrollIntoView({ block: "start" });
    drawEdges();
  });
  $("#mission-primary").addEventListener("click", () =>
    onAction(model.action.target),
  );
  $("#mission-controller-action").addEventListener("click", () =>
    onAction(model.action.target),
  );
  return {
    mode: () => mode,
    select: focusPanel,
    redraw: drawEdges,
    update(value) {
      input = value;
      const nextContext = `${value.projectId}:${value.conversationId}`;
      if (context !== nextContext) {
        context = nextContext;
        selected = "gpt";
        selectedTask = null;
        document.body.dataset.outputExpanded = "false";
      }
      if (!value.team?.some((row) => row.id === selected)) selected = "gpt";
      model = missionState(value.run, value.team);
      let action = model.action;
      if (!value.linked && !value.run)
        action = {
          title: "프로젝트 폴더를 연결해 주세요",
          detail: "새 프로젝트를 누르면 작업할 폴더를 고를 수 있어요.",
          label: "새 프로젝트",
          target: "project",
        };
      else if (!value.connected && !value.run)
        action = {
          title: "사용할 AI를 연결해 주세요",
          detail: "공식 CLI 로그인 상태를 확인하고 역할을 배정하세요.",
          label: "계정 연결",
          target: "connections",
        };
      if (value.delivery?.status === "failed")
        action = {
          title: "외부 전송을 확인해 주세요",
          detail: value.delivery.message,
          label: "전송 상태와 재시도",
          target: "delivery",
        };
      if (value.delivery?.pending)
        action = {
          title: "전송 대상을 확인해 주세요",
          detail: value.delivery.pending.target,
          label: "배포 승인 보기",
          target: "delivery",
        };
      model = { ...model, action };
      $("#mission-summary").textContent = model.summary;
      $("#mission-controller-provider").textContent =
        PROVIDERS[value.team?.[0]?.provider] ?? "AI";
      $("#mission-action-title").textContent = action.title;
      $("#mission-action-detail").textContent = action.detail;
      $("#mission-primary").textContent = action.label;
      $("#mission-controller-action").textContent = action.label;
      $("#mission-controller").dataset.state =
        value.run?.status === "awaiting_design"
          ? "waiting"
          : model.done
            ? "done"
            : value.run
              ? "active"
              : "idle";
      $("#mission-next").dataset.state = model.done
        ? "done"
        : ["design", "settings", "delivery"].includes(action.target)
          ? "waiting"
          : "idle";
      const next = JSON.stringify([context, model]);
      if (signature !== next) {
        signature = next;
        renderGraph();
      }
      const tabs = JSON.stringify(value.team);
      if (tabs !== tabSignature) {
        tabSignature = tabs;
        $("#mission-tabs").replaceChildren(
          ...(value.team ?? []).map((agent, i) => {
            const tab = element(
              "button",
              `${i ? agent.roles.map((role) => CAPABILITIES[role]).join(" · ") : "컨트롤 타워"} · ${PROVIDERS[agent.provider]}`,
            );
            tab.type = "button";
            tab.dataset.actor = agent.id;
            tab.addEventListener("click", () => focusPanel(agent.id));
            return tab;
          }),
        );
      }
      applyFocus();
      renderTask();
    },
  };
}
