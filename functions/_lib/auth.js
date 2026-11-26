// auth.js — 会话签发/校验/吊销、Cookie 读写、CSRF 头校验、初始站长与登录锁定
// 会话令牌：明文只进 Cookie，库里只存 SHA-256（库泄露≠会话被盗）。
// 写接口除 Cookie 外还要带 X-Requested-With: fetch 头（CSRF 双保险，配合 SameSite=Lax）。

import { run, first, all } from './db.js';
import { nowSec, sha256Hex, unauthorized, HttpError, ipHash } from './http.js';
import { hashPassword, hashSecret } from './hash.js';

export const SESSION_COOKIE = 'bk_session';
const SESSION_TTL = 7 * 24 * 3600; // 7 天绝对过期（原 30 天，Peter 2026-11-19 拍板改短）

export function readCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) { try { return decodeURIComponent(v.join('=')); } catch { return v.join('='); } }
  }
  return null;
}

export function sessionCookieHeader(token, maxAge = SESSION_TTL) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
export function clearCookieHeader() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function createSession(env, request, userId) {
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const tokenHash = await sha256Hex(token);
  const t = nowSec();
  await run(env, 'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, ip_hash, ua) VALUES (?, ?, ?, ?, ?, ?, ?)',
    tokenHash, userId, t, t + SESSION_TTL, t, await ipHash(env, request), (request.headers.get('user-agent') || '').slice(0, 200));
  return token;
}

export async function getSessionUser(env, request) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await first(env, 'SELECT s.user_id, s.expires_at, s.last_seen_at, u.username, u.role FROM sessions s JOIN admin_users u ON u.id = s.user_id WHERE s.token_hash = ?', tokenHash);
  if (!row) return null;
  const t = nowSec();
  if (row.expires_at <= t) {
    await run(env, 'DELETE FROM sessions WHERE token_hash = ?', tokenHash);
    return null;
  }
  // 最后活跃时间：旧版只读不写，后台会话列表里永远等于登录时间。
  // 节流到 1 小时才回写一次，避免每个请求都烧一次 D1 写。
  if ((row.last_seen_at || 0) < t - 3600) {
    await run(env, 'UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?', t, tokenHash).catch(() => {});
  }
  return { id: row.user_id, username: row.username, role: row.role };
}

export async function requireAdmin(env, request) {
  const user = await getSessionUser(env, request);
  if (!user) throw unauthorized();
  // role 校验（中1）：role 是预留字段，只认 owner/admin，其余一律不当站长。
  // 改成失败即关（fail-closed）：旧写法带 user.role && 前置，role 为空时
  // 会直接放行——本站 schema 里 role 是 NOT NULL DEFAULT 'owner'、所有
  // 建号路径都不写 role（走默认 owner），线上不存在空 role，所以收紧
  // 不影响任何真实账号，只是把门禁从「靠 schema 兜底」改成「代码本身关死」。
  if (!['owner', 'admin'].includes(user.role)) {
    throw new HttpError('forbidden', '账号角色无权访问后台', 403);
  }
  return user;
}

// CSRF 双保险：站长写接口必须带此头（浏览器跨站表单带不上自定义头）
export function requireCsrf(request) {
  if (request.headers.get('x-requested-with') !== 'fetch') {
    throw new HttpError('csrf', '缺少 X-Requested-With 头', 403);
  }
}

export async function revokeSession(env, request) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await run(env, 'DELETE FROM sessions WHERE token_hash = ?', await sha256Hex(token));
}
export async function revokeAllSessions(env, userId) {
  await run(env, 'DELETE FROM sessions WHERE user_id = ?', userId);
}
export async function listSessions(env, userId) {
  return all(env, 'SELECT id, created_at, expires_at, last_seen_at, ua FROM sessions WHERE user_id = ? ORDER BY created_at DESC', userId);
}

// ---- 初始站长：环境变量注入（INITIAL_ADMIN_USERNAME/PASSWORD）或首次初始化流程 ----
// 仓库代码内绝不写真实账号密码；这里只是「有注入才建号」的读取逻辑。
export async function ensureInitialAdmin(env) {
  const existing = await first(env, 'SELECT id FROM admin_users LIMIT 1');
  if (existing) return false;
  // fail-closed（高危余项）：未配 SETUP_TOKEN 时不许用环境变量路径建号，与页面 setup 同门
  if (!env.SETUP_TOKEN) return false;
  const username = env.INITIAL_ADMIN_USERNAME;
  const password = env.INITIAL_ADMIN_PASSWORD;
  if (!username || !password) return false;
  const hash = await hashPassword(env, password);
  const t = nowSec();
  await run(env, 'INSERT INTO admin_users (username, password_hash, password_updated_at, created_at) VALUES (?, ?, ?, ?)',
    String(username).slice(0, 64), hash, t, t);
  return true;
}
export async function needsSetup(env) {
  await ensureInitialAdmin(env);
  const existing = await first(env, 'SELECT id FROM admin_users LIMIT 1');
  return !existing;
}
export async function createAdminUser(env, username, password) {
  const hash = await hashPassword(env, password);
  const t = nowSec();
  // 原子建号：INSERT ... SELECT ... WHERE NOT EXISTS——并发的首访请求
  // 只有一个能插入，其余 changes=0 返回 null（旧版先查后插有竞态窗口，
  // 极端情况下会建出两个站长；2026-11-13 三方审查 B#10）。
  const r = await run(env, `INSERT INTO admin_users (username, password_hash, password_updated_at, created_at)
    SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM admin_users)`,
    String(username).slice(0, 64), hash, t, t);
  if (!r.meta.changes) return null;
  return r.meta.last_row_id;
}

// ---- 登录锁定（双轨之一：失败锁定，同 IP 另走 rate_limits）----
// 规则：连错 5 次锁 15 分钟；再犯指数退避 30/60/120…分钟（上限 24 小时）。
// 计数键由调用方给「用户名|IP哈希」组合（login_guards.username 列存的就是
// 这个键）：旧版只按用户名计数，而站长用户名会随评论回复公开，任何人连错
// 5 次就能把站长锁在后台外（2026-11-13 三方审查 B#9）。组合键下，攻击者
// 只能锁住自己那个 IP 对该账号的尝试，换 IP 重新计数、仍受 IP 限流约束。
export async function loginLockState(env, username) {
  const g = await first(env, 'SELECT fail_streak, locked_until FROM login_guards WHERE username = ?', username);
  if (!g) return { locked: false, remainSec: 0, streak: 0 };
  const remain = (g.locked_until || 0) - nowSec();
  return { locked: remain > 0, remainSec: Math.max(0, remain), streak: g.fail_streak || 0 };
}
export async function recordLoginFail(env, username) {
  // 原子自增（C-19）：旧版先 SELECT 旧 streak、在 JS 里 +1 再整行覆写——
  // 并发失败请求会读到同一个旧值、互相覆盖，计数少算、锁定被推迟。现照
  // ratelimit.js hitLimit 的写法：单条 UPSERT 里由数据库做
  // fail_streak = fail_streak + 1，locked_until 用 CASE 按「新 streak」
  // 同步算（阈值/退避口径与旧版逐字一致：≥5 次起锁，15 分钟起指数翻倍、
  // 上限 24 小时；CASE 展开代替 pow()，不依赖 SQLite 数学函数可用性）。
  const t = nowSec();
  await run(env, `INSERT INTO login_guards (username, fail_streak, locked_until) VALUES (?, 1, 0)
    ON CONFLICT(username) DO UPDATE SET
      fail_streak = login_guards.fail_streak + 1,
      locked_until = CASE
        WHEN login_guards.fail_streak + 1 < 5 THEN 0
        WHEN login_guards.fail_streak + 1 = 5 THEN ? + 900
        WHEN login_guards.fail_streak + 1 = 6 THEN ? + 1800
        WHEN login_guards.fail_streak + 1 = 7 THEN ? + 3600
        WHEN login_guards.fail_streak + 1 = 8 THEN ? + 7200
        WHEN login_guards.fail_streak + 1 = 9 THEN ? + 14400
        WHEN login_guards.fail_streak + 1 = 10 THEN ? + 28800
        WHEN login_guards.fail_streak + 1 = 11 THEN ? + 57600
        ELSE ? + 86400
      END`,
    username, t, t, t, t, t, t, t, t);
  const g = await first(env, 'SELECT fail_streak, locked_until FROM login_guards WHERE username = ?', username);
  return { streak: g?.fail_streak || 0, lockedUntil: g?.locked_until || 0 };
}
export async function clearLoginFails(env, username) {
  await run(env, 'DELETE FROM login_guards WHERE username = ?', username);
}

// ---- 恢复码（第一层恢复）：10 个一次性码，只存哈希，明文只在生成响应里出现一次 ----
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // 去掉易混字符
export function genRecoveryCode() {
  const seg = () => Array.from(crypto.getRandomValues(new Uint8Array(4))).map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `${seg()}-${seg()}-${seg()}`;
}
export async function generateRecoveryCodes(env, userId) {
  await run(env, 'DELETE FROM recovery_codes WHERE user_id = ?', userId);
  const codes = [];
  const t = nowSec();
  for (let i = 0; i < 10; i++) {
    const code = genRecoveryCode();
    codes.push(code);
    await run(env, 'INSERT INTO recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)',
      userId, await hashSecret(env, code), t);
  }
  return codes;
}
// 校验并消费一个恢复码；返回 true 表示命中（调用方负责随后改密+吊销会话）
// 原子消费（2026-11-17 审计核验 #3）：UPDATE 带 used_at IS NULL 条件并检查
// changes——旧版先 SELECT 再无条件 UPDATE，并发下两个请求能同时选中同一枚
// 未用码、都返回 true 把同一码消费两次。抢不到（changes=0）即失败。
export async function consumeRecoveryCode(env, userId, code) {
  const h = await hashSecret(env, String(code || '').trim().toLowerCase());
  const row = await first(env, 'SELECT id FROM recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL', userId, h);
  if (!row) return false;
  const r = await run(env, 'UPDATE recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL', nowSec(), row.id);
  return !!(r && r.meta && r.meta.changes);
}
