import { randomUUID } from "node:crypto";
import { digest, relativeFile } from "./workspace.js";
import { PROVIDER_NAMES } from "./roles.js";
import { teamFor, agentLabel } from "./team.js";
import { compileFunPlan, skillHash } from "./fun-contract.js";
import { readFile } from "node:fs/promises";
import { testPlanMarkdown } from "./test-plan.js";

const ACTIVE = new Set([
  "testing",
  "planning",
  "building",
  "validating",
  "reviewing",
  "repairing",
  "final_review",
]);
const controllerName = (state) =>
  PROVIDER_NAMES[teamFor(state.options)[0].provider];
export function objectJSON(text) {
  const clean =
    typeof text === "string"
      ? text
          .trim()
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/\s*```$/, "")
      : "";
  try {
    const object = JSON.parse(clean);
    if (object && typeof object === "object" && !Array.isArray(object))
      return object;
  } catch {}
  throw new Error(
    "AI 응답이 정해진 JSON 형식이 아닙니다. 자동 적용을 중단했습니다.",
  );
}
export function validatePlan(plan, options = {}) {
  if (Array.isArray(plan.questions) && plan.questions.length)
    return { ...plan, tasks: [] };
  if (
    !Array.isArray(plan.tasks) ||
    !plan.tasks.length ||
    plan.tasks.length > 40 ||
    typeof plan.spec !== "string" ||
    plan.spec.length > 300000
  )
    throw new Error("기능 명세 또는 작업 목록이 불완전합니다.");
  const ids = new Set();
  const owners = options.team
    ? teamFor(options).map((agent) => agent.id)
    : ["grok", "claude"];
  for (const task of plan.tasks) {
    if (
      typeof task.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,60}$/.test(task.id) ||
      ids.has(task.id) ||
      !owners.includes(task.owner) ||
      typeof task.instructions !== "string" ||
      !task.instructions.trim() ||
      !Array.isArray(task.dependsOn) ||
      !Array.isArray(task.acceptanceCriteria) ||
      !task.acceptanceCriteria.length ||
      task.acceptanceCriteria.some(
        (value) => typeof value !== "string" || !value.trim(),
      )
    )
      throw new Error("작업의 담당자·완료 기준·의존 관계가 유효하지 않습니다.");
    ids.add(task.id);
  }
  const remaining = new Set(ids),
    finished = new Set();
  while (remaining.size) {
    const ready = plan.tasks.filter(
      (task) =>
        remaining.has(task.id) &&
        task.dependsOn.every((id) => finished.has(id)),
    );
    if (!ready.length)
      throw new Error("존재하지 않는 작업 의존성 또는 순환 의존성이 있습니다.");
    for (const task of ready) {
      remaining.delete(task.id);
      finished.add(task.id);
    }
  }
  return plan;
}
export function validateReview(review, tasks, ownership = {}) {
  if (!Array.isArray(review.issues) || typeof review.summary !== "string")
    throw new Error("검토 결과의 형식이 올바르지 않습니다.");
  for (const issue of review.issues) {
    const task = tasks.find((task) => task.id === issue.taskId);
    if (
      !task ||
      issue.owner !== task.owner ||
      typeof issue.description !== "string" ||
      !issue.description.trim()
    )
      throw new Error("검토 지적의 원래 작업 담당자를 확인할 수 없습니다.");
    if (
      issue.file &&
      ownership[issue.file] &&
      ownership[issue.file].taskId !== task.id
    )
      throw new Error(
        "파일 변경 기록과 검토 지적의 담당 작업이 일치하지 않습니다.",
      );
  }
  return review;
}

export class Workflow {
  constructor(
    workspace,
    providers,
    notify = () => {},
    validate = async () => ({ configured: false, passed: false }),
  ) {
    this.workspace = workspace;
    this.providers = providers;
    this.notify = notify;
    this.validate = validate;
    this.runs = new Map();
    this.starting = new Set();
  }
  isActive(projectId) {
    return (
      this.starting.has(projectId) ||
      ACTIVE.has(this.runs.get(projectId)?.state.status)
    );
  }
  async preflight(projectId, options) {
    if (
      !options ||
      typeof options.request !== "string" ||
      !options.request.trim() ||
      options.request.length > 16000
    )
      throw new Error("작업 요청을 1~16,000자로 입력하세요.");
    if (
      !Number.isInteger(options.maxRepairRounds) ||
      options.maxRepairRounds < 0 ||
      options.maxRepairRounds > 20
    )
      throw new Error("자동 수정 최대 횟수를 0~20 사이에서 직접 설정하세요.");
    await this.workspace.grant(projectId);
    for (const agent of teamFor(options))
      if (!(await this.providers[agent.id]?.ready(options)))
        throw new Error(
          `${options.team ? agentLabel(agent) : agent.id.toUpperCase()} 연결과 모델 설정을 먼저 완료하세요.`,
        );
  }
  async start(projectId, options) {
    if (this.isActive(projectId))
      throw new Error("이 프로젝트는 작업 중입니다. 먼저 중지하세요.");
    this.starting.add(projectId);
    try {
      await this.preflight(projectId, options);
      const grant = await this.workspace.grant(projectId);
      const state = {
        id: randomUUID(),
        projectId,
        grantId: grant.grantId,
        root: grant.root,
        request: options.request,
        options: structuredClone(options),
        status: "planning",
        round: 0,
        tasks: [],
        events: [],
        createdAt: new Date().toISOString(),
      };
      const run = {
        state,
        controller: new AbortController(),
        queue: Promise.resolve(),
      };
      this.runs.set(projectId, run);
      await this.record(run, "gpt", "요구사항과 기능 명세를 작성합니다.");
      run.promise = this.execute(run).catch(async (error) => {
        const cancelled = run.controller.signal.aborted && !run.failure;
        state.status = cancelled ? "cancelled" : "needs_attention";
        for (const task of state.tasks)
          if (task.status === "working")
            task.status = cancelled ? "cancelled" : "failed";
          else if (task.status === "pending")
            task.status = cancelled ? "cancelled" : "blocked";
        if (
          state.testing &&
          ["writing", "running"].includes(state.testing.status)
        ) {
          state.testing.status = cancelled ? "cancelled" : "failed";
          state.testing.stale = true;
        }
        await this.record(
          run,
          "system",
          cancelled ? "사용자가 작업을 중지했습니다." : error.message,
        ).catch(() => {});
        this.notify({
          type: "workflow",
          projectId,
          state: structuredClone(state),
        });
      });
      return structuredClone(state);
    } finally {
      this.starting.delete(projectId);
    }
  }
  async record(run, actor, message, details = {}) {
    const operation = run.queue.then(async () => {
      const event = {
        at: new Date().toISOString(),
        actor,
        message,
        ...details,
      };
      run.state.eventCount = (run.state.eventCount ?? 0) + 1;
      await this.workspace.write(
        run.state.projectId,
        `.control-tower/runs/${run.state.id}/events/${String(run.state.eventCount).padStart(6, "0")}.json`,
        JSON.stringify(event),
        { internal: true, grantId: run.state.grantId, newOnly: true },
      );
      run.state.events.push(event);
      run.state.events = run.state.events.slice(-150);
      const { state } = run;
      await this.workspace.write(
        state.projectId,
        `.control-tower/runs/${state.id}/state.json`,
        JSON.stringify(state, null, 2),
        { internal: true, grantId: state.grantId },
      );
      await this.workspace.write(
        state.projectId,
        ".control-tower/latest-run.json",
        JSON.stringify({ id: state.id }),
        { internal: true, grantId: state.grantId },
      );
      this.notify({
        type: "workflow",
        projectId: state.projectId,
        state: structuredClone(state),
      });
    });
    run.queue = operation.catch(() => {});
    return operation;
  }
  async snapshot(run) {
    run.controller.signal.throwIfAborted();
    await this.workspace.grant(run.state.projectId, run.state.grantId);
    const snapshot = await this.workspace.snapshot(run.state.projectId);
    if (snapshot.truncated)
      throw new Error(
        "프로젝트가 현재 검토 범위를 초과합니다. 제외 파일을 확인한 뒤 더 작은 작업 폴더로 나누세요.",
      );
    return snapshot;
  }
  async worker(run, task, issues = []) {
    const { state } = run;
    const snapshot = await this.snapshot(run);
    task.status = "working";
    if (state.testing?.result) state.testing.stale = true;
    task.startedAt = new Date().toISOString();
    if (task.kind === "test") {
      state.status = "testing";
      if (state.testing) state.testing.status = "writing";
    }
    await this.record(
      run,
      task.owner,
      `${task.title || task.id}: ${issues.length ? "지적된 문제를 수정합니다." : "구현을 시작합니다."}`,
      { taskId: task.id, activity: "dispatch" },
    );
    const report = await this.providers[task.owner].build({
      task:
        task.kind === "test"
          ? {
              ...task,
              instructions: `${task.instructions}\nHost test plan: ${JSON.stringify({ ...state.testing.plan, cases: state.testing.plan.cases.filter((row) => task.requirementIds.includes(row.requirementId)), assignedFiles: task.testFiles ?? state.testing.plan.files })}\nWrite meaningful assertions for every case. Use node:test, name each test starting with its case ID (e.g. T1). Only edit assignedFiles, not every file in the full test plan. Never modify application code or weaken requirements. Do not claim execution. No package installation.`,
            }
          : task,
      issues,
      spec: state.spec,
      snapshot,
      options: state.options,
      signal: run.controller.signal,
    });
    run.controller.signal.throwIfAborted();
    if (
      !report ||
      typeof report.summary !== "string" ||
      !Array.isArray(report.files) ||
      report.files.length > 60
    )
      throw new Error("작업 결과의 파일 목록을 확인하지 못했습니다.");
    const seen = new Set();
    for (const file of report.files) {
      relativeFile(file.path);
      if (
        task.kind === "test" &&
        !(task.testFiles ?? state.testing.plan.files).includes(file.path)
      )
        throw new Error(
          "테스트 담당자는 계획에 선언한 테스트 코드만 수정할 수 있습니다.",
        );
      if (
        seen.has(file.path) ||
        typeof file.content !== "string" ||
        Buffer.byteLength(file.content) > 500000
      )
        throw new Error("작업 결과의 파일 경로나 크기가 올바르지 않습니다.");
      seen.add(file.path);
    }
    const changed = [];
    for (const file of report.files) {
      run.controller.signal.throwIfAborted();
      const before = snapshot.files.find((entry) => entry.path === file.path);
      if (before)
        await this.workspace.write(
          state.projectId,
          `.control-tower/runs/${state.id}/backups/${randomUUID()}.json`,
          JSON.stringify({
            path: file.path,
            hash: before.hash,
            content: before.content,
          }),
          { internal: true, grantId: state.grantId, newOnly: true },
        );
      const result = await this.workspace.write(
        state.projectId,
        file.path,
        file.content,
        { baseHash: before?.hash ?? null, grantId: state.grantId },
      );
      changed.push({ path: result.path, hash: result.hash });
      state.ownership ??= {};
      state.ownership[result.path] = { owner: task.owner, taskId: task.id };
      await this.record(run, task.owner, `${result.path} 저장`, {
        taskId: task.id,
        path: result.path,
        preview: file.content.slice(0, 8000),
        previewTruncated: file.content.length > 8000,
      });
    }
    task.status = "reported";
    if (task.kind === "test" && state.testing) state.testing.status = "ready";
    task.report = {
      summary: report.summary,
      changed,
      at: new Date().toISOString(),
    };
    await this.record(
      run,
      task.owner,
      `${task.title || task.id}: ${controllerName(state)}에 완료 보고를 전달했습니다.`,
      { taskId: task.id, summary: report.summary, activity: "report" },
    );
  }
  async buildTasks(run, taskIds, issues = []) {
    const selected = new Set(taskIds);
    const running = new Map();
    const owners = new Set();
    for (const task of run.state.tasks.filter((task) => selected.has(task.id)))
      task.status = "pending";
    const launch = (task) => {
      owners.add(task.owner);
      const promise = this.worker(
        run,
        task,
        issues.filter((issue) => issue.taskId === task.id),
      ).then(
        () => ({ id: task.id, owner: task.owner }),
        (error) => ({ id: task.id, owner: task.owner, error }),
      );
      running.set(task.id, promise);
    };
    while (true) {
      run.controller.signal.throwIfAborted();
      const pending = run.state.tasks.filter(
        (task) => selected.has(task.id) && task.status === "pending",
      );
      for (const task of pending) {
        if (
          !owners.has(task.owner) &&
          task.dependsOn.every(
            (id) =>
              run.state.tasks.find((candidate) => candidate.id === id)
                ?.status === "reported",
          )
        )
          launch(task);
      }
      if (!running.size) {
        if (pending.length)
          throw new Error("작업 의존성 때문에 진행할 수 없습니다.");
        break;
      }
      const done = await Promise.race(running.values());
      running.delete(done.id);
      owners.delete(done.owner);
      if (done.error) {
        const cancelled = run.controller.signal.aborted;
        run.controller.abort();
        await Promise.all(running.values());
        // A failed worker is an error, not an intentional user cancellation.
        if (!cancelled) run.failure = done.error;
        throw done.error;
      }
    }
  }
  async execute(run) {
    const { state } = run;
    const snapshot = await this.snapshot(run);
    const skill = await readFile(
      new URL("../skills/fun.md", import.meta.url),
      "utf8",
    );
    state.governance = {
      skill: "fun",
      sha256: skillHash(skill),
      contractVersion: state.options.funContract ? 1 : 0,
    };
    let plan;
    for (let attempt = 0; attempt < 2; attempt++) {
      const proposed = await this.providers.gpt.plan({
        request: state.request,
        snapshot,
        options: state.options,
        signal: run.controller.signal,
      });
      try {
        plan = validatePlan(
          state.options.funContract
            ? compileFunPlan(proposed, state.options)
            : proposed,
          state.options,
        );
        break;
      } catch (error) {
        if (attempt) throw error;
        await this.record(
          run,
          "gpt",
          `명세 누락을 감지해 보완을 요청합니다: ${error.message}`,
        );
        state.options.planCorrection = error.message;
      }
    }
    delete state.options.planCorrection;
    if (plan.questions?.length) {
      state.status = "needs_input";
      state.questions = plan.questions;
      await this.record(run, "gpt", "누락된 요구사항에 대한 답이 필요합니다.", {
        questions: plan.questions,
      });
      return;
    }
    state.spec = plan.spec;
    if (
      state.options.suggestRepositoryName &&
      typeof plan.repositoryName === "string" &&
      /^[a-z0-9][a-z0-9-]{0,44}$/.test(plan.repositoryName)
    )
      state.repositoryName = plan.repositoryName;
    state.requirements = plan.requirements ?? [];
    state.decisions = plan.decisions ?? [];
    state.reviewItems = plan.reviewItems ?? [];
    if (plan.testPlan) {
      state.testing = { status: "planned", plan: plan.testPlan, result: null };
      state.options.testPlan = plan.testPlan;
      await this.workspace.write(
        state.projectId,
        `.control-tower/runs/${state.id}/test-plan.md`,
        testPlanMarkdown(plan.testPlan),
        { internal: true, grantId: state.grantId, newOnly: true },
      );
    }
    state.tasks = plan.tasks.map((task) => ({ ...task, status: "pending" }));
    await this.workspace.write(
      state.projectId,
      `Function/${state.id}_fun.md`,
      state.spec,
      { newOnly: true, grantId: state.grantId },
    );
    state.status = "building";
    await this.record(
      run,
      "gpt",
      "기능 명세를 저장하고 담당 AI에 작업을 전달합니다.",
    );
    await this.buildTasks(
      run,
      state.tasks.map((task) => task.id),
    );
    while (true) {
      state.status = "validating";
      if (state.testing)
        state.testing.status = state.options.allowExecution
          ? "running"
          : "permission";
      await this.record(run, "system", "프로젝트 검증을 실행합니다.");
      const beforeValidation = await this.snapshot(run);
      state.validation = await this.validate({
        projectId: state.projectId,
        grantId: state.grantId,
        options: state.options,
        signal: run.controller.signal,
        onOutput: (event) =>
          this.notify({
            type: "agent-progress",
            projectId: state.projectId,
            conversationId: state.options.conversationId,
            agentId:
              teamFor(state.options).find((agent) =>
                agent.roles.includes("test"),
              )?.id ?? "gpt",
            ...event,
          }),
      });
      const frozen = await this.snapshot(run);
      state.snapshotHash = frozen.hash;
      if (beforeValidation.hash !== frozen.hash)
        state.validation = {
          ...state.validation,
          passed: false,
          stale: true,
          summary:
            "검증 중 소스가 변경되어 검증 결과를 현재 파일에 적용할 수 없습니다.",
        };
      await this.testingResult(run);
      state.status = "reviewing";
      await this.record(
        run,
        "gpt",
        "변경 파일과 검증 결과를 읽기 전용으로 재검토합니다.",
      );
      const context = {
        snapshot: frozen,
        tasks: state.tasks,
        ownership: state.ownership,
        validation: state.validation,
        spec: state.spec,
        signal: run.controller.signal,
        options: state.options,
      };
      let reviews = [
        {
          actor: "gpt",
          ...validateReview(
            await this.providers.gpt.review(context),
            state.tasks,
            state.ownership,
          ),
        },
      ];
      if (!reviews[0].issues.length) {
        const participants = teamFor(state.options).map((agent) => agent.id);
        state.status = "final_review";
        await this.record(
          run,
          "gpt",
          `같은 파일 버전을 ${participants.length}개 패널의 AI 세션이 읽기 전용으로 최종 검사합니다.`,
        );
        const final = await Promise.all(
          participants.map(async (actor) => ({
            actor,
            ...validateReview(
              await this.providers[actor].review(context),
              state.tasks,
              state.ownership,
            ),
          })),
        );
        reviews.push(...final);
      }
      run.controller.signal.throwIfAborted();
      const after = await this.snapshot(run);
      if (after.hash !== frozen.hash)
        throw new Error(
          "검토 중 파일이 변경되었습니다. 현재 검토를 완료로 인정할 수 없습니다.",
        );
      state.reviews = reviews;
      const issues = reviews.flatMap((review) => review.issues);
      for (const review of reviews)
        await this.record(run, review.actor, review.summary, {
          issues: review.issues,
          snapshotHash: frozen.hash,
        });
      if (!issues.length) {
        state.status =
          state.validation.configured && state.validation.passed
            ? "completed"
            : "awaiting_validation";
        await this.record(
          run,
          "gpt",
          state.status === "completed"
            ? "검증과 최종 검토를 통과했습니다."
            : "코드 검토는 통과했지만 실행 검증이 통과하지 않아 전체 완료로 표시하지 않습니다.",
        );
        return;
      }
      if (state.round >= state.options.maxRepairRounds) {
        state.status = "needs_attention";
        await this.record(
          run,
          "gpt",
          "설정한 자동 수정 한도에 도달했습니다. 남은 문제를 확인하세요.",
          { issues },
        );
        return;
      }
      state.round++;
      state.status = "repairing";
      const selected = new Set(issues.map((issue) => issue.taskId));
      // Reconnect dependent UI/integration tasks whenever their feature changed.
      let grew = true;
      while (grew) {
        grew = false;
        for (const task of state.tasks)
          if (
            !selected.has(task.id) &&
            task.dependsOn.some((id) => selected.has(id))
          ) {
            selected.add(task.id);
            grew = true;
          }
      }
      for (const issue of issues)
        await this.record(
          run,
          "gpt",
          `${state.options.team ? agentLabel(teamFor(state.options).find((agent) => agent.id === issue.owner)) : state.options.roles ? PROVIDER_NAMES[state.options.roles[issue.owner]] : issue.owner.toUpperCase()}에 수정 요청: ${issue.description}`,
          { taskId: issue.taskId },
        );
      await this.buildTasks(run, [...selected], issues);
    }
  }
  async testingResult(run) {
    const { state } = run;
    if (!state.testing) return;
    state.testing.stale = state.validation.stale === true;
    state.testing.status = state.validation.requiresConsent
      ? "permission"
      : state.validation.passed
        ? "passed"
        : "failed";
    state.testing.result = state.validation;
    const report = [
      testPlanMarkdown(state.testing.plan),
      "\n# 실제 실행 결과",
      `상태: ${state.testing.status}`,
      `명령: ${state.validation.command ?? "미실행"}`,
      `종료 코드: ${state.validation.exitCode ?? "없음"}`,
      `요약: ${state.validation.summary}`,
      ...(state.validation.cases ?? []).map(
        (row) => `- ${row.id}: ${row.status} · ${row.title}`,
      ),
      "\n```text",
      state.validation.output ?? "실행 출력 없음",
      "```",
    ].join("\n");
    await this.workspace.write(
      state.projectId,
      `.control-tower/runs/${state.id}/test-report.md`,
      report,
      { internal: true, grantId: state.grantId },
    );
  }
  async revalidate(projectId, runId, options) {
    if (this.isActive(projectId))
      throw new Error("진행 중인 작업이 끝난 후 테스트를 다시 실행하세요.");
    this.starting.add(projectId);
    try {
      const state = await this.current(projectId, runId);
      if (!state || !state.testing)
        throw new Error("이 대화에는 테스트 계획이 없습니다.");
      const before = await this.workspace.snapshot(projectId);
      if (before.hash !== state.snapshotHash)
        throw new Error(
          "검토 이후 소스가 변경되었습니다. 컨트롤 타워에 재검토를 요청하세요.",
        );
      const run = {
        state,
        controller: new AbortController(),
        queue: Promise.resolve(),
      };
      this.runs.set(projectId, run);
      state.options.allowExecution = options.allowExecution === true;
      state.status = "validating";
      state.testing.status = state.options.allowExecution
        ? "running"
        : "permission";
      await this.record(run, "system", "저장된 테스트를 다시 실행합니다.");
      run.promise = (async () => {
        state.validation = await this.validate({
          projectId,
          grantId: state.grantId,
          options: state.options,
          signal: run.controller.signal,
          onOutput: (event) =>
            this.notify({
              type: "agent-progress",
              projectId,
              conversationId: state.options.conversationId,
              agentId: "gpt",
              ...event,
            }),
        });
        const after = await this.workspace.snapshot(projectId);
        if (before.hash !== after.hash)
          state.validation = {
            ...state.validation,
            passed: false,
            stale: true,
            summary: "검증 중 소스가 변경되었습니다.",
          };
        await this.testingResult(run);
        const reviewed =
          state.reviews?.length &&
          state.reviews.every((review) => !review.issues.length);
        state.status =
          state.validation.passed && reviewed
            ? "completed"
            : "awaiting_validation";
        await this.record(run, "system", state.validation.summary);
      })().catch(async (error) => {
        state.status = run.controller.signal.aborted
          ? "cancelled"
          : "needs_attention";
        state.testing.status = run.controller.signal.aborted
          ? "cancelled"
          : "failed";
        state.testing.stale = true;
        await this.record(run, "system", error.message);
      });
      return structuredClone(state);
    } finally {
      this.starting.delete(projectId);
    }
  }
  async current(projectId, runId = null) {
    const active = this.runs.get(projectId);
    if (active && (!runId || active.state.id === runId)) {
      try {
        const grant = await this.workspace.grant(projectId);
        if (grant.root !== active.state.root) return null;
      } catch {
        return null;
      }
      return structuredClone(active.state);
    }
    try {
      const pointer = runId
        ? { id: runId }
        : JSON.parse(
            (
              await this.workspace.read(
                projectId,
                ".control-tower/latest-run.json",
                { internal: true },
              )
            ).toString(),
          );
      if (!/^[0-9a-f-]{36}$/.test(pointer.id))
        throw new Error("잘못된 작업 기록");
      const state = JSON.parse(
        (
          await this.workspace.read(
            projectId,
            `.control-tower/runs/${pointer.id}/state.json`,
            { internal: true, maxBytes: 20000000 },
          )
        ).toString(),
      );
      if (ACTIVE.has(state.status)) state.status = "interrupted";
      return state;
    } catch (error) {
      if (error.code === "ENOENT" || !(await this.hasGrant(projectId)))
        return null;
      throw error;
    }
  }
  async hasGrant(projectId) {
    try {
      await this.workspace.grant(projectId);
      return true;
    } catch {
      return false;
    }
  }
  stop(projectId) {
    const run = this.runs.get(projectId);
    if (run && this.isActive(projectId)) run.controller.abort();
  }
  async stopAndWait(projectId) {
    this.stop(projectId);
    await this.runs.get(projectId)?.promise;
  }
  stopAll() {
    for (const projectId of this.runs.keys()) this.stop(projectId);
  }
}
