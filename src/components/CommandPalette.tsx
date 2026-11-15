import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { isIssueKey } from '../lib/jql';
import { searchIssueSuggestions, type IssueSuggestions } from '../lib/issueSuggestions';
import { useSession } from '../lib/session';
import { loadRecent, type RecentIssue } from '../lib/recent';
import type { Project } from '../lib/types';
import { StatusPill, TypeBadge } from './Badges';
import { useDialogFocus } from '../lib/useDialogFocus';

interface Props {
  projects: Project[];
  /** 当前全局项目：关键字只搜这个项目；完整编号仍可跨项目打开 */
  currentProject: string | null;
  onOpenIssue: (key: string) => void;
  onOpenProject: (key: string) => void;
  onClose: () => void;
}

type Item =
  | { kind: 'issue'; key: string; summary: string; type: string; status: string }
  | { kind: 'project'; key: string; name: string };

/** ⌘K / Ctrl+K 跳转：在当前项目搜索，完整编号可跨项目直接打开。 */
export function CommandPalette({ projects, currentProject, onOpenIssue, onOpenProject, onClose }: Props) {
  const { me } = useSession();
  const namespace = `${me.jiraBaseUrl}:${me.name}`;
  const [text, setText] = useState('');
  const [result, setResult] = useState<(IssueSuggestions & { query: string; project: string | null }) | null>(null);
  const [active, setActive] = useState(0);
  const listId = useId();
  const recent = useMemo<RecentIssue[]>(() => loadRecent(), []);
  const q = text.trim();
  const ready = result?.query === q && result.project === currentProject;
  const found: Item[] = useMemo(() => ready ? result.issues.map(i => ({ kind: 'issue', key: i.key, summary: i.fields.summary, type: i.fields.issuetype.name, status: i.fields.status.name })) : [], [ready, result]);
  const listRef = useRef<HTMLUListElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, onClose);

  useEffect(() => {
    if (!q) {
      setResult(null);
      return;
    }
    let alive = true;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      searchIssueSuggestions(q, currentProject, namespace, ctrl.signal, value => {
        if (alive) setResult({ ...value, query: q, project: currentProject });
      }).catch((error: Error) => {
        if (alive) setResult({ query: q, project: currentProject, issues: [], loading: false, error: error.message });
      });
    }, 220);
    return () => {
      alive = false;
      ctrl.abort();
      clearTimeout(t);
    };
  }, [q, currentProject, namespace]);

  const items: Item[] = useMemo(() => {
    if (!q) return recent.map((r) => ({ kind: 'issue' as const, ...r }));
    const lower = q.toLowerCase();
    const projs = projects
      .filter((p) => p.key.toLowerCase().includes(lower) || p.name.toLowerCase().includes(lower))
      .slice(0, 4)
      .map((p) => ({ kind: 'project' as const, key: p.key, name: p.name }));
    return isIssueKey(q) || /^\d+$/.test(q) ? [...found, ...projs] : [...projs, ...found];
  }, [q, recent, projects, found]);

  useEffect(() => setActive(0), [q, currentProject]);

  const choose = (it: Item | undefined) => {
    if (it?.kind === 'project') onOpenProject(it.key);
    else if (it) onOpenIssue(it.key);
    else if (isIssueKey(q)) onOpenIssue(q.toUpperCase()); // 搜索还没返回也能直接开
    else return;
    onClose();
  };

  return (
    <div className="modal-mask palette-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialogRef} tabIndex={-1} className="palette" role="dialog" aria-modal="true" aria-label="快速跳转">
        <input
          className="palette-input"
          autoFocus
          role="combobox"
          aria-expanded={items.length > 0}
          aria-controls={listId}
          aria-activedescendant={items[active] ? `${listId}-${active}` : undefined}
          placeholder={currentProject ? `搜索 ${currentProject} 的编号、尾号或标题，也可输入项目名切换` : '搜索问题编号、尾号或标题，完整编号可直接打开'}
          value={text}
          maxLength={160}
          onChange={(e) => { setText(e.target.value); setActive(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              const next = Math.max(0, Math.min(active + 1, items.length - 1));
              setActive(next); listRef.current?.querySelector(`[data-idx="${next}"]`)?.scrollIntoView({ block: 'nearest' });
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              const next = Math.max(active - 1, 0);
              setActive(next); listRef.current?.querySelector(`[data-idx="${next}"]`)?.scrollIntoView({ block: 'nearest' });
            } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              choose(items[active]);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
        />
        <ul className="palette-list" role="listbox" id={listId} ref={listRef}>
          {!q && <li className="palette-head">{recent.length ? '最近查看' : '还没有查看记录，输入编号或关键字开始'}</li>}
          {items.map((it, idx) => (
            <li
              key={`${it.kind}:${it.key}`}
              id={`${listId}-${idx}`}
              data-idx={idx}
              role="option"
              aria-selected={idx === active}
              onMouseMove={() => setActive(idx)}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(it);
              }}
            >
              {it.kind === 'project' ? (
                <>
                  <span className="palette-tag">切换项目</span>
                  <span className="summary">{it.name}</span>
                  <span className="mono muted">{it.key}</span>
                </>
              ) : (
                <>
                  {it.type && <TypeBadge type={it.type} />}
                  <span className="mono muted">{it.key}</span>
                  <span className="summary">{it.summary}</span>
                  {it.status && <StatusPill status={it.status} />}
                </>
              )}
            </li>
          ))}
          {q && !ready && <li className="palette-head" role="status">搜索中…{isIssueKey(q) ? `回车可直接打开 ${q.toUpperCase()}` : ''}</li>}
          {q && ready && result.note && <li className="palette-head" role="status">{result.note}</li>}
          {q && ready && result.error && <li className="palette-head err" role="alert">{result.error}</li>}
          {q && ready && !result.loading && !result.error && !items.length && (
            <li className="palette-head">{isIssueKey(q) ? `回车直接打开 ${q.toUpperCase()}` : '没有匹配的问题'}</li>
          )}
        </ul>
        <footer className="palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
          <span><kbd>↵</kbd> 打开</span>
          <span><kbd>Esc</kbd> 关闭</span>
        </footer>
      </div>
    </div>
  );
}
