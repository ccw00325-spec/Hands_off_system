import { redact } from './secrets.js';

export function clarificationQuestions(value) {
  if (!Array.isArray(value) || !value.length || value.length > 8)
    throw new Error('질문은 한 번에 1~8개까지 전달할 수 있습니다.');
  const ids = new Set();
  return value.map((item, index) => {
    const raw = typeof item === 'string' ? { prompt: item } : item;
    const id = raw?.id ?? `Q${index + 1}`;
    const prompt = raw?.prompt ?? raw?.question;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,60}$/.test(id) || ids.has(id) ||
        typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000)
      throw new Error('질문의 ID와 내용을 확인하세요.');
    ids.add(id);
    const options = raw.options ?? [];
    if (!Array.isArray(options) || options.length > 6 || options.some(option => typeof option !== 'string' || !option.trim() || option.length > 1000))
      throw new Error('질문 선택지를 확인하세요.');
    return { id, prompt: redact(prompt.trim()), options: [...new Set(options.map(option => redact(option.trim())))] };
  });
}

export function clarificationAnswers(questions, answers) {
  if (!Array.isArray(answers) || answers.length !== questions.length)
    throw new Error('각 질문의 선택지를 고르거나 직접 답변을 입력하세요.');
  const seen = new Set();
  const result = answers.map(answer => {
    const question = questions.find(row => row.id === answer?.id);
    if (!question || seen.has(answer.id) || !['option', 'text'].includes(answer.kind) ||
        typeof answer.value !== 'string' || !answer.value.trim() || answer.value.length > 4000 ||
        (answer.kind === 'option' && !question.options.includes(answer.value)))
      throw new Error('질문의 선택지 또는 직접 입력한 답변을 확인하세요.');
    seen.add(answer.id);
    return { id: answer.id, prompt: question.prompt, kind: answer.kind, value: redact(answer.value.trim()) };
  });
  if (JSON.stringify(result).length > 20000) throw new Error('답변 전체 길이를 줄여 주세요.');
  return result;
}
