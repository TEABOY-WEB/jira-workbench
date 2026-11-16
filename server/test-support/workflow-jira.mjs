import http from 'node:http';

/** 仅供集成测试及本地 UI 验收，所有数据都在内存中，不连接真实 Jira。 */
export function workflowJira() {
  const field = (name, required, type, extra = {}) => ({ name, required, schema: { type }, ...extra });
  const meta = { summary: field('标题', true, 'string'), description: field('描述', false, 'string'), assignee: field('经办人', false, 'user'), customfield_10204: field('开发人员', false, 'user'), customfield_100: field('开发预估时间', false, 'number'), customfield_101: field('开发完成日期', false, 'date'), issuelinks: field('关联', false, 'issuelinks') };
  const types = [{ id: '1', name: '需求', fields: meta }, { id: '2', name: '编码任务', fields: meta }, { id: '3', name: '其他任务', fields: meta }];
  const issues = new Map(); const events = [];
  const flags = { failCreate: false, failTransition: false, failLink: false, failUpload: false, unknownCreate: false, unknownTransition: false, requireComment: false, noResolution: false, holdCreate: null, onCreate: null };
  let count = 0;
  function seed(key, name = '编码任务', status = '新增') {
    const issue = { id: key, key, fields: { project: { key: 'DEMO' }, issuetype: { id: types.find(t => t.name === name).id, name }, summary: name === '需求' ? '工作台效率改进' : '接口联调与验证', status: { id: status, name: status }, assignee: { name: 'alice', displayName: '王同学' }, updated: new Date().toISOString(), created: new Date().toISOString(), components: [], versions: [], issuelinks: [], comment: { comments: [] }, attachment: [] } };
    issues.set(key, issue); return issue;
  }
  seed('DEMO-900', '需求'); seed('DEMO-901'); seed('DEMO-902', '编码任务', '处理中'); seed('DEMO-903', '其他任务');
  const send = (res, body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(status === 204 ? undefined : JSON.stringify(body)); };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost'); u.pathname = u.pathname.replace(/^\/jira\//, '/');
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const body = req.headers['content-type']?.includes('json') ? JSON.parse(raw.toString() || 'null') : null;
    if (u.pathname === '/rest/auth/1/session') {
      const name = body?.username || /JSESSIONID=([^;]+)/.exec(req.headers.cookie || '')?.[1] || 'alice';
      res.setHeader('Set-Cookie', `JSESSIONID=${name}; Path=/`); return send(res, { name });
    }
    const sub = u.pathname.replace('/rest/api/2/', '');
    if (sub === 'mypermissions') return send(res, { permissions: {} });
    if (sub === 'project') return send(res, [{ id: '1', key: 'DEMO', name: '演示项目' }]);
    if (sub === 'project/DEMO') return send(res, { id: '1', key: 'DEMO', name: '演示项目', components: [], versions: [], issueTypes: types });
    if (sub === 'priority') return send(res, []);
    if (sub === 'issue/createmeta') return send(res, { projects: [{ key: 'DEMO', issuetypes: types }] });
    if (sub === 'field') return send(res, Object.entries(meta).map(([id, m]) => ({ id, name: m.name, schema: m.schema })));
    if (sub === 'issueLinkType') return send(res, { issueLinkTypes: [{ id: '1', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, { id: '2', name: 'Relates', inward: 'relates to', outward: 'relates to' }] });
    if (sub.startsWith('user/')) return send(res, [{ name: 'alice', displayName: '王同学' }]);
    if (sub === 'search') return send(res, { issues: [...issues.values()], total: issues.size, startAt: 0, maxResults: 1000 });
    if (sub === 'issue' && req.method === 'POST') {
      if (flags.failCreate) return send(res, { errorMessages: ['当前账号无创建权限'] }, 403);
      events.push({ kind: 'create', body }); count++;
      flags.onCreate?.(); if (flags.holdCreate) await flags.holdCreate;
      const created = seed(`DEMO-${count}`, types.find(t => t.id === body.fields.issuetype.id).name);
      Object.assign(created.fields, body.fields); created.fields.issuetype = { id: body.fields.issuetype.id, name: types.find(t => t.id === body.fields.issuetype.id).name };
      if (flags.unknownCreate) return send(res, { errorMessages: ['创建成功但响应丢失'] }, 502);
      return send(res, { id: created.id, key: created.key }, 201);
    }
    if (sub === 'issueLink') {
      events.push({ kind: 'link', body });
      return flags.failLink ? send(res, { errorMessages: ['无关联权限'] }, 403) : send(res, null, 201);
    }
    const m = /^issue\/(DEMO-\d+)(?:\/(.*))?$/.exec(sub);
    if (m) {
      const issue = issues.get(m[1]); if (!issue) return send(res, { errorMessages: ['问题不存在'] }, 404);
      if (m[2] === 'transitions') {
        if (req.method === 'GET') return send(res, { transitions: issue.fields.status.name === '新增' ? [{ id: '11', name: '开始处理', to: { id: '2', name: '处理中' }, fields: {} }] : issue.fields.status.name === '处理中' ? [{ id: '21', name: '关闭', to: { id: '3', name: '关闭' }, fields: { resolution: field('解决结果', true, 'resolution', { allowedValues: [{ id: '1', name: '完成' }] }), ...(flags.requireComment ? { comment: field('完成说明', true, 'string') } : {}) } }] : [] });
        events.push({ kind: 'transition', key: issue.key, body });
        if (flags.failTransition) return send(res, { errorMessages: ['当前账号无流转权限'] }, 403);
        Object.assign(issue.fields, body.fields);
        issue.fields.status = { id: body.transition.id, name: body.transition.id === '11' ? '处理中' : '关闭' };
        if (flags.noResolution) delete issue.fields.resolution;
        return flags.unknownTransition ? send(res, { errorMessages: ['流转响应丢失'] }, 502) : send(res, null, 204);
      }
      if (m[2] === 'attachments') {
        events.push({ kind: 'upload', key: issue.key });
        return flags.failUpload ? send(res, { errorMessages: ['附件暂不可上传'] }, 403) : send(res, [{ id: '1', filename: 'proof.txt' }], 201);
      }
      if (m[2] === 'editmeta') return send(res, { fields: meta });
      return send(res, issue);
    }
    send(res, { errorMessages: [`模拟 Jira 未实现 ${req.method} ${sub}`] }, 404);
  });
  return { server, flags, issues, events, meta, types, seed, count: () => count };
}

export const workflowPolicy = { id: 'demo-complete', projectKey: 'DEMO', typeName: '编码任务', targetStatus: '关闭', requireResolution: true, steps: [{ from: '新增', transitionId: '11', to: '处理中', fields: {} }, { from: '处理中', transitionId: '21', to: '关闭', fields: { resolution: '1' } }] };
