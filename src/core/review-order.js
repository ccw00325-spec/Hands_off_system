import { teamFor } from './team.js';

const priority = { grok: 0, gemini: 1, claude: 2, gpt: 3 };
export function sortReviewAgents(team) {
  return team.map((agent,index)=>({agent,index})).sort((a,b)=>
    Number(a.agent.id==='gpt')-Number(b.agent.id==='gpt') ||
    (priority[a.agent.provider]??4)-(priority[b.agent.provider]??4) || a.index-b.index).map(row=>row.agent);
}
export function reviewOrder(options) {
  return sortReviewAgents(teamFor(options).filter(agent=>agent.id==='gpt'||agent.roles.some(role=>['debug','review'].includes(role))));
}
export function orderDebugTasks(plan, options) {
  if (!Array.isArray(plan.tasks) || plan.questions?.length) return plan;
  const agents=sortReviewAgents(teamFor(options)).map(agent=>agent.id);
  const tasks=plan.tasks.filter(task=>task.kind==='debug').sort((a,b)=>agents.indexOf(a.owner)-agents.indexOf(b.owner));
  for(let index=1;index<tasks.length;index++) tasks[index].dependsOn=[...new Set([...(tasks[index].dependsOn??[]),tasks[index-1].id])];
  return plan;
}
