// stats.js — 浏览计数（按天聚合）与用量汇总
// 为什么按天聚合：D1 单库串行、每日写额度有限；一篇文章一天最多占 1 行写（重复上报只 UPDATE 同一行），
// 既不烧额度也不挤占正文读写。前端从不为计数单独发读请求，热门榜在服务端一次聚合查完。

import { run, all, first } from './db.js';
import { beijingDay, nowSec } from './http.js';

export async function recordView(env, postId) {
  const day = beijingDay();
  await run(env, 'INSERT INTO view_stats (post_id, day, pv) VALUES (?, ?, 1) ON CONFLICT(post_id, day) DO UPDATE SET pv = pv + 1', postId, day);
}

export async function postTotalViews(env, postId) {
  const r = await first(env, 'SELECT COALESCE(SUM(pv),0) AS total FROM view_stats WHERE post_id = ?', postId);
  return r?.total || 0;
}

// 近 N 天热门（公开侧与后台共用）
export async function hotPosts(env, days = 30, limit = 5) {
  const since = beijingDay(Date.now() - (days - 1) * 86400 * 1000);
  return all(env, `SELECT p.id, p.slug, p.title, SUM(v.pv) AS pv FROM view_stats v JOIN posts p ON p.id = v.post_id
    WHERE v.day >= ? AND (p.status = 'published' OR (p.status = 'scheduled' AND p.publish_at <= ?)) GROUP BY p.id ORDER BY pv DESC LIMIT ?`, since, nowSec(), limit);
}

export async function totalViews(env) {
  const r = await first(env, 'SELECT COALESCE(SUM(pv),0) AS total FROM view_stats');
  return r?.total || 0;
}

// 媒体用量：实时聚合（行数极少），按 kind 分段
export async function mediaUsage(env) {
  const rows = await all(env, "SELECT kind, COUNT(*) AS n, COALESCE(SUM(size_bytes),0) AS bytes FROM media WHERE status='ready' GROUP BY kind");
  const byKind = {};
  let totalBytes = 0, totalCount = 0;
  for (const r of rows) { byKind[r.kind] = { count: r.n, bytes: r.bytes }; totalBytes += r.bytes; totalCount += r.n; }
  return { totalBytes, totalCount, byKind };
}

// 按天统计明细：近 N 天逐日 PV 序列（无数据的天补 0）+ 每日新增已通过/待审评论数
// view_stats 已按天聚合，序列查走 idx_vs_day；评论按 created_at 的北京时间日期分组（量小可接受）。
export async function dailyStats(env, days = 30) {
  const d = Math.min(90, Math.max(1, Number(days) || 30));
  const dayList = [];
  for (let i = d - 1; i >= 0; i--) dayList.push(beijingDay(Date.now() - i * 86400 * 1000));
  const since = dayList[0];
  const pvRows = await all(env, 'SELECT day, SUM(pv) AS pv FROM view_stats WHERE day >= ? GROUP BY day', since);
  const pvMap = new Map(pvRows.map((r) => [r.day, r.pv]));
  // 评论的「天」按北京时间算：created_at 是 Unix 秒，+8 小时后取 UTC 日期部分即北京时间日期
  const sinceSec = Math.floor(new Date(`${since}T00:00:00+08:00`).getTime() / 1000);
  const cmtRows = await all(env, `SELECT date(created_at + 28800, 'unixepoch') AS day,
      SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending
    FROM comments WHERE created_at >= ? GROUP BY day`, sinceSec);
  const cmtMap = new Map(cmtRows.map((r) => [r.day, r]));
  return dayList.map((day) => ({
    day,
    pv: pvMap.get(day) || 0,
    comments_approved: cmtMap.get(day)?.approved || 0,
    comments_pending: cmtMap.get(day)?.pending || 0,
  }));
}

// 内容计数（仪表盘一次拉齐用）
export async function contentCounts(env) {
  const one = async (sql) => (await first(env, sql))?.n || 0;
  return {
    postsPublished: await one("SELECT COUNT(*) AS n FROM posts WHERE status='published'"),
    postsDraft: await one("SELECT COUNT(*) AS n FROM posts WHERE status='draft'"),
    postsTrash: await one("SELECT COUNT(*) AS n FROM posts WHERE status='trash'"),
    moments: await one("SELECT COUNT(*) AS n FROM moments WHERE status='published'"),
    commentsPending: await one("SELECT COUNT(*) AS n FROM comments WHERE status='pending'"),
    commentsApproved: await one("SELECT COUNT(*) AS n FROM comments WHERE status='approved'"),
    friends: await one('SELECT COUNT(*) AS n FROM friend_links WHERE enabled=1'),
  };
}
