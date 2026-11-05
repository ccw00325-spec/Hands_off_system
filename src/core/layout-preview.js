import { redact } from './secrets.js';
export function layoutPreview(request, specification, feedback = []) {
  const render = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  let spec;
  if (Array.isArray(specification?.screens)) {
    const lines = specification.screens.flatMap((screen,index) => [
      `화면 ${index+1} · ${screen.name ?? '이름 미지정'}`,
      ...(screen.layout ? ['  배치: ' + render(screen.layout)] : []),
      ...(screen.states ? ['  상태: ' + render(screen.states)] : []),
      ...Object.entries(screen).filter(([key]) => !['name','layout','states'].includes(key)).map(([key,value]) => `  ${key}: ${render(value)}`), '',
    ]);
    for (const [key,value] of Object.entries(specification).filter(([key])=>key!=='screens')) lines.push(`${{palette:'색상',spacing:'간격',typography:'글꼴',components:'구성 요소',interactions:'상호작용'}[key] ?? key}: ${render(value)}`);
    spec = lines.join('\n');
  } else spec = render(specification);
  return redact([
    '┌─────────────────────────────────────────────┐',
    '│  UI 구조안 · 이미지 API 호출 없음            │',
    '└─────────────────────────────────────────────┘',
    '', '요청', String(request).slice(0, 1800), '', '설계에 명시한 화면·상태·스타일', String(spec ?? '').slice(0, 7000),
    ...(feedback.length ? ['', '사용자가 요청한 변경', ...feedback.map((text, index) => `${index + 1}. ${text}`)] : []),
    '', '이 구조안은 완성 화면 이미지가 아닙니다. 승인하면 담당 AI가 위 조건으로 구현합니다.',
    '상세한 시각 시안이 필요할 때만 이미지 생성 버튼을 사용하세요.',
  ].join('\n'));
}
