import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRememberedLoginStore, REMEMBER_SECONDS } from './remembered-login.mjs';

const dirs = [];
const temp = () => { const dir = mkdtempSync(path.join(os.tmpdir(), 'wb-login-store-')); dirs.push(dir); return dir; };
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('本机记住登录', () => {
  it('加密保存并能重启读取，令牌只存摘要，权限为0600', () => {
    const dir = temp(), store = createRememberedLoginStore(dir);
    const token = store.save(null, 'https://jira.example', 'alice', 'test-only-password');
    const text = readFileSync(store.dataFile, 'utf8');
    expect(text).not.toContain('test-only-password'); expect(text).not.toContain(token);
    expect(createRememberedLoginStore(dir).get(token, 'https://jira.example')?.password).toBe('test-only-password');
    if (process.platform !== 'win32') {
      expect(statSync(store.dataFile).mode & 0o777).toBe(0o600);
      expect(statSync(path.join(dir, 'login.key')).mode & 0o777).toBe(0o600);
    }
  });
  it('按浏览器令牌和Jira地址隔离，更新或清除不影响其他浏览器', () => {
    const store = createRememberedLoginStore(temp());
    const a = store.save(null, 'https://jira-a', 'alice', 'password-a');
    const b = store.save(null, 'https://jira-a', 'bob', 'password-b');
    expect(store.get(a, 'https://jira-b')).toBeNull(); expect(store.get('invalid', 'https://jira-a')).toBeNull();
    store.save(a, 'https://jira-a', 'alice', 'updated');
    expect(store.get(a, 'https://jira-a')?.password).toBe('updated');
    store.forget(a); expect(store.get(a, 'https://jira-a')).toBeNull();
    expect(store.get(b, 'https://jira-a')?.username).toBe('bob');
  });
  it('90天过期；损坏文件或写入错误不伪装成成功', () => {
    const store = createRememberedLoginStore(temp());
    const token = store.save(null, 'https://jira', 'alice', 'fake');
    const at = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(at + REMEMBER_SECONDS * 1000 + 1);
    expect(store.get(token, 'https://jira')).toBeNull();
    writeFileSync(store.dataFile, '{bad');
    expect(() => store.get(token, 'https://jira')).toThrow();
    expect(() => store.forget(token)).toThrow();
    expect(() => store.save(token, 'https://jira', 'alice', 'new')).toThrow();
  });
});
