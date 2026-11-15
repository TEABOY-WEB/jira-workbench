// 密码只在本机代理内使用，不通过读取接口返回给页面。随机设备令牌放在 HttpOnly cookie 中。
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decrypt, encrypt } from './sessionStore.mjs';

export const REMEMBER_SECONDS = 90 * 24 * 60 * 60;
const validToken = token => typeof token === 'string' && /^[a-f0-9]{64}$/.test(token);
const digest = token => createHash('sha256').update(token).digest('hex');
const fail = message => Object.assign(new Error(message), { status: 500 });

function writePrivate(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, value, { mode: 0o600 });
  renameSync(temp, file);
  if (process.platform !== 'win32') chmodSync(file, 0o600);
}

/** 与登录会话分开存放；写入失败必须明确报错，不能宣称记住/清除成功。 */
export function createRememberedLoginStore(dir) {
  const keyFile = path.join(dir, 'login.key'), dataFile = path.join(dir, 'logins.json');
  function key() {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (existsSync(keyFile)) {
      const value = Buffer.from(readFileSync(keyFile, 'utf8'), 'base64');
      if (value.length !== 32) throw fail('已保存密码的密钥损坏，请清除本机登录保存文件后重试');
      return value;
    }
    if (existsSync(dataFile)) throw fail('已保存密码的密钥缺失，请清除本机登录保存文件后重试');
    const value = randomBytes(32);
    writePrivate(keyFile, value.toString('base64'));
    return value;
  }
  function read() {
    if (!existsSync(dataFile)) return [];
    const list = JSON.parse(decrypt(key(), JSON.parse(readFileSync(dataFile, 'utf8'))));
    if (!Array.isArray(list)) throw fail('已保存密码的文件格式错误');
    return list.filter(item => item && typeof item.id === 'string' && typeof item.baseUrl === 'string' && typeof item.username === 'string' && typeof item.password === 'string' && Number.isFinite(item.expiresAt) && item.expiresAt > Date.now());
  }
  function write(list) { writePrivate(dataFile, JSON.stringify(encrypt(key(), JSON.stringify(list)))); }
  return {
    dataFile,
    get(token, baseUrl) {
      if (!validToken(token)) return null;
      return read().find(item => item.id === digest(token) && item.baseUrl === baseUrl) ?? null;
    },
    save(token, baseUrl, username, password) {
      const nextToken = validToken(token) ? token : randomBytes(32).toString('hex');
      const id = digest(nextToken);
      const list = read().filter(item => item.id !== id);
      list.push({ id, baseUrl, username, password, expiresAt: Date.now() + REMEMBER_SECONDS * 1000 });
      write(list);
      return nextToken;
    },
    forget(token) {
      if (!validToken(token) || !existsSync(dataFile)) return;
      write(read().filter(item => item.id !== digest(token)));
    },
  };
}
