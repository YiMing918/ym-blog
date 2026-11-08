// hash.js — 密码哈希与校验（登录密码、文章密码共用）
// 背景（调研暗病 #1）：Workers 免费版每请求 CPU 只有 10ms，OWASP 推荐的强哈希参数在本平台跑不出来：
//   Argon2/bcrypt 不可用或必爆；WebCrypto PBKDF2 硬顶 10 万次、实测约 20–29ms。
// 本文件取设计稿的双轨折中：
//   主轨 scrypt（node:crypto 原生实现，需 wrangler.toml 开 nodejs_compat）低参数 N=16384/r=8/p=1
//   + 服务端 pepper（环境变量 PASSWORD_PEPPER，不入库）；
//   万一运行环境没有 node:crypto，自动降级 PBKDF2 10 万次（格式串里会标明算法，老记录可平滑迁移）。
// 存储格式：<algo>$<params>$<salt_b64>$<hash_b64>，将来升参数时登录成功可按新参数重哈希。
// 注意：会话令牌、恢复码、预览令牌这类「高熵随机值」不用慢哈希，用 SHA-256 即可（见 auth.js），别混。

import { createRequire } from 'node:module';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };
let nodeCrypto = null;
try {
  const require = createRequire(import.meta.url);
  nodeCrypto = require('node:crypto');
  if (typeof nodeCrypto.scrypt !== 'function') nodeCrypto = null;
} catch { nodeCrypto = null; }

const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64');

function scryptAsync(password, salt, keylen, params) {
  return new Promise((resolve, reject) => {
    nodeCrypto.scrypt(password, salt, keylen, params, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function withPepper(env, password) {
  const pepper = env && env.PASSWORD_PEPPER;
  return pepper ? password + '\x00' + pepper : password;
}

async function pbkdf2(password, salt, iterations, keylen) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, keylen * 8);
  return new Uint8Array(bits);
}

export async function hashPassword(env, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const input = withPepper(env, String(password));
  if (nodeCrypto) {
    const key = await scryptAsync(input, Buffer.from(salt), SCRYPT.keylen, SCRYPT);
    return `scrypt$${SCRYPT.N},${SCRYPT.r},${SCRYPT.p}$${b64(salt)}$${b64(key)}`;
  }
  const key = await pbkdf2(input, salt, 100000, 32);
  return `pbkdf2$100000$${b64(salt)}$${b64(key)}`;
}

export async function verifyPassword(env, password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  const input = withPepper(env, String(password));
  try {
    if (parts[0] === 'scrypt' && parts.length === 4) {
      if (!nodeCrypto) return false;
      const [N, r, p] = parts[1].split(',').map(Number);
      const salt = unb64(parts[2]);
      const expected = unb64(parts[3]);
      const key = await scryptAsync(input, salt, expected.length, { N, r, p, maxmem: SCRYPT.maxmem });
      return nodeCrypto.timingSafeEqual(Buffer.from(key), expected);
    }
    if (parts[0] === 'pbkdf2' && parts.length === 4) {
      const iterations = Number(parts[1]);
      const salt = unb64(parts[2]);
      const expected = unb64(parts[3]);
      const key = await pbkdf2(input, salt, iterations, expected.length);
      if (key.length !== expected.length) return false;
      let diff = 0;
      for (let i = 0; i < key.length; i++) diff |= key[i] ^ expected[i];
      return diff === 0;
    }
  } catch { return false; }
  return false;
}

// 恢复码：高熵随机，用 SHA-256+pepper 存哈希即可（校验快、可批量比对）
export async function hashSecret(env, value) {
  const pepper = (env && env.PASSWORD_PEPPER) || '';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pepper + '\x00' + String(value)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
