import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';
import { searchIssueSuggestions, type IssueSuggestions } from './issueSuggestions';
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

  it('不存在的完整编号仍可查询前缀；标题搜索只发一次请求', async () => {
    const search = vi.spyOn(api, 'search').mockRejectedValueOnce(new ApiError(400, 'issue does not exist')).mockResolvedValueOnce(page(['BB-123']));
    const values: IssueSuggestions[] = [];
    await searchIssueSuggestions('BB-12', 'AA', 'prefix-test', new AbortController().signal, value => values.push(value));
    expect(values.at(-1)?.issues[0].key).toBe('BB-123');
    expect(search.mock.calls[1][0]).not.toContain('project = "AA"');
    search.mockResolvedValueOnce(page(['AA-1']));
    await searchIssueSuggestions('导出报表', 'AA', 'title-test', new AbortController().signal, () => {});
    expect(search.mock.calls.at(-1)?.[0]).toBe('project = "AA" AND summary ~ "导出报表" ORDER BY updated DESC');
    expect(search).toHaveBeenCalledTimes(3);
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
