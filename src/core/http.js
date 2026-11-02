export async function requestJson(url, options = {}, fetcher = fetch) {
  const response = await fetcher(url, { ...options, redirect: 'error', signal: options.signal ?? AbortSignal.timeout(30000) });
  let body;
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) {
    // Do not surface provider error bodies: these can echo prompts or credentials.
    const messages = {
      400: '요청을 처리할 수 없습니다. 연결 권한 또는 입력값을 확인하세요.',
      401: '인증이 만료되었거나 키가 올바르지 않습니다. 다시 연결하세요.',
      403: '이 계정에는 요청한 기능의 권한이 없습니다.',
      404: '요청한 모델을 사용할 수 없습니다. 계정의 모델 권한을 확인하세요.',
      429: '사용 한도, 잔액 또는 요청 빈도 제한에 도달했습니다.'
    };
    const error = new Error(messages[response.status] ?? `공급자 요청이 실패했습니다. HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

export function publicError(error) {
  if (['TimeoutError', 'AbortError'].includes(error.name)) return '요청 시간이 초과되었거나 취소되었습니다. 연결 상태를 확인하세요.';
  if (error instanceof TypeError) return '공급자에 연결할 수 없습니다. 네트워크 상태를 확인하세요.';
  return String(error.message || '작업에 실패했습니다.')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[보호된 키]')
    .replace(/eyJ[A-Za-z0-9_.-]+/g, '[보호된 토큰]')
    .slice(0, 350);
}
