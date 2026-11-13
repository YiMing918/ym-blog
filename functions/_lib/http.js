// http.js — 请求/响应小工具：JSON 响应、错误、读 body、取 IP、时间
// 改这里要小心：全站接口的响应格式都从这里出（{ok:true,data} / {ok:false,error}）。

export const nowSec = () => Math.floor(Date.now() / 1000);

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify({ ok: true, data }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders },
  });
}

export function fail(code, message, status = 400) {
  return new Response(JSON.stringify({ ok: false, error: { code, message } }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// 业务代码里 throw new HttpError(...)，由总路由统一转成 fail 响应
export class HttpError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export const badRequest = (msg) => new HttpError('bad_request', msg, 400);
export const unauthorized = (msg = '请先登录') => new HttpError('unauthorized', msg, 401);
export const forbidden = (msg = '无权操作') => new HttpError('forbidden', msg, 403);
export const notFound = (msg = '不存在') => new HttpError('not_found', msg, 404);
export const tooMany = (msg = '操作太频繁，请稍后再试') => new HttpError('rate_limited', msg, 429);

export async function readJson(request) {
  try {
    const t = await request.text();
    if (!t) return {};
    return JSON.parse(t);
  } catch { throw badRequest('请求内容不是合法 JSON'); }
}

// 客户端 IP：CF 会给 cf-connecting-ip；本地测试退回 x-forwarded-for
export function clientIp(request) {
  return request.headers.get('cf-connecting-ip')
    || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim()
    || '0.0.0.0';
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// IP 只存哈希，不落明文（salt 可用环境变量 IP_SALT 覆盖）。
// 没配 IP_SALT 时退回用 PASSWORD_PEPPER（部署必配的真秘密）——旧版默认
// 盐是写死的公开常量 'ym-blog-ip'，IPv4 空间可穷举反查，等于没盐。
export async function ipHash(env, request) {
  return sha256Hex((env.IP_SALT || env.PASSWORD_PEPPER || 'ym-blog-ip') + '|' + clientIp(request));
}

export function randomToken(bytes = 32) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 北京时间的 YYYY-MM-DD（计数按天聚合用）
export function beijingDay(ts = Date.now()) {
  return new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
export function isoOf(sec) { return sec ? new Date(sec * 1000).toISOString() : null; }

// HTML 转义：评论等一切不可信文本进页面前必过
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// 属性值转义（同 esc，多处理反引号场景已覆盖引号）
export const escAttr = esc;

// 安全响应头（访客页与接口共用）；后台页额外加 X-Frame-Options 的在路由层处理
export function securityHeaders(extra = {}) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    ...extra,
  };
}
