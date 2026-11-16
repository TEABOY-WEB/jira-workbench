import { buildFields, inputKind } from '../.wb-build/domain.mjs';
import { problem } from './mcp-store.mjs';

/** 网页与 MCP 共用的字段校验；写路径不猜测选项或忽略未知字段。 */
export function validateWorkflowFields(meta, input, required = true) {
  for (const [id, value] of Object.entries(input)) {
    const field = meta[id];
    if (!field || ['project', 'issuetype', 'status', 'reporter', 'issuelinks', 'attachment'].includes(id)) throw problem('INVALID_FIELD', `字段 ${id} 不允许写入或不存在`);
    if (field.operations && !field.operations.includes('set')) throw problem('INVALID_FIELD', `字段 ${id} 不允许 set`);
    const kind = inputKind(id, field);
    if (Array.isArray(value) && !['multiselect', 'cascade'].includes(kind)) throw problem('INVALID_FIELD', `字段 ${field.name} 需要单个表单值`, { fields: meta });
    if (kind === 'number' && value.trim() && !Number.isFinite(Number(value))) throw problem('INVALID_FIELD', `字段 ${field.name} 需要有效数字`, { fields: meta });
    if (!kind && (Array.isArray(value) ? value.length : value.trim())) throw problem('UNSUPPORTED_FIELD', `工作台暂不支持写入字段 ${field.name}`, { fields: meta });
    if (field.allowedValues && ['select', 'multiselect', 'cascade'].includes(kind)) {
      const allowed = field.allowedValues.flatMap(v => [v, ...(v.children ?? [])]).map(v => String(v.id));
      if ((Array.isArray(value) ? value : [value]).some(v => v && !allowed.includes(v))) throw problem('INVALID_FIELD', `字段 ${field.name} 选项不合法`, { fields: meta });
      if (kind === 'cascade') {
        const [parent, child] = Array.isArray(value) ? value : [value];
        if (child && !field.allowedValues.find(v => String(v.id) === parent)?.children?.some(v => String(v.id) === child)) throw problem('INVALID_FIELD', `字段 ${field.name} 子选项不属于当前父选项`, { fields: meta });
      }
    }
  }
  const plan = buildFields(meta, input, ['project', 'issuetype', 'issuelinks', 'attachment', 'reporter']);
  if (required && (plan.missing.length || plan.unsupported.length)) throw problem('MISSING_FIELDS', `请补充：${[...plan.missing, ...plan.unsupported].join('、')}`, { missing: plan.missing, unsupported: plan.unsupported, fields: meta });
  return plan.fields;
}

/** 只执行显式配置的路线，逐步重新读取 Jira 可执行流转并确认结果。 */
export async function runCompletion({ issueKey, policy, readIssue, transitions, transition }) {
  const visited = new Set();
  for (let i = 0; i <= 12; i++) {
    const current = await readIssue(issueKey);
    if (current.fields.project?.key !== policy.projectKey || current.fields.issuetype.name !== policy.typeName) throw problem('POLICY_MISMATCH', '完成策略与项目/问题类型不匹配');
    const status = current.fields.status.name;
    if (status === policy.targetStatus) {
      if (policy.requireResolution && !current.fields.resolution) throw problem('RESOLUTION_REQUIRED', '已到目标状态但没有解决结果');
      return current;
    }
    if (i === 12) break;
    if (visited.has(status)) throw problem('WORKFLOW_LOOP', '完成路线出现循环，已停止流转');
    visited.add(status);
    const choices = policy.steps.filter(step => step.from === status);
    if (choices.length !== 1) throw problem('AMBIGUOUS_TRANSITION', '未找到唯一的已配置路线', { current: status });
    const step = choices[0];
    const available = await transitions(issueKey);
    if (!available.some(t => t.id === step.transitionId && t.to.name === step.to)) throw problem('SCHEMA_CHANGED', 'Jira 流转路线已变化，请更新完成规则');
    await transition(current, step, available.find(t => t.id === step.transitionId));
  }
  throw problem('WORKFLOW_LOOP', '超过12步，停止自动流转');
}
