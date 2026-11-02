export const DEFAULT_ROLES=Object.freeze({gpt:'gpt',grok:'grok',claude:'claude'});
export const PROVIDER_NAMES=Object.freeze({gpt:'GPT',claude:'Claude',grok:'Grok · Cursor',gemini:'Gemini'});
export const ROLE_NAMES=Object.freeze({gpt:'컨트롤 타워',grok:'기능 구현',claude:'UI 구현·연결'});
export function validateRoles(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==3||Object.keys(DEFAULT_ROLES).some(role=>!Object.hasOwn(PROVIDER_NAMES,value[role])))throw new Error('세 역할에 사용할 AI를 각각 선택하세요.');
  return Object.fromEntries(Object.keys(DEFAULT_ROLES).map(role=>[role,value[role]]));
}
export class RoleAssignments {
  constructor(projects){this.projects=projects;}
  async get(id){const project=this.projects.find(await this.projects.list(),id);return validateRoles(project.roles??DEFAULT_ROLES);}
  async set(id,value){const roles=validateRoles(value);await this.projects.mutate(data=>{this.projects.find(data,id).roles=roles;});return roles;}
}
// Keep existing task owner IDs stable for persisted runs; route by frozen role assignment.
export function roleProviders(providers){
  return Object.fromEntries(Object.keys(DEFAULT_ROLES).map(role=>[role,{
    async ready(options){const selected=validateRoles(options.roles??DEFAULT_ROLES)[role];return providers[selected].ready(options);},
    async plan(context){const selected=validateRoles(context.options.roles??DEFAULT_ROLES)[role];return providers[selected].plan(context);},
    async build(context){const selected=validateRoles(context.options.roles??DEFAULT_ROLES)[role];return providers[selected].build(context);},
    async review(context){const selected=validateRoles(context.options.roles??DEFAULT_ROLES)[role];return providers[selected].review(context);}
  }]));
}
