// public-api.js — 访客侧 JSON 接口：评论提交/列表、浏览上报、文章解锁、即时搜索
// 所有匿名写接口都过限流（防刷爆 D1 额度连带整站停摆）；评论流水线顺序：
// 开关 → 文章可评论 → Turnstile（开时）→ 限流 → 净化预检（链接数/审核词）→ 老访客免审 → 先审后显。

import { first, all, run } from '../_lib/db.js';
import { json, readJson, nowSec, ipHash, badRequest, notFound, tooMany, forbidden, HttpError } from '../_lib/http.js';
import { getSettings } from '../_lib/settings.js';
import { checkLimit } from '../_lib/ratelimit.js';
import { verifyTurnstile } from '../_lib/turnstile.js';
import { renderCommentText, countLinks, hitSpamWord } from '../_lib/sanitize.js';
import { verifyPassword } from '../_lib/hash.js';
import { recordView } from '../_lib/stats.js';
import { readCookie } from '../_lib/auth.js';
import { sha256Hex } from '../_lib/http.js';

// 文章当前是否对访客可见（定时到点靠读时判断）
export function isPubliclyVisible(post, t = nowSec()) {
  if (!post) return false;
  if (post.status === 'published') return true;
  if (post.status === 'scheduled' && post.publish_at && post.publish_at <= t) return true;
  return false;
}

export async function handlePublicApi(env, request, method, path, url) {
  const settings = await getSettings(env);

  // ---- 评论提交 ----
  if (method === 'POST' && path === '/api/comments') {
    if (!settings.comments_on) throw forbidden('评论已关闭');
    const body = await readJson(request);
    const postId = Number(body.post_id);
    const post = await first(env, 'SELECT id, status, publish_at, comment_enabled FROM posts WHERE id = ?', postId);
    if (!isPubliclyVisible(post) || !post.comment_enabled) throw notFound('文章不存在');
    const name = String(body.author_name || '').trim().slice(0, 30);
    const content = String(body.content || '').trim();
    if (!name) throw badRequest('请填写昵称');
    if (!content || content.length > 2000) throw badRequest('评论内容为空或过长（最多 2000 字）');
    // 人机验证（开启时服务端验 token，只挂前端组件不算开）
    if (settings.turnstile_on) {
      const v = await verifyTurnstile(env, request, body.turnstile_token);
      if (!v.ok) throw badRequest(v.reason || '人机验证未通过');
    }
    const iph = await ipHash(env, request);
    const rl = await checkLimit(env, settings, 'comment', iph);
    if (!rl.allowed) throw tooMany('评论太频繁，请稍后再试');
    // 状态判定
    let status = 'pending';
    if (hitSpamWord(content) || hitSpamWord(name)) status = 'spam';
    else if (countLinks(content) >= Math.max(1, settings.comments_link_limit)) status = 'pending';
    else {
      const old = await first(env, "SELECT id FROM comments WHERE ip_hash = ? AND status='approved' LIMIT 1", iph);
      if (old) status = 'approved';                        // 老访客免审
      else if (!settings.comments_moderation) status = 'approved';
    }
    const contactHash = body.contact ? await sha256Hex(String(body.contact).slice(0, 120)) : null;
    const parentId = Number(body.parent_id) || 0;
    if (parentId) {
      const parent = await first(env, "SELECT id FROM comments WHERE id = ? AND post_id = ? AND status='approved'", parentId, postId);
      if (!parent) throw badRequest('要回复的评论不存在');
    }
    const r = await run(env, 'INSERT INTO comments (post_id, parent_id, author_name, author_hash, content, status, ip_hash, ua, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      postId, parentId, name, contactHash, content, status, iph, (request.headers.get('user-agent') || '').slice(0, 200), nowSec());
    return json({
      id: r.meta.last_row_id, status,
      message: status === 'approved' ? '评论已发表' : '已提交，审核后显示',
    });
  }

  // ---- 评论列表（只出已通过；首屏由文章页 SSR 内嵌，本接口供翻页与发表后刷新）----
  if (method === 'GET' && path === '/api/comments') {
    const postId = Number(url.searchParams.get('post_id'));
    if (!postId) throw badRequest('缺少 post_id');
    const rows = await all(env, "SELECT id, parent_id, author_name, content, is_admin, created_at FROM comments WHERE post_id = ? AND status='approved' ORDER BY created_at ASC LIMIT 200", postId);
    return json({ comments: rows.map((c) => ({ ...c, html: renderCommentText(c.content) })) });
  }

  // ---- 浏览上报（sendBeacon）：聚合进 view_stats，同 IP+文 1 分钟去重 ----
  if (method === 'POST' && path === '/api/view') {
    const body = await readJson(request).catch(() => ({}));
    const postId = Number(body.post_id);
    if (postId) {
      const iph = await ipHash(env, request);
      const rl = await checkLimit(env, settings, 'view', `${iph}:${postId}`);
      if (rl.allowed) await recordView(env, postId);
    }
    return json({ ok: true });
  }

  // ---- 文章密码解锁：成功后发仅该文有效的 Cookie（路径限定、24 小时）----
  const unlockMatch = path.match(/^\/api\/post\/(\d+)\/unlock$/);
  if (method === 'POST' && unlockMatch) {
    const postId = Number(unlockMatch[1]);
    const iph = await ipHash(env, request);
    const rl = await checkLimit(env, settings, 'unlock', iph);
    if (!rl.allowed) throw tooMany('尝试次数过多，请 15 分钟后再试');
    const post = await first(env, 'SELECT id, password_hash FROM posts WHERE id = ?', postId);
    if (!post || !post.password_hash) throw notFound('文章不存在');
    const body = await readJson(request);
    const ok = await verifyPassword(env, String(body.password || ''), post.password_hash);
    if (!ok) throw new HttpError('invalid', '密码错误', 401);
    // 令牌由当前密码哈希派生：文章改密后旧令牌自动失效，校验端可复算比对（见 isUnlocked）
    const token = await sha256Hex(`unlock:${postId}:${post.password_hash}`);
    return json({ ok: true }, 200, {
      'Set-Cookie': `bk_unlock_${postId}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`,
    });
  }

  // ---- 即时搜索 JSON（页面版在 pages.js 的 /search）----
  if (method === 'GET' && path === '/api/search') {
    if (!settings.search_on) throw notFound('搜索已关闭');
    const iph = await ipHash(env, request);
    const rl = await checkLimit(env, settings, 'search', iph);
    if (!rl.allowed) throw tooMany();
    const q = (url.searchParams.get('q') || '').trim().slice(0, 60);
    if (!q) return json({ results: [] });
    const like = `%${q.replace(/[%_]/g, '')}%`;
    const t = nowSec();
    const rows = await all(env, `SELECT id, slug, title, excerpt, publish_at,
      CASE WHEN title LIKE ? THEN 0 ELSE 1 END AS rank
      FROM posts WHERE type='post' AND (status='published' OR (status='scheduled' AND publish_at<=?))
      AND (title LIKE ? OR excerpt LIKE ? OR content_md LIKE ?)
      ORDER BY rank, publish_at DESC LIMIT 20`, like, t, like, like, like);
    return json({ results: rows });
  }

  return null;
}

// 文章密码是否已解锁（文章页 SSR 用）：Cookie 值应为 sha256(postId + 当前密码哈希)，改密即失效
export async function isUnlocked(env, request, post) {
  if (!post.password_hash) return true;
  const v = readCookie(request, `bk_unlock_${post.id}`);
  if (!v) return false;
  const expect = await sha256Hex(`unlock:${post.id}:${post.password_hash}`);
  return v === expect;
}
