import { describe, expect, it } from 'vitest';
import { buildJql, isIssueKey, issueNumberJql, issueProjectJql, issueSearchJql, MINE_CLAUSE, quote } from './jql';

describe('quote', () => {
  it('转义引号和反斜杠', () => {
    expect(quote('a"b\\c')).toBe('"a\\"b\\\\c"');
  });
});

describe('buildJql', () => {
  it('组合项目/类型/模块并排序', () => {
    expect(buildJql({ project: 'YLZHXT', types: ['需求'], component: '01-综合收费' })).toBe(
      'project = "YLZHXT" AND issuetype in ("需求") AND component = "01-综合收费" ORDER BY updated DESC',
    );
  });

  it('问题编号走 key 精确匹配', () => {
    expect(isIssueKey('ylzhxt-123')).toBe(true);
    expect(buildJql({ text: 'ylzhxt-123' }, '')).toBe('key = "YLZHXT-123"');
  });

  it('关键字去掉 Lucene 特殊字符，防止 JQL 报错', () => {
    expect(buildJql({ text: '导出(excel) "报错"*' }, '')).toBe('summary ~ "导出 excel 报错"');
    expect(buildJql({ text: '  ***  ' }, '')).toBe('');
  });

  it('阶段展开为状态集合', () => {
    expect(buildJql({ stages: ['dev'] }, '')).toBe('status in ("开发中", "联调中", "处理中")');
  });

  it('近期已完成过滤', () => {
    expect(buildJql({ recentClosedDays: 30, closedStatuses: ['关闭'] }, '')).toBe(
      '(status not in ("关闭") OR updated >= -30d)',
    );
  });

  it('指定同事沿用经办、开发、测试任一匹配的口径，与项目条件同时生效', () => {
    expect(buildJql({ project: 'AA', people: ['zhangsan'] }, '')).toBe(
      'project = "AA" AND (assignee in ("zhangsan") OR cf[10204] in ("zhangsan") OR cf[10401] in ("zhangsan"))',
    );
    expect(buildJql({ onlyMine: true }, '')).toBe(MINE_CLAUSE);
  });

  it('具体人员优先于只看我的并安全转义用户名', () => {
    const jql = buildJql({ people: ['a"b\\c'], onlyMine: true }, '');
    expect(jql).toBe('(assignee in ("a\\"b\\\\c") OR cf[10204] in ("a\\"b\\\\c") OR cf[10401] in ("a\\"b\\\\c"))');
    expect(jql).not.toContain('currentUser()');
  });
  it('多个人员任一匹配，去重排序且不改变项目与其他条件的交集', () => {
    expect(buildJql({ project: 'AA', people: ['bob', 'alice', 'bob'], onlyMine: true }, '')).toBe('project = "AA" AND (assignee in ("alice", "bob") OR cf[10204] in ("alice", "bob") OR cf[10401] in ("alice", "bob"))');
    expect(buildJql({ people: [], onlyMine: true }, '')).toBe(MINE_CLAUSE);
  });
});

describe('issueNumberJql', () => {
  it('覆盖不同长度的编号前缀，不会只查询九位数', () => {
    const jql = issueNumberJql('123', 'test');
    const ranges = [...jql.matchAll(/key >= "TEST-(\d+)" AND key <= "TEST-(\d+)"/g)].map(([, low, high]) => [BigInt(low), BigInt(high)]);
    const matches = (n: bigint) => n === 123n || ranges.some(([low, high]) => low <= n && n <= high);
    for (const n of [123n, 1234n, 12345n, 123456789n, 123456789012n]) expect(matches(n)).toBe(true);
    for (const n of [12n, 124n, 1123n, 1240n, 12300n - 1n]) expect(matches(n)).toBe(false);
    expect(jql).toContain('project = "TEST"');
    expect(jql).toContain('key = "TEST-123"');
    expect(issueNumberJql('TEST-123')).toBe(jql);
  });

  it('不将标题或超出支持范围的数字当作编号查询', () => {
    expect(issueNumberJql('123')).toBe('');
    expect(issueNumberJql('导出报表', 'TEST')).toBe('');
    expect(issueNumberJql('0', 'TEST')).toBe('');
    expect(issueNumberJql('99999999999999999999', 'TEST')).toBe('');
  });

  it('项目前缀只列出对应项目，标题输入不受影响', () => {
    expect(issueProjectJql('TEST-')).toBe('project = "TEST" ORDER BY updated DESC');
    expect(issueProjectJql('OTHER-')).toBe('project = "OTHER" ORDER BY updated DESC');
    expect(issueProjectJql('标题')).toBe('');
  });

  it('数字查询的标题分支同样限制项目，完整编号提供前缀候选', () => {
    expect(issueSearchJql('123', 'AA')).toContain('OR (project = "AA" AND summary ~ "123")');
    expect(issueSearchJql('BB-12', 'AA')).toContain('project = "BB"');
    expect(issueSearchJql('BB-12', 'AA')).not.toContain('project = "AA"');
    expect(issueSearchJql('BB-12', 'AA')).toContain('key >= "BB-120"');
    expect(issueSearchJql('报表', 'AA')).toBe('project = "AA" AND summary ~ "报表" ORDER BY updated DESC');
  });
});
