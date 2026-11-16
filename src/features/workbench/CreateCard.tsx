import type { CreateTarget } from '../../components/CreateDialog';
import { useSession } from '../../lib/session';

const ACTIONS = [
  { name: '需求', type: '需求', hint: '记录目标与验收标准', icon: '◇', color: 'story' },
  { name: '任务', type: '编码任务', hint: '拆解开发与交付工作', icon: '✓', color: 'task' },
  { name: '其他任务', type: '其他任务', hint: '联调、支持与日常工作', icon: '↗', color: 'other' },
];
export function CreateCard({ projectKey, onCreate }: { projectKey: string | null; onCreate: (target: CreateTarget) => void }) {
  const { me, canWriteProject } = useSession();
  const allowed = me.allowWrite && (!projectKey || canWriteProject(projectKey));
  return <div className="workbench-create">
    <div className="workbench-create-actions">{ACTIONS.map(a => <button className={`workbench-create-entry ${a.color}`} key={a.type} disabled={!allowed} onClick={() => onCreate({ projectKey, typeName: a.type })}>
      <span className="workbench-create-icon" aria-hidden="true">{a.icon}</span><span><strong>新建{a.name}</strong><small>{a.hint}</small></span><span className="workbench-create-plus" aria-hidden="true">＋</span>
    </button>)}</div>
    <p className="workbench-create-note">{!allowed ? '当前项目未开放写入，新建入口暂不可用。' : <>{projectKey ? `创建到 ${projectKey}` : '创建时选择项目'}<span>已做完的工作，可在表单中勾选直接完成。</span></>}</p>
  </div>;
}
