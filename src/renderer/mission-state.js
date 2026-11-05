import { PROVIDERS, teamFor } from "../core/team.js";

const LIVE = new Set([
  "planning",
  "awaiting_design",
  "building",
  "testing",
  "validating",
  "reviewing",
  "repairing",
  "final_review",
]);
export const PHASE_LABELS = {
  idle: "대기",
  active: "진행 중",
  waiting: "확인 필요",
  error: "확인 필요",
  done: "완료",
  reported: "완료 보고",
  skipped: "생략",
  stopped: "중지됨",
};

export function missionState(run, team = []) {
  const tasks = run?.tasks ?? [];
  const status = run?.status;
  const planned = Boolean(run?.spec || tasks.length);
  const changed = ["building", "repairing", "testing"].includes(status);
  const validationPassed = Boolean(
    run?.validation?.passed &&
    !run.validation.stale &&
    !run.testing?.stale &&
    !changed &&
    (!run.options?.mutation || run.mutation?.passed),
  );
  const done = status === "completed" && validationPassed;
  const stopped = ["cancelled", "interrupted"].includes(status);
  const taskNodes = tasks.map((task) => {
    const agent = (run.options?.team ? teamFor(run.options) : team).find(
      (row) => row.id === task.owner,
    );
    return {
      id: task.id,
      actor: task.owner,
      kind: task.kind,
      title: task.title || task.id,
      label: PROVIDERS[task.executedProvider ?? agent?.provider] ?? task.owner,
      state:
        {
          working: "active",
          reported: "reported",
          failed: "error",
          blocked: "error",
          cancelled: "stopped",
        }[task.status] ?? "idle",
      dependsOn: task.dependsOn ?? [],
    };
  });
  const design = run?.design;
  const designState = design
    ? ({
        ready: "waiting",
        error: "error",
        approved: "done",
        generating: "active",
        pending: "idle",
      }[design.status] ?? "idle")
    : planned
      ? "skipped"
      : "idle";
  const summary =
    {
      planning: "요구사항과 완료 기준을 정리하고 있어요.",
      building: "명세를 전달했어요. 담당 AI가 구현하고 있습니다.",
      testing: "완료 기준을 확인할 테스트를 준비하고 있어요.",
      validating: "테스트를 실제로 실행하고 있어요.",
      reviewing: "변경 코드와 검증 결과를 검토하고 있어요.",
      repairing: "발견한 문제를 담당 AI에게 돌려보냈어요.",
      awaiting_design:
        design?.status === "ready"
          ? "요구사항을 정리했어요. UI 시안을 확인해 주세요."
          : design?.status === "error"
            ? "시안을 만들지 못했어요. 이미지 연결을 확인해 주세요."
            : "명세를 바탕으로 UI 시안을 만들고 있어요.",
      final_review: "참여한 AI들이 결과를 교차 검토하고 있어요.",
      completed: done
        ? "검증과 최종 검토를 마쳤어요. 결과를 확인해 주세요."
        : "완료 기록의 검증 상태를 다시 확인해 주세요.",
      awaiting_validation: "코드는 준비됐어요. 실행 검증을 확인해 주세요.",
      needs_input: "명세를 정리하려면 사용자의 답이 더 필요해요.",
      needs_attention: "자동으로 해결하지 못한 항목을 확인해 주세요.",
      cancelled: "작업을 멈췄어요. 변경 내역을 확인할 수 있어요.",
      interrupted: "이전 작업이 중단됐어요. 변경 내역을 확인해 주세요.",
    }[status] ?? "만들고 싶은 것을 아래에 설명해 주세요.";
  let action = {
    title: "첫 작업을 시작해 보세요",
    detail: "작업 폴더와 AI를 연결한 뒤 요청을 보내세요.",
    label: "컨트롤 타워에 요청",
    target: "controller",
  };
  if (LIVE.has(status))
    action = {
      title: "AI가 작업하고 있어요",
      detail: "노드를 선택하면 담당 AI의 실제 출력을 볼 수 있어요.",
      label: "작업 출력 보기",
      target: "output",
    };
  if (status === "awaiting_design")
    action =
      design?.status === "ready"
        ? {
            title: "UI 시안을 확인해 주세요",
            detail: "승인하면 기능 구현과 UI 작업을 시작합니다.",
            label: "UI 시안 열기",
            target: "design",
          }
        : design?.status === "error"
          ? {
              title: "이미지 연결을 확인해 주세요",
              detail:
                "시안 화면에서 API 키와 사용 내역을 확인하고 다시 생성하세요.",
              label: "시안 연결 확인",
              target: "design",
            }
          : {
              title: "UI 시안을 준비하고 있어요",
              detail: "시안이 준비되면 검토를 요청합니다.",
              label: "생성 상태 보기",
              target: "design",
            };
  else if (run?.validation?.requiresConsent && !LIVE.has(status))
    action = {
      title: "테스트 실행 권한이 필요해요",
      detail: "설정에서 현재 폴더의 코드 실행 범위를 확인하세요.",
      label: "실행 권한 설정",
      target: "settings",
    };
  else if (status === "needs_input")
    action = {
      title: "요구사항에 답을 추가해 주세요",
      detail: run.questions?.join("\n") || summary,
      label: "질문과 요청 보기",
      target: "controller",
    };
  else if (
    status === "needs_attention" &&
    (!run.validation || taskNodes.some((task) => task.state === "error"))
  )
    action = {
      title: "중단된 작업을 확인해 주세요",
      detail:
        run.events?.findLast((event) => event.actor === "system")?.message ||
        summary,
      label: "문제 작업 출력 보기",
      target: "failed-output",
    };
  else if (["awaiting_validation", "needs_attention"].includes(status))
    action = {
      title:
        run?.mutation?.passed === false
          ? "변이 검증을 확인해 주세요"
          : "검증 결과를 확인해 주세요",
      detail:
        run?.testFailure?.reason ||
        run?.mutation?.summary ||
        run?.validation?.summary ||
        summary,
      label: "검증 결과 보기",
      target: "testing",
    };
  else if (done)
    action = {
      title: "작업 결과를 확인해 주세요",
      detail: "변경 파일과 검증 기록을 확인할 수 있습니다.",
      label: "테스트 결과 보기",
      target: "testing",
    };
  else if (stopped)
    action = {
      title: "작업 변경 내역을 확인해 주세요",
      detail: "체크포인트에서 복원할 파일을 미리 볼 수 있습니다.",
      label: "체크포인트 보기",
      target: "checkpoints",
    };
  return {
    summary,
    action,
    done,
    phases: [
      {
        id: "requirements",
        title: "요구사항 정리",
        state:
          status === "planning"
            ? "active"
            : planned
              ? "done"
              : status === "needs_input"
                ? "waiting"
                : "idle",
      },
      {
        id: "design",
        title: "UI 시안",
        state: designState,
        stateLabel: designState === "waiting" ? "승인 대기" : undefined,
      },
      {
        id: "implementation",
        title: "기능·UI 구현",
        state: taskNodes.some((t) => t.kind !== "test" && t.state === "active")
          ? "active"
          : tasks.some((t) => t.kind !== "test") &&
              tasks
                .filter((t) => t.kind !== "test")
                .every((t) => t.status === "reported")
            ? "reported"
            : taskNodes.some((t) => t.kind !== "test" && t.state === "error")
              ? "error"
              : stopped
                ? "stopped"
                : "idle",
      },
      {
        id: "testing",
        title: run?.options?.mutation ? "테스트·변이 검증" : "테스트 실행",
        state:
          status === "validating" || status === "testing"
            ? "active"
            : validationPassed
              ? "done"
              : run?.validation && !changed
                ? "error"
                : "idle",
      },
      {
        id: "review",
        title: "최종 검토",
        state: ["reviewing", "final_review"].includes(status)
          ? "active"
          : done
            ? "done"
            : status === "needs_attention"
              ? "error"
              : "idle",
      },
      { id: "complete", title: "작업 완료", state: done ? "done" : "idle" },
    ],
    tasks: taskNodes,
  };
}
