import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startServer, stopServer } from './index.mjs';

const dir = mkdtempSync(path.join(os.tmpdir(), 'wb-remember-login-'));
let url, baseUrl, hits = 0;
let waitForLogin;
const mock = http.createServer(async (req, res) => {
  const json = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (req.url !== '/rest/auth/1/session') return json({}, 404);
  if (req.method === 'POST') {
    hits++;
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (!['alice', 'bob'].includes(body.username) || body.password !== 'fake-only-secret') return json({}, 401);
    await waitForLogin?.();
    res.setHeader('Set-Cookie', 'JSESSIONID=fake');
    return json({ name: body.username });
  }
  return json({ name: 'alice' });
});
const start = async () => { ({ url } = await startServer({ jiraBaseUrl: baseUrl, port: 0, sessionDir: path.join(dir, 'session'), settingsFile: path.join(dir, 'settings.json') })); };
const login = (body, cookie = '', origin = url) => fetch(url + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin }, body: JSON.stringify(body) });
const savedCookie = response => response.headers.getSetCookie().find(value => value.startsWith('wb_remember='))?.split(';')[0] || '';
const readSaved = cookie => fetch(url + '/api/login/remembered', { headers: { Cookie: cookie, Origin: url } });
const save = async (extra = {}) => {
  const response = await login({ username: 'alice', password: 'fake-only-secret', rememberAccount: true, rememberPassword: true, ...extra });
  expect(response.status).toBe(200);
  return savedCookie(response);
};

beforeAll(async () => {
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${mock.address().port}`;
  await start();
});
afterAll(async () => { await stopServer(); await new Promise(resolve => mock.close(resolve)); rmSync(dir, { recursive: true, force: true }); });

it('登录成功才保存，读取仅返回账号和保存标志；cookie不可被脚本读取', async () => {
  const failed = await login({ username: 'alice', password: 'wrong', rememberAccount: true, rememberPassword: true });
  expect(failed.status).toBe(401); expect(savedCookie(failed)).toBe('');
  const response = await login({ username: 'alice', password: 'fake-only-secret', rememberAccount: true, rememberPassword: true });
  const cookie = savedCookie(response);
  expect(cookie).toMatch(/^wb_remember=[a-f0-9]{64}$/);
  expect(response.headers.getSetCookie().find(value => value.startsWith('wb_remember='))).toContain('HttpOnly; SameSite=Strict');
  const result = await readSaved(cookie);
  expect(result.headers.get('Cache-Control')).toBe('no-store');
  expect(await result.json()).toEqual({ available: true, username: 'alice', passwordSaved: true });
  expect(await (await readSaved('')).json()).toEqual({ available: true, username: '', passwordSaved: false });
  expect(readFileSync(path.join(dir, 'session/remembered-login/logins.json'), 'utf8')).not.toContain('fake-only-secret');
});

it('重启后可用已保存密码登录；换账号必须重新输入，失败不会覆盖保存项', async () => {
  const cookie = await save();
  await stopServer(); await start();
  expect((await (await readSaved(cookie)).json()).passwordSaved).toBe(true);
  const before = hits;
  expect((await login({ username: 'bob', useSavedPassword: true }, cookie)).status).toBe(400);
  expect(hits).toBe(before);
  expect((await login({ username: 'alice', password: 'wrong', rememberAccount: true, rememberPassword: true }, cookie)).status).toBe(401);
  const restored = await login({ username: 'alice', useSavedPassword: true, rememberAccount: true, rememberPassword: true }, cookie);
  expect(restored.status).toBe(200);
});

it('可仅记住账号，取消记住密码后不再保留密码；清除只影响当前浏览器', async () => {
  const first = await save(), second = await save();
  expect((await login({ username: 'alice', useSavedPassword: true, rememberAccount: true, rememberPassword: false }, first)).status).toBe(200);
  expect(await (await readSaved(first)).json()).toEqual({ available: true, username: 'alice', passwordSaved: false });
  expect((await login({ username: 'alice', useSavedPassword: true }, first)).status).toBe(400);
  const cleared = await fetch(url + '/api/login/remembered', { method: 'DELETE', headers: { Cookie: first, Origin: url } });
  expect(cleared.status).toBe(200);
  expect(await (await readSaved(first)).json()).toEqual({ available: true, username: '', passwordSaved: false });
  expect((await (await readSaved(second)).json()).passwordSaved).toBe(true);
  expect((await login({ username: 'alice', useSavedPassword: true, rememberAccount: false, rememberPassword: false }, second)).status).toBe(200);
  expect((await (await readSaved(second)).json()).username).toBe('');
});

it('跨站不能读取、使用或清除保存项；错误参数不会调用Jira', async () => {
  const cookie = await save();
  const before = hits;
  expect((await login({ username: 'alice', useSavedPassword: true }, cookie, 'https://other.example')).status).toBe(403);
  for (const method of ['GET', 'DELETE']) {
    expect((await fetch(url + '/api/login/remembered', { method, headers: { Cookie: cookie, Origin: 'https://other.example' } })).status).toBe(403);
  }
  expect((await login({ username: 'alice', password: 'fake-only-secret', rememberPassword: 'yes' })).status).toBe(400);
  expect((await login(null)).status).toBe(400);
  expect(hits).toBe(before);
  expect((await (await readSaved(cookie)).json()).passwordSaved).toBe(true);
});

it('更换Jira地址不会把已保存密码发往新地址', async () => {
  const cookie = await save();
  const change = async jiraBaseUrl => fetch(url + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify({ jiraBaseUrl, llmBaseUrl: '', llmModel: '', llmApiKey: '' }) });
  try {
    expect((await change(baseUrl + '/other')).status).toBe(200);
    expect((await (await readSaved(cookie)).json()).passwordSaved).toBe(false);
    const before = hits;
    expect((await login({ username: 'alice', useSavedPassword: true }, cookie)).status).toBe(400);
    expect(hits).toBe(before);
  } finally { await change(baseUrl); }
});

it('登录过程中更换Jira地址会拒绝保存，保留原保存项且不创建本地会话', async () => {
  const cookie = await save();
  const before = readFileSync(path.join(dir, 'session/remembered-login/logins.json'), 'utf8');
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const received = new Promise(resolve => { started = resolve; });
  waitForLogin = () => { started(); return gate; };
  const change = jiraBaseUrl => fetch(url + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify({ jiraBaseUrl, llmBaseUrl: '', llmModel: '', llmApiKey: '' }) });
  const pending = login({ username: 'alice', useSavedPassword: true, rememberAccount: true, rememberPassword: true }, cookie);
  try {
    await received;
    expect((await change(baseUrl + '/other')).status).toBe(200);
    release();
    const result = await pending;
    expect(result.status).toBe(409);
    expect(result.headers.getSetCookie()).toEqual([]);
    expect(readFileSync(path.join(dir, 'session/remembered-login/logins.json'), 'utf8')).toBe(before);
  } finally { release(); waitForLogin = undefined; await change(baseUrl); }
});
