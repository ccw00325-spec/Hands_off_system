export function validationResult({ code, output, overflow = false, testPlan, command, startedAt, backend = 'host' }) {
  const observed = [...output.matchAll(/^(not ok|ok)\s+\d+\s+-\s+([^\r\n]+)/gm)].map(match => ({
    passed: match[1] === 'ok' && !/\s#\s*(?:SKIP|TODO)\b/i.test(match[2]),
    skipped: /\s#\s*(?:SKIP|TODO)\b/i.test(match[2]), name: match[2],
  }));
  const cases = (testPlan?.cases ?? []).map(row => {
    const matches = observed.filter(item => item.name === row.id || item.name.startsWith(row.id + ' ') || item.name.startsWith(row.id + ':'));
    return { id: row.id, title: row.title, status: !matches.length ? 'not-observed' : matches.some(item => !item.passed && !item.skipped) ? 'failed' : matches.some(item => item.skipped) ? 'skipped' : 'passed' };
  });
  const complete = cases.every(row => row.status === 'passed');
  return { configured: true, passed: code === 0 && complete && !overflow, exitCode: code, backend,
    summary: overflow ? '출력이 검증 한도를 초과했습니다.' : code === 0 && complete ? '사용자가 지정한 검증 명령을 통과했습니다.' : code === 0 ? '명령은 종료했지만 계획한 테스트 일부가 생략됐거나 실행을 확인하지 못했습니다.' : '검증 명령이 실패했습니다.',
    output, command, startedAt, finishedAt: new Date().toISOString(), cases };
}
