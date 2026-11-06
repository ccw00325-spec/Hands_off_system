export function requestIssues({ folder, team, roleSaving, connection, gptModel, question, text }) {
  const issues = [];
  const names = { gpt: 'GPT', grok: 'Cursor', claude: 'Claude', gemini: 'Gemini' };
  if (!folder) issues.push({ label: '프로젝트 폴더 연결', action: 'folder', button: '폴더 선택', message: '왼쪽 프로젝트의 작업 폴더를 먼저 선택하고 접근에 동의해 주세요.' });
  if (!team?.length || roleSaving) issues.push({ label: '역할 배치 확인', action: 'roles', button: 'AI 역할 변경', message: '상단 ‘AI 역할 변경’에서 담당 AI와 역할을 저장해 주세요.' });
  for (const agent of (question ? team?.slice(0, 1) : team) ?? []) {
    const status = connection?.[agent.provider], name = names[agent.provider] ?? agent.provider;
    if (!status?.connected) issues.push({ label: `${name} 로그인`, action: 'connections', button: '계정 · 연결', message: `우측 상단 ‘계정 · 연결’에서 ${name}에 로그인해 주세요.` });
    const needsModel = agent.provider === 'gpt' ? status?.source === 'api' && !gptModel : ['grok', 'gemini'].includes(agent.provider) && !status?.modelId;
    if (!agent.modelId && needsModel) issues.push({ label: `${name} 모델 선택`, action: 'roles', agentId: agent.id, button: 'AI 역할 변경', message: `상단 ‘AI 역할 변경’에서 ${name} 담당 패널의 모델을 선택하고 저장해 주세요.` });
  }
  if (!text?.trim()) issues.push({ label: '요청 내용 입력', action: 'input', button: '요청 입력', message: '채팅 입력란에 만들고 싶은 기능이나 질문을 입력해 주세요.' });
  return issues;
}

export function createRequestAlerts(onAction) {
  const stack = document.querySelector('#request-alerts');
  return issues => {
    const card = document.createElement('article');
    card.className = 'request-alert'; card.setAttribute('role', 'alert');
    const title = document.createElement('strong'); title.textContent = 'Error · 먼저 준비해 주세요'; card.append(title);
    const unique = [...new Map(issues.map(issue => [issue.message, issue])).values()];
    for (const issue of unique) {
      const row = document.createElement('div'), message = document.createElement('p'), action = document.createElement('button');
      message.textContent = issue.message; action.type = 'button'; action.textContent = issue.button;
      action.onclick = () => { dismiss(); onAction(issue); };
      row.append(message, action); card.append(row);
    }
    const close = document.createElement('button'); close.type = 'button'; close.className = 'request-alert-close';
    close.textContent = '×'; close.setAttribute('aria-label', '작업 준비 안내 닫기');
    const hint = document.createElement('small'); hint.textContent = '5초 후 자동으로 닫힙니다.';
    const dismiss = () => { clearTimeout(timer); card.remove(); if (!stack.children.length && stack.matches(':popover-open')) stack.hidePopover(); };
    close.onclick = dismiss; card.append(close, hint); stack.append(card);
    if (!stack.matches(':popover-open')) stack.showPopover();
    const timer = setTimeout(dismiss, 5000);
  };
}
