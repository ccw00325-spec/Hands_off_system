import {
  defaultTeam,
  validateTeam,
  teamFor,
  agentOptions,
  SLOT_IDS,
} from "./team.js";
import { isQuotaExhausted } from "./provider-errors.js";
export const DEFAULT_ROLES = Object.freeze({
  gpt: "gpt",
  grok: "grok",
  claude: "claude",
});
export const PROVIDER_NAMES = Object.freeze({
  gpt: "GPT",
  claude: "Claude",
  grok: "Grok · Cursor",
  gemini: "Gemini",
});
export const ROLE_NAMES = Object.freeze({
  gpt: "컨트롤 타워",
  grok: "기능 구현",
  claude: "UI 구현·연결",
});
export function validateRoles(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    Object.keys(DEFAULT_ROLES).some(
      (role) => !Object.hasOwn(PROVIDER_NAMES, value[role]),
    )
  )
    throw new Error("세 역할에 사용할 AI를 각각 선택하세요.");
  return Object.fromEntries(
    Object.keys(DEFAULT_ROLES).map((role) => [role, value[role]]),
  );
}
export class RoleAssignments {
  constructor(projects) {
    this.projects = projects;
  }
  async get(id) {
    const project = this.projects.find(await this.projects.list(), id);
    return validateRoles(project.roles ?? DEFAULT_ROLES);
  }
  async set(id, value) {
    const roles = validateRoles(value);
    await this.projects.mutate((data) => {
      const project = this.projects.find(data, id);
      project.roles = roles;
      project.team = defaultTeam(roles);
    });
    return roles;
  }
  async getTeam(id) {
    const project = this.projects.find(await this.projects.list(), id);
    return validateTeam(
      project.team ?? defaultTeam(project.roles ?? DEFAULT_ROLES),
    );
  }
  async setTeam(id, value) {
    const team = validateTeam(value);
    await this.projects.mutate((data) => {
      const project = this.projects.find(data, id);
      project.team = team;
      project.roles = {
        gpt: team[0].provider,
        grok: team.find((agent) => agent.roles.includes("feature")).provider,
        claude: team.find((agent) => agent.roles.includes("ui")).provider,
      };
    });
    return team;
  }
}
// Keep existing task owner IDs stable for persisted runs; route by frozen role assignment.
export function roleProviders(providers) {
  async function invoke(role, action, context) {
    const options = context.options;
    const configured = validateTeam(options.team ?? defaultTeam(options.roles)).find((row) => row.id === role);
    if (!configured) throw new Error("현재 팀에 없는 AI 패널입니다.");
    let agent = teamFor(options).find((row) => row.id === role);
    for (let attempt = 0; attempt < 2; attempt++) {
      context.signal?.throwIfAborted();
      const local = agentOptions(options, role);
      await options.onProviderAttempt?.({ actor: role, provider: agent.provider, modelId: agent.modelId, action });
      try {
        return await providers[agent.provider][action]({ ...context, options: local });
      } catch (error) {
        if (context.signal?.aborted || !isQuotaExhausted(error)) throw error;
        if (options.runtimeRoutes?.[role] || !configured.fallback || attempt)
          throw new Error(`${PROVIDER_NAMES[agent.provider]} 사용 한도를 소진했습니다. 사용 가능한 대체 AI를 설정하거나 한도 갱신 후 다시 시작하세요.`);
        const next = configured.fallback;
        const nextOptions = { ...options, runtimeRoutes: { ...options.runtimeRoutes, [role]: next } };
        if (!(await providers[next.provider]?.ready(agentOptions(nextOptions, role))))
          throw new Error(`${PROVIDER_NAMES[agent.provider]} 한도를 소진했지만 대체 ${PROVIDER_NAMES[next.provider]}의 로그인 또는 모델이 준비되지 않았습니다. 계정 연결을 확인하세요.`);
        context.signal?.throwIfAborted();
        await options.onProviderSwitch?.({ actor: role, from: agent.provider, provider: next.provider,
          ...(next.modelId ? { modelId: next.modelId } : {}), reason: "quota_exhausted", action });
        options.runtimeRoutes ??= {};
        options.runtimeRoutes[role] = { ...next };
        agent = teamFor(options).find((row) => row.id === role);
      }
    }
  }
  return Object.fromEntries(
    SLOT_IDS.map((role) => [
      role,
      {
        routed: true,
        async ready(options) {
          const agent = teamFor(options).find((row) => row.id === role);
          if(!agent)return false;
          try { return await providers[agent.provider].ready(agentOptions(options, role)); }
          catch(error) {
            if(!isQuotaExhausted(error)||options.runtimeRoutes?.[role]||!agent.fallback)throw error;
            const next=agent.fallback;
            const routed={...options,runtimeRoutes:{...options.runtimeRoutes,[role]:next}};
            if(!(await providers[next.provider]?.ready(agentOptions(routed,role))))
              throw new Error(`${PROVIDER_NAMES[agent.provider]} 한도 소진 · 대체 ${PROVIDER_NAMES[next.provider]}의 연결과 모델을 확인하세요.`);
            options.runtimeRoutes??={};options.runtimeRoutes[role]={...next};
            options.preflightSwitches??=[];options.preflightSwitches.push({actor:role,from:agent.provider,...next});
            return true;
          }
        },
        async plan(context) {
          return invoke(role, "plan", context);
        },
        async build(context) {
          return invoke(role, "build", context);
        },
        async review(context) {
          return invoke(role, "review", context);
        },
        async chat(context) {
          return invoke(role, "chat", context);
        },
      },
    ]),
  );
}
