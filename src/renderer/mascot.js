const NAMES={gpt:'GPT',grok:'Grok · Cursor',claude:'Claude',gemini:'Gemini'};
const ROLES={gpt:'컨트롤 타워',grok:'기능 구현',claude:'UI 구현·연결'};
export function mascotState(run,assignments={gpt:'gpt',grok:'grok',claude:'claude'}){
  const roles=run?.options?.roles??assignments;const labels=Object.fromEntries(Object.entries(ROLES).map(([id,role])=>[id,`${role} · ${NAMES[roles[id]]??roles[id]}`]));
  let state='idle',message='다음 작업을 기다리고 있어요.';
  const modes={planning:['planning','컨트롤 타워가 요구사항과 작업 명세를 정리하고 있어요.'],building:['working','기능·UI 담당이 배정된 작업을 처리하고 있어요.'],repairing:['working','담당 AI가 지적된 문제를 수정하고 있어요.'],validating:['checking','저장된 코드의 실행 검증을 확인하고 있어요.'],reviewing:['checking','컨트롤 타워가 같은 코드 버전을 검토하고 있어요.'],final_review:['checking','세 역할의 AI 세션이 최종 검토하고 있어요.'],completed:['done','실행 검증과 최종 검토를 통과했어요.'],awaiting_validation:['waiting','코드 검토는 끝났고, 실행 검증을 기다리고 있어요.'],needs_input:['waiting','답이 필요한 질문이 있어요. 작업 로그를 확인해 주세요.'],needs_attention:['error','확인이 필요해요. 작업 로그에서 원인을 확인해 주세요.'],cancelled:['paused','작업을 중지했어요.'],interrupted:['paused','이전 작업이 중단됐어요. 기록을 확인해 주세요.']};
  if(run&&modes[run.status])[state,message]=modes[run.status];
  const active=['planning','building','repairing','validating','reviewing','final_review'].includes(run?.status);
  const event=active?run.events?.findLast(item=>['dispatch','report'].includes(item.activity)):null;
  const handoff=event&&['grok','claude'].includes(event.actor)?{key:`${run.id}:${event.at}:${event.activity}:${event.taskId}`,from:event.activity==='dispatch'?'gpt':event.actor,to:event.activity==='dispatch'?event.actor:'gpt'}:null;
  return {state,message,labels,handoff};
}
export function createMascot(stage){
  const carrier=stage.querySelector('.mascot-carrier'),toggle=stage.querySelector('.mascot-motion-toggle');let lastKey=null;
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');let enabled=true;
  try{enabled=localStorage.getItem('cw-handsoff-mascot-motion')!=='off';}catch{}
  function motion(){const moving=enabled&&!reduced.matches;stage.dataset.motion=moving?'on':'off';toggle.textContent=enabled?'움직임 끄기':'움직임 켜기';toggle.setAttribute('aria-pressed',String(enabled));if(!moving)carrier.classList.remove('is-delivering');}
  toggle.addEventListener('click',()=>{enabled=!enabled;try{localStorage.setItem('cw-handsoff-mascot-motion',enabled?'on':'off');}catch{}motion();});
  reduced.addEventListener('change',motion);carrier.addEventListener('animationend',event=>{if(event.target===carrier)carrier.classList.remove('is-delivering');});
  const visibility=()=>{stage.dataset.hidden=String(document.hidden);};document.addEventListener('visibilitychange',visibility);visibility();motion();
  return {update(run,assignments){const view=mascotState(run,assignments);stage.dataset.state=view.state;stage.querySelector('.mascot-message').textContent=view.message;
    for(const role of ['gpt','grok','claude'])stage.querySelector(`[data-mascot-role="${role}"]`).textContent=view.labels[role];
    stage.querySelector('.mascot-event').textContent=view.handoff?`${view.labels[view.handoff.from]} → ${view.labels[view.handoff.to]}`:'실제 작업 전달과 완료 보고에 맞춰 움직입니다.';
    if(!view.handoff){carrier.classList.remove('is-delivering');lastKey=null;return;}
    if(view.handoff.key===lastKey)return;lastKey=view.handoff.key;
    if(stage.dataset.motion!=='on'||document.hidden)return;
    carrier.dataset.from=view.handoff.from;carrier.dataset.to=view.handoff.to;carrier.classList.remove('is-delivering');void carrier.offsetWidth;carrier.classList.add('is-delivering');
  }};
}
