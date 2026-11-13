// admin-api.js — 站长后台全部 JSON 接口（文章/版本/评论/媒体/设置/说说/友链/统计/导出导入/备份）
// 全部要会话（requireAdmin）；写操作还要 CSRF 头。
// 发布管线单点收敛在 publishPost()：渲染、摘要、字数、封面、修订、引用计数都只在这里做，别在别处重复。

import { all, first, run } from '../_lib/db.js';
import { json, readJson, nowSec, badRequest, notFound, HttpError } from '../_lib/http.js';
import { requireAdmin, requireCsrf } from '../_lib/auth.js';
import { getSettings, saveSettings, validateSetting } from '../_lib/settings.js';
import { renderMarkdown, excerptOf, wordCountOf, firstImageOf } from '../_lib/render.js';
import { hashPassword, hashSecret } from '../_lib/hash.js';
import { MIME_MAP, newObjectKey, presignPut, publicMediaUrl } from '../_lib/r2sign.js';
import { checkLimit } from '../_lib/ratelimit.js';
import { ipHash } from '../_lib/http.js';
import { contentCounts, mediaUsage, hotPosts, totalViews, dailyStats } from '../_lib/stats.js';
import { exportSite, buildMarkdownPack, zipStore, importSite, countOf } from '../_lib/backup.js';
import { renderCommentText } from '../_lib/sanitize.js';

// ---------- 文章辅助 ----------
export function slugifyTitle(title) {
  const s = String(title || '').toLowerCase().trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  // 纯中文标题会得到中文 slug（合法但分享不友好），给个时间戳兜底由调用方决定；这里原样返回
  return s.slice(0, 80);
}
async function uniqueSlug(env, base, selfId = 0) {
  let slug = base || `post-${Date.now().toString(36)}`;
  let candidate = slug;
  let n = 2;
  for (;;) {
    const row = await first(env, 'SELECT id FROM posts WHERE slug = ?', candidate);
    if (!row || row.id === selfId) return candidate;
    candidate = `${slug}-${n++}`;
  }
}
async function saveRevision(env, post, note) {
  await run(env, 'INSERT INTO post_revisions (post_id, title, content_md, note, created_at) VALUES (?, ?, ?, ?, ?)',
    post.id, post.title, post.content_md, note || '', nowSec());
  // 只留最近 20 版
  await run(env, 'DELETE FROM post_revisions WHERE post_id = ? AND id NOT IN (SELECT id FROM post_revisions WHERE post_id = ? ORDER BY created_at DESC, id DESC LIMIT 20)', post.id, post.id);
}
// 扫描全部引用位，重算某个附件的 ref_count；删附件前以此为准。
// 引用位共四处：文章正文（含 r2_key）、文章封面 cover_media_id、说说 media_id、头像设置 avatar_media_id——
// 此前只查正文，只被用作封面/说说图/头像的附件会被算成 0 引用、误删（2026-11-09 审校补齐）。
async function recountMediaRef(env, mediaRow) {
  const inPosts = await all(env, "SELECT COUNT(*) AS n FROM posts WHERE status != 'trash' AND content_md LIKE ?", `%${mediaRow.r2_key}%`);
  const asCover = await all(env, "SELECT COUNT(*) AS n FROM posts WHERE status != 'trash' AND cover_media_id = ?", mediaRow.id);
  const inMoments = await all(env, "SELECT COUNT(*) AS n FROM moments WHERE status != 'trash' AND media_id = ?", mediaRow.id);
  const settings = await getSettings(env);
  const asAvatar = Number(settings.avatar_media_id || 0) === Number(mediaRow.id) ? 1 : 0;
  const n = (inPosts[0]?.n || 0) + (asCover[0]?.n || 0) + (inMoments[0]?.n || 0) + asAvatar;
  await run(env, 'UPDATE media SET ref_count = ? WHERE id = ?', n, mediaRow.id);
  return n;
}

// 发布/更新管线：body 字段 → posts 行；status 决定走向
async function applyPostWrite(env, post, body, { isNew = false } = {}) {
  const t = nowSec();
  const title = body.title !== undefined ? String(body.title).slice(0, 200) : post.title;
  const md = body.content_md !== undefined ? String(body.content_md) : post.content_md;
  let slug = post.slug;
  if (body.slug !== undefined && String(body.slug).trim() && String(body.slug).trim() !== post.slug) {
    const want = slugifyTitle(String(body.slug).trim()) || String(body.slug).trim();
    slug = await uniqueSlug(env, want, post.id);
    if (slug !== post.slug && !isNew) {
      await run(env, 'INSERT OR REPLACE INTO redirects (old_slug, post_id, created_at) VALUES (?, ?, ?)', post.slug, post.id, t);
    }
  }
  const rendered = renderMarkdown(md);
  const doRender = ['published', 'scheduled', 'private'].includes(body.status || post.status);
  // 摘要：手动填的优先（站长自己写的简介，公开无妨）；自动摘要在文章
  // 带密码时必须留空——它是从正文截的字，存下来会被列表/搜索/RSS
  // 原样送出去（2026-11-13 三方审查 B#1）。密码状态先算（下方才赋值的
  // passwordHash 提前到这里判定，两处口径一致）。
  const willPassword = body.post_password !== undefined
    ? (body.post_password ? String(body.post_password) : null)
    : post.password_hash;
  const excerpt = body.excerpt !== undefined && String(body.excerpt).trim()
    ? String(body.excerpt).slice(0, 300)
    : (willPassword ? '' : excerptOf(md, rendered.text));
  let coverId = body.cover_media_id !== undefined ? (Number(body.cover_media_id) || null) : post.cover_media_id;
  if (!coverId && firstImageOf(md)) {
    const key = firstImageOf(md).split('/').slice(-4).join('/');
    const m = await first(env, 'SELECT id FROM media WHERE r2_key LIKE ?', `%${key.split('/').slice(-1)[0]}`);
    if (m) coverId = m.id;
  }
  let passwordHash = post.password_hash;
  if (body.post_password !== undefined) {
    passwordHash = body.post_password ? await hashPassword(env, String(body.post_password)) : null;
  }
  const status = body.status || post.status;
  let publishAt = body.publish_at !== undefined ? (Number(body.publish_at) || null)
    : (status === 'scheduled' ? post.publish_at : (status === 'published' && !post.publish_at ? t : post.publish_at));
  // 定时改立即发布时把未来时间钳到现在：否则「已发布」的文章日期还在
  // 未来，置顶排序与上下篇导航都会错乱（2026-11-13 三方审查 B 轻微项）
  if (status === 'published' && publishAt && publishAt > t) publishAt = t;
  await run(env, `UPDATE posts SET slug=?, title=?, content_md=?, rendered_html=?, excerpt=?, cover_media_id=?,
    status=?, publish_at=?, password_hash=?, is_sticky=?, comment_enabled=?, word_count=?, trashed_at=?, updated_at=? WHERE id=?`,
    slug, title, md, doRender ? rendered.html : post.rendered_html, excerpt, coverId,
    status, publishAt, passwordHash,
    body.is_sticky !== undefined ? (body.is_sticky ? 1 : 0) : post.is_sticky,
    body.comment_enabled !== undefined ? (body.comment_enabled ? 1 : 0) : post.comment_enabled,
    wordCountOf(rendered.text),
    status === 'trash' ? (post.trashed_at || t) : null,
    t, post.id);
  // 标签
  if (Array.isArray(body.tags)) {
    await run(env, 'DELETE FROM post_tags WHERE post_id = ?', post.id);
    for (const rawName of body.tags.slice(0, 20)) {
      const name = String(rawName).trim().slice(0, 30);
      if (!name) continue;
      const tslug = slugifyTitle(name) || `tag-${Date.now().toString(36)}`;
      await run(env, 'INSERT OR IGNORE INTO tags (name, slug) VALUES (?, ?)', name, tslug);
      const tag = await first(env, 'SELECT id FROM tags WHERE slug = ?', tslug);
      if (tag) await run(env, 'INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)', post.id, tag.id);
    }
  }
  // 卫生（与 GET 详情同一口径）：回前端的行绝不带 password_hash，只给 has_password 布尔；
  // 本函数的返回值会被创建/保存/发布/还原等写接口直接序列化进响应，内部调用方
  // （saveRevision 等）只用 title/content_md，不受影响。
  const row = await first(env, 'SELECT * FROM posts WHERE id = ?', post.id);
  const { password_hash: _ph2, ...safeRow } = row;
  return { ...safeRow, has_password: !!row.password_hash };
}

export async function handleAdminApi(env, request, method, path, url) {
  if (!path.startsWith('/api/admin/')) return null;
  // auth-api 已处理的路径不在这里拦截（总路由先调 auth-api，未命中才到这）
  const me = await requireAdmin(env, request);
  const isWrite = method !== 'GET';
  if (isWrite) requireCsrf(request);
  const settings = await getSettings(env);

  // ---- 仪表盘一次拉齐 ----
  if (method === 'GET' && path === '/api/admin/me') {
    const counts = await contentCounts(env);
    const usage = await mediaUsage(env);
    const lastBackup = await first(env, 'SELECT created_at, size_bytes FROM backups ORDER BY created_at DESC LIMIT 1');
    return json({
      user: { id: me.id, username: me.username, role: me.role },
      counts,
      media_usage: usage,
      total_views: await totalViews(env),
      last_backup: lastBackup,
    });
  }

  if (method === 'GET' && path === '/api/admin/stats') {
    return json({
      hot: await hotPosts(env, 30, 10),
      total_views: await totalViews(env),
      counts: await contentCounts(env),
      media_usage: await mediaUsage(env),
      daily: await dailyStats(env, url.searchParams.get('days') || 30),
    });
  }

  // 按天统计明细单点查（统计页切换天数用）：?days=30（1–90）
  if (method === 'GET' && path === '/api/admin/stats/daily') {
    return json({ days: Number(url.searchParams.get('days')) || 30, daily: await dailyStats(env, url.searchParams.get('days') || 30) });
  }

  // 标签全集（编辑器标签联想/补全用）：每项带在用文章数
  if (method === 'GET' && path === '/api/admin/tags') {
    const rows = await all(env, `SELECT t.id, t.name, t.slug, COUNT(pt.post_id) AS post_count
      FROM tags t LEFT JOIN post_tags pt ON pt.tag_id = t.id GROUP BY t.id ORDER BY post_count DESC, t.name`);
    return json({ tags: rows });
  }

  // 服务端渲染预览：与 publish 管线同一个 renderMarkdown，保证编辑器预览与发布口径一致
  if (method === 'POST' && path === '/api/admin/render') {
    const body = await readJson(request);
    const rendered = renderMarkdown(String(body.content_md ?? ''));
    return json({ html: rendered.html, toc: rendered.toc, word_count: wordCountOf(rendered.text) });
  }

  // ---- 文章 ----
  if (method === 'GET' && path === '/api/admin/posts') {
    const status = url.searchParams.get('status') || '';
    const type = url.searchParams.get('type') || '';
    const q = (url.searchParams.get('q') || '').trim();
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const per = 20;
    const conds = [];
    const params = [];
    if (status) { conds.push('status = ?'); params.push(status); }
    if (type) { conds.push('type = ?'); params.push(type); }
    if (q) { conds.push('(title LIKE ? OR slug LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const total = (await first(env, `SELECT COUNT(*) AS n FROM posts ${where}`, ...params))?.n || 0;
    const rows = await all(env, `SELECT id, slug, type, title, status, publish_at, is_sticky, word_count, created_at, updated_at,
      (SELECT COUNT(*) FROM comments c WHERE c.post_id = posts.id AND c.status='approved') AS comment_count
      FROM posts ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`, ...params, per, (page - 1) * per);
    // 每篇补 tags 字段（标签名数组）：一次批量查，避免逐篇 N+1
    if (rows.length) {
      const tagRows = await all(env, `SELECT pt.post_id, t.name FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
        WHERE pt.post_id IN (${rows.map(() => '?').join(',')}) ORDER BY t.name`, ...rows.map((r) => r.id));
      const tagMap = new Map();
      for (const tr of tagRows) {
        if (!tagMap.has(tr.post_id)) tagMap.set(tr.post_id, []);
        tagMap.get(tr.post_id).push(tr.name);
      }
      for (const r of rows) r.tags = tagMap.get(r.id) || [];
    }
    return json({ posts: rows, total, page, per });
  }

  if (method === 'POST' && path === '/api/admin/posts') {
    const body = await readJson(request);
    const t = nowSec();
    let baseMd = '';
    let baseTitle = '未命名草稿';
    if (body.template_post_id) {
      const tpl = await first(env, 'SELECT title, content_md FROM posts WHERE id = ?', Number(body.template_post_id));
      if (tpl) { baseMd = tpl.content_md; baseTitle = tpl.title + '（副本）'; }
    }
    const slug = await uniqueSlug(env, slugifyTitle(body.slug || body.title || baseTitle));
    const r = await run(env, "INSERT INTO posts (slug, type, title, content_md, status, created_at, updated_at) VALUES (?, 'post', ?, ?, 'draft', ?, ?)",
      slug, String(body.title || baseTitle).slice(0, 200), String(body.content_md ?? baseMd), t, t);
    const post = await first(env, 'SELECT * FROM posts WHERE id = ?', r.meta.last_row_id);
    if (body.title || body.content_md || body.tags) await applyPostWrite(env, post, body);
    const created = await first(env, 'SELECT * FROM posts WHERE id = ?', post.id);
    const { password_hash: _ph3, ...safeCreated } = created;
    return json({ post: { ...safeCreated, has_password: !!created.password_hash } });
  }

  const postMatch = path.match(/^\/api\/admin\/posts\/(\d+)(\/.*)?$/);
  if (postMatch) {
    const id = Number(postMatch[1]);
    const sub = postMatch[2] || '';
    const post = await first(env, 'SELECT * FROM posts WHERE id = ?', id);
    if (!post) throw notFound('文章不存在');

    if (method === 'GET' && sub === '') {
      const autosave = await first(env, 'SELECT title, content_md, updated_at FROM autosaves WHERE post_id = ?', id);
      const tags = await all(env, 'SELECT t.name FROM tags t JOIN post_tags pt ON pt.tag_id = t.id WHERE pt.post_id = ?', id);
      // 卫生：密码哈希绝不下发给前端，只给「有没有设密码」的布尔（SPA 按 has_password 消费）
      const { password_hash: _ph, ...safePost } = post;
      return json({ post: { ...safePost, has_password: !!post.password_hash }, tags: tags.map((x) => x.name), autosave });
    }
    if (method === 'PUT' && sub === '') {
      // 编辑冲突检测：前端带 base_updated_at，不一致就提示先对比
      const body = await readJson(request);
      if (body.base_updated_at && Number(body.base_updated_at) !== post.updated_at && body.force !== true) {
        throw new HttpError('conflict', '这篇文章已在其他地方被修改过，请先对比再保存（或带 force=true 强行覆盖）', 409);
      }
      const updated = await applyPostWrite(env, post, body);
      if (body.save_revision) await saveRevision(env, updated, body.revision_note || '手动保存');
      return json({ post: updated });
    }
    if (method === 'DELETE' && sub === '') {
      if (post.status === 'trash') {
        if (url.searchParams.get('purge') !== '1') throw badRequest('彻底删除需带 ?purge=1 二次确认');
        await run(env, 'DELETE FROM posts WHERE id = ?', id);
        await run(env, 'DELETE FROM post_tags WHERE post_id = ?', id);
        await run(env, 'DELETE FROM post_revisions WHERE post_id = ?', id);
        await run(env, 'DELETE FROM autosaves WHERE post_id = ?', id);
        await run(env, 'DELETE FROM comments WHERE post_id = ?', id);
        await run(env, 'DELETE FROM view_stats WHERE post_id = ?', id);
        await run(env, 'DELETE FROM preview_tokens WHERE post_id = ?', id);
        return json({ purged: true });
      }
      const updated = await applyPostWrite(env, post, { status: 'trash' });
      return json({ post: updated });
    }
    if (method === 'POST' && sub === '/publish') {
      const body = await readJson(request);
      const target = ['published', 'scheduled', 'private'].includes(body.status) ? body.status : 'published';
      const updated = await applyPostWrite(env, post, { ...body, status: target });
      await saveRevision(env, updated, target === 'published' ? '发布' : target === 'scheduled' ? '定时发布' : '设为私密');
      return json({ post: updated });
    }
    if (method === 'POST' && sub === '/restore-trash') {
      const updated = await applyPostWrite(env, post, { status: 'draft' });
      return json({ post: updated });
    }
    if (method === 'PUT' && sub === '/autosave') {
      const body = await readJson(request);
      await run(env, 'INSERT INTO autosaves (post_id, title, content_md, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(post_id) DO UPDATE SET title=excluded.title, content_md=excluded.content_md, updated_at=excluded.updated_at',
        id, String(body.title || '').slice(0, 200), String(body.content_md || ''), nowSec());
      return json({ ok: true, saved_at: nowSec() });
    }
    if (method === 'GET' && sub === '/revisions') {
      const rows = await all(env, 'SELECT id, title, note, created_at, LENGTH(content_md) AS size FROM post_revisions WHERE post_id = ? ORDER BY created_at DESC, id DESC LIMIT 20', id);
      return json({ revisions: rows });
    }
    const revMatch = sub.match(/^\/revisions\/(\d+)\/restore$/);
    if (method === 'POST' && revMatch) {
      const rev = await first(env, 'SELECT * FROM post_revisions WHERE id = ? AND post_id = ?', Number(revMatch[1]), id);
      if (!rev) throw notFound('版本不存在');
      await saveRevision(env, post, `还原自版本 #${rev.id} 前的自动存档`);
      const updated = await applyPostWrite(env, post, { title: rev.title, content_md: rev.content_md });
      return json({ post: updated });
    }
    if (method === 'POST' && sub === '/preview-token') {
      const tokenPlain = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
      const expires = nowSec() + 7 * 24 * 3600;
      await run(env, 'INSERT INTO preview_tokens (post_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)',
        id, await hashSecret(env, tokenPlain), expires, nowSec());
      return json({ url: `/preview/${id}?key=${tokenPlain}`, expires_at: expires });
    }
  }

  // ---- 媒体 ----
  if (method === 'POST' && path === '/api/admin/media/sign') {
    const iph = await ipHash(env, request);
    const rl = await checkLimit(env, settings, 'sign', iph);
    if (!rl.allowed) throw new HttpError('rate_limited', '签发上传过于频繁', 429);
    const body = await readJson(request);
    const mime = String(body.mime || '');
    const spec = MIME_MAP[mime];
    if (!spec) throw badRequest(`不支持的文件类型：${mime || '(空)'}`);
    const size = Number(body.size) || 0;
    const maxMb = spec.kind === 'image' ? settings.upload_image_max_mb : spec.kind === 'video' ? settings.upload_video_max_mb : settings.upload_file_max_mb;
    if (size <= 0) throw badRequest('文件大小不合法');
    if (size > maxMb * 1024 * 1024) {
      throw badRequest(spec.kind === 'video'
        ? `视频超过 ${maxMb}MB 上限：大视频建议贴 B 站/YouTube 外链（零存储、播放更流畅），本地直传留给短视频`
        : `文件超过 ${maxMb}MB 上限`);
    }
    const key = newObjectKey(spec.kind, spec.ext);
    const t = nowSec();
    const r = await run(env, "INSERT INTO media (r2_key, kind, display_name, orig_name, mime, size_bytes, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
      key, spec.kind, String(body.display_name || body.orig_name || key).slice(0, 120), String(body.orig_name || '').slice(0, 200), mime, size, t);
    const signed = await presignPut(env, key, mime, 600);
    return json({ media_id: r.meta.last_row_id, put_url: signed.url, headers: signed.headers, expires_in: signed.expires_in, media_url: publicMediaUrl(env, key), r2_key: key });
  }

  if (method === 'POST' && path === '/api/admin/media/complete') {
    const body = await readJson(request);
    const row = await first(env, 'SELECT * FROM media WHERE id = ?', Number(body.media_id));
    if (!row) throw notFound('媒体记录不存在');
    if (!env.MEDIA) throw badRequest('媒体桶未绑定');
    const head = await env.MEDIA.head(row.r2_key);
    if (!head) throw badRequest('对象还不存在：上传可能未完成，请重试');
    if (head.size !== row.size_bytes) throw badRequest(`大小对不上：登记 ${row.size_bytes} 字节，实际 ${head.size} 字节`);
    await run(env, 'UPDATE media SET status=?, width=?, height=?, duration_sec=? WHERE id = ?',
      'ready', Number(body.width) || null, Number(body.height) || null, Number(body.duration_sec) || null, row.id);
    return json({ media_id: row.id, media_url: publicMediaUrl(env, row.r2_key) });
  }

  if (path.startsWith('/api/admin/media/multipart')) {
    return json({ error: '分片上传尚未启用：200MB 以内的文件请用普通直传' }, 501);
  }

  // 相册（分组）清单：每个非空 album 一项，带文件数与总大小（媒体库分组导航用）
  if (method === 'GET' && path === '/api/admin/media/albums') {
    const rows = await all(env, `SELECT album, COUNT(*) AS count, COALESCE(SUM(size_bytes),0) AS bytes
      FROM media WHERE status != 'trashed' AND album IS NOT NULL AND album != '' GROUP BY album ORDER BY album`);
    return json({ albums: rows });
  }

  if (method === 'GET' && path === '/api/admin/media') {
    const album = url.searchParams.get('album') || '';
    const status = url.searchParams.get('status') || '';
    const q = (url.searchParams.get('q') || '').trim();
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const per = 30;
    // 默认排除回收站；?status=trashed 看媒体回收站（可还原）；?status=ready/pending 按状态筛
    const conds = [status ? 'status = ?' : "status != 'trashed'"];
    const params = status ? [status] : [];
    if (album) { conds.push('album = ?'); params.push(album); }
    if (q) { conds.push('(display_name LIKE ? OR orig_name LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
    const rows = await all(env, `SELECT * FROM media WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`, ...params, per, (page - 1) * per);
    return json({ media: rows.map((m) => ({ ...m, url: publicMediaUrl(env, m.r2_key) })), usage: await mediaUsage(env), page, per });
  }

  const mediaMatch = path.match(/^\/api\/admin\/media\/(\d+)(\/restore)?$/);
  if (mediaMatch && method === 'POST' && mediaMatch[2] === '/restore') {
    // 媒体回收站还原：trashed → ready（对象本体还在桶里，真删由清理任务到期做、或后台回收站里手动彻底删除）
    const row = await first(env, 'SELECT * FROM media WHERE id = ?', Number(mediaMatch[1]));
    if (!row) throw notFound('媒体不存在');
    if (row.status !== 'trashed') throw badRequest('该文件不在回收站里');
    await run(env, "UPDATE media SET status='ready', trashed_at=NULL WHERE id = ?", row.id);
    return json({ ok: true });
  }
  if (mediaMatch && method === 'PATCH') {
    const body = await readJson(request);
    const sets = [];
    const params = [];
    if (body.display_name !== undefined) { sets.push('display_name = ?'); params.push(String(body.display_name).slice(0, 120)); }
    if (body.album !== undefined) { sets.push('album = ?'); params.push(String(body.album).slice(0, 60) || null); }
    if (!sets.length) throw badRequest('没有要改的字段');
    await run(env, `UPDATE media SET ${sets.join(', ')} WHERE id = ?`, ...params, Number(mediaMatch[1]));
    return json({ ok: true });
  }
  if (mediaMatch && method === 'DELETE') {
    const row = await first(env, 'SELECT * FROM media WHERE id = ?', Number(mediaMatch[1]));
    if (!row) throw notFound('媒体不存在');
    if (url.searchParams.get('purge') === '1') {
      // 彻底删除（立即真删，v1.1.4）：只准对已在回收站里的媒体用——必须先走软删进回收站，
      // 不许拿 purge=1 绕过两步口径直接真删还没删过的文件。
      if (row.status !== 'trashed') throw badRequest('彻底删除只对回收站里的文件可用，请先移入回收站');
      const refs = await recountMediaRef(env, row);
      if (refs > 0 && url.searchParams.get('force') !== '1') {
        const usedBy = await all(env, "SELECT title FROM posts WHERE status != 'trash' AND content_md LIKE ? LIMIT 5", `%${row.r2_key}%`);
        throw new HttpError('in_use', `该文件正被 ${refs} 篇文章引用（${usedBy.map((x) => x.title).join('、')}），确认要删请带 force=1`, 409);
      }
      // 删法与清理任务 purge 的媒体真删同款：本站媒体只有一个对象键 r2_key（无缩略图等派生键），
      // 先删 R2 对象本体、再删 media 行；对象删除失败不拦行删除（与任务侧口径一致）。
      if (env.MEDIA) { try { await env.MEDIA.delete(row.r2_key); } catch { /* 对象可能已不存在 */ } }
      await run(env, 'DELETE FROM media WHERE id = ?', row.id);
      return json({ purged: true });
    }
    const refs = await recountMediaRef(env, row);
    if (refs > 0 && url.searchParams.get('force') !== '1') {
      const usedBy = await all(env, "SELECT title FROM posts WHERE status != 'trash' AND content_md LIKE ? LIMIT 5", `%${row.r2_key}%`);
      // refs 的口径是四处引用合计（正文/封面/说说/头像），文案别只说「篇文章」
      throw new HttpError('in_use', `该文件正被引用 ${refs} 处（正文/封面/说说/头像合计${usedBy.length ? `，如文章：${usedBy.map((x) => x.title).join('、')}` : ''}），确认要删请带 force=1`, 409);
    }
    // 落 trashed_at：清理任务按它算保留期（默认 30 天），没这个时间戳就无从判断到期与否
    await run(env, "UPDATE media SET status='trashed', trashed_at=? WHERE id = ?", nowSec(), row.id);
    return json({ ok: true, note: `已移入媒体回收站，${settings.trash_keep_days || 30} 天后由清理任务真删（保留天数以后台设置为准）` });
  }

  // ---- 评论管理（分页 + 可按文章筛选） ----
  if (method === 'GET' && path === '/api/admin/comments') {
    const status = url.searchParams.get('status') || 'pending';
    const postId = Number(url.searchParams.get('post_id')) || 0;
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const per = Math.min(100, Math.max(1, Number(url.searchParams.get('per')) || 20));
    const conds = ['c.status = ?'];
    const params = [status];
    if (postId) { conds.push('c.post_id = ?'); params.push(postId); }
    const where = `WHERE ${conds.join(' AND ')}`;
    const total = (await first(env, `SELECT COUNT(*) AS n FROM comments c ${where}`, ...params))?.n || 0;
    const rows = await all(env, `SELECT c.*, p.title AS post_title, p.slug AS post_slug FROM comments c JOIN posts p ON p.id = c.post_id
      ${where} ORDER BY c.created_at DESC LIMIT ? OFFSET ?`, ...params, per, (page - 1) * per);
    return json({ comments: rows.map((c) => ({ ...c, html: renderCommentText(c.content) })), total, page, per });
  }
  const cmtMatch = path.match(/^\/api\/admin\/comments\/(\d+)\/(approve|reject|spam)$/);
  if (method === 'POST' && cmtMatch) {
    const map = { approve: 'approved', reject: 'trash', spam: 'spam' };
    const target = map[cmtMatch[2]];
    await run(env, 'UPDATE comments SET status = ? WHERE id = ?', target, Number(cmtMatch[1]));
    // 进回收站/垃圾箱落 trashed_at（迁移 0005），purge 按它算 30 天保留期；
    // 恢复通过则清空。生产库还没跑 0005 时这一句会失败——吞掉，不挡审核。
    await run(env, 'UPDATE comments SET trashed_at = ? WHERE id = ?',
      target === 'approved' ? null : nowSec(), Number(cmtMatch[1])).catch(() => {});
    return json({ ok: true });
  }
  const cmtDel = path.match(/^\/api\/admin\/comments\/(\d+)$/);
  if (method === 'DELETE' && cmtDel) {
    await run(env, "UPDATE comments SET status='trash' WHERE id = ?", Number(cmtDel[1]));
    await run(env, 'UPDATE comments SET trashed_at = ? WHERE id = ?', nowSec(), Number(cmtDel[1])).catch(() => {});
    return json({ ok: true });
  }
  if (method === 'POST' && path === '/api/admin/comments') {
    // 站长回复：直接通过、带站长标记。显示名用设置里的评论昵称，
    // 绝不用登录用户名（会随评论公开，成撞库/锁号靶子；审查 B#9）
    const body = await readJson(request);
    const postId = Number(body.post_id);
    const content = String(body.content || '').trim();
    if (!postId || !content) throw badRequest('内容不完整');
    const settings = await getSettings(env);
    const displayName = String(settings.author_nickname || '站长').slice(0, 30) || '站长';
    const r = await run(env, "INSERT INTO comments (post_id, parent_id, author_name, content, status, is_admin, created_at) VALUES (?, ?, ?, ?, 'approved', 1, ?)",
      postId, Number(body.parent_id) || 0, displayName, content.slice(0, 2000), nowSec());
    return json({ id: r.meta.last_row_id });
  }

  // ---- 设置 ----
  if (method === 'GET' && path === '/api/admin/settings') {
    return json({ settings });
  }
  if (method === 'PUT' && path === '/api/admin/settings') {
    const body = await readJson(request);
    const patch = {};
    for (const [k, v] of Object.entries(body.settings || {})) {
      try { patch[k] = validateSetting(k, v); }
      catch (e) { throw badRequest(e.message); }
    }
    const ver = await saveSettings(env, patch);
    return json({ ok: true, version: ver, settings: await getSettings(env, true) });
  }

  // ---- 说说 ----
  if (method === 'GET' && path === '/api/admin/moments') {
    const rows = await all(env, "SELECT * FROM moments WHERE status != 'trash' ORDER BY created_at DESC LIMIT 100");
    return json({ moments: rows });
  }
  if (method === 'POST' && path === '/api/admin/moments') {
    const body = await readJson(request);
    const content = String(body.content || '').trim();
    if (!content) throw badRequest('说说内容为空');
    const t = nowSec();
    const r = await run(env, 'INSERT INTO moments (content, media_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      content.slice(0, 1000), Number(body.media_id) || null, body.status === 'draft' ? 'draft' : 'published', t, t);
    return json({ id: r.meta.last_row_id });
  }
  const moMatch = path.match(/^\/api\/admin\/moments\/(\d+)$/);
  if (method === 'PUT' && moMatch) {
    const body = await readJson(request);
    await run(env, 'UPDATE moments SET content = ?, status = ?, updated_at = ? WHERE id = ?',
      String(body.content || '').slice(0, 1000), body.status || 'published', nowSec(), Number(moMatch[1]));
    return json({ ok: true });
  }
  if (method === 'DELETE' && moMatch) {
    // 进回收站时刷新 updated_at：定时清理按 updated_at 算 30 天保留期，
    // 不刷新的话「很久没编辑、刚删」的说说会被立刻真删（2026-11-09 审校修正）
    await run(env, "UPDATE moments SET status='trash', updated_at = ? WHERE id = ?", nowSec(), Number(moMatch[1]));
    return json({ ok: true });
  }

  // ---- 友链 ----
  // 友链三个 URL 字段写入时校验协议：只许 http(s) 或留空。esc() 挡不住
  // javascript: 进 href——导入恶意备份也能种下存储型 XSS（审查 B#14）；
  // 渲染侧（pages.js /links）另有 safeUrl 兜底。
  const checkFriendUrl = (v, label) => {
    const s = String(v || '').trim();
    if (!s) return null;
    if (!/^https?:\/\//i.test(s)) throw badRequest(`${label}只支持 http(s) 链接`);
    return s.slice(0, 500);
  };
  if (method === 'GET' && path === '/api/admin/friends') {
    return json({ friends: await all(env, 'SELECT * FROM friend_links ORDER BY sort_order, id') });
  }
  if (method === 'POST' && path === '/api/admin/friends') {
    const body = await readJson(request);
    if (!body.name || !body.url) throw badRequest('名称与链接必填');
    const r = await run(env, 'INSERT INTO friend_links (name, url, rss_url, avatar_url, desc, sort_order, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      String(body.name).slice(0, 60), checkFriendUrl(body.url, '链接'), checkFriendUrl(body.rss_url, 'RSS 地址'), checkFriendUrl(body.avatar_url, '头像地址'),
      String(body.desc || '').slice(0, 200), Number(body.sort_order) || 0, body.enabled === false ? 0 : 1, nowSec());
    return json({ id: r.meta.last_row_id });
  }
  const frMatch = path.match(/^\/api\/admin\/friends\/(\d+)(\/check)?$/);
  if (frMatch && method === 'PUT') {
    const body = await readJson(request);
    await run(env, 'UPDATE friend_links SET name=?, url=?, rss_url=?, avatar_url=?, desc=?, sort_order=?, enabled=? WHERE id=?',
      String(body.name || '').slice(0, 60), checkFriendUrl(body.url, '链接'), checkFriendUrl(body.rss_url, 'RSS 地址'), checkFriendUrl(body.avatar_url, '头像地址'),
      String(body.desc || '').slice(0, 200), Number(body.sort_order) || 0, body.enabled === false ? 0 : 1, Number(frMatch[1]));
    return json({ ok: true });
  }
  if (frMatch && method === 'DELETE') {
    await run(env, 'DELETE FROM friend_links WHERE id = ?', Number(frMatch[1]));
    return json({ ok: true });
  }
  if (frMatch && method === 'POST' && frMatch[2] === '/check') {
    const link = await first(env, 'SELECT * FROM friend_links WHERE id = ?', Number(frMatch[1]));
    if (!link) throw notFound('友链不存在');
    const { checkOneLink } = await import('./tasks-api.js');
    const health = await checkOneLink(env, link);
    return json({ health });
  }

  // ---- 备份列表（分页：时间/种类/大小/对账计数），下载与删除在 /backups/:id 子路径 ----
  if (method === 'GET' && path === '/api/admin/backups') {
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const per = Math.min(50, Math.max(1, Number(url.searchParams.get('per')) || 20));
    const total = (await first(env, 'SELECT COUNT(*) AS n FROM backups'))?.n || 0;
    const rows = await all(env, 'SELECT id, kind, r2_key, size_bytes, post_count, media_count, note, created_at FROM backups ORDER BY created_at DESC LIMIT ? OFFSET ?', per, (page - 1) * per);
    const last = rows[0] || await first(env, 'SELECT created_at FROM backups ORDER BY created_at DESC LIMIT 1');
    return json({ backups: rows, total, page, per, last_backup_at: last?.created_at || null });
  }
  const bkMatch = path.match(/^\/api\/admin\/backups\/(\d+)(\/download)?$/);
  if (bkMatch && method === 'GET' && bkMatch[2] === '/download') {
    const row = await first(env, 'SELECT * FROM backups WHERE id = ?', Number(bkMatch[1]));
    if (!row) throw notFound('备份不存在');
    if (!env.BACKUPS) throw badRequest('备份桶未绑定');
    const obj = await env.BACKUPS.get(row.r2_key);
    if (!obj) throw notFound('备份文件已不在备份桶里（可能已被保留策略清理）');
    const text = await obj.text();
    return new Response(text, {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="ym-blog-backup-${row.id}.json"`,
      },
    });
  }
  if (bkMatch && method === 'DELETE' && !bkMatch[2]) {
    const row = await first(env, 'SELECT * FROM backups WHERE id = ?', Number(bkMatch[1]));
    if (!row) throw notFound('备份不存在');
    if (env.BACKUPS && row.r2_key) { try { await env.BACKUPS.delete(row.r2_key); } catch { /* 对象没了就算了 */ } }
    await run(env, 'DELETE FROM backups WHERE id = ?', row.id);
    return json({ ok: true });
  }

  // ---- 导出 / 导入 / 备份 ----
  if (method === 'GET' && path === '/api/admin/export/markdown') {
    const { files, counts } = await buildMarkdownPack(env);
    const zip = zipStore(files);
    return new Response(zip, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="ym-blog-escape-${new Date().toISOString().slice(0, 10)}.zip"`,
        'X-Export-Counts': JSON.stringify(counts),
      },
    });
  }
  if (method === 'GET' && path === '/api/admin/export/full.json') {
    const data = await exportSite(env);
    return new Response(JSON.stringify(data, null, 2), {
      headers: { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="ym-blog-full-${new Date().toISOString().slice(0, 10)}.json"` },
    });
  }
  if (method === 'POST' && path === '/api/admin/import') {
    const body = await readJson(request);
    if (body.confirm !== true) throw badRequest('导入需二次确认：请求体带 confirm=true');
    // 恢复前强制先备份当前站（学 Halo 的做法）。旧版备份桶没绑定时
    // 静默跳过备份照样导入，与「强制先备份」的承诺不符（审查 A#3）：
    // 没绑定、或备份写入失败，一律终止导入、先把备份通道修好再来。
    if (!env.BACKUPS) throw badRequest('备份桶未绑定（BACKUPS），无法在导入前自动备份，已取消导入');
    const before = await exportSite(env);
    const key = `backup/${new Date().toISOString().slice(0, 10)}/pre-import-${nowSec()}.json`;
    const beforeText = JSON.stringify(before);
    try {
      await env.BACKUPS.put(key, beforeText);
    } catch (e) {
      throw badRequest('导入前自动备份写入失败，已取消导入：' + (e?.message || e));
    }
    await run(env, "INSERT INTO backups (kind, r2_key, size_bytes, post_count, media_count, note, created_at) VALUES ('pre-import', ?, ?, ?, ?, '导入前自动备份', ?)",
      key, new TextEncoder().encode(beforeText).length, countOf(before).posts, countOf(before).media, nowSec());
    const report = await importSite(env, body.data);
    return json({ report });
  }
  if (method === 'POST' && path === '/api/admin/backup/run') {
    const { runBackup } = await import('./tasks-api.js');
    const rec = await runBackup(env, 'manual');
    return json({ backup: rec });
  }

  return null;
}
