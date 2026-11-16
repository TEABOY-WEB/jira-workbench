import { useState } from 'react';
import { api, type Transition } from '../lib/api';
import type { McpPolicy } from '../lib/mcpTypes';
import type { FormValue } from '../lib/fields';
import { FieldInput } from './FieldInput';

export function PolicyEditor({policies,busy,save,onError,context}:{policies:McpPolicy[];busy:boolean;save:(p:McpPolicy[])=>void;onError:(s:string)=>void;context?:{projectKey:string;typeName:string}}) {
  const [sample,setSample]=useState('');
  const [loaded,setLoaded]=useState<{projectKey:string;typeName:string;from:string;transitions:Transition[]}|null>(null);
  const [loading,setLoading]=useState(false);
  const [policy,setPolicy]=useState<McpPolicy>({id:`complete-${crypto.randomUUID().slice(0,8)}`,projectKey:'',typeName:'',targetStatus:'',requireResolution:false,steps:[]});
  const [transition,setTransition]=useState('');
  const [stepFields,setStepFields]=useState('{}');
  const [stepValues,setStepValues]=useState<Record<string,FormValue>>({});
  async function load() {
    setLoading(true);onError('');
    try {
      const k=sample.trim().toUpperCase(),[issue,transitions]=await Promise.all([api.issue(k),api.transitions(k)]);
      if(context && (context.projectKey !== issue.key.split('-')[0] || context.typeName !== issue.fields.issuetype.name))throw new Error(`请选择 ${context.projectKey} 项目中“${context.typeName}”类型的示例问题`);
      if(policy.steps.length && (policy.projectKey!==k.split('-')[0] || policy.typeName!==issue.fields.issuetype.name))throw new Error('路线已有步骤，请使用同一项目、同一类型的示例问题');
      setLoaded({projectKey:k.split('-')[0],typeName:issue.fields.issuetype.name,from:issue.fields.status.name,transitions});setTransition(transitions[0]?.id??'');setStepValues({});setStepFields('{}');
      setPolicy(p=>({...p,projectKey:k.split('-')[0],typeName:issue.fields.issuetype.name}));
    }catch(e){onError((e as Error).message);}finally{setLoading(false);}
  }
  function add() {
    const t=loaded?.transitions.find(t=>t.id===transition);if(!t||!loaded)return;
    try {
      const raw=JSON.parse(stepFields);
      if(!raw||Array.isArray(raw)||typeof raw!=='object'||Object.values(raw).some(v=>typeof v!=='string'&&!(Array.isArray(v)&&v.every(x=>typeof x==='string'))))throw new Error('字段必须是“字段 ID: 字符串或字符串数组”的 JSON 对象');
      setPolicy(p=>({...p,targetStatus:t.to.name,steps:[...p.steps.filter(s=>s.from!==loaded.from),{from:loaded.from,transitionId:t.id,to:t.to.name,fields:{...raw,...stepValues}}]}));
    }catch(e){onError((e as Error).message);}
  }
  return <>
    <section className="mcp-card"><h3>配置自动完成路线</h3><p className="muted">使用现有问题读取当前允许的流转，只查询、不修改该问题。每个起始状态添加一步，直到目标状态；只有已完成的实际工作才应授权自动流转。</p>
      <div className="check-group"><input className="input" aria-label="示例问题编号" placeholder="示例问题，如 AGENT-123" value={sample} onChange={e=>setSample(e.target.value)}/><button className="btn" disabled={loading||!sample.trim()} onClick={load}>{loading?'读取中…':'读取可用流转'}</button></div>
      {loaded&&<div className="mcp-policy-builder"><p>{loaded.projectKey} · {loaded.typeName} · 当前状态：<strong>{loaded.from}</strong></p><select className="select" aria-label="策略流转" value={transition} onChange={e=>{setTransition(e.target.value);setStepValues({});setStepFields('{}');}}>{loaded.transitions.map(t=><option key={t.id} value={t.id}>{t.name} → {t.to.name}（{t.id}）</option>)}</select><p className="muted">配置这一步的默认补充信息。实际执行时会再次检查 Jira 的必填字段。</p><div className="form-grid">{Object.entries(loaded.transitions.find(t=>t.id===transition)?.fields??{}).map(([id,meta])=><FieldInput key={id} id={id} meta={meta} project={loaded.projectKey} value={stepValues[id]} onChange={v=>setStepValues(p=>({...p,[id]:v}))}/>)}</div><details><summary>高级字段配置（JSON）</summary><textarea className="input textarea mono" aria-label="流转补充字段" rows={3} value={stepFields} onChange={e=>setStepFields(e.target.value)}/></details>{loaded.transitions.find(t=>t.id===transition)?.fields&&<details><summary>查看此流转字段与选项</summary><pre className="mcp-code">{JSON.stringify(loaded.transitions.find(t=>t.id===transition)?.fields,null,2)}</pre></details>}<button className="btn" disabled={!transition} onClick={add}>添加此步到路线</button></div>}
      <div className="form-grid mcp-policy-fields"><label className="field"><span>策略 ID（供 Agent 调用）</span><input className="input" value={policy.id} onChange={e=>setPolicy(p=>({...p,id:e.target.value}))}/></label><label className="field"><span>目标状态（精确名称）</span><input className="input" value={policy.targetStatus} onChange={e=>setPolicy(p=>({...p,targetStatus:e.target.value}))}/></label></div>
      <p className="muted">适用：{policy.projectKey||'待选择'} / {policy.typeName||'待选择'}。新增路线时请使用同一项目、同一类型的问题。</p>
      {policy.steps.map(s=><div className="mcp-route-step" key={s.from}><span>{s.from} <b>→</b> {s.to} <small>流转 {s.transitionId}</small></span><button className="btn small ghost" onClick={()=>setPolicy(p=>({...p,steps:p.steps.filter(x=>x.from!==s.from)}))}>移除</button></div>)}
      <label className="mcp-policy-check"><input type="checkbox" checked={policy.requireResolution} onChange={e=>setPolicy(p=>({...p,requireResolution:e.target.checked}))}/>到达目标时必须存在解决结果</label>
      <button className="btn primary" disabled={busy||!policy.id.trim()||!policy.projectKey||!policy.targetStatus.trim()||!policy.steps.length} onClick={()=>save([...policies.filter(p=>p.id!==policy.id),policy])}>保存完成策略</button>
    </section>
    <section className="mcp-card"><h3>已配置策略</h3>{!policies.length&&<p className="muted">尚无自动完成策略。Agent 仍可新建任务或执行单步流转。</p>}{policies.filter(p=>!context||(p.projectKey===context.projectKey&&p.typeName===context.typeName)).map(p=><div className="mcp-grant" key={p.id}><div><strong>{p.id}</strong><p>{p.projectKey} · {p.typeName} → {p.targetStatus} · {p.steps.length} 步</p></div><div className="check-group"><button className="btn small" onClick={()=>setPolicy(p)}>编辑</button><button className="btn small ghost" disabled={busy} onClick={()=>save(policies.filter(x=>x.id!==p.id))}>移除</button></div></div>)}</section>
  </>;
}
