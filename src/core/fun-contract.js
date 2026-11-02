import { createHash } from "node:crypto";
import { teamFor, CAPABILITIES } from "./team.js";
const required = (value, label) => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 30000 ||
    /^(?:TODO|TBD|미정|<미정[^>]*>)$/i.test(value)
  )
    throw new Error(`Fun 명세 누락: ${label}`);
  return value.trim();
};
export const FUN_CONTRACT = `Return JSON with contractVersion:1, version:"1.0.0", questions:[], requirements:[{id:"R1",title,context,trigger,reaction,acceptanceCriteria:["observable test"]}], decisions:[{id,description,source:"user" or "assumption"}], reviewItems:[{description,critical:false}], design:{screens:[{name,layout,states:["idle","running","error"]}],palette:["color purpose"],spacing:"spacing rules",typography:"font rules"}, tasks:[{id,title,owner:"EXACT team panel id",kind:"feature" or "ui" or "debug",requirementIds:["R1"],instructions,acceptanceCriteria:["testable result"],dependsOn:[]}]. Every requirement needs explicit Context + Trigger -> Reaction and testable criteria, and at least one task must cover it. Assign tasks ONLY to a team panel that has the matching kind role. Multiple roles per panel and duplicate roles across panels are allowed. Panel ids are routing keys, NOT AI vendor names. The team is supplied in options.team. Never invent permissions, account access, successful tests or user decisions. When unattended is true, choose reversible implementation details, record every assumption, and put noncritical decisions in reviewItems instead of asking the user. Critical missing permission or unsafe/irreversible scope must return questions and no tasks. Workers never receive the full fun skill.`;
export function skillHash(text) {
  return createHash("sha256").update(text).digest("hex");
}
export function compileFunPlan(plan, options) {
  if (plan.questions?.length) return plan;
  if (plan.contractVersion !== 1)
    throw new Error("Fun 구조화 명세 contractVersion=1이 필요합니다.");
  const version = required(plan.version, "버전");
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("Fun 명세 버전을 확인하세요.");
  if (
    !Array.isArray(plan.requirements) ||
    !plan.requirements.length ||
    plan.requirements.length > 60
  )
    throw new Error("Fun 기능 요구사항이 비어 있습니다.");
  const ids = new Set();
  const requirements = plan.requirements.map((item) => {
    const id = required(item.id, "요구사항 ID");
    if (!/^[A-Za-z0-9_-]{1,50}$/.test(id) || ids.has(id))
      throw new Error("Fun 요구사항 ID가 중복되거나 잘못되었습니다.");
    ids.add(id);
    const result = {
      id,
      title: required(item.title, `${id} 제목`),
      context: required(item.context, `${id} Context`),
      trigger: required(item.trigger, `${id} Trigger`),
      reaction: required(item.reaction, `${id} Reaction`),
    };
    if (
      !Array.isArray(item.acceptanceCriteria) ||
      !item.acceptanceCriteria.length
    )
      throw new Error(`Fun ${id} 완료 기준이 없습니다.`);
    result.acceptanceCriteria = item.acceptanceCriteria.map((value) =>
      required(value, `${id} 완료 기준`),
    );
    return result;
  });
  if (!Array.isArray(plan.decisions) || !Array.isArray(plan.reviewItems))
    throw new Error("Fun 결정 기록과 사용자 검토 목록이 필요합니다.");
  const decisions = plan.decisions.map((item) => ({
    id: required(item.id, "결정 ID"),
    description: required(item.description, "결정 내용"),
    source: ["user", "assumption"].includes(item.source)
      ? item.source
      : (() => {
          throw new Error("Fun 결정의 사용자 입력/가정 출처를 구분하세요.");
        })(),
  }));
  const reviewItems = plan.reviewItems.map((item) => ({
    description: required(item.description, "검토 항목"),
    critical: item.critical === true,
  }));
  if (reviewItems.some((item) => item.critical))
    return {
      ...plan,
      questions: reviewItems
        .filter((item) => item.critical)
        .map((item) => item.description),
      tasks: [],
    };
  const design = plan.design;
  if (
    !design ||
    !Array.isArray(design.screens) ||
    !design.screens.length ||
    !Array.isArray(design.palette) ||
    !design.palette.length
  )
    throw new Error("Fun 화면 구성과 색상 기준이 필요합니다.");
  const screens = design.screens.map((screen) => {
    if (!Array.isArray(screen.states) || !screen.states.length)
      throw new Error("Fun 화면별 상태 동작이 필요합니다.");
    return {
      name: required(screen.name, "화면 이름"),
      layout: required(screen.layout, "화면 구성"),
      states: screen.states.map((value) => required(value, "화면 상태")),
    };
  });
  const palette = design.palette.map((value) => required(value, "색상 기준"));
  const spacing = required(design.spacing, "간격 기준"),
    typography = required(design.typography, "글꼴 기준");
  const team = teamFor(options),
    covered = new Set();
  if (!Array.isArray(plan.tasks) || !plan.tasks.length)
    throw new Error("Fun 구현 작업이 없습니다.");
  for (const task of plan.tasks) {
    const agent = team.find((row) => row.id === task.owner);
    if (
      !agent ||
      !["feature", "ui", "debug"].includes(task.kind) ||
      !agent.roles.includes(task.kind)
    )
      throw new Error("Fun 작업 종류가 배정된 패널 역할과 다릅니다.");
    if (
      !Array.isArray(task.requirementIds) ||
      !task.requirementIds.length ||
      task.requirementIds.some((id) => !ids.has(id))
    )
      throw new Error("Fun 작업과 요구사항의 연결이 누락됐습니다.");
    for (const id of task.requirementIds) covered.add(id);
  }
  if ([...ids].some((id) => !covered.has(id)))
    throw new Error("Fun 명세의 일부 기능에 구현 작업이 없습니다.");
  const spec = [
    `# 기능 명세 · v${version}`,
    `\n## 결정 기록`,
    ...decisions.map(
      (item) => `- ${item.id} [${item.source}]: ${item.description}`,
    ),
    "\n## 화면·디자인 기준",
    ...screens.map(
      (screen) =>
        `- ${screen.name}: ${screen.layout}\n  - 상태: ${screen.states.join(" / ")}`,
    ),
    `- 색상: ${palette.join(" / ")}`,
    `- 간격: ${spacing}`,
    `- 글꼴: ${typography}`,
    "\n## 완료 기준",
    ...requirements.flatMap((item) => [
      `\n### ${item.id} ${item.title}`,
      "```gherkin",
      `Feature: ${item.title}`,
      `  Scenario: ${item.id}`,
      `    Given ${item.context}`,
      `    When ${item.trigger}`,
      `    Then ${item.reaction}`,
      "```",
      ...item.acceptanceCriteria.map((value) => `- [ ] ${value}`),
    ]),
    "\n## 사용자 검토 목록",
    ...(reviewItems.length
      ? reviewItems.map((item, index) => `${index + 1}. ${item.description}`)
      : ["없음"]),
    "\n## 역할 배치",
    ...team.map(
      (agent) =>
        `- ${agent.id}: ${agent.provider} · ${agent.roles.map((role) => CAPABILITIES[role]).join(", ")}`,
    ),
  ].join("\n");
  return {
    ...plan,
    requirements,
    decisions,
    reviewItems,
    design: { screens, palette, spacing, typography },
    spec,
  };
}
