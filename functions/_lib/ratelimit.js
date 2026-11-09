// ratelimit.js — 基于 D1 的窗口计数限流 + 档位策略
// 为什么用 D1 不用 KV：计数要原子自增、要和业务同库对账，量极小，D1 够用。
// 档位来自设置 ratelimit_level：off 关闭 / normal 默认 / strict 从严。本文件只管「计数与判定」，
// 命中后的响应（429+中文提示）由调用方出。

import { run, first } from './db.js';
import { nowSec } from './http.js';

// 窗口内计数 +1，返回是否放行
export async function hitLimit(env, bucket, limit, windowSec) {
  if (!limit || limit <= 0) return { allowed: true, count: 0 };
  const w = Math.floor(nowSec() / windowSec) * windowSec;
  await run(env, 'INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1) ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1', bucket, w);
  const row = await first(env, 'SELECT count FROM rate_limits WHERE bucket = ? AND window_start = ?', bucket, w);
  const count = row?.count || 0;
  return { allowed: count <= limit, count };
}

export async function peekLimit(env, bucket, windowSec) {
  const w = Math.floor(nowSec() / windowSec) * windowSec;
  const row = await first(env, 'SELECT count FROM rate_limits WHERE bucket = ? AND window_start = ?', bucket, w);
  return row?.count || 0;
}

// 档位表：key → {normal, strict}（limit, windowSec 秒）
export const LIMITS = {
  comment:  { normal: [5, 600], strict: [3, 600] },     // 同 IP 发评论
  unlock:   { normal: [5, 900], strict: [3, 900] },      // 文章密码尝试
  loginIp:  { normal: [20, 3600], strict: [10, 3600] },  // 同 IP 登录失败触发额外防护的阈值（配合 login_guards）
  view:     { normal: [1, 60], strict: [1, 60] },        // 同 IP+文浏览去重
  search:   { normal: [30, 60], strict: [15, 60] },      // 搜索防刷行读
  sign:     { normal: [20, 3600], strict: [10, 3600] },  // 站长签发上传
  recovery: { normal: [5, 3600], strict: [5, 3600] },    // 恢复码试错（锁的是恢复入口）
};

// 取某类限流在当前档位下的 (上限, 窗口秒)：档位 off 或未知类型回 null（=不限）。
// 「只数失败、不数每次尝试」的路径（如登录 loginIp：先 peek 判定、失败后才计数）
// 不能直接用 checkLimit（它每次调用都计数），用本函数取规格后自行 peek/hit。
export function limitSpec(settings, kind) {
  const level = settings?.ratelimit_level || 'normal';
  if (level === 'off') return null;
  const spec = LIMITS[kind];
  if (!spec) return null;
  const [limit, windowSec] = spec[level] || spec.normal;
  return { limit, windowSec, level };
}

export async function checkLimit(env, settings, kind, bucketSuffix) {
  const s = limitSpec(settings, kind);
  if (!s) return { allowed: true, count: 0 };
  return hitLimit(env, `${kind}:${bucketSuffix}`, s.limit, s.windowSec);
}
