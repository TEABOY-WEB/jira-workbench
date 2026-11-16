import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, stopServer } from './index.mjs';
import { workflowJira, workflowPolicy as policy } from './test-support/workflow-jira.mjs';

const dir = mkdtempSync(path.join(os.tmpdir(), 'wb-web-workflow-'));
const mock = workflowJira(); let url, jiraUrl, cookie;
const options = () => ({ jiraBaseUrl: jiraUrl, port: 0, allowWrite: true, writeProjects: ['DEMO'], settingsFile: path.join(dir, 'settings.json'), sessionDir: path.join(dir, 'sessions') });
async function login(name = 'alice') {
  const r = await fetch(url + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: 'test-only' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
}
async function request(method, sub, body, headers = {}) {
  const r = await fetch(url + '/api/workflow/' + sub, { method, headers: { Cookie: cookie, Origin: url, ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }) });
  return { status: r.status, body: await r.json() };
}
const input = (requestId, extra = {}) => ({ requestId, projectKey: 'DEMO', typeName: '编码任务', policyId: policy.id, values: { summary: '补录：接口联调', customfield_100: '4', customfield_101: '2026-11-10' }, ...extra });
beforeAll(async () => {
  await new Promise(r => mock.server.listen(0, '127.0.0.1', r)); jiraUrl = `http://127.0.0.1:${mock.server.address().port}`;
  ({ url } = await startServer(options())); await login();
});
afterAll(async () => { await stopServer(); await new Promise(r => mock.server.close(r)); rmSync(dir, { recursive: true, force: true }); });

describe.sequential('网页创建并完成：独立于 MCP 的真实 HTTP 编排', () => {
  it('只接受本机同源网页登录，配置路线无需开启 MCP 或创建授权', async () => {
    expect((await request('GET', 'policies', undefined, { Cookie: '' })).status).toBe(401);
    expect((await request('PUT', 'policies', [policy], { Origin: 'https://other.test' })).status).toBe(403);
    expect((await request('PUT', 'policies', [policy])).status).toBe(200);
    const status = await (await fetch(url + '/api/mcp/status', { headers: { Cookie: cookie } })).json();
    expect(status.enabled).toBe(false); expect(status.grants).toHaveLength(0); expect(status.policies).toEqual([policy]);
  });
  it('单条创建、关联父需求、多步流转后核验最终状态，保留历史开发完成日期', async () => {
    mock.meta.assignee.allowedValues = [{ id: '42', name: 'alice' }];
    const r = await request('POST', 'operations', input('first', { parentKey: 'DEMO-900', values: { ...input('first').values, assignee: 'alice' } }));
    expect(r.body.state).toBe('completed'); expect(r.body.status).toBe('关闭'); expect(mock.count()).toBe(1);
    const issue = mock.issues.get(r.body.issueKey);
    expect(issue.fields.customfield_101).toBe('2026-11-10'); expect(issue.fields.resolution.id).toBe('1');
    expect(mock.issues.get('DEMO-900').fields.status.name).toBe('新增');
    expect(mock.events.find(e => e.kind === 'create').body.update.issuelinks).toHaveLength(1);
  });
  it('缺路线、非法字段、缺必填、越界关联与循环路线均在创建前拒绝', async () => {
    const n = mock.count();
    expect((await request('POST', 'operations', input('no-policy', { policyId: 'missing' }))).status).toBe(400);
    expect((await request('POST', 'operations', input('forbidden', { values: { summary: 'x', status: '关闭' } }))).status).toBe(400);
    expect((await request('POST', 'operations', input('invalid-number', { values: { summary: 'x', customfield_100: 'invalid' } }))).status).toBe(400);
    expect((await request('POST', 'operations', input('invalid-value', { values: { summary: ['不能用数组'] } }))).status).toBe(400);
    expect((await request('POST', 'operations', input('no-summary', { values: {} }))).status).toBe(400);
    expect((await request('POST', 'operations', input('cross-project', { links: [{ key: 'OTHER-1', option: { type: 'Relates', dir: 'out' } }] }))).status).toBe(403);
    expect((await request('PUT', 'policies', [{ ...policy, steps: [{ from: '新增', to: '新增', transitionId: '11', fields: {} }] }])).status).toBe(400);
    expect(mock.count()).toBe(n);
  });
  it('相同请求并发或重复不会多建，修改内容复用请求编号会冲突', async () => {
    const n = mock.count(); const data = input('concurrent');
    const [a, b] = await Promise.all([request('POST', 'operations', data), request('POST', 'operations', data)]);
    expect(a.body.id).toBe(b.body.id); expect(a.body.state).toBe('completed'); expect(b.body.state).toBe('completed'); expect(mock.count()).toBe(n + 1);
    expect((await request('POST', 'operations', data)).body.id).toBe(a.body.id); expect(mock.count()).toBe(n + 1);
    expect((await request('POST', 'operations', { ...data, values: { summary: '变更内容' } })).body.code).toBe('IDEMPOTENCY_CONFLICT');
  });
  it('创建被 Jira 明确拒绝时不伪装为成功，也不占用待流转列表', async () => {
    mock.flags.failCreate = true; const n = mock.count();
    const r = await request('POST', 'operations', input('create-rejected')); mock.flags.failCreate = false;
    expect(r.body.state).toBe('blocked'); expect(r.body.issueKey).toBeUndefined(); expect(r.body.steps.find(s => s.key === 'create').state).toBe('failed'); expect(mock.count()).toBe(n);
    expect((await request('GET', 'operations')).body.some(op => op.id === r.body.id)).toBe(false);
  });
  it('创建成功后流转失败，重启恢复并补充必填，只流转原任务', async () => {
    mock.flags.requireComment = true;
    const r = await request('POST', 'operations', input('required-field'));
    expect(r.body.state).toBe('blocked'); expect(r.body.issueKey).toBeTruthy(); expect(r.body.error.code).toBe('MISSING_FIELDS'); expect(r.body.error.fields.comment).toBeTruthy(); expect(r.body.error.values.resolution).toBe('1');
    const n = mock.count(); const transitions = mock.events.filter(e => e.kind === 'transition').length;
    await stopServer(); ({ url } = await startServer(options())); await login();
    expect((await request('GET', 'operations')).body.some(op => op.id === r.body.id)).toBe(true);
    const resumed = await request('POST', `operations/${r.body.id}/resume`, { fields: { comment: '已完成接口验证' } });
    expect(resumed.body.state).toBe('completed'); expect(mock.count()).toBe(n); expect(mock.events.filter(e => e.kind === 'transition')).toHaveLength(transitions + 1);
    mock.flags.requireComment = false;
  });
  it('附件上传完才开始流转；上传失败可恢复，重复上传不降级状态', async () => {
    mock.flags.failLink = true;
    const r = await request('POST', 'operations', input('attachments', { links: [{ key: 'DEMO-901', option: { type: 'Relates', dir: 'out' } }], files: [{ name: 'proof.txt', size: 5 }] }));
    expect(r.body.state).toBe('awaiting_attachments'); // 第一条关联随创建原子提交
    const before = mock.events.filter(e => e.kind === 'transition').length;
    const wrong = new FormData(); wrong.append('file', new File(['wrong'], 'other.txt'));
    expect((await request('POST', `operations/${r.body.id}/attachments`, wrong)).status).toBe(400);
    const files = new FormData(); files.append('file', new File(['proof'], 'proof.txt'));
    mock.flags.failUpload = true;
    expect((await request('POST', `operations/${r.body.id}/attachments`, files)).body.state).toBe('blocked');
    expect(mock.events.filter(e => e.kind === 'transition')).toHaveLength(before);
    mock.flags.failUpload = false; mock.flags.failLink = false;
    expect((await request('POST', `operations/${r.body.id}/attachments`, files)).body.state).toBe('awaiting_attachments');
    const done = await request('POST', `operations/${r.body.id}/resume`, { fields: {} }); expect(done.body.state).toBe('completed');
    const uploads = mock.events.filter(e => e.kind === 'upload').length;
    expect((await request('POST', `operations/${r.body.id}/attachments`, files)).body.state).toBe('completed'); expect(mock.events.filter(e => e.kind === 'upload')).toHaveLength(uploads);
  });
  it('补建关联权限失败不重建，显式恢复后按顺序完成', async () => {
    mock.flags.failLink = true;
    const r = await request('POST', 'operations', input('link-fail', { links: [{ key: 'DEMO-901', option: { type: 'Relates', dir: 'out' } }, { key: 'DEMO-902', option: { type: 'Blocks', dir: 'in' } }] }));
    expect(r.body.state).toBe('blocked'); expect(r.body.issueKey).toBeTruthy();
    const n = mock.count(); mock.flags.failLink = false;
    expect((await request('POST', `operations/${r.body.id}/resume`, { fields: {} })).body.state).toBe('completed'); expect(mock.count()).toBe(n);
  });
  it('路线变化时可为原任务选择新规则，项目和类型仍必须匹配', async () => {
    const stale = { ...policy, id: 'stale', steps: [{ ...policy.steps[0], transitionId: '99' }, policy.steps[1]] };
    await request('PUT', 'policies', [policy, stale]);
    const r = await request('POST', 'operations', input('stale-route', { policyId: 'stale' })); const n = mock.count();
    expect(r.body.error.code).toBe('SCHEMA_CHANGED');
    expect((await request('POST', `operations/${r.body.id}/resume`, { fields: {}, policyId: 'not-found' })).status).toBe(400);
    expect((await request('POST', `operations/${r.body.id}/resume`, { fields: {}, policyId: policy.id })).body.state).toBe('completed'); expect(mock.count()).toBe(n);
    await request('PUT', 'policies', [policy]);
  });
  it('创建发送后登录失效会暂停后续写入，重新登录同一用户可继续', async () => {
    let release; mock.flags.holdCreate = new Promise(r => { release = r; });
    const started = new Promise(r => { mock.flags.onCreate = r; });
    try {
      const task = request('POST', 'operations', input('session-expired')); await started;
      const n = mock.count(); const transitions = mock.events.filter(e => e.kind === 'transition').length;
      await fetch(url + '/api/logout', { method: 'POST', headers: { Cookie: cookie } }); release();
      const r = await task; expect(r.body.state).toBe('blocked'); expect(r.body.error.code).toBe('AUTH_REQUIRED'); expect(r.body.issueKey).toBeTruthy(); expect(mock.events.filter(e => e.kind === 'transition')).toHaveLength(transitions);
      await login(); expect((await request('POST', `operations/${r.body.id}/resume`, { fields: {} })).body.state).toBe('completed'); expect(mock.count()).toBe(n);
    } finally { release(); mock.flags.holdCreate = null; mock.flags.onCreate = null; }
  });
  it('创建响应未知不能重发；流转响应未知可以从真实当前状态继续下一步', async () => {
    mock.flags.unknownCreate = true;
    const data = input('unknown-create'); const r = await request('POST', 'operations', data); const n = mock.count();
    expect(r.body.error.code).toBe('UNKNOWN_OUTCOME'); mock.flags.unknownCreate = false;
    expect((await request('POST', `operations/${r.body.id}/resume`, { fields: {} })).body.error.code).toBe('UNKNOWN_OUTCOME'); await request('POST', 'operations', data); expect(mock.count()).toBe(n);
    mock.flags.unknownTransition = true;
    const t = await request('POST', 'operations', input('unknown-transition')); expect(t.body.status).toBe('处理中'); mock.flags.unknownTransition = false;
    const transitions = mock.events.filter(e => e.kind === 'transition').length;
    expect((await request('POST', `operations/${t.body.id}/resume`, { fields: {} })).body.state).toBe('completed'); expect(mock.events.filter(e => e.kind === 'transition')).toHaveLength(transitions + 1);
  });
  it('到达目标但缺解决结果不能报告成功，其他用户无法读取或恢复操作', async () => {
    mock.flags.noResolution = true;
    const r = await request('POST', 'operations', input('no-resolution')); mock.flags.noResolution = false;
    expect(r.body.state).toBe('blocked'); expect(r.body.error.code).toBe('RESOLUTION_REQUIRED');
    await login('bob'); expect((await request('GET', `operations/${r.body.id}`)).status).toBe(404); expect((await request('GET', 'operations')).body).toEqual([]);
    expect((await request('POST', `operations/${r.body.id}/resume`, {})).status).toBe(404); await login();
  });
  it('切换 Jira 地址后规则和操作隔离，旧地址规则可恢复', async () => {
    const change = async address => {
      const r = await fetch(url + '/api/settings', { method: 'PUT', headers: { Cookie: cookie, Origin: url, 'Content-Type': 'application/json' }, body: JSON.stringify({ jiraBaseUrl: address, llmBaseUrl: '', llmModel: '', llmApiKey: '' }) }); expect(r.status).toBe(200); await login();
    };
    await change(jiraUrl + '/jira');
    expect((await request('GET', 'policies')).body.policies).toEqual([]); expect((await request('GET', 'operations')).body).toEqual([]);
    await change(jiraUrl); expect((await request('GET', 'policies')).body.policies).toEqual([policy]);
  });
  it('写入范围缩小后仍可保留其他项目的旧规则，但不能修改、删除或挪用它', async () => {
    await stopServer(); ({ url } = await startServer({ ...options(), writeProjects: [] })); await login();
    const other = { ...policy, id: 'other-rule', projectKey: 'OTHER' };
    expect((await request('PUT', 'policies', [policy, other])).status).toBe(200);
    await stopServer(); ({ url } = await startServer(options())); await login();
    expect((await request('PUT', 'policies', [{ ...policy, requireResolution: false }, other])).status).toBe(200);
    expect((await request('PUT', 'policies', [policy])).status).toBe(403);
    expect((await request('PUT', 'policies', [policy, { ...other, projectKey: 'DEMO' }])).status).toBe(403);
  });
});
