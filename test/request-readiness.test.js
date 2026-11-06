import test from 'node:test';
import assert from 'node:assert/strict';
import { requestIssues } from '../src/renderer/request-readiness.js';
const team = [{ id: 'gpt', provider: 'gpt' }, { id: 'grok', provider: 'grok' }];
const ready = { folder: true, team, connection: { gpt: { connected: true, source: 'codex' }, grok: { connected: true, modelId: 'selected' } }, text: '앱 만들어줘' };
test('missing worker model names the worker and routes to its model settings', () => {
  const issues = requestIssues({ ...ready, connection: { ...ready.connection, grok: { connected: true } } });
  assert.equal(issues.length, 1); assert.equal(issues[0].agentId, 'grok');
  assert.equal(issues[0].action, 'roles'); assert.match(issues[0].message, /AI 역할 변경.*Cursor.*모델.*저장/);
});
test('explicit panel model and CLI defaults are accepted; API GPT requires a model', () => {
  assert.deepEqual(requestIssues(ready), []);
  assert.deepEqual(requestIssues({ ...ready, team: [{ ...team[0] }, { ...team[1], modelId: 'panel-model' }], connection: { ...ready.connection, grok: { connected: true } } }), []);
  assert.match(requestIssues({ ...ready, connection: { ...ready.connection, gpt: { connected: true, source: 'api' } } })[0].message, /GPT.*모델/);
});
test('questions need only the controller; missing folder, login and request have distinct remedies', () => {
  const disconnected = { ...ready, connection: { gpt: ready.connection.gpt } };
  assert.deepEqual(requestIssues({ ...disconnected, question: true }), []);
  assert.ok(requestIssues(disconnected).some(issue => issue.action === 'connections'));
  assert.deepEqual(requestIssues({ ...ready, folder: false, text: ' ' }).map(issue => issue.action), ['folder', 'input']);
});
