import { CAPABILITIES } from "../core/team.js";
const NAMES = {
  gpt: "GPT",
  grok: "Grok · Cursor",
  claude: "Claude",
  gemini: "Gemini",
};
const ROLES = { gpt: "컨트롤 타워", grok: "기능 구현", claude: "UI 구현·연결" };
export function mascotState(
  run,
  assignments = { gpt: "gpt", grok: "grok", claude: "claude" },
) {
  const roles = run?.options?.roles ?? assignments;
  const team =
    run?.options?.team ?? (Array.isArray(assignments) ? assignments : null);
  const labels = team
    ? Object.fromEntries(
        team.map((agent) => [
          agent.id,
          `${agent.roles.map((role) => CAPABILITIES[role]).join("/")} · ${NAMES[agent.provider]}`,
        ]),
      )
    : Object.fromEntries(
        Object.entries(ROLES).map(([id, role]) => [
          id,
          `${role} · ${NAMES[roles[id]] ?? roles[id]}`,
        ]),
      );
  let state = "idle",
    message = "다음 작업을 기다리고 있어요.";
  const modes = {
    planning: ["planning", "요구사항 빈칸에 손전등 비추는 중…"],
    building: ["working", "기능 부품을 차곡차곡 조립하는 중…"],
    testing: ["checking", "예외 상황으로 모서리를 톡톡 두드리는 중…"],
    repairing: ["working", "삐걱이는 부품 다시 조이는 중…"],
    validating: ["checking", "방금 만든 걸 검사대에서 굴려보는 중…"],
    reviewing: ["checking", "버그 발자국 따라 손전등 옮기는 중…"],
    awaiting_design: ["checking", "UI 시안 확인을 기다리고 있어요."],
    final_review: ["checking", "출고 전에 놓친 나사 한 번 더 찾는 중…"],
    completed: ["done", "검사 통과! 마지막 상자까지 배송 완료."],
    awaiting_validation: [
      "waiting",
      "코드 검토는 끝났고, 실행 검증을 기다리고 있어요.",
    ],
    needs_input: [
      "waiting",
      "답이 필요한 질문이 있어요. 작업 로그를 확인해 주세요.",
    ],
    needs_attention: [
      "error",
      "확인이 필요해요. 작업 로그에서 원인을 확인해 주세요.",
    ],
    cancelled: ["paused", "작업을 중지했어요."],
    interrupted: ["paused", "이전 작업이 중단됐어요. 기록을 확인해 주세요."],
  };
  if (run && modes[run.status]) [state, message] = modes[run.status];
  if (
    run?.status === "building" &&
    run.tasks?.some((task) => task.status === "working" && task.kind === "ui")
  )
    message = "버튼들 자리 배치 회의 중…";
  const active = [
    "planning",
    "building",
    "testing",
    "repairing",
    "validating",
    "reviewing",
    "final_review",
  ].includes(run?.status);
  const event = active
    ? run.events?.findLast((item) =>
        ["dispatch", "report"].includes(item.activity),
      )
    : null;
  const handoff =
    event &&
    (team
      ? team.slice(1).map((agent) => agent.id)
      : ["grok", "claude"]
    ).includes(event.actor)
      ? {
          key: `${run.id}:${event.at}:${event.activity}:${event.taskId}`,
          from: event.activity === "dispatch" ? "gpt" : event.actor,
          to: event.activity === "dispatch" ? event.actor : "gpt",
        }
      : null;
  return { state, message, labels, handoff };
}
export function createMascot(stage) {
  const carrier = stage.querySelector(".mascot-carrier"),
    toggle = stage.querySelector(".mascot-motion-toggle");
  let lastKey = null, designKey = null;
  let runKey = null,
    courierQueue = [],
    delivering = false;
  const courier = document.querySelector("#courier");
  function anchor(actor) {
    const focused = document.body.dataset.missionMode === "focus";
    if (focused && actor === "gpt") return document.querySelector("#mission-controller");
    if (focused) {
      const nodes = [...document.querySelectorAll("#mission-graph [data-actor]")].filter((node) => node.dataset.actor === actor && node.getClientRects().length);
      const task = nodes.find((node) => node.dataset.state === "active") ?? nodes[0];
      if (task) return task;
    }
    return actor === "gpt"
      ? document.querySelector(".planner .panel-heading")
      : document.querySelector(`[data-agent-panel="${actor}"] .panel-heading`);
  }
  async function deliver() {
    if (
      delivering ||
      !courierQueue.length ||
      !courier ||
      stage.dataset.motion !== "on" ||
      document.hidden
    )
      return;
    delivering = true;
    const event = courierQueue.shift();
    const source = anchor(event.from);
    const target =
      event.to === "design"
        ? ["#sidebar-images", "#tab-images"].map((selector) => document.querySelector(selector))
          .find((button) => {
            const rect = button?.getBoundingClientRect();
            return rect?.width && rect.top >= 0 && rect.bottom <= window.innerHeight;
          })
        : anchor(event.to);
    if (!source || !target || !source.getClientRects().length) {
      delivering = false;
      void deliver();
      return;
    }
    const from = source.getBoundingClientRect(),
      to = target.getBoundingClientRect();
    const x1 = from.left + from.width / 2 - 27,
      y1 = from.top - 12,
      x2 = to.left + to.width / 2 - 27,
      y2 = to.top - 12;
    courier.hidden = false;
    courier.dataset.from = event.from;
    courier.dataset.to = event.to;
    const token = runKey;
    try {
      const animation = courier.animate(
        [
          { transform: `translate(${x1}px,${y1}px) rotate(-5deg)`, opacity: 0 },
          {
            transform: `translate(${x1}px,${y1}px) rotate(3deg)`,
            opacity: 1,
            offset: 0.08,
          },
          {
            transform: `translate(${x2}px,${y2}px) rotate(-3deg)`,
            opacity: 1,
            offset: 0.9,
          },
          { transform: `translate(${x2}px,${y2}px) rotate(0deg)`, opacity: 0 },
        ],
        { duration: 1100, easing: "ease-in-out" },
      );
      await animation.finished;
    } catch {
    } finally {
      if (runKey === token) {
        courier.hidden = true;
        delivering = false;
        void deliver();
      }
    }
  }
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  let enabled = true;
  try {
    enabled = localStorage.getItem("cw-handsoff-mascot-motion") !== "off";
  } catch {}
  function motion() {
    const moving = enabled && !reduced.matches;
    stage.dataset.motion = moving ? "on" : "off";
    toggle.textContent = enabled ? "움직임 끄기" : "움직임 켜기";
    toggle.setAttribute("aria-pressed", String(enabled));
    if (!moving) carrier.classList.remove("is-delivering");
    if (!moving && courier) {
      courierQueue = [];
      courier.getAnimations().forEach((animation) => animation.cancel());
      courier.hidden = true;
    }
  }
  toggle.addEventListener("click", () => {
    enabled = !enabled;
    try {
      localStorage.setItem("cw-handsoff-mascot-motion", enabled ? "on" : "off");
    } catch {}
    motion();
  });
  reduced.addEventListener("change", motion);
  carrier.addEventListener("animationend", (event) => {
    if (event.target === carrier) carrier.classList.remove("is-delivering");
  });
  const visibility = () => {
    stage.dataset.hidden = String(document.hidden);
  };
  document.addEventListener("visibilitychange", visibility);
  visibility();
  motion();
  return {
    update(run, assignments) {
      if (runKey !== run?.id) {
        runKey = run?.id;
        courierQueue = [];
        delivering = false;
        courier?.getAnimations().forEach((animation) => animation.cancel());
        if (courier) courier.hidden = true;
      }
      const view = mascotState(run, assignments);
      stage.dataset.state = view.state;
      stage.querySelector(".mascot-message").textContent = view.message;
      const route = stage.querySelector(".mascot-route");
      route.dataset.count = String(Object.keys(view.labels).length - 1);
      for (const role of ["gpt", "grok", "claude", "reviewer"]) {
        let label = stage.querySelector(`[data-mascot-role="${role}"]`);
        if (!label && view.labels[role]) {
          label = document.createElement("span");
          label.className = "mascot-role mascot-reviewer";
          label.dataset.mascotRole = role;
          route.append(label);
        }
        if (label) {
          label.hidden = !view.labels[role];
          label.textContent = view.labels[role] ?? "";
        }
      }
      stage.querySelector(".mascot-event").textContent = view.handoff
        ? `${view.labels[view.handoff.from]} → ${view.labels[view.handoff.to]}`
        : "실제 작업 전달과 완료 보고에 맞춰 움직입니다.";
      const readyArtifact = run?.status === "awaiting_design" && run.design?.status === "ready"
        ? run.design.artifactId : null;
      if (readyArtifact && readyArtifact !== designKey && stage.dataset.motion === "on" && !document.hidden) {
        courierQueue.push({ from: "gpt", to: "design" });
        void deliver();
      }
      designKey = readyArtifact;
      if (!view.handoff) {
        carrier.classList.remove("is-delivering");
        lastKey = null;
        return;
      }
      if (view.handoff.key === lastKey) return;
      lastKey = view.handoff.key;
      if (stage.dataset.motion !== "on" || document.hidden) return;
      if (courier) {
        courierQueue.push(view.handoff);
        void deliver();
      }
      carrier.dataset.from = view.handoff.from;
      carrier.dataset.to = view.handoff.to;
      carrier.classList.remove("is-delivering");
      void carrier.offsetWidth;
      carrier.classList.add("is-delivering");
    },
  };
}
