import { api, ApiError } from './api';
import { isIssueKey, issueSearchJql, quote, quoteList } from './jql';
import type { Issue } from './types';

export interface IssueSuggestions { issues: Issue[]; loading: boolean; note?: string; error?: string }
interface CandidateIndex { issues: Issue[]; offset: number; total: number; complete: boolean; at: number }
const INDEX_LIMIT = 1000;
const INDEX_TTL = 300_000;
const FIELDS = ['summary', 'status', 'issuetype'];
const keyIndexes = new Map<string, CandidateIndex>();
const titleIndexes = new Map<string, CandidateIndex>();
const titleLoads = new Map<string, Promise<void>>();

/** 标题按连续片段匹配，不依赖 Lucene 的中文分词；空格分隔的多个片段必须同时出现。 */
export function titleMatches(summary: string, query: string): boolean {
  const title = summary.normalize('NFKC').toLocaleLowerCase();
  const terms = query.normalize('NFKC').toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return terms.length > 0 && terms.every(term => title.includes(term));
}

function indexFor(map: Map<string, CandidateIndex>, key: string): CandidateIndex {
  let index = map.get(key);
  if (!index || Date.now() - index.at >= INDEX_TTL) {
    index = { issues: [], offset: 0, total: 0, complete: false, at: Date.now() };
    map.delete(key); map.set(key, index);
    while (map.size > 8) map.delete(map.keys().next().value!);
  }
  return index;
}

if (typeof window !== 'undefined') window.addEventListener('wb-session-ended', () => { keyIndexes.clear(); titleIndexes.clear(); titleLoads.clear(); });

function waitForTitleLoad(loading: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    loading.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** 同范围共享当前页的读取；一个关键词取消不会取消另一个关键词正在使用的页面。 */
async function loadTitlePage(cacheKey: string, scope: string | null, signal: AbortSignal, publish: () => void) {
  const index = indexFor(titleIndexes, cacheKey);
  const existing = titleLoads.get(cacheKey);
  if (existing) { await waitForTitleLoad(existing, signal); return; }
  const scopeJql = scope ? `project = ${quote(scope)}` : '';
  const loading = (async () => {
    signal.throwIfAborted();
    const revision = (await api.cacheStatus(scope || '', signal)).revision;
    // 已停用的缓存即使页码尚未完成，也不能接到另一代数据后面。
    if (Date.now() - index.at >= INDEX_TTL) throw new Error('标题索引已过期，请重新搜索');
    const page = await api.search(`${scopeJql} ORDER BY updated DESC, key ASC`, { fields: FIELDS, startAt: index.offset, maxResults: Math.min(500, INDEX_LIMIT - index.offset), background: true, feedback: 'local' }, signal);
    signal.throwIfAborted();
    if (!page.issues.length && index.offset < page.total) throw new Error('Jira 标题分页提前结束');
    index.issues.push(...page.issues); index.offset += page.issues.length; index.total = page.total;
    index.complete = index.offset >= page.total || index.offset >= INDEX_LIMIT; index.at = Date.now();
    const current = await api.cacheStatus(scope || '', signal);
    if (current.revision !== revision) {
      titleIndexes.delete(cacheKey);
      throw new Error('读取期间问题已变更，请重新搜索');
    }
    signal.throwIfAborted();
    publish();
  })();
  titleLoads.set(cacheKey, loading);
  try { await waitForTitleLoad(loading, signal); }
  finally { if (titleLoads.get(cacheKey) === loading) titleLoads.delete(cacheKey); }
}

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
  let first = await api.search(issueSearchJql(q, project), { fields: FIELDS, maxResults: 15, feedback: 'local' }, signal);
  signal.throwIfAborted();
  if (!digits) first = { ...first, issues: first.issues.filter(issue => titleMatches(issue.fields.summary, q)) };
  let issues = [...new Map([...exactIssues, ...first.issues].map(issue => [issue.key, issue])).values()];
  const rank = (issue: Issue) => {
    if (issue.key === exact) return 0;
    if (digits) return issue.key.split('-').at(-1)?.startsWith(digits) ? 1 : issue.key.includes(digits) ? 2 : 3;
    const title = issue.fields.summary.normalize('NFKC').toLocaleLowerCase(), normalized = q.normalize('NFKC').toLocaleLowerCase();
    if (titleMatches(title, q)) return title === normalized ? 1 : title.startsWith(normalized) ? 2 : 3;
    return 4;
  };
  const result = (extra: Partial<IssueSuggestions> = {}) => publish({ issues: [...issues].sort((a, b) => rank(a) - rank(b)).slice(0, 15), loading: false, ...extra });
  const merge = (additional: Issue[]) => { issues = [...new Map([...issues, ...additional].map(issue => [issue.key, issue])).values()]; };
  if (!digits || !scope || digits.length < 3) {
    if (digits) {
      result({ note: scope ? '编号支持精确与前缀匹配；输入至少 3 位数字可补充编号包含匹配' : '选择具体项目后可按数字查询编号；完整编号可跨项目打开' });
      return;
    }
    const cacheKey = JSON.stringify([namespace, scope]);
    const index = indexFor(titleIndexes, cacheKey);
    const note = (loading: boolean) => loading ? `正在补充标题模糊匹配，已读取 ${index.offset} 项…` : index.total > index.offset ? `标题模糊匹配覆盖最近 ${index.offset} / ${index.total} 项；可输入完整编号直接打开` : undefined;
    if (index.complete || index.offset >= INDEX_LIMIT) { merge(index.issues.filter(issue => titleMatches(issue.fields.summary, q))); result({ note: note(false) }); return; }
    result({ loading: true, note: note(true) });
    try {
      while (!index.complete && index.offset < INDEX_LIMIT) {
        await loadTitlePage(cacheKey, scope, signal, () => { merge(index.issues.filter(issue => titleMatches(issue.fields.summary, q))); result({ loading: true, note: note(true) }); });
      }
      merge(index.issues.filter(issue => titleMatches(issue.fields.summary, q)));
      result({ note: note(false) });
    } catch (error) {
      if (signal.aborted) throw error;
      result({ error: `标题模糊匹配未完成：${(error as Error).message}。当前结果可能不完整，请重试` });
    }
    return;
  }
  result({ loading: true, note: '前缀与标题结果已就绪，正在补充编号包含匹配…' });
  try {
    const key = JSON.stringify([namespace, scope]);
    const index = indexFor(keyIndexes, key);
    while (!index.complete && index.offset < INDEX_LIMIT) {
      const page = await api.search(`project = ${quote(scope)} ORDER BY updated DESC, key ASC`, { fields: ['key'], startAt: index.offset, maxResults: Math.min(500, INDEX_LIMIT - index.offset), background: true, feedback: 'local' }, signal);
      signal.throwIfAborted();
      if (!page.issues.length && index.offset < page.total) throw new Error('Jira 编号分页提前结束');
      index.issues.push(...page.issues);
      index.offset += page.issues.length; index.total = page.total; index.complete = index.offset >= page.total;
      result({ loading: true, note: `正在补充编号包含匹配，已检查 ${index.offset} 项…` });
    }
    const known = new Set(issues.map(issue => issue.key));
    const matching = [...new Set(index.issues.map(issue => issue.key))].filter(key => key.split('-').at(-1)?.includes(digits) && !known.has(key)).slice(0, 15);
    if (matching.length) {
      const extra = await api.search(`project = ${quote(scope)} AND key in ${quoteList(matching)} ORDER BY updated DESC`, { fields: FIELDS, maxResults: 15, feedback: 'local' }, signal);
      signal.throwIfAborted(); merge(extra.issues);
    }
    result({ note: !index.complete ? `编号包含匹配覆盖最近 ${index.offset} / ${index.total} 项；前缀与标题查询覆盖整个项目，完整编号可直接打开` : undefined });
  } catch (error) {
    if (signal.aborted) throw error;
    result({ error: `编号包含匹配未完成：${(error as Error).message}。当前仅展示前缀与标题结果` });
  }
}
