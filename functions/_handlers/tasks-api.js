// tasks-api.js — 定时任务接口（GitHub Actions 以 X-Task-Secret 调用，无 Cookie）
// Pages Functions 没有 Cron，调度外置；本文件的接口全部幂等，重复调用无副作用。
// 接口：friend-check 友链探活 / purge 垃圾清理 / backup 每周备份 / health 看门狗探活。

import { all, first, run } from '../_lib/db.js';
import { json, fail, nowSec } from '../_lib/http.js';
import { getSettings } from '../_lib/settings.js';
import { exportSite, countOf } from '../_lib/backup.js';

function taskAuthed(env, request) {
  const secret = env.TASK_SECRET;
  if (!secret) return false;
  return request.headers.get('x-task-secret') === secret;
}

// 探活一条友链：只请求首页、8 秒超时、只看状态码；回写 health/fail_streak
export async function checkOneLink(env, link) {
  let ok = false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(link.url, { method: 'GET', redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': 'ym-blog-linkcheck/1.0' } });
    clearTimeout(timer);
    ok = resp.status < 500;
  } catch { ok = false; }
  const streak = ok ? 0 : (link.fail_streak || 0) + 1;
  await run(env, 'UPDATE friend_links SET health = ?, fail_streak = ?, last_checked_at = ? WHERE id = ?',
    ok ? 'ok' : 'fail', streak, nowSec(), link.id);
  return ok ? 'ok' : 'fail';
}

// 每周备份管线：按表导出 JSON → 存备份桶 → 登记 + 对账 → 按 backup_keep 保留期数删旧
export async function runBackup(env, kind = 'auto-weekly') {
  if (!env.BACKUPS) throw new Error('备份桶未绑定（BACKUPS）');
  const data = await exportSite(env);
  const text = JSON.stringify(data);
  const day = new Date().toISOString().slice(0, 10);
  const key = `backup/${day}/${kind}-${nowSec()}.json`;
  await env.BACKUPS.put(key, text);
  const counts = countOf(data);
  const r = await run(env, 'INSERT INTO backups (kind, r2_key, size_bytes, post_count, media_count, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    kind, key, text.length, counts.posts, counts.media, `对账：文章 ${counts.posts} / 附件 ${counts.media} / 评论 ${counts.comments}`, nowSec());
  // 保留最近 N 期
  const settings = await getSettings(env);
  const keep = settings.backup_keep || 12;
  const old = await all(env, 'SELECT id, r2_key FROM backups ORDER BY created_at DESC LIMIT 1000 OFFSET ?', keep);
  for (const o of old) {
    if (o.r2_key) { try { await env.BACKUPS.delete(o.r2_key); } catch { /* 对象没了就算了 */ } }
    await run(env, 'DELETE FROM backups WHERE id = ?', o.id);
  }
  return { id: r.meta.last_row_id, r2_key: key, size_bytes: text.length, ...counts };
}

export async function handleTasksApi(env, request, method, path) {
  if (!path.startsWith('/api/tasks/')) return null;
  if (!taskAuthed(env, request)) return fail('forbidden', '任务密钥未配置或不正确', 403);
  const settings = await getSettings(env);
  const t = nowSec();

  if (method === 'POST' && path === '/api/tasks/friend-check') {
    const links = await all(env, 'SELECT * FROM friend_links WHERE enabled = 1');
    let ok = 0, failN = 0;
    // 并发 5 条一批
    for (let i = 0; i < links.length; i += 5) {
      const batch = links.slice(i, i + 5);
      const results = await Promise.all(batch.map((l) => checkOneLink(env, l)));
      for (const r of results) (r === 'ok' ? ok++ : failN++);
    }
    return json({ checked: links.length, ok, fail: failN });
  }

  if (method === 'POST' && path === '/api/tasks/purge') {
    const keepDays = settings.trash_keep_days || 30;
    const cutoff = t - keepDays * 86400;
    const result = {};
    // 超期回收站文章真删（连版本/自动保存/标签关系/预览令牌）
    const deadPosts = await all(env, "SELECT id FROM posts WHERE status='trash' AND trashed_at IS NOT NULL AND trashed_at < ?", cutoff);
    for (const p of deadPosts) {
      await run(env, 'DELETE FROM post_tags WHERE post_id = ?', p.id);
      await run(env, 'DELETE FROM post_revisions WHERE post_id = ?', p.id);
      await run(env, 'DELETE FROM autosaves WHERE post_id = ?', p.id);
      await run(env, 'DELETE FROM preview_tokens WHERE post_id = ?', p.id);
      await run(env, 'DELETE FROM posts WHERE id = ?', p.id);
    }
    result.posts = deadPosts.length;
    const deadMoments = await all(env, "SELECT id FROM moments WHERE status='trash' AND updated_at < ?", cutoff);
    for (const m of deadMoments) await run(env, 'DELETE FROM moments WHERE id = ?', m.id);
    result.moments = deadMoments.length;
    await run(env, "DELETE FROM comments WHERE status IN ('trash','spam') AND created_at < ?", cutoff);
    // 超期媒体软删：先复查引用，在用的绝不真删
    const deadMedia = await all(env, "SELECT * FROM media WHERE status='trashed'");
    let mediaDeleted = 0;
    for (const m of deadMedia) {
      const used = await first(env, "SELECT id FROM posts WHERE status != 'trash' AND content_md LIKE ? LIMIT 1", `%${m.r2_key}%`);
      if (used) continue;
      if (env.MEDIA) { try { await env.MEDIA.delete(m.r2_key); } catch { /* 同上 */ } }
      await run(env, 'DELETE FROM media WHERE id = ?', m.id);
      mediaDeleted++;
    }
    result.media = mediaDeleted;
    // 超 24 小时未完成登记的 pending 媒体行（签了没传的垃圾行）
    const stalePending = await all(env, "SELECT * FROM media WHERE status='pending' AND created_at < ?", t - 86400);
    for (const m of stalePending) {
      if (env.MEDIA) { try { await env.MEDIA.delete(m.r2_key); } catch { /* 对象可能根本没传上来 */ } }
      await run(env, 'DELETE FROM media WHERE id = ?', m.id);
    }
    result.pending_media = stalePending.length;
    await run(env, 'DELETE FROM sessions WHERE expires_at < ?', t);
    await run(env, 'DELETE FROM preview_tokens WHERE expires_at < ? OR revoked = 1', t);
    await run(env, 'DELETE FROM rate_limits WHERE window_start < ?', t - 90 * 86400);
    return json({ purged: result });
  }

  if (method === 'POST' && path === '/api/tasks/backup') {
    const rec = await runBackup(env, 'auto-weekly');
    return json({ backup: rec });
  }

  if (method === 'GET' && path === '/api/tasks/health') {
    const lastBackup = await first(env, 'SELECT created_at FROM backups ORDER BY created_at DESC LIMIT 1');
    const pending = (await first(env, "SELECT COUNT(*) AS n FROM comments WHERE status='pending'"))?.n || 0;
    const posts = (await first(env, "SELECT COUNT(*) AS n FROM posts WHERE status='published'"))?.n || 0;
    const backupAgeDays = lastBackup ? Math.floor((t - lastBackup.created_at) / 86400) : null;
    return json({
      ok: true,
      published_posts: posts,
      pending_comments: pending,
      last_backup_at: lastBackup?.created_at || null,
      backup_age_days: backupAgeDays,
      backup_stale: backupAgeDays === null || backupAgeDays > 14,
      now: t,
    });
  }

  return null;
}
