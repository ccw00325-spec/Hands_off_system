import { relativeFile } from "./workspace.js";
const text = (value, label) => {
  if (typeof value !== "string" || !value.trim() || value.length > 4000)
    throw new Error(`테스트 계획 누락: ${label}`);
  return value.trim();
};
export function validateTestPlan(plan, requirements) {
  if (
    !plan ||
    !["node-test", "npm"].includes(plan.runner) ||
    !Array.isArray(plan.files) ||
    !plan.files.length ||
    plan.files.length > 30 ||
    !Array.isArray(plan.cases) ||
    !plan.cases.length ||
    plan.cases.length > 100
  )
    throw new Error("테스트 코드·실행기·시나리오 계획이 필요합니다.");
  const files = [
    ...new Set(
      plan.files.map((path) => {
        relativeFile(path);
        if (!/^tests?\//.test(path) || !/\.(?:[cm]?[jt]sx?)$/i.test(path))
          throw new Error("테스트 파일은 tests/ 또는 test/ 안에 작성하세요.");
        return path;
      }),
    ),
  ];
  const requirementIds = new Set(requirements.map((row) => row.id)),
    covered = new Set(),
    caseIds = new Set();
  const cases = plan.cases.map((row) => {
    const id = text(row.id, "시나리오 ID");
    if (!/^[A-Za-z0-9_-]{1,60}$/.test(id) || caseIds.has(id))
      throw new Error("테스트 ID가 중복됐거나 올바르지 않습니다.");
    caseIds.add(id);
    if (
      !requirementIds.has(row.requirementId) ||
      !["unit", "integration", "e2e"].includes(row.type) ||
      !Array.isArray(row.steps) ||
      !row.steps.length
    )
      throw new Error("테스트의 요구사항·종류·재현 절차를 확인하세요.");
    covered.add(row.requirementId);
    return {
      id,
      requirementId: row.requirementId,
      type: row.type,
      title: text(row.title, "제목"),
      given: text(row.given, "전제"),
      when: text(row.when, "입력"),
      expected: text(row.expected, "기대 결과"),
      steps: row.steps.map((step) => text(step, "재현 단계")),
    };
  });
  if ([...requirementIds].some((id) => !covered.has(id)))
    throw new Error("테스트가 연결되지 않은 요구사항이 있습니다.");
  return { runner: plan.runner, files, cases };
}
export function testPlanMarkdown(plan) {
  return [
    "# 테스트 설계·재현 절차",
    `실행기: ${plan.runner}`,
    `테스트 코드: ${plan.files.join(", ")}`,
    ...plan.cases.flatMap((row) => [
      `\n## ${row.id} · ${row.title}`,
      `요구사항: ${row.requirementId} · ${row.type}`,
      `- 전제: ${row.given}`,
      `- 입력: ${row.when}`,
      `- 기대 결과: ${row.expected}`,
      ...row.steps.map((step, index) => `${index + 1}. ${step}`),
    ]),
  ].join("\n");
}
