// public-api.js — 访客侧 JSON 接口：评论提交/列表、浏览上报、文章解锁、即时搜索
// 所有匿名写接口都过限流（防刷爆 D1 额度连带整站停摆）；评论流水线顺序：
// 开关 → 文章可评论 → Turnstile（开时）→ 限流 → 净化预检（链接数/审核词）→ 老访客免审 → 先审后显。

import { first, all, run } from '../_lib/db.js';
import { json, readJson, nowSec, ipHash, badRequest, notFound, tooMany, forbidden, HttpError } from '../_lib/http.js';
import { getSettings } from '../_lib/settings.js';
import { checkLimit } from '../_lib/ratelimit.js';
import { verifyTurnstile } from '../_lib/turnstile.js';
import { renderCommentText, countLinks, hitSpamWord } from '../_lib/sanitize.js';
import { verifyPassword, hashSecret } from '../_lib/hash.js';
import { recordView } from '../_lib/stats.js';
import { readCookie } from '../_lib/auth.js';
import { sha256Hex } from '../_lib/http.js';

// 密码文章在一切公开列表/搜索/订阅里只露标题，摘要统一用这句占位——
// 摘要默认从正文截前 140 字，密码文章原样输出等于直接送正文开头，
// 搜索还能拿它逐词试探正文（2026-11-13 三方审查 B#1 / A#2）。
export const PASSWORD_EXCERPT = '这篇文章设置了密码，输入密码后查看。';
export function maskExcerpt(post) {
  return post.password_hash ? PASSWORD_EXCERPT : (post.excerpt || '');
}

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
    const post = await first(env, 'SELECT id, status, publish_at, comment_enabled, password_hash FROM posts WHERE id = ?', postId);
    if (!isPubliclyVisible(post) || !post.comment_enabled) throw notFound('文章不存在');
    // 密码文章未解锁不许评论（页面上解锁前本来也看不到评论框，
    // 接口层必须同口径，否则绕过页面直接调接口即可；审查 A#2）
    if (post.password_hash && !(await isUnlocked(env, request, post))) throw notFound('文章不存在');
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
    const contactHash = body.contact ? await sha256Hex(String(body.contact).slice(0, 120)) : null;
    let status = 'pending';
    if (hitSpamWord(content) || hitSpamWord(name)) status = 'spam';
    else if (settings.comments_link_limit > 0 && countLinks(content) >= settings.comments_link_limit) status = 'pending'; // 0 = 不按链接审（后台文案口径）；旧写法 Math.max(1, …) 让 0 档变成「≥1 条就审」的假开关
    else {
      // 老访客免审：旧版只认 IP 哈希——移动 NAT/校园网/公司出口共用一个
      // IP 时全员连带免审，先发一条正常评论再批量发垃圾也畅通（审查 B#11）。
      // 改为 IP + 昵称 + 联系方式哈希三者同时对上才算老访客（联系方式
      // 不公开显示，只存哈希；没留联系方式时按 NULL 对 NULL 匹配）。
      const old = await first(env, "SELECT id FROM comments WHERE ip_hash = ? AND author_name = ? AND author_hash IS ? AND status='approved' LIMIT 1", iph, name, contactHash);
      if (old) status = 'approved';                        // 老访客免审
      else if (!settings.comments_moderation) status = 'approved';
    }
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
    // 先查文章可见性：旧版按 post_id 直接出评论，私密/草稿/回收站文章下
    // 已通过的评论仍能被任何人读到（审查 A#2 / B 轻微项）；密码文章
    // 还要已解锁才给（与提交侧同口径）。
    const post = await first(env, 'SELECT id, status, publish_at, password_hash FROM posts WHERE id = ?', postId);
    if (!isPubliclyVisible(post)) throw notFound('文章不存在');
    if (post.password_hash && !(await isUnlocked(env, request, post))) throw notFound('文章不存在');
    const rows = await all(env, "SELECT id, parent_id, author_name, content, is_admin, created_at FROM comments WHERE post_id = ? AND status='approved' ORDER BY created_at ASC LIMIT 200", postId);
    return json({ comments: rows.map((c) => ({ ...c, html: renderCommentText(c.content) })) });
  }

  // ---- 浏览上报（sendBeacon）：聚合进 view_stats，同 IP+文 1 分钟去重 ----
  if (method === 'POST' && path === '/api/view') {
    const body = await readJson(request).catch(() => ({}));
    const postId = Number(body.post_id);
    // 可见口径与页面统一（旧版只认 published：定时文章到点后阅读数
    // 永远记不上、热门榜也上不去；审查 B#7）
    const viewable = postId ? await first(env, "SELECT id FROM posts WHERE id = ? AND (status='published' OR (status='scheduled' AND publish_at<=?))", postId, nowSec()) : null;
    if (postId && viewable) {
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
    // 令牌 = hashSecret(文章号 + 当前密码哈希 + 时间窗)：hashSecret 以服务端
    // 秘密 PASSWORD_PEPPER 为材料（部署必配、永不入库/不进仓库），不知道
    // 秘密的人拿到 password_hash 也算不出令牌；时间窗 24 小时一格、校验认
    // 当前格与上一格（见 isUnlocked），令牌最长约 48 小时、配合 Cookie 的
    // Max-Age=86400 实际 24 小时内过期。文章改密后旧令牌同样自动失效。
    // 旧版令牌是 sha256(文章号+password_hash) 确定值：全员共用、永不过期、
    // 密码哈希一旦泄露即可离线算出（C-6）。改算法后旧 Cookie 全部失效、
    // 需重新输一次密码，属预期。
    const token = await makeUnlockToken(env, post);
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
    const t = nowSec();
    // 与页面搜索（pages.js 的 /search）同口径：先走 FTS5 trigram 全文索引（schema/0003），
    // 按相关度排序；退回 LIKE 的三种情况与页面版一致：词太短（<3 字切不出 trigram 片段）、
    // 索引表还没建（迁移未跑，查询抛错）、索引无命中（LIKE 再兜一次保证召回不劣于旧版）。
    // 密码文章只许按标题命中：正文不参与匹配（防逐词试探的预言机），
    // 命中后摘要打码（与页面搜索 pages.js /search 同口径；审查 B#1）
    let rows = null;
    const tokens = q.replace(/["*()^]/g, ' ').split(/\s+/).filter((w) => w.length >= 3);
    if (tokens.length) {
      try {
        const match = tokens.map((w) => `"${w}"`).join(' OR ');
        rows = await all(env, `SELECT p.id, p.slug, p.title, p.excerpt, p.publish_at, p.password_hash
          FROM posts p JOIN posts_fts f ON f.rowid = p.id
          WHERE posts_fts MATCH ? AND p.type='post' AND p.password_hash IS NULL
          AND (p.status='published' OR (p.status='scheduled' AND p.publish_at<=?))
          ORDER BY rank LIMIT 20`, match, t);
      } catch { rows = null; }
    }
    if (!rows || !rows.length) {
      const like = `%${q.replace(/[%_]/g, '')}%`;
      rows = await all(env, `SELECT id, slug, title, excerpt, publish_at, password_hash,
        CASE WHEN title LIKE ? THEN 0 ELSE 1 END AS rank
        FROM posts WHERE type='post' AND (status='published' OR (status='scheduled' AND publish_at<=?))
        AND (title LIKE ? OR (password_hash IS NULL AND (excerpt LIKE ? OR content_md LIKE ?)))
        ORDER BY rank, publish_at DESC LIMIT 20`, like, t, like, like, like);
    }
    return json({
      results: rows.map((r) => ({
        id: r.id, slug: r.slug, title: r.title,
        excerpt: maskExcerpt(r), publish_at: r.publish_at,
      })),
    });
  }

  return null;
}

// ---- 文章解锁令牌（C-6）：HMAC 式 = hashSecret(秘密, 文章号+密码哈希+时间窗) ----
// 取舍：仓内已有 preview_tokens 的「随机令牌存表」先例，但解锁是高频读路径
// （每篇密码文每次访问都要验），存表要多一次 D1 读且需清理过期行；时间窗
// 派生令牌无状态可复算、改密/换秘密/过窗自动失效，改动更小，故选时间窗方案。
// 服务端秘密来源：PASSWORD_PEPPER（hashSecret 内部使用；部署必配的服务端
// -only 环境变量，与密码哈希同一秘密体系，见 README 配置表）。
export const UNLOCK_WINDOW_SEC = 24 * 3600; // 24 小时一格
export async function makeUnlockToken(env, post, atSec = nowSec()) {
  const w = Math.floor(atSec / UNLOCK_WINDOW_SEC);
  return hashSecret(env, `unlock:${post.id}:${post.password_hash}:${w}`);
}

// 文章密码是否已解锁（文章页 SSR 用）：Cookie 值应为当前或上一时间窗的
// 解锁令牌（认上一格是给跨窗临界点留缓冲：刚解锁就跨窗不该立刻被踢回）
export async function isUnlocked(env, request, post) {
  if (!post.password_hash) return true;
  const v = readCookie(request, `bk_unlock_${post.id}`);
  if (!v) return false;
  const t = nowSec();
  for (const at of [t, t - UNLOCK_WINDOW_SEC]) {
    if (v === (await makeUnlockToken(env, post, at))) return true;
  }
  return false;
}
