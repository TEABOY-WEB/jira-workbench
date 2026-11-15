import { api, ApiError } from './api';
import { isIssueKey, issueSearchJql, quote, quoteList } from './jql';
import type { Issue } from './types';

export interface IssueSuggestions { issues: Issue[]; loading: boolean; note?: string; error?: string }
interface KeyIndex { keys: string[]; offset: number; total: number; complete: boolean; at: number }
const indexes = new Map<string, KeyIndex>();
const INDEX_LIMIT = 1000;
const INDEX_TTL = 300_000;
const FIELDS = ['summary', 'status', 'issuetype'];
if (typeof window !== 'undefined') window.addEventListener('wb-session-ended', () => indexes.clear());

/** Jira 6 无编号子串查询。先展示前缀/标题命中，再用有界、可取消的轻量编号索引补充包含匹配。 */
export async function searchIssueSuggestions(query: string, project: string | null, namespace: string, signal: AbortSignal, publish: (value: IssueSuggestions) => void) {
  const q = query.trim();
  const numeric = /^(?:([A-Za-z][A-Za-z0-9_]*)-)?(\d+)$/.exec(q);
  const scope = numeric?.[1]?.toUpperCase() || project;
  const digits = numeric?.[2];
  const exact = isIssueKey(q) ? q.toUpperCase() : digits && scope ? `${scope}-${BigInt(digits)}` : '';
  let exactIssues: Issue[] = [];
  if (exact) {
    try {
      exactIssues = (await api.search(`key = ${quote(exact)}`, { fields: FIELDS, maxResults: 1, feedback: 'local' }, signal)).issues;
      signal.throwIfAborted();
      if (exactIssues.length) publish({ issues: exactIssues, loading: true, note: '已找到精确编号，正在查询其他候选…' });
    } catch (error) {
      // 某些 Jira 6 对不存在或无权查看的完整编号返回 400/404；仍需查前缀候选。
      if (!(error instanceof ApiError) || ![400, 404].includes(error.status)) throw error;
    }
  }
  const first = await api.search(issueSearchJql(q, project), { fields: FIELDS, maxResults: 15, feedback: 'local' }, signal);
  signal.throwIfAborted();
  let issues = [...new Map([...exactIssues, ...first.issues].map(issue => [issue.key, issue])).values()];
  const rank = (issue: Issue) => issue.key === exact ? 0 : digits && issue.key.split('-').at(-1)?.startsWith(digits) ? 1 : digits && issue.key.includes(digits) ? 2 : 3;
  const result = (extra: Partial<IssueSuggestions> = {}) => publish({ issues: [...issues].sort((a, b) => rank(a) - rank(b)).slice(0, 15), loading: false, ...extra });
  if (!digits || !scope || digits.length < 3) {
    result({ note: digits ? scope ? '编号支持精确与前缀匹配；输入至少 3 位数字可补充编号包含匹配' : '选择具体项目后可按数字查询编号；完整编号可跨项目打开' : undefined });
    return;
  }
  result({ loading: true, note: '前缀与标题结果已就绪，正在补充编号包含匹配…' });
  try {
    const key = JSON.stringify([namespace, scope]);
    let index = indexes.get(key);
    if (!index || Date.now() - index.at >= INDEX_TTL) {
      index = { keys: [], offset: 0, total: 0, complete: false, at: Date.now() };
      indexes.delete(key); indexes.set(key, index);
      while (indexes.size > 8) indexes.delete(indexes.keys().next().value!);
    }
    while (!index.complete && index.offset < INDEX_LIMIT) {
      const page = await api.search(`project = ${quote(scope)} ORDER BY updated DESC, key ASC`, { fields: ['key'], startAt: index.offset, maxResults: Math.min(500, INDEX_LIMIT - index.offset), background: true, feedback: 'local' }, signal);
      signal.throwIfAborted();
      if (!page.issues.length && index.offset < page.total) throw new Error('Jira 编号分页提前结束');
      index.keys.push(...page.issues.map(issue => issue.key));
      index.offset += page.issues.length; index.total = page.total; index.complete = index.offset >= page.total;
      result({ loading: true, note: `正在补充编号包含匹配，已检查 ${index.offset} 项…` });
    }
    const known = new Set(issues.map(issue => issue.key));
    const matching = [...new Set(index.keys)].filter(key => key.split('-').at(-1)?.includes(digits) && !known.has(key)).slice(0, 15);
    if (matching.length) {
      const extra = await api.search(`project = ${quote(scope)} AND key in ${quoteList(matching)} ORDER BY updated DESC`, { fields: FIELDS, maxResults: 15, feedback: 'local' }, signal);
      signal.throwIfAborted(); issues = [...issues, ...extra.issues];
    }
    result({ note: !index.complete ? `编号包含匹配覆盖最近 ${index.offset} / ${index.total} 项；前缀与标题查询覆盖整个项目，完整编号可直接打开` : undefined });
  } catch (error) {
    if (signal.aborted) throw error;
    result({ error: `编号包含匹配未完成：${(error as Error).message}。当前仅展示前缀与标题结果` });
  }
}
