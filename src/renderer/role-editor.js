import {
  PROVIDERS,
  CAPABILITIES,
  validateTeam,
  resizeTeam,
} from "../core/team.js";
import { providerIcon } from "./provider-icon.js";
import { sortReviewAgents } from '../core/review-order.js';
const $ = (selector) => document.querySelector(selector);
function node(tag, text, cls) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (cls) el.className = cls;
  return el;
}
const name = (provider) =>
  provider === "grok" ? "Cursor" : PROVIDERS[provider];
function options(select, provider, rows = [], chosen = "") {
  const explicit = ["grok", "gemini"].includes(provider);
  select.required = explicit;
  select.replaceChildren(
    new Option(
      explicit
        ? `${name(provider)} 모델을 선택하세요`
        : `${name(provider)} 자동 선택 · 현재 계정 설정`,
      "",
    ),
    ...rows.map((row) => new Option(row.name ?? row.id, row.id)),
  );
  if (chosen && !rows.some((row) => row.id === chosen))
    select.append(new Option(chosen, chosen));
  select.value = chosen;
}
function uniqueRoles() {
  const fields = [
    ...$("#team-editor").querySelectorAll("fieldset[data-agent]"),
  ];
  for (const role of ["feature", "ui"]) {
    const owner = fields.find(
      (field) => field.querySelector(`input[value="${role}"]`)?.checked,
    );
    for (const field of fields) {
      const input = field.querySelector(`input[value="${role}"]`);
      input.disabled = !!owner && owner !== field;
      input.closest("label").title =
        owner && owner !== field
          ? `${owner.querySelector("legend").textContent} 담당입니다. 담당 패널에서 먼저 체크를 해제하세요.`
          : "";
    }
  }
  const selected = fields.map(field=>({id:field.dataset.agent,provider:field.querySelector('select').value,
    roles:[...field.querySelectorAll('input:checked')].map(input=>input.value)}));
  $('#role-review-order').textContent = '검토 순서: '+sortReviewAgents(selected.filter(agent=>agent.id==='gpt'||agent.roles.some(role=>['debug','review'].includes(role))))
    .map(agent=>`${name(agent.provider)}${agent.id==='gpt'?' (컨트롤 타워 · 마지막)':''}`).join(' → ');
}
const confirmCursorUI = async () => {
  const response = await window.tower.confirmCursorUIRole();
  if (!response.ok) throw new Error(response.error);
  return response.value === true;
};
export async function renderTeamEditor(team, catalog) {
  $("#agent-count").value = String(team.length);
  const container = $("#team-editor");
  container.replaceChildren();
  const pending = [];
  for (const [index, agent] of team.entries()) {
    const field = node("fieldset", undefined, "role-setting team-member");
    field.dataset.agent = agent.id;
    const legend = node(
      "legend",
      `${String(index + 1).padStart(2, "0")} · ${index ? "작업 AI" : "컨트롤 타워 · 고정"}`,
    );
    field.append(legend);
    const columns = node("div", undefined, "role-ai-fields"),
      identity = node("div", undefined, "role-provider-field");
    const label = node("label", "사용할 AI");
    label.htmlFor = "role-" + agent.id;
    const select = node("select");
    select.id = "role-" + agent.id;
    select.append(
      ...Object.entries(PROVIDERS).map(([id, value]) => new Option(value, id)),
    );
    select.value = agent.provider;
    const mark = node("span", undefined, "role-provider-mark");
    mark.append(providerIcon(agent.provider, 24));
    identity.append(label, mark, select);
    const modelBox = node("div"),
      modelLabel = node("label", `${name(agent.provider)} 모델 선택`);
    modelLabel.htmlFor = "panel-model-" + agent.id;
    const models = node("select");
    models.id = "panel-model-" + agent.id;
    models.className = "panel-model";
    options(models, agent.provider, [], agent.modelId);
    const status = node(
      "p",
      "모델 목록을 자동으로 불러오는 중…",
      "hint model-status",
    );
    status.setAttribute("role", "status");
    modelBox.append(modelLabel, models, status);
    columns.append(identity, modelBox);
    field.append(columns);
    let generation = 0;
    async function load() {
      const ticket = ++generation,
        provider = select.value,
        chosen = models.value;
      modelLabel.textContent = `${name(provider)} 모델 선택`;
      mark.replaceChildren(providerIcon(provider, 24));
      models.disabled = true;
      status.textContent = `${name(provider)} 모델을 불러오는 중…`;
      try {
        const rows = await catalog(provider);
        if (ticket !== generation || !field.isConnected) return;
        options(
          models,
          provider,
          rows,
          chosen || rows.find((row) => row.current)?.id || "",
        );
        status.textContent = rows.length
          ? ["grok", "gemini"].includes(provider)
            ? `모델 ${rows.length}개 · 실행할 모델을 선택하세요.`
            : `모델 ${rows.length}개 · 자동 선택은 현재 ${name(provider)} 계정의 실행 설정을 따릅니다.`
          : "사용 가능한 목록을 받지 못했습니다. 계정 연결을 확인하세요.";
      } catch (error) {
        if (ticket === generation)
          status.textContent = `모델 목록을 읽지 못했습니다. ${error.message}`;
      } finally {
        if (ticket === generation) models.disabled = false;
      }
    }
    let previousProvider = select.value;
    select.addEventListener("change", async () => {
      const ui = field.querySelector('input[value=ui]');
      if (select.value==='grok' && ui.checked) {
        field.dataset.cursorPending='true';
        try { if (!(await confirmCursorUI())) { select.value=previousProvider; return; } }
        catch { select.value=previousProvider; return; }
        finally { delete field.dataset.cursorPending; }
      }
      previousProvider=select.value;
      options(models, select.value);
      uniqueRoles();
      void load();
    });
    const roleTitle = node(
      "p",
      index ? "담당할 업무" : "추가로 맡길 업무",
      "role-section-title",
    );
    field.append(roleTitle);
    const checks = node("div", undefined, "role-checks");
    for (const [role, value] of Object.entries(CAPABILITIES)) {
      if (role === "control") continue;
      const wrapper = node("label", undefined, "check-label"),
        input = node("input");
      input.type = "checkbox";
      input.value = role;
      input.checked = agent.roles.includes(role);
      input.addEventListener('change', async () => {
        if(role==='ui' && input.checked && select.value==='grok') {
          field.dataset.cursorPending='true';
          try { if (!(await confirmCursorUI())) input.checked=false; }
          catch { input.checked=false; }
          finally { delete field.dataset.cursorPending; }
        }
        uniqueRoles();
      });
      wrapper.append(input, document.createTextNode(value));
      checks.append(wrapper);
    }
    field.append(checks);
    const advanced = node("details", undefined, "fallback-setting"),
      summary = node("summary", "대체 AI 우선순위 (선택)");
    advanced.append(summary);
    const backupLabel = node("label", "한도 부족 시 먼저 넘길 AI");
    backupLabel.htmlFor = "fallback-" + agent.id;
    const backup = node("select");
    backup.id = "fallback-" + agent.id;
    backup.className = "fallback-provider";
    backup.append(
      new Option("자동 · 연결된 다른 AI 중 선택", ""),
      ...Object.entries(PROVIDERS).map(([id, value]) => new Option(value, id)),
    );
    backup.value = agent.fallback?.provider ?? "";
    const backupModels = node("select");
    backupModels.id = "fallback-model-" + agent.id;
    backupModels.className = "fallback-model";
    backupModels.setAttribute("aria-label", "대체 AI 모델 선택");
    const backupStatus = node(
      "p",
      "선택하지 않아도 연결된 팀에서 역할과 확인 가능한 잔여 한도를 고려해 이어받습니다. 같은 계정은 한도를 공유할 수 있습니다.",
      "hint",
    );
    let backupGeneration = 0;
    async function loadBackup() {
      const ticket = ++backupGeneration,
        provider = backup.value,
        chosen = backupModels.value;
      backupModels.hidden = !provider;
      backupModels.required =
        !!provider && ["grok", "gemini"].includes(provider);
      backupModels.disabled = !provider;
      if (!provider) return;
      backupModels.disabled = true;
      options(backupModels, provider, [], chosen);
      backupStatus.textContent = `${name(provider)} 대체 모델을 자동 조회 중…`;
      try {
        const rows = await catalog(provider);
        if (ticket !== backupGeneration || !field.isConnected) return;
        options(backupModels, provider, rows, chosen);
        backupStatus.textContent =
          "이 AI를 우선 확인하고, 사용이 불가능하면 연결된 다른 팀 AI를 찾습니다.";
      } catch (error) {
        if (ticket === backupGeneration)
          backupStatus.textContent = error.message;
      } finally {
        if (ticket === backupGeneration) backupModels.disabled = false;
      }
    }
    if (agent.fallback)
      options(
        backupModels,
        agent.fallback.provider,
        [],
        agent.fallback.modelId,
      );
    else backupModels.hidden = true;
    backup.addEventListener("change", () => {
      backupModels.replaceChildren();
      void loadBackup();
    });
    advanced.append(backupLabel, backup, backupModels, backupStatus);
    field.append(advanced);
    container.append(field);
    pending.push(load());
    if (agent.fallback) pending.push(loadBackup());
  }
  uniqueRoles();
  await Promise.allSettled(pending);
}
function draft() {
  return [...$("#team-editor").querySelectorAll("fieldset[data-agent]")].map(
    (field) => ({
      id: field.dataset.agent,
      provider: field.querySelector("select").value,
      roles: [
        ...(field.dataset.agent === "gpt" ? ["control"] : []),
        ...[...field.querySelectorAll("input:checked")].map(
          (input) => input.value,
        ),
      ],
      ...(field.querySelector(".panel-model").value
        ? { modelId: field.querySelector(".panel-model").value }
        : {}),
      ...(field.querySelector(".fallback-provider").value
        ? {
            fallback: {
              provider: field.querySelector(".fallback-provider").value,
              ...(field.querySelector(".fallback-model").value
                ? { modelId: field.querySelector(".fallback-model").value }
                : {}),
            },
          }
        : {}),
    }),
  );
}
export function readTeamEditor() {
  if ($('#team-editor [data-cursor-pending]')) throw new Error('Cursor UI 역할 선택을 먼저 확인해 주세요.');
  if([...$('#team-editor').querySelectorAll('.panel-model,.fallback-model')].some(select=>select.disabled&&!select.hidden))
    throw new Error('모델 목록을 불러오는 중입니다. 조회가 끝난 뒤 저장해 주세요.');
  return validateTeam(draft(), { exclusive: true });
}
export function refreshEditorModels(catalog){
 for(const field of document.querySelectorAll('#team-editor fieldset[data-agent]')){
  for(const [providerSelector,modelSelector]of [['select[id^=role-]','.panel-model'],['.fallback-provider','.fallback-model']]){
    const provider=field.querySelector(providerSelector)?.value,select=field.querySelector(modelSelector),entry=catalog[provider];
    if(!provider||!entry)continue;const selected=select.value;
    options(select,provider,entry.rows??[],selected);select.disabled=entry.state==='loading'||entry.state==='pending';
    if(modelSelector==='.panel-model')field.querySelector('.model-status').textContent=entry.message;
  }
 }
}
export async function resizeEditor(count, catalog) {
  const team = draft();
  for (const row of team) if (!row.roles.length) row.roles = ["review"];
  for (const role of ["feature", "ui"])
    if (!team.some((row) => row.roles.includes(role))) team[1].roles.push(role);
  const resized = resizeTeam(team, count);
  const assignedCursorUI = resized.some(agent=>agent.provider==='grok' && agent.roles.includes('ui') &&
    !team.some(old=>old.id===agent.id&&old.provider==='grok'&&old.roles.includes('ui')));
  try {
    if (assignedCursorUI && !(await confirmCursorUI())) { $('#agent-count').value=String(team.length); return team; }
  } catch(error) { $('#agent-count').value=String(team.length); throw error; }
  await renderTeamEditor(resized, catalog);
  return resized;
}
