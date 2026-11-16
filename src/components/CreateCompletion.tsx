import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { scopeKey } from '../lib/management';
import { useSession } from '../lib/session';
import type { FormValue } from '../lib/fields';
import type { McpPolicy } from '../lib/mcpTypes';
import { completionRoute, type CreateCompleteInput, type WorkflowOperation } from '../lib/workflow';
import { AttachmentDrop } from './AttachmentDrop';
import { FieldInput } from './FieldInput';
import { Modal } from './Modal';
import { PolicyEditor } from './PolicyEditor';

/** 仅编排“创建并完成”；普通新建仍走原有路径。未收到结果时保留同一请求编号。 */
export function useCreateCompletion(onCreated: (keys: string[]) => void) {
  const { me, toast } = useSession();
  const storage = `wb.pendingCompletion.v1:${scopeKey(me.jiraBaseUrl, me.name, null)}`;
  const [attempt, setAttempt] = useState<CreateCompleteInput | null>(() => {
    try { const p = JSON.parse(localStorage.getItem(storage) ?? 'null'); return p && typeof p.requestId === 'string' && p.values && Array.isArray(p.files) ? p : null; } catch { return null; }
  });
  const [operation, setOperation] = useState<WorkflowOperation | null>(null);
  const [pending, setPending] = useState<WorkflowOperation[]>([]);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const announced = useRef(new Set<string>());
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  function remember(input: CreateCompleteInput | null) {
    if (input) localStorage.setItem(storage, JSON.stringify(input)); else localStorage.removeItem(storage);
    setAttempt(input);
  }
  function accept(op: WorkflowOperation) {
    setOperation(op);
    if (op.issueKey && !announced.current.has(op.issueKey)) { announced.current.add(op.issueKey); onCreated([op.issueKey]); }
    if (op.state === 'completed') { remember(null); setPending(p => p.filter(x => x.id !== op.id)); toast(`${op.issueKey} 已创建并完成`); }
    else if (!op.issueKey && op.steps.some(s => s.key === 'create' && s.state === 'failed')) remember(null);
  }
  async function refresh() {
    setLoading(true); setError('');
    try {
      const list = await api.workflowOperations(); setPending(list);
      const found = list.find(op => op.requestId === attempt?.requestId);
      if (found) accept(found);
    } catch (e) { setError(`读取待完成操作失败：${(e as Error).message}`); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []); // 只在本次打开表单时读取恢复记录
  async function run(task: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await task(); } catch (e) { setError((e as Error).message); }
    finally { lock.current = false; setBusy(false); }
  }
  async function finish(op: WorkflowOperation, files: File[]) {
    accept(op);
    if (op.state !== 'awaiting_attachments') return;
    if (!op.steps.some(s => s.key === 'attachments' && s.state === 'done')) {
      if (!files.length) return;
      op = await api.uploadWorkflowFiles(op.id, files); accept(op);
      if (op.error) return;
    }
    accept(await api.resumeWorkflow(op.id));
  }
  return {
    operation, pending, busy, error, loading, attempt,
    refresh,
    select: (op: WorkflowOperation) => { setError(''); accept(op); },
    reset: () => { remember(null); setOperation(null); setError(''); },
    submit: (input: CreateCompleteInput, files: File[]) => run(async () => {
      remember(input); // 本机写入失败则停止，避免发出无法恢复的创建请求。
      try { await finish(await api.createComplete(input), files); }
      catch (e) {
        if (e instanceof ApiError && e.status >= 400 && e.status < 500 && ![408, 429].includes(e.status)) remember(null);
        throw e;
      }
    }),
    retry: () => run(async () => { if (attempt) await finish(await api.createComplete(attempt), []); }),
    resume: (fields: Record<string, FormValue>, files: File[], policyId?: string) => run(async () => {
      if (!operation) return;
      await finish(await api.resumeWorkflow(operation.id, fields, policyId), files);
    }),
  };
}

export function CompletionSettings({ projectKey, typeName, checked, onChange, onPolicy, disabled }: {
  projectKey: string; typeName: string; checked: boolean; onChange: (v: boolean) => void;
  onPolicy: (p: McpPolicy | null) => void; disabled: boolean;
}) {
  const { toast } = useSession();
  const [policies, setPolicies] = useState<McpPolicy[]>([]);
  const [policyId, setPolicyId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [configuring, setConfiguring] = useState(false);
  const [saving, setSaving] = useState(false);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!checked) return;
    let live = true; setLoading(true); setError('');
    api.workflowPolicies().then(r => { if (live) { setPolicies(r.policies); setPolicyId(''); } }, e => live && setError(e.message)).finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [checked, nonce]);
  const matches = policies.filter(p => p.projectKey === projectKey && p.typeName === typeName);
  const policy = matches.find(p => p.id === policyId) ?? matches[0] ?? null;
  useEffect(() => { onPolicy(checked && !loading && !error ? policy : null); }, [checked, loading, error, policy, onPolicy]);
  return <div className={`create-completion-settings${checked ? ' enabled' : ''}`}>
    <label><input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} disabled={disabled}/><span><strong>这项工作已完成，创建后直接完成</strong><small>适合补录已完成的工作；按照当前项目的流程到达最终状态。</small></span></label>
    {checked && <div className="create-completion-route">
      {loading ? <p role="status">正在读取完成路线…</p> : error ? <p className="err" role="alert">{error}<button type="button" className="btn small" onClick={() => setNonce(n => n + 1)}>重试</button></p> : policy ? <>
        <div className="create-completion-target"><span>完成到 <strong>{policy.targetStatus}</strong></span><button type="button" className="btn ghost small" onClick={() => setConfiguring(true)}>配置路线</button></div>
        {matches.length > 1 && <select className="select" aria-label="完成规则" value={policy.id} onChange={e => setPolicyId(e.target.value)}>{matches.map(p => <option key={p.id} value={p.id}>{p.id} · {p.targetStatus}</option>)}</select>}
        <p className="create-route-preview">{completionRoute(policy)}</p>
        <small className="muted">附件和关联处理后再流转。只完成当前工作项，所属需求保持原状态。</small>
      </> : <div className="create-completion-target"><span>还没有「{projectKey} · {typeName}」的完成路线</span><button type="button" className="btn small" onClick={() => setConfiguring(true)}>配置完成路线</button></div>}
    </div>}
    {configuring && <Modal title={`完成路线 · ${projectKey} · ${typeName}`} width={740} busy={saving} onClose={() => setConfiguring(false)}>
      <p className="muted">网页与 MCP 共用规则，无需启用 MCP。使用示例问题只读取可用流转。</p>
      {error && <p className="err" role="alert">{error}</p>}
      <PolicyEditor policies={policies} busy={saving} onError={setError} context={{ projectKey, typeName }} save={async next => {
        setSaving(true); setError('');
        try { const r = await api.saveWorkflowPolicies(next); setPolicies(r.policies); toast('完成路线已保存到本机'); }
        catch (e) { setError((e as Error).message); }
        finally { setSaving(false); }
      }}/>
    </Modal>}
  </div>;
}

export function CompletionResult({ operation: op, busy, error, onResume, onOpen, onClose, onEdit, initialFiles }: {
  operation: WorkflowOperation; busy: boolean; error: string; onResume: (fields: Record<string, FormValue>, files: File[], policyId?: string) => void;
  onOpen?: (key: string) => void; onClose: () => void; onEdit: () => void; initialFiles: File[];
}) {
  const [fields, setFields] = useState<Record<string, FormValue>>(op.error?.values ?? {});
  useEffect(() => { setFields(op.error?.values ?? {}); }, [op.error]);
  const [files, setFiles] = useState<File[]>(initialFiles);
  const [policy, setPolicy] = useState<McpPolicy | null>(null);
  const [changeRoute, setChangeRoute] = useState(false);
  const done = op.state === 'completed';
  const uncertain = op.error?.code === 'UNKNOWN_OUTCOME';
  const createFailed = !op.issueKey && op.steps.some(s => s.key === 'create' && s.state === 'failed');
  const needsFiles = op.files.length > 0 && !op.steps.some(s => s.key === 'attachments' && s.state === 'done');
  return <section className={`create-completion-result${done ? ' done' : ''}`} aria-live="polite">
    <div className="create-result-mark" aria-hidden="true">{done ? '✓' : '↻'}</div>
    <h3>{done ? '工作已记录，也已完成。' : op.issueKey ? '工作项已创建，后续步骤待完成' : createFailed ? 'Jira 未接受本次创建' : '创建操作待核实'}</h3>
    <p>{op.issueKey && <strong className="mono">{op.issueKey} · </strong>}{op.summary}</p>
    <p className="muted">{op.status ? `当前状态：${op.status} · ` : ''}目标状态：{op.targetStatus}</p>
    {op.error && <p className="err" role="alert">{op.error.message}</p>}
    {error && <p className="err" role="alert">{error}</p>}
    {!done && <p className="muted">{uncertain ? '请先查看 Jira 核实写入结果。继续检查会读取当前状态，不会重复发送结果未知的步骤。' : '补充信息后继续当前操作，已成功的创建、关联和附件不会重复提交。关闭后可从新建表单找回。'}</p>}
    {!done && <><button className="btn ghost small" disabled={busy} onClick={() => setChangeRoute(v => !v)}>{changeRoute ? '收起路线设置' : '调整完成路线'}</button>{changeRoute && <CompletionSettings projectKey={op.projectKey} typeName={op.typeName} checked onChange={() => {}} onPolicy={setPolicy} disabled/>}</>}
    {!done && <fieldset disabled={busy} className="create-resume-fields"><div className="form-grid">{Object.entries(op.error?.fields ?? {}).map(([id, meta]) => <FieldInput key={id} id={id} meta={meta} project={op.projectKey} value={fields[id]} onChange={v => setFields(p => ({ ...p, [id]: v }))}/>)}</div>
      {needsFiles && !uncertain && <><p className="field-label">重新选择待上传附件</p><p className="muted">{op.files.map(f => f.name).join('、')}（按原顺序选择，同名、同大小）</p><AttachmentDrop files={files} onChange={setFiles}/></>}
    </fieldset>}
    <div className="create-result-actions">
      {createFailed && <button className="btn" disabled={busy} onClick={onEdit}>返回表单修改</button>}
      {op.issueKey && onOpen && <button className="btn" disabled={busy} onClick={() => { onClose(); onOpen(op.issueKey!); }}>查看工作项 ↗</button>}
      {done ? <button className="btn primary" onClick={onClose}>完成</button> : <button className="btn primary" disabled={busy || (changeRoute && !policy)} onClick={() => onResume(fields, files, changeRoute ? policy?.id : undefined)}>{busy ? '正在处理…' : op.state === 'running' ? '查询执行结果' : uncertain ? '核实状态并继续' : '继续完成当前工作项'}</button>}
    </div>
  </section>;
}
