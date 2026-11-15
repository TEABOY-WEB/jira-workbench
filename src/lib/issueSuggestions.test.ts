import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';
import { searchIssueSuggestions, titleMatches, type IssueSuggestions } from './issueSuggestions';
import type { Issue } from './types';

const issue = (key: string): Issue => ({ key, fields: { summary: key, issuetype: { name: '需求' }, status: { name: '新增' } } }) as Issue;
const page = (keys: string[], total = keys.length) => ({ issues: keys.map(issue), total, maxResults: 500, startAt: 0 });
afterEach(() => vi.restoreAllMocks());

describe('快速跳转候选', () => {
  it('精确编号即使很久未更新也优先保留，并补充前缀和编号包含匹配', async () => {
    const search = vi.spyOn(api, 'search')
      .mockResolvedValueOnce(page(['AA-123']))
      .mockResolvedValueOnce(page(['AA-1234', 'AA-3']))
      .mockResolvedValueOnce(page(['AA-123', 'AA-1123', 'AA-1234', 'AA-3']))
      .mockResolvedValueOnce(page(['AA-1123']));
    const updates: IssueSuggestions[] = [];
    await searchIssueSuggestions('123', 'AA', 'suffix-test', new AbortController().signal, value => updates.push(value));
    expect(updates[0].issues.map(i => i.key)).toEqual(['AA-123']);
    expect(updates.at(-1)?.issues.map(i => i.key)).toEqual(['AA-123', 'AA-1234', 'AA-1123', 'AA-3']);
    expect(search.mock.calls[1][0]).toContain('OR (project = "AA" AND summary ~ "123")');
    expect(search.mock.calls[2][1].fields).toEqual(['key']);
    expect(search.mock.calls[2][1].background).toBe(true);
    search.mockResolvedValueOnce(page(['AA-123'])).mockResolvedValueOnce(page(['AA-1234'])).mockResolvedValueOnce(page(['AA-1123']));
    await searchIssueSuggestions('123', 'AA', 'suffix-test', new AbortController().signal, () => {});
    expect(search.mock.calls.filter(([, opts]) => opts.fields[0] === 'key')).toHaveLength(1);
  });

  it('不存在的完整编号仍可查询前缀', async () => {
    const search = vi.spyOn(api, 'search').mockRejectedValueOnce(new ApiError(400, 'issue does not exist')).mockResolvedValueOnce(page(['BB-123']));
    const values: IssueSuggestions[] = [];
    await searchIssueSuggestions('BB-12', 'AA', 'prefix-test', new AbortController().signal, value => values.push(value));
    expect(values.at(-1)?.issues[0].key).toBe('BB-123');
    expect(search.mock.calls[1][0]).not.toContain('project = "AA"');
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('标题匹配连续中文片段、忽略英文字母大小写，空格分隔词需同时命中', () => {
    expect(titleMatches('【订单中心】缴费报表导出优化', '费报')).toBe(true);
    expect(titleMatches('【订单中心】缴费报表导出优化', '缴费 导出')).toBe(true);
    expect(titleMatches('【订单中心】缴费报表导出优化', '缴费 报表 缺失')).toBe(false);
    expect(titleMatches('LoginFormDialog', 'inform')).toBe(true);
    expect(titleMatches('全角ＡＰＰ升级', 'app')).toBe(true);
    expect(titleMatches('标题', '  ')).toBe(false);
  });

  it('标题只展示连续片段命中，并在后台补齐 Jira 分词漏掉的结果', async () => {
    const titled = (key: string, summary: string): Issue => ({ ...issue(key), fields: { ...issue(key).fields, summary } });
    const cacheStatus = vi.spyOn(api, 'cacheStatus').mockResolvedValue({ revision: 'same' });
    const search = vi.spyOn(api, 'search').mockImplementation(async (jql) => {
      if (jql.includes('summary ~')) return { ...page(['AA-1']), issues: [titled('AA-1', '缴费报表优化'), titled('AA-2', '无关标题')] };
      return { ...page([]), issues: [titled('AA-3', '【订单中心】缴费报表导出优化'), titled('AA-4', '缴费 报表 缺失')] };
    });
    const values: IssueSuggestions[] = [];
    await searchIssueSuggestions('费报', 'AA', 'chinese-title', new AbortController().signal, value => values.push(value));
    expect(values[0].issues.map(issue => issue.key)).toEqual(['AA-1']);
    expect(values.at(-1)?.issues.map(issue => issue.key)).toEqual(['AA-1', 'AA-3']);
    expect(search.mock.calls[1][1]).toMatchObject({ fields: ['summary', 'status', 'issuetype'], background: true });
    expect(cacheStatus).toHaveBeenCalledWith('AA', expect.any(AbortSignal));
    await searchIssueSuggestions('报表 缺失', 'AA', 'chinese-title', new AbortController().signal, value => values.push(value));
    expect(values.at(-1)?.issues.map(issue => issue.key)).toEqual(['AA-4']);
    expect(search.mock.calls.filter(([jql]) => !jql.includes('summary ~'))).toHaveLength(1);
  });

  it('标题补页有范围提示，失败保留已命中结果；数据变更不会使用混合索引', async () => {
    const titled = (key: string, summary: string): Issue => ({ ...issue(key), fields: { ...issue(key).fields, summary } });
    vi.spyOn(api, 'cacheStatus').mockResolvedValue({ revision: 'stable' });
    const search = vi.spyOn(api, 'search')
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce({ ...page([], 1500), issues: [titled('AA-5', '订单缴费报表'), ...Array.from({ length: 999 }, (_, index) => titled(`AA-${index + 6}`, '其他标题'))] });
    const values: IssueSuggestions[] = [];
    await searchIssueSuggestions('费报', 'AA', 'limited-title', new AbortController().signal, value => values.push(value));
    expect(values.at(-1)).toMatchObject({ loading: false });
    expect(values.at(-1)?.issues.map(issue => issue.key)).toEqual(['AA-5']);
    expect(values.at(-1)?.note).toContain('最近 1000 / 1500');

    search.mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce({ ...page([], 1500), maxResults: 1, issues: [titled('BB-5', '订单缴费报表')] })
      .mockResolvedValueOnce({ ...page([], 1500), maxResults: 500, issues: [titled('BB-6', '订单缴费报表续期')] })
      .mockRejectedValueOnce(new Error('Jira busy'));
    await searchIssueSuggestions('订单', 'BB', 'failed-title', new AbortController().signal, value => values.push(value));
    expect(values.at(-1)?.error).toContain('Jira busy');
    expect(search.mock.calls.filter(([jql]) => jql.startsWith('project = "BB" ORDER')).map(([, options]) => options.startAt)).toEqual([0, 1, 2]);

    vi.mocked(api.cacheStatus).mockResolvedValueOnce({ revision: 'old' }).mockResolvedValueOnce({ revision: 'new' });
    search.mockResolvedValueOnce(page([])).mockResolvedValueOnce({ ...page([]), issues: [titled('BB-1', '订单缴费报表')] });
    await searchIssueSuggestions('费报', 'BB', 'changed-title', new AbortController().signal, value => values.push(value));
    expect(values.at(-1)?.error).toContain('问题已变更');
  });

  it('输入取消后标题查询立即停止，已共享的页面仍可被后续关键词复用', async () => {
    const ctrl = new AbortController();
    vi.spyOn(api, 'cacheStatus').mockResolvedValue({ revision: 'same' });
    let finish: (() => void) | undefined;
    const search = vi.spyOn(api, 'search').mockResolvedValueOnce(page([])).mockImplementationOnce(async () => {
      ctrl.abort(); return page([]);
    });
    const publish = vi.fn();
    await expect(searchIssueSuggestions('订单', 'AA', 'cancel-title', ctrl.signal, publish)).rejects.toMatchObject({ name: 'AbortError' });
    expect(publish).toHaveBeenCalledTimes(1);
    search.mockResolvedValueOnce(page([])).mockImplementationOnce(async () => new Promise(resolve => { finish = () => resolve(page([])); }));
    const sharedController = new AbortController();
    const first = searchIssueSuggestions('订单', 'AA', 'shared-title', sharedController.signal, () => {}).catch(() => {});
    const second = searchIssueSuggestions('报表', 'AA', 'shared-title', new AbortController().signal, () => {});
    finish?.();
    await Promise.all([first, second]);
    expect(search.mock.calls.filter(([jql]) => !jql.includes('summary ~'))).toHaveLength(2);
  });

  it('受限的编号包含匹配明确说明范围，索引失败保留当前查询的正常结果并提示', async () => {
    const search = vi.spyOn(api, 'search').mockResolvedValueOnce(page([])).mockResolvedValueOnce(page(['AA-555']))
      .mockResolvedValueOnce(page(Array.from({ length: 500 }, (_, i) => `AA-${i + 10000}`), 2000))
      .mockResolvedValueOnce(page(Array.from({ length: 500 }, (_, i) => `AA-${i + 20000}`), 2000))
      .mockImplementation(async () => { throw new Error('Jira busy'); });
    const values: IssueSuggestions[] = [];
    await searchIssueSuggestions('555', 'AA', 'limited-test', new AbortController().signal, value => values.push(value));
    expect(values.at(-1)?.note).toContain('最近 1000 / 2000');
    search.mockResolvedValueOnce(page([])).mockResolvedValueOnce(page(['AA-999'])).mockRejectedValueOnce(new Error('Jira busy'));
    await searchIssueSuggestions('999', 'AA', 'error-test', new AbortController().signal, value => values.push(value));
    expect(values.at(-1)?.error).toContain('Jira busy');
    expect(values.at(-1)?.issues[0].key).toBe('AA-999');
  });

  it('取消后不发布结果也不发起后续索引；不同身份不共享编号索引', async () => {
    const ctrl = new AbortController();
    const search = vi.spyOn(api, 'search').mockImplementationOnce(async () => { ctrl.abort(); return page(['AA-123']); });
    const publish = vi.fn();
    await expect(searchIssueSuggestions('123', 'AA', 'abort-test', ctrl.signal, publish)).rejects.toMatchObject({ name: 'AbortError' });
    expect(publish).not.toHaveBeenCalled(); expect(search).toHaveBeenCalledOnce();
    for (const name of ['identity-a', 'identity-b']) {
      search.mockResolvedValueOnce(page([])).mockResolvedValueOnce(page([])).mockResolvedValueOnce(page([]));
      await searchIssueSuggestions('123', 'AA', name, new AbortController().signal, () => {});
    }
    expect(search.mock.calls.filter(([, opts]) => opts.fields[0] === 'key')).toHaveLength(2);
  });
});
