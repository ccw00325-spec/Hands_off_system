import { createHash } from "node:crypto";
import { teamFor, CAPABILITIES } from "./team.js";
import { validateTestPlan } from "./test-plan.js";
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
export const FUN_CONTRACT = `Return JSON with contractVersion:1, version:"1.0.0", questions:[], requirements:[{id:"R1",title,context,trigger,reaction,acceptanceCriteria:["observable test"]}], decisions:[{id,description,source:"user" or "assumption"}], reviewItems:[{description,critical:false}], design:{screens:[{name,layout,states:["idle","running","error"]}],palette:["color purpose"],spacing:"spacing rules",typography:"font rules"}, tasks:[{id,title,owner:"EXACT team panel id",kind:"feature" or "ui" or "debug" or "test",requirementIds:["R1"],instructions,acceptanceCriteria:["testable result"],dependsOn:[]}]. Every requirement needs explicit Context + Trigger -> Reaction and testable criteria, and at least one task must cover it. Assign tasks ONLY to a team panel that has the matching kind role. Multiple roles per panel are allowed. Feature and UI implementation each have exactly one owner panel. Debug, review and test roles may be shared across panels. Panel ids are routing keys, NOT AI vendor names. The team is supplied in options.team. Never invent permissions, account access, successful tests or user decisions. When unattended is true, choose reversible implementation details, record every assumption, and put noncritical decisions in reviewItems instead of asking the user. Critical missing permission or unsafe/irreversible scope must return questions and no tasks. When a team panel has the test role, include testPlan:{runner:"node-test" (preferred) or "npm",files:["tests/app.test.cjs"],cases:[{id:"T1",requirementId:"R1",type:"unit" or "integration" or "e2e",title,given,when,expected,steps:["exact reproduction step"]}]}. Cover EVERY requirement with meaningful assertions, include normal and applicable error/boundary cases. Every automated test name MUST begin with its case id (e.g. T1) so the host can verify that each planned test actually ran. Use built-in node:test/assert and no new dependencies unless already installed. An unavailable browser/framework must be reported as a limitation, not a passing test. For multiple test tasks, provide task.testFiles as disjoint subsets covering testPlan.files. Test tasks depend on implementation, can only edit their assigned test files, and cannot weaken implementation or change acceptance criteria to make tests pass. Workers never receive the full fun skill.`;
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
      !["feature", "ui", "debug", "test"].includes(task.kind) ||
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
  const testing = team.some((agent) => agent.roles.includes("test"));
  const testTasks = plan.tasks.filter((task) => task.kind === "test");
  if (testing && !testTasks.length)
    throw new Error(
      "테스트 역할을 선택했습니다. 테스트 코드 작성 작업이 필요합니다.",
    );
  if (!testing && testTasks.length)
    throw new Error("테스트 역할을 배정한 패널이 없습니다.");
  const testPlan = testing
    ? validateTestPlan(plan.testPlan, requirements)
    : null;
  if (testPlan) {
    const implementation = plan.tasks
      .filter((task) => task.kind !== "test")
      .map((task) => task.id);
    for (const task of testTasks)
      task.dependsOn = [...new Set([...task.dependsOn, ...implementation])];
  }
  if (testPlan) {
    const assigned = new Set();
    for (const task of testTasks) {
      task.testFiles ??= testTasks.length === 1 ? [...testPlan.files] : [];
      if (
        !Array.isArray(task.testFiles) ||
        !task.testFiles.length ||
        task.testFiles.some(
          (path) => !testPlan.files.includes(path) || assigned.has(path),
        )
      )
        throw new Error(
          "여러 테스트 담당자는 서로 다른 테스트 파일을 맡아야 합니다.",
        );
      for (const path of task.testFiles) assigned.add(path);
    }
    if (testPlan.files.some((path) => !assigned.has(path)))
      throw new Error("담당자가 없는 테스트 코드 파일이 있습니다.");
  }
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
    testPlan,
  };
}
