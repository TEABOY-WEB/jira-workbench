import { z } from 'zod';
import { planCreate, fromJiraValue } from '../.wb-build/domain.mjs';
import { canonical, digest, problem } from './mcp-store.mjs';
import { runCompletion, validateWorkflowFields } from './completion.mjs';
import { policySchema } from './mcp-tools.mjs';
import { isLocalRequest } from './settings.mjs';
import { checkWrite } from './policy.mjs';

const text = z.string().trim().min(1).max(200);
const key = z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/);
const values = z.record(z.string(), z.union([z.string().max(20000), z.array(z.string())]));
const createInput = z.object({
  requestId: text, projectKey: z.string().regex(/^[A-Z][A-Z0-9_]*$/), typeName: text,
  values, parentKey: key.optional(), policyId: text,
  links: z.array(z.object({ key, option: z.object({ type: text, dir: z.enum(['in', 'out']) }).strict() }).strict()).max(50).default([]),
  files: z.array(z.object({ name: z.string().min(1).max(255), size: z.number().int().nonnegative().max(100 * 1024 * 1024) }).strict()).max(20).default([]),
}).strict().refine(v => v.files.reduce((sum, f) => sum + f.size, 0) <= 100 * 1024 * 1024, '附件总大小不能超过 100 MB');
const policiesInput = z.array(policySchema).max(100).superRefine((policies, ctx) => {
  if (new Set(policies.map(p => p.id)).size !== policies.length) ctx.addIssue({ code: 'custom', message: '规则 ID 不可重复' });
  for (const p of policies) {
    if (new Set(p.steps.map(s => s.from)).size !== p.steps.length) ctx.addIssue({ code: 'custom', message: '每个起始状态只能配置一步' });
    for (const start of p.steps) {
      const seen = new Set(); let status = start.from;
      while (status !== p.targetStatus) {
        const next = p.steps.find(s => s.from === status);
        if (!next || seen.has(status)) { ctx.addIssue({ code: 'custom', message: `规则 ${p.id} 从“${start.from}”无法到达“${p.targetStatus}”` }); break; }
        seen.add(status); status = next.to;
      }
    }
  }
});
const errorInfo = e => ({ code: e.code || 'JIRA_ERROR', message: e.message, ...(e.details || {}) });

/** 网页编排：复用本机操作日志和完成规则，独立于 MCP 开关和 Agent 授权。 */
export function createWebWorkflow({ store, jira, getSession, getBaseUrl, getWritePolicy, readBody, sendJson }) {
  const running = new Map();
  const owner = s => `web:${digest(`${getBaseUrl()}\n${s.user}`)}`;
  function check(s, method = 'GET', sub, body) {
    if (getSession(s.sid)?.user !== s.user) throw Object.assign(problem('AUTH_REQUIRED', '登录已失效，请重新登录'), { status: 401 });
    if (method !== 'GET') {
      const denied = checkWrite(getWritePolicy(), method, sub, body);
      if (denied) throw Object.assign(problem('FORBIDDEN', denied.msg), { status: denied.status });
    }
  }
  const call = (s, method, sub, body) => { check(s, method, sub, body); return jira(s, method, sub, body); };
  const issue = (s, k) => call(s, 'GET', `issue/${k}?fields=*all`);
  const transitions = async (s, k) => (await call(s, 'GET', `issue/${k}/transitions?expand=transitions.fields`)).transitions ?? [];
  const publicOperation = op => ({ id: op.id, requestId: op.requestId, state: op.state, issueKey: op.issueKey, status: op.status, summary: op.input.values.summary, projectKey: op.input.projectKey, typeName: op.input.typeName, targetStatus: op.policy.targetStatus, files: op.input.files, error: op.error, steps: store.steps(op.id).map(({ key, state }) => ({ key, state })) });
  function owned(s, id) {
    const op = store.operation(id);
    if (!op || op.grantId !== owner(s) || op.tool !== 'web_create_complete') throw Object.assign(problem('NOT_FOUND', '操作不存在'), { status: 404 });
    return op;
  }
  async function write(s, op, id, method, sub, body) {
    check(s, method, sub, body);
    const previous = store.step(op.id, id);
    if (previous?.state === 'done') return previous.result;
    if (['unknown', 'in_flight'].includes(previous?.state)) throw problem('UNKNOWN_OUTCOME', '上次写入结果尚不确定，请先在 Jira 核实，不会重复发送', { step: id });
    store.saveStep(op.id, id, { state: 'in_flight' });
    try {
      const result = await call(s, method, sub, body);
      store.saveStep(op.id, id, { state: 'done', result });
      return result;
    } catch (e) {
      const uncertain = !e.status || e.status >= 500 || [408, 429].includes(e.status);
      store.saveStep(op.id, id, { state: uncertain ? 'unknown' : 'failed', error: errorInfo(e) });
      if (uncertain) throw problem('UNKNOWN_OUTCOME', 'Jira 写入响应不确定，请先核实结果，不会自动重复提交', { step: id });
      throw e;
    }
  }
  function once(id, run) {
    if (running.has(id)) return running.get(id);
    const promise = run().finally(() => running.delete(id));
    running.set(id, promise); return promise;
  }
  async function run(s, op) {
    if (op.state === 'completed') return op;
    return once(op.id, async () => {
      op.state = 'running'; delete op.error; store.saveOperation(op);
      try {
        const created = await write(s, op, 'create', 'POST', 'issue', op.plan.body);
        op.issueKey = created.key; store.saveOperation(op);
        for (const [i, link] of op.plan.afterLinks.entries()) {
          const [a, b] = link.option.dir === 'out' ? [created.key, link.key] : [link.key, created.key];
          await write(s, op, `link:${i}`, 'POST', 'issueLink', { type: { name: link.option.type }, inwardIssue: { key: a }, outwardIssue: { key: b } });
        }
        if (op.input.files.length && store.step(op.id, 'attachments')?.state !== 'done') {
          op.state = 'awaiting_attachments';
          if (['unknown', 'in_flight'].includes(store.step(op.id, 'attachments')?.state)) throw problem('UNKNOWN_OUTCOME', '附件上传结果不确定，请打开任务核实，不会重复上传');
        } else {
          const completed = await runCompletion({ issueKey: created.key, policy: op.policy, readIssue: k => issue(s, k), transitions: k => transitions(s, k), transition: async (current, step, t) => {
            const form = {};
            for (const [id, meta] of Object.entries(t.fields ?? {})) {
              // Jira 的 issue.comment 是评论集合，不能把它字符串化为本次流转说明。
              const old = id === 'comment' ? undefined : fromJiraValue(id, meta, current.fields[id]);
              const value = op.resumeFields?.[id] ?? op.input.values[id] ?? step.fields[id] ?? old;
              if (value !== undefined) form[id] = value;
            }
            try {
              const fields = validateWorkflowFields(t.fields ?? {}, form);
              await write(s, op, `transition:${step.from}:${step.transitionId}`, 'POST', `issue/${created.key}/transitions`, { transition: { id: step.transitionId }, fields });
            } catch (e) {
              if (e.code !== 'UNKNOWN_OUTCOME') e.details = { ...e.details, fields: t.fields ?? {}, values: form };
              throw e;
            }
            const after = await issue(s, created.key);
            if (after.fields.status.name !== step.to) throw problem('STATE_CONFLICT', '流转后的状态与预期不一致', { current: after.fields.status.name, expected: step.to });
          } });
          op.status = completed.fields.status.name; op.state = 'completed';
        }
      } catch (e) { op.state = 'blocked'; op.error = errorInfo(e); }
      if (op.issueKey && op.state !== 'completed') {
        try { op.status = (await issue(s, op.issueKey)).fields.status.name; }
        catch (e) { delete op.status; op.state = 'blocked'; op.error ??= errorInfo(e); }
      }
      store.saveOperation(op); return op;
    });
  }
  async function prepare(s, input) {
    const policy = store.config().policies.find(p => p.id === input.policyId);
    if (!policy || policy.projectKey !== input.projectKey || policy.typeName !== input.typeName) throw problem('POLICY_MISMATCH', '请先配置或选择当前项目、类型对应的完成规则');
    policiesInput.parse([policy]);
    check(s, 'POST', 'issue', { fields: { project: { key: input.projectKey } } });
    const meta = await call(s, 'GET', `issue/createmeta?projectKeys=${encodeURIComponent(input.projectKey)}&expand=projects.issuetypes.fields`);
    const types = meta.projects?.find(p => p.key === input.projectKey)?.issuetypes.filter(t => t.name === input.typeName) ?? [];
    if (types.length !== 1) throw problem('SCHEMA_CHANGED', '当前项目没有唯一匹配的新建类型，请重新读取表单');
    validateWorkflowFields(types[0].fields, input.values, false);
    let parent = null;
    if (input.parentKey) {
      const p = await issue(s, input.parentKey);
      if (p.fields.issuetype.name !== '需求' || input.typeName === '需求') throw problem('INVALID_PARENT', '仅任务可关联父需求');
      parent = { key: p.key, fields: p.fields };
    }
    const plan = planCreate({ projectKey: input.projectKey, type: types[0], values: input.values, parent, links: input.links });
    if (plan.missing.length || plan.unsupported.length) throw problem('MISSING_FIELDS', `请填写：${[...plan.missing, ...plan.unsupported].join('、')}`);
    check(s, 'POST', 'issue', plan.body);
    for (const link of plan.afterLinks) check(s, 'POST', 'issueLink', { inwardIssue: { key: `${input.projectKey}-1` }, outwardIssue: { key: link.key } });
    return { policy: structuredClone(policy), plan };
  }
  return {
    drain: () => Promise.allSettled([...running.values()]),
    async handle(req, res, url, session) {
      if (!isLocalRequest(req.headers)) return sendJson(res, 403, { errorMessages: ['只允许本机同源访问工作流'] });
      if (!session) return sendJson(res, 401, { errorMessages: ['请先登录工作台'] });
      const parse = async () => JSON.parse((await readBody(req)).toString('utf8'));
      try {
        if (url.pathname === '/api/workflow/policies' && req.method === 'GET') return sendJson(res, 200, { policies: store.config().policies });
        if (url.pathname === '/api/workflow/policies' && req.method === 'PUT') {
          const policies = policiesInput.parse(await parse());
          const previous = store.config().policies;
          const changed = [...policies.filter(p => canonical(previous.find(old => old.id === p.id)) !== canonical(p)), ...previous.filter(old => canonical(policies.find(p => p.id === old.id)) !== canonical(old))];
          // 保留未改动的其他项目规则；新增、修改和删除仍逐项检查当前写入范围。
          for (const p of changed) check(session, 'POST', 'issue', { fields: { project: { key: p.projectKey } } });
          store.saveConfig({ ...store.config(), policies }); return sendJson(res, 200, { policies });
        }
        if (url.pathname === '/api/workflow/operations' && req.method === 'GET') return sendJson(res, 200, store.operations(owner(session)).filter(op => op.tool === 'web_create_complete' && op.state !== 'completed' && (op.issueKey || store.step(op.id, 'create')?.state !== 'failed')).map(publicOperation));
        if (url.pathname === '/api/workflow/operations' && req.method === 'POST') {
          const input = createInput.parse(await parse());
          // 重试先找原操作，不能因 Jira 字段/路线后续变化重新创建。
          let op = store.findOperation(owner(session), input.requestId);
          if (op) { store.begin(owner(session), input.requestId, 'web_create_complete', input); return sendJson(res, 200, publicOperation(await (running.get(op.id) ?? op))); }
          const prepared = await prepare(session, input);
          op = store.begin(owner(session), input.requestId, 'web_create_complete', input);
          // 并发预检后只有一个请求负责执行。
          if (!op.existing) { Object.assign(op, prepared); store.saveOperation(op); }
          return sendJson(res, 200, publicOperation(await run(session, op)));
        }
        const match = /^\/api\/workflow\/operations\/([a-f0-9-]+)(?:\/(resume|attachments))?$/.exec(url.pathname);
        if (match) {
          let op = owned(session, match[1]);
          if (req.method === 'GET' && !match[2]) return sendJson(res, 200, publicOperation(op));
          if (req.method === 'POST' && match[2] === 'resume') {
            const input = z.object({ fields: values.default({}), policyId: text.optional() }).strict().parse(await parse());
            op = owned(session, match[1]);
            if (op.state === 'completed') return sendJson(res, 200, publicOperation(op));
            check(session, 'POST', 'issue', { fields: { project: { key: op.input.projectKey } } });
            if (running.has(op.id)) return sendJson(res, 200, publicOperation(await running.get(op.id)));
            if (input.policyId) {
              const policy = store.config().policies.find(p => p.id === input.policyId);
              if (!policy || policy.projectKey !== op.input.projectKey || policy.typeName !== op.input.typeName) throw problem('POLICY_MISMATCH', '请选择当前项目、类型的完成规则');
              policiesInput.parse([policy]); op.policy = structuredClone(policy);
            }
            op.resumeFields = { ...op.resumeFields, ...input.fields }; store.saveOperation(op);
            return sendJson(res, 200, publicOperation(await run(session, op)));
          }
          if (req.method === 'POST' && match[2] === 'attachments') {
            if (op.state === 'completed' || store.step(op.id, 'attachments')?.state === 'done') return sendJson(res, 200, publicOperation(op));
            if (!op.issueKey || !op.input.files.length) throw problem('INVALID_INPUT', '当前操作不需要上传附件');
            const bytes = await readBody(req, 101 * 1024 * 1024); // 100MB 文件之外留出 multipart 头空间
            const form = await new Request('http://localhost', { method: 'POST', headers: { 'Content-Type': req.headers['content-type'] || '' }, body: bytes }).formData();
            const files = form.getAll('file');
            if (files.length !== op.input.files.length || files.some((f, i) => !(f instanceof File) || f.name !== op.input.files[i].name || f.size !== op.input.files[i].size)) throw problem('INVALID_INPUT', '请选择创建时的同名、同大小附件，顺序保持一致');
            const out = await once(op.id, async () => {
              op = owned(session, match[1]);
              if (op.state === 'completed' || store.step(op.id, 'attachments')?.state === 'done') return op;
              try { await write(session, op, 'attachments', 'POST', `issue/${op.issueKey}/attachments`, form); op.state = 'awaiting_attachments'; delete op.error; }
              catch (e) { op.state = 'blocked'; op.error = errorInfo(e); }
              store.saveOperation(op); return op;
            });
            return sendJson(res, 200, publicOperation(out));
          }
        }
        sendJson(res, 404, { errorMessages: ['工作流接口不存在'] });
      } catch (e) { sendJson(res, e.status || 400, { errorMessages: [e instanceof z.ZodError ? e.issues.map(i => i.message).join('；') : e.message], code: e.code || 'INVALID_INPUT' }); }
    },
  };
}
