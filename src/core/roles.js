import {
  defaultTeam,
  validateTeam,
  teamFor,
  agentOptions,
  SLOT_IDS,
} from "./team.js";
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
  return Object.fromEntries(
    SLOT_IDS.map((role) => [
      role,
      {
        async ready(options) {
          const agent = teamFor(options).find((row) => row.id === role);
          return (
            !!agent &&
            providers[agent.provider].ready(agentOptions(options, role))
          );
        },
        async plan(context) {
          const agent = teamFor(context.options).find((row) => row.id === role);
          return providers[agent.provider].plan({
            ...context,
            options: agentOptions(context.options, role),
          });
        },
        async build(context) {
          const agent = teamFor(context.options).find((row) => row.id === role);
          return providers[agent.provider].build({
            ...context,
            options: agentOptions(context.options, role),
          });
        },
        async review(context) {
          const agent = teamFor(context.options).find((row) => row.id === role);
          return providers[agent.provider].review({
            ...context,
            options: agentOptions(context.options, role),
          });
        },
      },
    ]),
  );
}
