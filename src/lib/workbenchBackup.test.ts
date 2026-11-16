import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultCards, isAction, newCard, newWidget, validCards } from './workCards';
import { initialWorkbenchCards, makeBackup, readBackup, saveWorkbench, loadWorkbench } from './workbenchBackup';
const tools = { notes: [], todos: [] };
describe('工作台备份与刷新', () => {
  beforeEach(() => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) });
  });
  it('保存配置、200px尺寸、隐藏和功能卡片后按相同账号恢复', () => {
    const cards = [{ ...defaultCards()[0], height: 200, hidden: true }, newWidget('todos')];
    expect(saveWorkbench('https://jira', 'alice', cards, tools)).toBe(true);
    expect(loadWorkbench('https://jira', 'alice')).toEqual({ cards, tools });
    expect(loadWorkbench('https://jira', 'bob').cards).toBeNull();
  });
  it('备份格式严格限制，读取拒绝畸形 JSON 和额外字段', async () => {
    const file = new File([JSON.stringify(makeBackup([], tools))], 'backup.json');
    expect(await readBackup(file)).toEqual(makeBackup([], tools));
    await expect(readBackup(new File(['{}'], 'bad.json'))).rejects.toThrow('格式');
    await expect(readBackup(new File([JSON.stringify({ ...makeBackup([], tools), token: 'secret' })], 'bad.json'))).rejects.toThrow('格式');
  });
  it('导入数据大小受限', async () => {
    const file = new File(['x'], 'large.json'); Object.defineProperty(file, 'size', { value: 1_000_001 });
    await expect(readBackup(file)).rejects.toThrow('1 MB');
  });
  it('快捷新建只插入一次，保留原布局、尺寸和条件，删除或导入后不复活', () => {
    const old = [{ ...newCard({ title: '我的筛选', text: '接口', width: 3, height: 360 }), hidden: true }, newWidget('notes')];
    saveWorkbench('https://jira', 'alice', old, tools);
    const first = initialWorkbenchCards('https://jira', 'alice');
    expect(first).toHaveLength(3); expect(isAction(first[0])).toBe(true); expect(first.slice(1)).toEqual(old); expect(validCards(first)).toBe(true);
    expect(initialWorkbenchCards('https://jira', 'alice')).toEqual(first);
    saveWorkbench('https://jira', 'alice', old, tools);
    expect(initialWorkbenchCards('https://jira', 'alice')).toEqual(old);
    expect(initialWorkbenchCards('https://jira', 'bob').some(isAction)).toBe(true);
    expect(initialWorkbenchCards('https://another-jira', 'alice').some(isAction)).toBe(true);
  });
  it('已满20张不挤掉原卡片，删除空位后也不会擅自补卡', () => {
    const full = Array.from({ length: 20 }, () => newCard()); saveWorkbench('https://jira', 'alice', full, tools);
    expect(initialWorkbenchCards('https://jira', 'alice')).toEqual(full);
    saveWorkbench('https://jira', 'alice', full.slice(1), tools);
    expect(initialWorkbenchCards('https://jira', 'alice')).toEqual(full.slice(1));
  });
});
