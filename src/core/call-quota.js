import { randomUUID } from 'node:crypto';

// One ledger shared by work, questions, fallback attempts and images. Admission
// and cost reservation are serialized before any billable provider request.
export class CallQuota {
  constructor(store, now = () => new Date()) { this.store = store; this.now = now; this.queue = Promise.resolve(); }
  async policy(options) {
    const current = await this.store.read('preferences', {});
    return {...options, ...Object.fromEntries(['maxDailyCalls','dailyApiBudgetUsd','maxImageCallsPerDay'].filter(key => typeof current?.[key] === 'number').map(key=>[key,current[key]]))};
  }
  transaction(operation) {
    const next = this.queue.catch(() => {}).then(async () => {
      const day = this.now().toISOString().slice(0, 10);
      const saved = await this.store.read('call-quota', null);
      const data = saved?.day === day ? saved : { day, calls: 0, images: 0, runs: {}, reservations: {}, usd: 0 };
      const result = await operation(data);
      await this.store.write('call-quota', data);
      return result;
    });
    this.queue = next; return next;
  }
  admit({ runId, options, image = false, reserveUsd = 0 }) {
    return this.transaction(async data => {
      options = await this.policy(options);
      const run = data.runs[runId] ??= { calls: 0, usd: 0 };
      if (data.calls >= (options.maxDailyCalls ?? 300) || run.calls >= (options.maxAgentCalls ?? 120)) throw Object.assign(new Error('호출 한도에 도달했습니다. 설정에서 작업·일일 한도를 확인하고 변경을 승인한 뒤 다시 시작하세요.'), { code: 'APP_QUOTA' });
      if (image && data.images >= (options.maxImageCallsPerDay ?? 5)) throw Object.assign(new Error('오늘 이미지 생성 횟수를 모두 사용했습니다. 설정에서 한도를 확인하세요.'), { code: 'APP_QUOTA' });
      if (!Number.isFinite(reserveUsd) || reserveUsd < 0) throw new Error('요청 비용을 예약하지 못했습니다.');
      if ((options.apiBudgetUsd > 0 && run.usd + reserveUsd > options.apiBudgetUsd) || (options.dailyApiBudgetUsd > 0 && data.usd + reserveUsd > options.dailyApiBudgetUsd)) throw Object.assign(new Error('새 요청의 최대 예약 비용이 작업·일일 API 예산을 넘습니다. 설정에서 예산을 검토하고 변경을 승인하세요.'), { code: 'APP_QUOTA' });
      const id = randomUUID(); data.calls++; run.calls++; if (image) data.images++;
      data.usd += reserveUsd; run.usd += reserveUsd;
      data.reservations[id] = { runId, usd: reserveUsd };
      return { id, day: data.day, reservedUsd: reserveUsd };
    });
  }
  settle(ticket, actualUsd) {
    return this.transaction(data => {
      if (data.day !== ticket.day || !data.reservations[ticket.id]) return;
      const reservation = data.reservations[ticket.id];
      // Missing usage is uncertain billing: retain the full reserved amount.
      const used = Number.isFinite(actualUsd) && actualUsd >= 0 ? actualUsd : reservation.usd;
      const difference = used - reservation.usd;
      data.usd += difference; data.runs[reservation.runId].usd += difference;
      delete data.reservations[ticket.id];
    });
  }
  reserve(ticket, amount, options) {
    return this.transaction(async data => {
      options = await this.policy(options);
      if (amount === null && !(options.apiBudgetUsd > 0 || options.dailyApiBudgetUsd > 0)) amount = 0;
      const current = data.reservations[ticket.id];
      if (data.day !== ticket.day || !current) throw new Error('호출 예약이 만료되었습니다. 다시 요청하세요.');
      const difference = amount - current.usd, run = data.runs[current.runId];
      if (!Number.isFinite(amount) || amount < 0 || (options.apiBudgetUsd > 0 && run.usd + difference > options.apiBudgetUsd) || (options.dailyApiBudgetUsd > 0 && data.usd + difference > options.dailyApiBudgetUsd)) throw Object.assign(new Error('요청 최대 예약 비용이 API 예산을 넘습니다. 설정에서 한도를 검토하고 변경을 승인하세요.'), {code:'APP_QUOTA'});
      data.usd += difference; run.usd += difference; current.usd = amount;
    });
  }
  snapshot() { return this.transaction(data => ({ day: data.day, calls: data.calls, images: data.images, reservedOrSpentUsd: data.usd })); }
}

export function reserveTextCost(instructions, payload, options) {
  if (options.gptModel !== options.apiRateModel || !(options.apiInputRate > 0 || options.apiOutputRate > 0) || payload.designImage) {
    if (!(options.apiBudgetUsd > 0 || options.dailyApiBudgetUsd > 0)) return null;
    throw new Error('API 예산을 적용하려면 현재 텍스트 모델의 단가가 필요합니다. 이미지 입력 비용은 이 예산으로 확인할 수 없습니다.');
  }
  // Conservative admission estimate, not a claim about exact vendor billing.
  const bytes = Buffer.byteLength(instructions + JSON.stringify(payload), 'utf8');
  return (bytes * options.apiInputRate + (options.maxOutputTokens ?? 16384) * options.apiOutputRate) / 1_000_000;
}
