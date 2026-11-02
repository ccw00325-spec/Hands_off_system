import {createMascot} from './mascot.js';
const $ = selector => document.querySelector(selector);
const mascot=createMascot($('#mascot-stage'));
const api = window.tower;
let projectData, connection, editingProject = false, resultImage = null, toastTimer;
let generationProject = null;
let folderTicket = null, linkedFolder = null, currentRun = null;
const ACTIVE_RUN = new Set(['planning','building','validating','reviewing','repairing','final_review']);
const resultCache = new Map();
let usageData=null,usageProvider='claude',restoring=false,lastActivity=0;
const usageRunStates=new Map();
const AI_NAMES={gpt:'GPT',grok:'Grok · Cursor',claude:'Claude',gemini:'Gemini'};
const ROLE_LABELS={gpt:'컨트롤 타워',grok:'기능 구현',claude:'UI 구현·연결'};
let roleAssignments=null,rolesProjectId=null,rolesDialogProjectId=null,roleSaving=false;

function toast(message, type = '') {
  $('#toast').textContent = message; $('#toast').className = `toast ${type}`; $('#toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 6500);
  $('#footer-status').textContent = message;
}
async function call(promise) {
  const result = await promise;
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
function message(selector, text, type = '') { $(selector).textContent = text; $(selector).className = `hint ${type}`; }
function pill(selector, text, good = false) { $(selector).textContent = text; $(selector).className = `status-pill${good ? ' connected' : ''}`; }
async function busy(button, text, task) {
  const previous = button.textContent; button.disabled = true; button.textContent = text; button.setAttribute('aria-busy', 'true');
  try { return await task(); }
  catch (error) { toast(error.message, 'error'); }
  finally {
    button.disabled = false; button.textContent = previous; button.removeAttribute('aria-busy');
    if (button.id === 'chatgpt-login' && connection) {
      button.disabled = connection.waiting || !connection.secureStorage;
      button.textContent = connection.waiting ? '브라우저에서 승인 대기 중…' : connection.accounts.length ? '다른 계정 연결 ↗' : 'Continue with ChatGPT ↗';
    }
    updateReadiness();
  }
}
function openConnections() { $('#connections').showModal(); }
function activeProject() { return projectData.items.find(project => project.id === projectData.activeId); }
function renderProjects(data) {
  projectData = data;
  roleAssignments=null;rolesProjectId=null;
  const roleProject=data.activeId;
  void call(api.roles(roleProject)).then(value=>{if(projectData.activeId!==roleProject)return;roleAssignments=value;rolesProjectId=roleProject;renderAssignedRoles();updateReadiness();}).catch(error=>toast(error.message,'error'));
  $('#project-select').replaceChildren(...data.items.map(project => new Option(project.title, project.id)));
  $('#project-select').value = data.activeId; $('#project-title').textContent = activeProject().title;
  document.title = `${activeProject().title} — CW_Handsoff_sys`;
  resultImage = resultCache.get(data.activeId) ?? null; renderImage();
  linkedFolder = null; currentRun = null;
  void refreshWorkspace();
  const id = data.activeId;
  if (!resultImage) void call(api.latestImage(id)).then(result => {
    if (result) resultCache.set(id, result);
    if (projectData.activeId === id && result) { resultImage = result; renderImage(); }
  }).catch(error => toast(error.message, 'error'));
}
function renderImage() {
  const currentGenerating = generationProject === projectData?.activeId;
  $('#image-empty').hidden = Boolean(resultImage); $('#generated-image').hidden = !resultImage; $('#image-result').hidden = !resultImage;
  if (resultImage) $('#generated-image').src = resultImage.dataUrl; else $('#generated-image').removeAttribute('src');
  $('#image-empty h3').textContent = currentGenerating ? '시안을 생성하고 있습니다…' : '시안을 이곳에서 확인합니다.';
  $('#image-empty p').textContent = currentGenerating ? '응답을 기다리고 있습니다. 완료 전까지 생성 완료로 표시하지 않습니다.' : '생성이 완료되면 현재 프로젝트에 저장됩니다.';
}
async function refreshStatus() {
  const status = await call(api.status()); connection = status;
  const account = status.accounts.find(item => item.active);
  const usable = account?.planEnabled === true;
  pill('#gpt-status', usable ? '권한 승인됨' : account?.signedIn ? '사용 권한 필요' : '미연결', usable);
  pill('#auth-status', usable ? '권한 승인됨' : account?.signedIn ? '로그인만 완료' : '미연결', usable);
  if(account?.needsReconnect){pill('#gpt-status','연결 재확인 필요');pill('#auth-status','연결 재확인 필요');}
  pill('#key-status', status.image.saved ? '등록됨' : '미등록', status.image.saved);
  pill('#claude-status', status.claude.connected ? 'CLI 로그인됨' : '미연결', status.claude.connected);
  pill('#claude-auth-status', status.claude.connected ? 'CLI 로그인됨' : status.claude.installed ? '미연결' : '설치 필요', status.claude.connected);
  $('#claude-login').disabled = !status.claude.installed || status.claude.connected;
  $('#connection-count').textContent = Number(usable) + Number(status.claude.connected) + Number(status.grok.connected)+Number(status.gemini.connected);
  $('#connection-dot').classList.toggle('mint-dot', usable || status.claude.connected || status.grok.connected||status.gemini.connected);
  $('#storage-status').textContent = status.secureStorage ? '✓ OS 암호화 저장소 사용 가능' : 'OS 보안 저장소 사용 불가 · 저장 차단';
  $('#save-key').disabled = !status.secureStorage;
  $('#chatgpt-login').disabled = status.waiting || !status.secureStorage;
  $('#chatgpt-login').textContent = status.waiting ? '브라우저에서 승인 대기 중…' : status.accounts.length ? '다른 계정 연결 ↗' : 'Continue with ChatGPT ↗';
  $('#cancel-login').hidden = !status.waiting;
  $('#delete-key').hidden = !status.image.saved;
  $('#image-api-key').placeholder = status.image.saved ? '교체하려면 새 키를 입력하세요.' : 'sk-…';
  $('#image-key-hint').textContent = status.image.saved ? '✓ 이미지 API 키 등록됨 · 실제 생성 시 권한과 잔액 확인' : '연결 설정에서 이미지 API 키를 등록하세요.';
  $('#generate-image').disabled = !status.image.saved || !linkedFolder || generationProject !== null;
  $('#account-section').hidden = !status.accounts.length;
  const previousSelected = $('#account-select').value;
  $('#account-select').replaceChildren(...status.accounts.map(item => new Option(`${item.label}${item.active ? ' · 현재 사용' : ''}${!item.signedIn ? ' · 재로그인 필요' : ''}`, item.id)));
  $('#account-select').value = status.accounts.some(item => item.id === previousSelected) ? previousSelected : account?.id ?? status.accounts[0]?.id ?? '';
  $('#sign-out').disabled = !account?.signedIn;
  if (account) message('#auth-message', usable ? `${account.label} · 사용 권한을 승인했습니다. 실제 모델 접근은 요청 시 확인됩니다.` : '로그인은 완료됐지만 AI 사용 권한은 없습니다. 다시 승인으로 권한을 연결하세요.', usable ? 'success' : '');
  if (status.claude.connected) message('#claude-message', '터미널에 저장된 Claude 로그인을 사용합니다. 다시 로그인할 필요가 없습니다.', 'success');
  else if (!status.claude.installed) message('#claude-message', '공식 Claude Code를 설치한 후 상태 다시 확인을 눌러주세요.');
  pill('#grok-auth-status',status.grok.connected?'CLI 로그인됨':status.grok.installed?'연결 필요':'설치 필요',status.grok.connected);
  if (!currentRun) pill('#grok-status',status.grok.connected?'CLI 로그인됨':status.grok.installed?'연결 확인 필요':'설치 필요',status.grok.connected);
  if(status.grok.connected)message('#grok-message','기존 Cursor Agent 로그인을 사용합니다. 아래에서 Grok 모델을 선택하세요. Cursor 계정의 이용 한도가 적용됩니다.','success');
  else if(!status.grok.installed)message('#grok-message','Cursor Agent CLI 설치 후 연결하기를 누르세요. 로그인 정보는 원본 CLI가 보관합니다.');
  const model=status.grok.modelId;
  if(model&&!Array.from($('#grok-model').options).some(option=>option.value===model))$('#grok-model').append(new Option(model,model));
  $('#grok-model').value=model??'';
  $('#grok-model-label').textContent=model??'Grok 모델 미선택';
  $('#load-grok-models').disabled=!status.grok.connected;
  for(const provider of ['claude','grok'])renderCliLogin(provider,status[provider]);
  renderGeminiConnection(status.gemini);renderAssignedRoles();
  updateReadiness();
  return status;
}

$('#open-connections').addEventListener('click', openConnections);
document.querySelectorAll('.connect-shortcut').forEach(button => button.addEventListener('click', openConnections));
$('#close-connections').addEventListener('click', () => { $('#connections').close(); $('#image-api-key').value = ''; });
$('#finish-connections').addEventListener('click', () => { $('#connections').close(); $('#image-api-key').value = ''; });
$('#connections').addEventListener('close', () => { $('#image-api-key').value = ''; });
document.querySelectorAll('[data-link]').forEach(button => button.addEventListener('click', () => busy(button, '여는 중…', () => call(api.openLink(button.dataset.link)))));

async function login(accountId) {
  try {
    await call(api.login(accountId));
    message('#auth-message', '공식 브라우저에서 로그인하고 사용 권한을 승인하세요. 비밀번호는 이 앱에 입력하지 않습니다.');
  } catch (error) { message('#auth-message', error.message, 'error'); }
  await refreshStatus();
}
$('#chatgpt-login').addEventListener('click', () => busy($('#chatgpt-login'), '로그인 준비 중…', () => login()));
$('#reauth-account').addEventListener('click', () => busy($('#reauth-account'), '준비 중…', () => login($('#account-select').value)));
$('#cancel-login').addEventListener('click', () => busy($('#cancel-login'), '취소 중…', async () => { await call(api.cancelLogin()); await refreshStatus(); }));
$('#use-account').addEventListener('click', () => busy($('#use-account'), '전환 중…', async () => { await call(api.selectAccount($('#account-select').value)); await refreshStatus(); toast('선택한 계정으로 전환했습니다.', 'success'); }));
$('#sign-out').addEventListener('click', () => busy($('#sign-out'), '로그아웃 중…', async () => { const result = await call(api.signOut()); await refreshStatus(); message('#auth-message', result.message, result.remoteRevoked ? '' : 'error'); toast(result.message); }));
$('#claude-login').addEventListener('click',()=>connectCLI('claude'));
$('#grok-login').addEventListener('click',()=>connectCLI('grok',true));
$('#refresh-status').addEventListener('click', () => busy($('#refresh-status'), '확인 중…', async () => { await restoreSavedConnections();await refreshStatus(); toast('공식 CLI와 저장된 연결 상태를 확인했습니다.'); }));

$('#key-form').addEventListener('submit', async event => {
  event.preventDefault();
  const input = $('#image-api-key'); const key = input.value;
  input.value = ''; input.removeAttribute('aria-invalid');
  await busy($('#save-key'), '키 확인 중…', async () => {
    try {
      const result = await call(api.saveKey(key)); await refreshStatus(); message('#key-message', result.message, 'success'); toast('이미지 API 키를 암호화해 저장했습니다.', 'success');
    } catch (error) { input.setAttribute('aria-invalid', 'true'); message('#key-message', error.message, 'error'); }
  });
});
$('#delete-key').addEventListener('click', () => busy($('#delete-key'), '삭제 중…', async () => { await call(api.removeKey()); await refreshStatus(); message('#key-message', '저장된 API 키를 삭제했습니다.'); }));

$('#project-select').addEventListener('change', async event => { try { renderProjects(await call(api.selectProject(event.target.value))); } catch (error) { toast(error.message, 'error'); } });
$('#new-project').addEventListener('click', () => { editingProject = false; $('#project-dialog-title').textContent = '새 프로젝트'; $('#project-name').value = ''; $('#project-dialog').showModal(); });
$('#edit-title').addEventListener('click', () => { editingProject = true; $('#project-dialog-title').textContent = '프로젝트 제목 편집'; $('#project-name').value = activeProject().title; $('#project-dialog').showModal(); });
$('#cancel-project').addEventListener('click', () => $('#project-dialog').close());
$('#project-form').addEventListener('submit', async event => {
  event.preventDefault();
  await busy($('#project-form button[type=submit]'), '저장 중…', async () => {
    const name = $('#project-name').value;
    renderProjects(await call(editingProject ? api.renameProject(projectData.activeId, name) : api.createProject(name)));
    $('#project-dialog').close(); toast(editingProject ? '프로젝트 제목을 변경했습니다.' : '프로젝트를 만들었습니다.', 'success');
  });
});

function view(images) {
  $('#workspace-view').hidden = images; $('#images-view').hidden = !images;
  $('#tab-workspace').classList.toggle('selected', !images); $('#tab-workspace').setAttribute('aria-selected', String(!images));
  $('#tab-images').classList.toggle('selected', images); $('#tab-images').setAttribute('aria-selected', String(images));
}
$('#tab-workspace').addEventListener('click', () => view(false));
$('#tab-images').addEventListener('click', () => view(true));
$('#image-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (generationProject !== null) return;
  const projectId = projectData.activeId; generationProject = projectId;
  renderImage();
  await busy($('#generate-image'), '시안 생성 중…', async () => {
    try {
      const result = await call(api.generateImage(projectId, $('#image-prompt').value));
      resultCache.set(projectId, result);
      if (projectData.activeId === projectId) resultImage = result;
      toast('시안 생성이 완료되어 요청한 프로젝트에 저장했습니다.', 'success');
    } finally { generationProject = null; renderImage(); }
  });
  $('#generate-image').disabled = !connection?.image.saved || !linkedFolder;
  await refreshWorkspace();
});
$('#export-image').addEventListener('click', () => busy($('#export-image'), '내보내는 중…', async () => {
  if (!resultImage) return;
  const result = await call(api.exportImage(resultImage.projectId, resultImage.artifactId));
  if (result.saved) toast('PNG 파일을 내보냈습니다.', 'success');
}));
$('#model-button').addEventListener('click', () => busy($('#model-button'), '목록 확인 중…', async () => {
  $('#model-list').replaceChildren(); $('#models-dialog').showModal();
  const rows = await call(api.models());
  const selected = $('#gpt-model').value;
  $('#gpt-model').replaceChildren(new Option('GPT 모델 선택', ''), ...rows.map(item => new Option(item.name, item.id)));
  if (rows.some(item => item.id === selected)) $('#gpt-model').value = selected;
  for (const item of rows) {
    const row = document.createElement('button'); row.className = 'model-row';
    const name = document.createElement('strong'); name.textContent = item.name;
    const slug = document.createElement('span'); slug.textContent = item.id;
    row.append(name, slug); $('#model-list').append(row);
    row.addEventListener('click', () => { $('#gpt-model').value = item.id; $('#models-dialog').close(); updateReadiness(); });
  }
  if (!rows.length) $('#model-list').textContent = '이 계정에서 표시할 모델이 없습니다.';
}));
$('#close-models').addEventListener('click', () => $('#models-dialog').close());

async function initialize() {
if (!api) {
  toast('이 화면은 데스크톱 앱에서 실행하세요. 프로젝트 폴더에서 npm start를 실행하면 됩니다.', 'error');
} else {
  api.onEvent(async event => {
    if(event.type==='usage'){renderUsage(event.usage);return;}
    if (event.type === 'workflow') {
      if (event.projectId === projectData?.activeId) renderWorkflow(event.state);
      const previous=usageRunStates.get(event.projectId);usageRunStates.set(event.projectId,event.state.status);
      if(previous!==event.state.status&&!ACTIVE_RUN.has(event.state.status))void refreshUsage(false);
      return;
    }
    if (event.type === 'auth') message('#auth-message', event.message, event.state === 'error' ? 'error' : '');
    if (event.type === 'claude') message('#claude-message', event.message, event.state === 'error' ? 'error' : '');
    if (event.type === 'grok') message('#grok-message', event.message, event.state === 'error' ? 'error' : '');
    if(['claude','grok'].includes(event.type)&&event.login)renderCliLogin(event.type,{...connection?.[event.type],login:event.login});
    if(event.type==='gemini'){message('#gemini-message',event.message,event.state==='error'?'error':'');if(event.login)renderGeminiConnection({...connection?.gemini,login:event.login});}
    if (event.state !== 'waiting') toast(event.message, event.state === 'error' ? 'error' : '');
    try { await refreshStatus(); } catch (error) { toast(error.message, 'error'); }
  });
  try {
    renderProjects(await call(api.projects()));
    const restored=await restoreSavedConnections();
    const status = await refreshStatus();
    $('#footer-status').textContent = '연결 상태 확인 완료 · 프로젝트 폴더에서 작업합니다.';
    const connected=status.accounts.some(account=>account.active&&account.planEnabled)||status.claude.connected||status.grok.connected||status.gemini.connected;
    if(restored?.session.firstLaunch&&!connected)openConnections();
    renderUsage(await call(api.usage()));void refreshUsage(false);
  } catch (error) { toast(error.message, 'error'); }
}
}

function updateReadiness() {
  const active = ACTIVE_RUN.has(currentRun?.status);
  const account = connection?.accounts.find(item => item.active && item.planEnabled);
  const missing = [];
  if (!linkedFolder) missing.push('작업 폴더 연결');
  if(!roleAssignments||rolesProjectId!==projectData?.activeId||roleSaving)missing.push('역할 배치 확인');
  for(const provider of new Set(Object.values(roleAssignments??{}))){
    if(provider==='gpt'){if(!account)missing.push('ChatGPT 사용 권한');if(!$('#gpt-model').value)missing.push('GPT 모델 선택');}
    else {if(!connection?.[provider]?.connected)missing.push(`${AI_NAMES[provider]} 로그인`);if(['grok','gemini'].includes(provider)&&!connection?.[provider]?.modelId)missing.push(`${AI_NAMES[provider]} 모델 선택`);}
  }
  $('#start-workflow').disabled = active || missing.length > 0;
  $('#stop-workflow').hidden = !active;
  $('#choose-folder').disabled = active;
  $('#run-readiness').textContent = active ? '작업 중입니다. 완료 보고와 컨트롤 타워 검토 결과를 위아래 패널에서 확인하세요. 역할 변경은 다음 작업부터 적용됩니다.' : missing.length ? `시작 전 필요: ${missing.join(' · ')}` : '자동 수정 한도를 직접 설정하세요. 검증 명령이 없으면 전체 완료로 표시하지 않습니다.';
  $('#generate-image').disabled = !connection?.image.saved || !linkedFolder || generationProject !== null;
}
async function refreshWorkspace() {
  if (!projectData) return;
  const id = projectData.activeId; const project = activeProject();
  linkedFolder = null;
  if (!project.workspace) {
    $('#folder-path').textContent = '작업 폴더를 연결하세요.'; pill('#folder-permission', '접근 동의 필요');
    for (const selector of ['#show-files','#open-folder','#revoke-folder']) $(selector).hidden = true;
    renderWorkflow(null); updateReadiness(); return;
  }
  $('#folder-path').textContent = project.workspace.root;
  $('#revoke-folder').hidden = false;
  try {
    const tree = await call(api.folderTree(id)); if (projectData.activeId !== id) return;
    linkedFolder = tree;
    pill('#folder-permission', '읽기 · 생성 · 수정 동의됨', true);
    $('#show-files').hidden = false; $('#open-folder').hidden = false; $('#choose-folder').textContent = '폴더 변경';
    renderFileList(tree);
    const run = await call(api.workflow(id)); if (projectData.activeId === id) renderWorkflow(run);
  } catch (error) {
    if (projectData.activeId !== id) return;
    pill('#folder-permission', '접근 확인 필요'); $('#show-files').hidden = true; $('#open-folder').hidden = true;
    toast(error.message, 'error'); renderWorkflow(null);
  }
  updateReadiness();
}
function renderFileList(tree) {
  $('#file-list').replaceChildren();
  $('#file-preview').textContent = ''; $('#preview-filename').textContent = '파일을 선택하면 내용을 읽기 전용으로 표시합니다.';
  for (const entry of tree.files) {
    const button = document.createElement('button'); button.className = `file-entry ${entry.type}`;
    button.textContent = `${entry.type === 'directory' ? '▸ ' : '  '}${entry.path}`;
    button.disabled = entry.type === 'directory';
    const projectId = projectData.activeId;
    button.addEventListener('click', () => busy(button, '읽는 중…', async () => {
      const text = await call(api.readFile(projectId, entry.path));
      if (projectId !== projectData.activeId) return;
      $('#preview-filename').textContent = entry.path; $('#file-preview').textContent = text;
    }));
    $('#file-list').append(button);
  }
  if (!tree.files.length) $('#file-list').textContent = '빈 폴더입니다. 생성된 파일이 여기에 나타납니다.';
  if (tree.omitted) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = '표시 한도를 넘는 파일이 있습니다.'; $('#file-list').append(p); }
}
const RUN_LABELS = { planning:'명세 작성 중',building:'기능·UI 구현 중',validating:'검증 실행 중',reviewing:'컨트롤 타워 검토 중',repairing:'담당 AI 수정 중',final_review:'3역할 최종 검토 중',completed:'전체 완료',awaiting_validation:'실행 검증 필요',needs_input:'사용자 답변 필요',needs_attention:'확인 필요',cancelled:'중지됨',interrupted:'이전 작업 중단됨' };
function renderWorkflow(run) {
  currentRun = run;
  mascot.update(run,roleAssignments??undefined);
  $('#project-state').textContent = run ? RUN_LABELS[run.status] ?? run.status : '작업 대기';
  $('#run-state-dot').classList.toggle('mint-dot', run?.status === 'completed');
  $('#round-indicator').textContent = run ? `수정 ${run.round} / ${run.options.maxRepairRounds}회` : '수정 라운드 —';
  for (const actor of ['gpt','grok','claude']) {
    const selector = actor === 'gpt' ? 'planner' : actor;
    const events = run?.events.filter(event => event.actor === actor || (actor === 'gpt' && event.actor === 'system')).slice(-80) ?? [];
    $(`#${selector}-empty`).hidden = events.length > 0;
    const container = $(`#${selector}-events`); container.hidden = !events.length; container.replaceChildren();
    for (const event of events) {
      const row = document.createElement('div'); row.className = 'event-row';
      const time = document.createElement('span'); time.className = 'event-time'; time.textContent = new Date(event.at).toLocaleTimeString('ko-KR', { hour:'2-digit',minute:'2-digit',hour12:false });
      const content = document.createElement('div'); const title = document.createElement('p'); title.textContent = `${event.actor==='system'?'':AI_NAMES[run.options.roles?.[actor]??actor]+' · '}${event.message}`; content.append(title);
      if (event.questions?.length) { const details = document.createElement('pre'); details.textContent = event.questions.join('\n'); content.append(details); }
      if (event.issues?.length) { const details = document.createElement('pre'); details.textContent = event.issues.map(issue => `${ROLE_LABELS[issue.owner]} · ${AI_NAMES[run.options.roles?.[issue.owner]??issue.owner]} · ${issue.description}`).join('\n'); content.append(details); }
      row.append(time,content); container.append(row);
    }
    container.scrollTop = container.scrollHeight;
    if (actor !== 'gpt' && run) {
      const tasks = run.tasks.filter(task => task.owner === actor);
      const working = tasks.some(task => task.status === 'working');
      pill(`#${actor}-status`, working ? '수행 중' : `${tasks.filter(task => task.status === 'reported').length}/${tasks.length} 보고됨`, !working && tasks.length > 0 && tasks.every(task => task.status === 'reported'));
    }
  }
  renderAssignedRoles();
  if (run?.status === 'needs_input') $('#run-readiness').textContent = '컨트롤 타워의 질문에 대한 답을 요청에 포함해 다시 시작하세요.';
  updateReadiness();
}
$('#choose-folder').addEventListener('click', () => busy($('#choose-folder'), '폴더 선택 중…', async () => {
  const ticket = await call(api.chooseFolder(projectData.activeId)); if (!ticket) return;
  folderTicket = ticket; $('#consent-path').textContent = ticket.root; $('#folder-consent-check').checked = false; $('#folder-consent').showModal();
}));
$('#cancel-folder-consent').addEventListener('click', () => { folderTicket = null; $('#folder-consent').close(); });
$('#folder-consent-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!folderTicket) return;
  await busy($('#confirm-folder'), '연결 중…', async () => {
    const data = await call(api.grantFolder(folderTicket.projectId, folderTicket.ticket, $('#folder-consent-check').checked));
    resultCache.delete(folderTicket.projectId); folderTicket = null; $('#folder-consent').close();
    renderProjects(data); toast('선택한 폴더와 하위 폴더를 프로젝트에 연결했습니다.', 'success');
  });
});
$('#revoke-folder').addEventListener('click', () => busy($('#revoke-folder'), '접근 해제 중…', async () => {
  const id = projectData.activeId; const data = await call(api.revokeFolder(id)); resultCache.delete(id); renderProjects(data);
  toast('작업을 중지하고 폴더 접근 동의를 해제했습니다. 생성물은 폴더에 남아 있습니다.');
}));
$('#open-folder').addEventListener('click', () => busy($('#open-folder'), '여는 중…', () => call(api.openFolder(projectData.activeId))));
$('#show-files').addEventListener('click', () => busy($('#show-files'), '읽는 중…', async () => { await refreshWorkspace(); $('#files-dialog').showModal(); }));
$('#close-files').addEventListener('click', () => $('#files-dialog').close());
$('#start-workflow').addEventListener('click', () => busy($('#start-workflow'), '시작 중…', async () => {
  const value = $('#max-repair-rounds').value;
  if (value === '') throw new Error('자동 수정 최대 횟수를 직접 설정하세요.');
  const options = { request: $('#planner-input').value, gptModel: $('#gpt-model').value, maxRepairRounds: Number(value), validationScript: $('#validation-script').value.trim(), allowExecution: $('#allow-execution').checked };
  renderWorkflow(await call(api.startWorkflow(projectData.activeId, options)));
}));
$('#stop-workflow').addEventListener('click', () => busy($('#stop-workflow'), '중지 중…', async () => { renderWorkflow(await call(api.stopWorkflow(projectData.activeId))); await refreshWorkspace(); }));
function renderCliLogin(provider,status={}){
  const login=status.login??{};const connected=status.connected===true;
  $(`#${provider}-login`).disabled=!status.installed||(connected&&provider!=='grok')||login.waiting;
  $(`#${provider}-login`).textContent=login.waiting?'공식 로그인 대기 중…':provider==='grok'&&status.installed?'Cursor 로그인 ↗':connected?'터미널 로그인 연결됨':status.installed?'연결하기 ↗':'공식 CLI 설치 필요';
  $(`#${provider}-reauth`).hidden=!connected;$(`#${provider}-reauth`).disabled=Boolean(login.waiting);
  $(`#${provider}-login-flow`).hidden=!login.waiting;$(`#${provider}-login-browser`).hidden=!login.hasBrowserLink;
  $(`#${provider}-code-form`).hidden=!login.codeRequired;
  if(!login.waiting)$(`#${provider}-code`).value='';
  if(provider==='grok')$('#grok-reauth').textContent='기존 연결 확인';
}
async function connectCLI(provider,force=false){
  const button=$(`#${provider}-${force?'reauth':'login'}`);
  await busy(button,'저장된 연결 확인 중…',async()=>{
    const result=await call(provider==='claude'?api.claudeLogin(force):api.grokLogin(force));
    message(`#${provider}-message`,result.reused?result.message:'공식 브라우저에서 로그인과 승인을 완료하세요.',result.reused?'success':'');
    await refreshStatus();
  });
  if(connection?.[provider])renderCliLogin(provider,connection[provider]);
}
async function restoreSavedConnections(){
  if(restoring)return null;restoring=true;
  $('#session-status').dataset.restoring='true';$('#session-status').textContent='저장된 연결 확인 중…';
  try{
    const result=await call(api.restoreConnections());
    const count=Number(result.gpt.connected)+Number(result.claude.connected)+Number(result.grok.connected)+Number(result.gemini.connected);
    $('#session-status').textContent=count?`${count}개 AI 연결 확인 · 저장된 로그인 사용`:'로그인 연결을 선택하세요.';
    $('#session-policy').textContent=result.session.recheckRequired?'7일 미사용 후 재확인 중 일부 연결을 확인하지 못했습니다. 기존 로그인은 유지되며 다시 확인할 수 있습니다.':'한 번 연결하면 다음 실행에도 유지합니다. 7일 미사용 후에는 상태를 재확인하고 유효하면 로그인 없이 계속합니다.';
    $('#login-browser').value=result.browser.preferred;
    $('#login-browser option[value=chrome]').disabled=!result.browser.chromeAvailable;
    return result;
  }catch(error){$('#session-status').textContent='저장된 연결 확인이 필요합니다.';toast(error.message,'error');return null;}
  finally{restoring=false;$('#session-status').dataset.restoring='false';}
}
for(const provider of ['claude','grok']){
  $(`#${provider}-reauth`).addEventListener('click',()=>connectCLI(provider,provider!=='grok'));
  $(`#${provider}-login-browser`).addEventListener('click',()=>busy($(`#${provider}-login-browser`),'브라우저 여는 중…',()=>call(api.loginBrowser(provider))));
  $(`#${provider}-cancel-login`).addEventListener('click',()=>busy($(`#${provider}-cancel-login`),'취소 중…',async()=>{await call(api.cancelCliLogin(provider));await refreshStatus();}));
  $(`#${provider}-code-form`).addEventListener('submit',event=>{
    event.preventDefault();const value=$(`#${provider}-code`).value;$(`#${provider}-code`).value='';
    void busy($(`#${provider}-code-form button`),'확인 중…',async()=>{await call(api.loginCode(provider,value));toast('승인 코드를 공식 CLI에 전달했습니다.');await refreshStatus();});
  });
}
$('#restore-connections').addEventListener('click',()=>busy($('#restore-connections'),'확인 중…',async()=>{await restoreSavedConnections();await refreshStatus();}));
$('#login-browser').addEventListener('change',async event=>{try{await call(api.setBrowser(event.target.value));toast('로그인 브라우저 설정을 저장했습니다.');}catch(error){toast(error.message,'error');$('#login-browser').value=(await call(api.browserSettings())).preferred;}});
$('#load-grok-models').addEventListener('click',()=>busy($('#load-grok-models'),'조회 중…',async()=>{
  const rows=await call(api.grokModels());const selected=connection?.grok.modelId;
  $('#grok-model').replaceChildren(new Option('Grok 모델 선택',''),...rows.map(row=>new Option(row.name,row.id)));
  if(rows.some(row=>row.id===selected))$('#grok-model').value=selected;
  if(!rows.length)toast('이 Cursor 계정에서 Grok 모델을 찾지 못했습니다.');
}));
$('#grok-model').addEventListener('change',async event=>{
  if(!event.target.value)return;
  try{await call(api.selectGrokModel(event.target.value));await refreshStatus();toast('Cursor의 Grok 모델을 저장했습니다. 실행 중인 작업은 시작할 때 선택한 모델을 유지합니다.');}
  catch(error){toast(error.message,'error');await refreshStatus();}
});
const usageNames={gpt:'GPT · 이 앱의 직접 로그인',claude:'Claude · 공식 /usage',grok:'Grok · Cursor 계정 사용 한도',codex:'Codex CLI · 별도 계정 참고 한도'};
const usageLinks={gpt:'gptUsage',claude:'claudeUsage',grok:'cursorUsage',codex:'codexUsage'};
function renderUsage(value){
  usageData=value;
  for(const provider of ['gpt','claude','grok','codex']){
    const data=value.providers[provider];const numeric=typeof data.remainingPercent==='number'&&Number.isFinite(data.remainingPercent)&&data.remainingPercent>=0&&data.remainingPercent<=100;
    $(`#quota-${provider}`).textContent=numeric?`${data.remainingPercent}% 잔여`:data.state==='unsupported'?'조회 미지원':data.state==='not-connected'?'연결 필요':'—';
    const button=$(`[data-usage=${provider}]`);button.classList.toggle('has-quota',numeric);
    button.title=`${data.message}${data.checkedAt?' · '+new Date(data.checkedAt).toLocaleTimeString('ko-KR'):''}`;
    button.setAttribute('aria-label',`${usageNames[provider]} ${$(`#quota-${provider}`).textContent}`);
  }
  $('#usage-refresh-state').textContent=value.checkedAt?`60초 갱신 · ${new Date(value.checkedAt).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit',hour12:false})} 확인`:'확인된 값만 표시';
  if($('#usage-dialog').open)renderUsageDetail();
}
async function refreshUsage(manual){
  try{const value=await call(manual?api.refreshUsage():api.pollUsage());renderUsage(value);}
  catch{if(manual)toast('사용량 조회에 실패했습니다. 공급자 연결을 확인하세요.','error');}
}
function renderUsageDetail(){
  const data=usageData?.providers[usageProvider];if(!data)return;
  $('#usage-title').textContent=usageNames[usageProvider];
  $('#usage-description').textContent=`${data.message}${data.accountLabel?' · 계정: '+data.accountLabel:''}`;
  $('#usage-checked-at').textContent=data.checkedAt?`최근 확인: ${new Date(data.checkedAt).toLocaleString('ko-KR')}`:'아직 조회하지 않았습니다.';
  $('#usage-meters').replaceChildren();
  for(const meter of data.meters??[]){
    const row=document.createElement('div');row.className='usage-meter-row';
    const text=document.createElement('p');text.textContent=`${meter.label}${meter.model?' · '+meter.model:''}${meter.surface?' · '+meter.surface:''}${meter.windowMinutes?' · '+meter.windowMinutes+'분 창':''}${meter.active===false?' · 현재 미적용':''}`;
    const number=document.createElement('strong');number.textContent=`${meter.remainingPercent}% 잔여`;
    const bar=document.createElement('meter');bar.min=0;bar.max=100;bar.value=meter.remainingPercent;bar.setAttribute('aria-label',`${text.textContent} 잔여 비율`);
    const reset=document.createElement('p');reset.className='hint';reset.textContent=meter.resetsAt?`초기화: ${new Date(meter.resetsAt).toLocaleString('ko-KR')}`:'초기화 시각 미제공';
    row.append(text,number,bar,reset);$('#usage-meters').append(row);
  }
}
document.querySelectorAll('[data-usage]').forEach(button=>button.addEventListener('click',()=>{usageProvider=button.dataset.usage;renderUsageDetail();$('#usage-dialog').showModal();}));
$('#close-usage').addEventListener('click',()=>$('#usage-dialog').close());
$('#official-usage-page').addEventListener('click',()=>busy($('#official-usage-page'),'여는 중…',()=>call(api.openLink(usageLinks[usageProvider]))));
$('#refresh-usage').addEventListener('click',()=>busy($('#refresh-usage'),'조회 중…',()=>refreshUsage(true)));
async function noteActivity(){
  if(!api||Date.now()-lastActivity<30000)return;lastActivity=Date.now();
  try{const session=await call(api.activity());if(session.recheckRequired&&!restoring){await restoreSavedConnections();await refreshStatus();}}catch{}
}
document.addEventListener('pointerdown',()=>{void noteActivity();},{passive:true});document.addEventListener('keydown',()=>{void noteActivity();});
window.addEventListener('focus',()=>{void noteActivity();void refreshUsage(false);});
setInterval(()=>{if(document.visibilityState==='visible'&&document.hasFocus())void refreshUsage(false);},60000);
function renderAssignedRoles(){
  const selected=ACTIVE_RUN.has(currentRun?.status)?currentRun.options.roles:roleAssignments;
  if(!selected)return;
  mascot.update(currentRun,roleAssignments??selected);
  $('#role-summary').textContent=Object.entries(roleAssignments??selected).map(([role,provider])=>`${ROLE_LABELS[role]} · ${AI_NAMES[provider]}`).join('  →  ');
  for(const [role,target] of [['gpt','planner-provider'],['grok','feature-provider'],['claude','ui-provider']]){
    const provider=selected[role];$(`#${target}`).textContent=AI_NAMES[provider];
    $(`#${target}`).closest('.agent-name').querySelector('.agent-icon').textContent={gpt:'G',grok:'/',claude:'✳',gemini:'✦'}[provider];
    const ready=provider==='gpt'?connection?.accounts.some(account=>account.active&&account.planEnabled):connection?.[provider]?.connected;
    if(!ACTIVE_RUN.has(currentRun?.status))pill(`#${role}-status`,ready?'연결됨':'연결 필요',ready);
    else if(role==='gpt')pill('#gpt-status',RUN_LABELS[currentRun.status]??'작업 중',true);
  }
  const feature=selected.grok;
  $('#feature-subtitle').textContent=feature==='grok'?'Cursor Agent · 기능 개발 · 담당 오류 수정':`${AI_NAMES[feature]} · 기능 개발 · 담당 오류 수정`;
  $('#grok-empty .secondary').textContent=`기능 구현 역할에 ${AI_NAMES[feature]}가 배정되어 있습니다.`;
  const featureModel=feature==='grok'?connection?.grok.modelId:feature==='gemini'?connection?.gemini.modelId:feature==='gpt'?$('#gpt-model').value:'Claude CLI 기본 모델';
  $('#grok-model-label').textContent=featureModel||`${AI_NAMES[feature]} 모델 선택 필요`;
}
async function openRoles(role='gpt'){
  if(!projectData)return;const id=projectData.activeId;
  try{const selected=await call(api.roles(id));if(projectData.activeId!==id)return;rolesDialogProjectId=id;
    for(const current of ['gpt','grok','claude']){
      $(`#role-${current}`).replaceChildren(...Object.entries(AI_NAMES).map(([provider,name])=>new Option(name,provider)));
      $(`#role-${current}`).value=selected[current];
    }
    $('#roles-dialog').showModal();$(`#role-${role}`).focus();
  }catch(error){toast(error.message,'error');}
}
$('#open-roles').addEventListener('click',()=>openRoles());
document.querySelectorAll('.change-role').forEach(button=>button.addEventListener('click',()=>openRoles(button.dataset.role)));
$('#close-roles').addEventListener('click',()=>$('#roles-dialog').close());
$('#roles-connections').addEventListener('click',()=>{$('#roles-dialog').close();openConnections();});
$('#roles-form').addEventListener('submit',event=>{
  event.preventDefault();const id=rolesDialogProjectId;const selection=Object.fromEntries(['gpt','grok','claude'].map(role=>[role,$(`#role-${role}`).value]));
  roleSaving=true;void busy($('#save-roles'),'저장 중…',async()=>{const saved=await call(api.setRoles(id,selection));if(projectData.activeId===id){roleAssignments=saved;rolesProjectId=id;renderAssignedRoles();}$('#roles-dialog').close();toast('역할 배치를 저장했습니다. 진행 중인 작업에는 시작할 때의 배치가 유지됩니다.');}).finally(()=>{roleSaving=false;updateReadiness();});
});
function renderGeminiConnection(status={}){
  const login=status.login??{};
  pill('#gemini-auth-status',status.connected?'Google 연결됨':login.waiting?'승인 대기':status.installed?'연결 필요':'설치 필요',status.connected);
  $('#gemini-login').disabled=!status.installed||!!login.waiting;
  $('#gemini-login').textContent=login.waiting?'Google 승인 대기 중…':status.connected?'기존 Google 연결 확인':'Google 로그인 ↗';
  $('#gemini-install').hidden=!!status.installed;
  $('#gemini-login-flow').hidden=!login.waiting;$('#gemini-login-browser').hidden=!login.hasBrowserLink;
  $('#load-gemini-models').disabled=!status.connected;
  if(status.modelId&&!Array.from($('#gemini-model').options).some(option=>option.value===status.modelId))$('#gemini-model').append(new Option(status.modelId,status.modelId));
  $('#gemini-model').value=status.modelId??'';
  if(status.connected)message('#gemini-message','Gemini CLI의 Google 인증을 사용합니다. 실행할 모델을 선택하세요.','success');
  else if(!status.installed)message('#gemini-message','Node.js 20 이상과 공식 Gemini CLI가 필요합니다. 설치 버튼으로 이 앱의 도구 폴더에 설치할 수 있습니다.');
}
$('#gemini-login').addEventListener('click',async()=>{await busy($('#gemini-login'),'Google 연결 준비 중…',async()=>{const result=await call(api.geminiLogin());if(result.reused)message('#gemini-message',result.message,'success');await refreshStatus();});if(connection?.gemini)renderGeminiConnection(connection.gemini);});
$('#gemini-install').addEventListener('click',()=>busy($('#gemini-install'),'Gemini CLI 설치 중…',async()=>{await call(api.installGemini());await refreshStatus();toast('공식 Gemini CLI를 설치했습니다. Google 로그인을 누르세요.');}));
$('#gemini-login-browser').addEventListener('click',()=>busy($('#gemini-login-browser'),'여는 중…',()=>call(api.loginBrowser('gemini'))));
$('#gemini-cancel-login').addEventListener('click',()=>busy($('#gemini-cancel-login'),'취소 중…',async()=>{await call(api.cancelCliLogin('gemini'));await refreshStatus();}));
$('#load-gemini-models').addEventListener('click',()=>busy($('#load-gemini-models'),'조회 중…',async()=>{const rows=await call(api.geminiModels());const selected=connection?.gemini.modelId;$('#gemini-model').replaceChildren(new Option('Gemini 모델 선택',''),...rows.map(row=>new Option(row.name,row.id)));if(rows.some(row=>row.id===selected))$('#gemini-model').value=selected;if(!rows.length)toast('Gemini CLI가 모델 목록을 제공하지 않았습니다.');}));
$('#gemini-model').addEventListener('change',async event=>{if(!event.target.value)return;try{await call(api.selectGeminiModel(event.target.value));await refreshStatus();toast('Gemini 모델을 저장했습니다.');}catch(error){toast(error.message,'error');await refreshStatus();}});
$('#gpt-model').addEventListener('change',()=>{renderAssignedRoles();updateReadiness();});
await initialize();
