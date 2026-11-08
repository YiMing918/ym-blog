// pages.js — 访客侧全部 SSR 页面：首页/文章/归档/标签/搜索/说说/友链/关于/草稿预览/404
// 原则：文章正文用发布时预渲染好的 rendered_html 直出（不在读路径现算）；无 JS 时正文照常可读；
// 互动（灯箱/进度/评论提交/上报）才由 assets/js/site.js 增强。
// 私密文一律返回 404 假象，不泄露存在性；密码文未解锁只出解锁页。

import { all, first } from '../_lib/db.js';
import { esc, nowSec, isoOf } from '../_lib/http.js';
import { getSettings } from '../_lib/settings.js';
import { getSessionUser } from '../_lib/auth.js';
import { hashSecret } from '../_lib/hash.js';
import { isPubliclyVisible, isUnlocked } from './public-api.js';
import { renderCommentText } from '../_lib/sanitize.js';
import { renderMarkdown, readingMinutes } from '../_lib/render.js';
import { hotPosts, postTotalViews } from '../_lib/stats.js';
import { publicMediaUrl } from '../_lib/r2sign.js';

const fmtDate = (sec) => (sec ? new Date(sec * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 10) : '');
const monthKey = (sec) => fmtDate(sec).slice(0, 7);

function themeAttr(settings) {
  if (settings.dark_mode === 'dark') return ' data-theme="dark"';
  if (settings.dark_mode === 'light') return ' data-theme="light"';
  return ' data-theme="auto"';
}

async function layout(env, request, settings, { title, body, desc = '', adminUser = null, extraHead = '' }) {
  const s = settings;
  const navSearch = s.search_on ? `<form class="nav-search" action="/search" method="get"><input name="q" type="search" placeholder="搜索文章…" aria-label="搜索文章"></form>` : '';
  const avatar = '';
  const html = `<!DOCTYPE html>
<html lang="zh-CN"${themeAttr(s)}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(s.site_name)}</title>
<meta name="description" content="${esc(desc || s.site_desc || '')}">
<link rel="stylesheet" href="/assets/css/site.css">
${s.rss_on ? '<link rel="alternate" type="application/rss+xml" title="RSS" href="/rss.xml">' : ''}
<style>:root{--accent:${esc(s.accent_color || '#e8710a')}}</style>
${extraHead}
</head>
<body>
<div id="progress" aria-hidden="true"></div>
<header class="site-header">
  <a class="brand" href="/">${avatar}<span class="brand-name">${esc(s.site_name)}</span></a>
  <nav class="site-nav">
    <a href="/">首页</a><a href="/archive">归档</a><a href="/tags">标签</a><a href="/moments">说说</a><a href="/links">友链</a><a href="/about">关于</a>
  </nav>
  ${navSearch}
  <button id="themeToggle" class="theme-toggle" type="button" title="切换深浅色">🌗</button>
</header>
${adminUser ? `<div class="admin-bar">站长模式：${esc(adminUser.username)} · <a href="/admin/">进入后台</a></div>` : ''}
<main class="wrap">
${body}
</main>
<footer class="site-footer">
  <p>© ${esc(s.site_name)}${s.rss_on ? ' · <a class="foot-rss" href="/rss.xml">RSS 订阅</a>' : ''} · 由 ym-blog 驱动（Powered by ym-blog）</p>
</footer>
<script src="/assets/js/site.js" defer></script>
<script src="/assets/js/beacon.js" defer></script>
</body>
</html>`;
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      ...(adminUser ? { 'Cache-Control': 'private, no-store' } : { 'Cache-Control': 'public, max-age=60' }),
    },
  });
}

async function coverUrlOf(env, post) {
  if (post.cover_media_id) {
    const m = await first(env, 'SELECT r2_key FROM media WHERE id = ?', post.cover_media_id);
    if (m) return publicMediaUrl(env, m.r2_key);
  }
  const { firstImageOf } = await import('../_lib/render.js');
  return firstImageOf(post.content_md);
}

function postListItem(post, cover, settings) {
  const date = fmtDate(post.publish_at || post.created_at);
  if (settings.layout_home === 'list') {
    return `<article class="post-row">
      ${cover ? `<a class="row-thumb" href="/post/${esc(post.slug)}"><img src="${esc(cover)}" alt="" loading="lazy"></a>` : ''}
      <div class="row-main">
        <h3><a href="/post/${esc(post.slug)}">${post.is_sticky ? '📌 ' : ''}${esc(post.title)}</a></h3>
        <p class="excerpt">${esc(post.excerpt || '')}</p>
        <p class="meta">${date} · 约 ${post.word_count || 0} 字</p>
      </div>
    </article>`;
  }
  return `<article class="post-card">
    ${cover ? `<a class="card-cover" href="/post/${esc(post.slug)}"><img src="${esc(cover)}" alt="" loading="lazy"></a>` : ''}
    <div class="card-body">
      <h3><a href="/post/${esc(post.slug)}">${post.is_sticky ? '📌 ' : ''}${esc(post.title)}</a></h3>
      <p class="excerpt">${esc(post.excerpt || '')}</p>
      <p class="meta">${date} · 约 ${post.word_count || 0} 字</p>
    </div>
  </article>`;
}

async function onThisDay(env, t) {
  const md = new Date(t * 1000 + 8 * 3600 * 1000).toISOString().slice(5, 10);
  const posts = await all(env, `SELECT slug, title, publish_at FROM posts WHERE type='post'
    AND (status='published' OR (status='scheduled' AND publish_at<=?))
    AND strftime('%m-%d', publish_at, 'unixepoch', '+8 hours') = ? AND strftime('%Y', publish_at, 'unixepoch', '+8 hours') != strftime('%Y', 'now')
    ORDER BY publish_at DESC LIMIT 5`, t, md);
  return posts;
}

export async function handlePages(env, request, method, path, url) {
  if (method !== 'GET') return null;
  const settings = await getSettings(env);
  const adminUser = await getSessionUser(env, request);
  const t = nowSec();
  const pubCond = "(status='published' OR (status='scheduled' AND publish_at<=?))";

  // ---------- 首页 ----------
  if (path === '/') {
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const per = settings.posts_per_page || 10;
    const posts = await all(env, `SELECT * FROM posts WHERE type='post' AND ${pubCond}
      ORDER BY is_sticky DESC, publish_at DESC LIMIT ? OFFSET ?`, t, per, (page - 1) * per);
    const total = (await first(env, `SELECT COUNT(*) AS n FROM posts WHERE type='post' AND ${pubCond}`, t))?.n || 0;
    const cards = [];
    for (const p of posts) cards.push(postListItem(p, await coverUrlOf(env, p), settings));
    const moments = await all(env, "SELECT * FROM moments WHERE status='published' ORDER BY created_at DESC LIMIT 3");
    const otd = await onThisDay(env, t);
    const hot = await hotPosts(env, 30, 5);
    const side = `
    <aside class="side">
      ${moments.length ? `<section class="side-box"><h4>最新说说</h4>${moments.map((m) => `<p class="moment-mini">${esc(m.content)} <span class="meta">${fmtDate(m.created_at)}</span></p>`).join('')}<p><a href="/moments">全部说说 →</a></p></section>` : ''}
      ${otd.length ? `<section class="side-box"><h4>那年今日</h4><ul>${otd.map((p) => `<li><a href="/post/${esc(p.slug)}">${esc(p.title)}</a> <span class="meta">${fmtDate(p.publish_at)}</span></li>`).join('')}</ul></section>` : ''}
      ${hot.length ? `<section class="side-box"><h4>热门文章（近 30 天）</h4><ol>${hot.map((p) => `<li><a href="/post/${esc(p.slug)}">${esc(p.title)}</a> <span class="meta">${p.pv} 次阅读</span></li>`).join('')}</ol></section>` : ''}
    </aside>`;
    const pager = total > per ? `<nav class="pager">${page > 1 ? `<a href="/?page=${page - 1}">← 上一页</a>` : ''}<span>第 ${page} 页</span>${page * per < total ? `<a href="/?page=${page + 1}">下一页 →</a>` : ''}</nav>` : '';
    const body = `
      <section class="hero"><h1>${esc(settings.hero_title || settings.site_name)}</h1><p>${esc(settings.hero_text || settings.site_desc || '')}</p></section>
      <div class="home-grid"><section class="post-list ${settings.layout_home}">${cards.join('') || '<p class="empty">还没有文章。</p>'}${pager}</section>${side}</div>`;
    return layout(env, request, settings, { title: '首页', body, adminUser });
  }

  // ---------- 文章页 ----------
  const postPageMatch = path.match(/^\/post\/(.+)$/);
  if (postPageMatch) {
    const slug = decodeURIComponent(postPageMatch[1]);
    let post = await first(env, 'SELECT * FROM posts WHERE slug = ?', slug);
    if (!post) {
      const red = await first(env, 'SELECT post_id FROM redirects WHERE old_slug = ?', slug);
      if (red) {
        const target = await first(env, 'SELECT slug FROM posts WHERE id = ?', red.post_id);
        if (target) return Response.redirect(new URL(`/post/${target.slug}`, request.url).toString(), 301);
      }
      return notFoundPage(env, request, settings, adminUser);
    }
    const visible = isPubliclyVisible(post, t);
    if (!visible && !adminUser) return notFoundPage(env, request, settings, adminUser);
    if (post.status === 'private' && !adminUser) return notFoundPage(env, request, settings, adminUser);
    return renderPostPage(env, request, settings, post, { adminUser, draft: false });
  }

  // ---------- 草稿预览 ----------
  const previewMatch = path.match(/^\/preview\/(\d+)$/);
  if (previewMatch) {
    const key = url.searchParams.get('key') || '';
    const postId = Number(previewMatch[1]);
    const rows = await all(env, 'SELECT token_hash, expires_at, revoked FROM preview_tokens WHERE post_id = ?', postId);
    const keyHash = key ? await hashSecret(env, key) : '';
    const ok = rows.some((r) => !r.revoked && r.expires_at > t && r.token_hash === keyHash);
    if (!ok) return notFoundPage(env, request, settings, adminUser);
    const post = await first(env, 'SELECT * FROM posts WHERE id = ?', postId);
    if (!post) return notFoundPage(env, request, settings, adminUser);
    return renderPostPage(env, request, settings, post, { adminUser, draft: true });
  }

  // ---------- 归档 ----------
  if (path === '/archive') {
    const posts = await all(env, `SELECT slug, title, publish_at FROM posts WHERE type='post' AND ${pubCond} ORDER BY publish_at DESC LIMIT 1000`, t);
    const groups = new Map();
    for (const p of posts) {
      const k = monthKey(p.publish_at || p.created_at);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(p);
    }
    const body = `<h1 class="page-title">归档（Archive）</h1>` + [...groups.entries()].map(([k, list]) =>
      `<section class="archive-group"><h2>${esc(k)} <span class="meta">${list.length} 篇</span></h2><ul>${list.map((p) => `<li><span class="meta">${fmtDate(p.publish_at)}</span> <a href="/post/${esc(p.slug)}">${esc(p.title)}</a></li>`).join('')}</ul></section>`).join('');
    return layout(env, request, settings, { title: '归档', body, adminUser });
  }

  // ---------- 标签 ----------
  if (path === '/tags') {
    const tags = await all(env, `SELECT t.name, t.slug, COUNT(pt.post_id) AS n FROM tags t JOIN post_tags pt ON pt.tag_id = t.id
      JOIN posts p ON p.id = pt.post_id WHERE ${pubCond.replaceAll('status', 'p.status').replaceAll('publish_at', 'p.publish_at')} GROUP BY t.id ORDER BY n DESC`, t);
    const body = `<h1 class="page-title">标签（Tags）</h1><div class="tag-cloud">${tags.map((x) => `<a class="tag-chip" style="font-size:${Math.min(22, 13 + x.n * 2)}px" href="/tag/${esc(x.slug)}">${esc(x.name)} <span class="meta">${x.n}</span></a>`).join('') || '<p class="empty">还没有标签。</p>'}</div>`;
    return layout(env, request, settings, { title: '标签', body, adminUser });
  }
  const tagMatch = path.match(/^\/tag\/(.+)$/);
  if (tagMatch) {
    const tag = await first(env, 'SELECT * FROM tags WHERE slug = ?', decodeURIComponent(tagMatch[1]));
    if (!tag) return notFoundPage(env, request, settings, adminUser);
    const posts = await all(env, `SELECT p.* FROM posts p JOIN post_tags pt ON pt.post_id = p.id
      WHERE pt.tag_id = ? AND p.type='post' AND (p.status='published' OR (p.status='scheduled' AND p.publish_at<=?))
      ORDER BY p.publish_at DESC LIMIT 100`, tag.id, t);
    const cards = [];
    for (const p of posts) cards.push(postListItem(p, await coverUrlOf(env, p), settings));
    const body = `<h1 class="page-title">标签：${esc(tag.name)}</h1><section class="post-list ${settings.layout_home}">${cards.join('') || '<p class="empty">这个标签下还没有文章。</p>'}</section>`;
    return layout(env, request, settings, { title: `标签 ${tag.name}`, body, adminUser });
  }

  // ---------- 搜索 ----------
  if (path === '/search') {
    if (!settings.search_on) return notFoundPage(env, request, settings, adminUser);
    const q = (url.searchParams.get('q') || '').trim().slice(0, 60);
    let resultsHtml = '';
    if (q) {
      const like = `%${q.replace(/[%_]/g, '')}%`;
      const rows = await all(env, `SELECT * FROM posts WHERE type='post' AND ${pubCond}
        AND (title LIKE ? OR excerpt LIKE ? OR content_md LIKE ?) ORDER BY publish_at DESC LIMIT 20`, t, like, like, like);
      const cards = [];
      for (const p of rows) cards.push(postListItem(p, await coverUrlOf(env, p), settings));
      resultsHtml = `<section class="post-list ${settings.layout_home}">${cards.join('') || '<p class="empty">没有找到相关文章。</p>'}</section>`;
    }
    const body = `<h1 class="page-title">搜索（Search）</h1>
      <form class="search-form" action="/search" method="get"><input name="q" type="search" value="${esc(q)}" placeholder="输入关键词…" aria-label="搜索关键词"><button type="submit">搜索</button></form>${resultsHtml}`;
    return layout(env, request, settings, { title: '搜索', body, adminUser });
  }

  // ---------- 说说 ----------
  if (path === '/moments') {
    const list = await all(env, "SELECT * FROM moments WHERE status='published' ORDER BY created_at DESC LIMIT 100");
    const body = `<h1 class="page-title">说说（Moments）</h1><div class="moment-list">${list.map((m) => `<article class="moment"><p>${esc(m.content)}</p><p class="meta">${fmtDate(m.created_at)}</p></article>`).join('') || '<p class="empty">还没有说说。</p>'}</div>`;
    return layout(env, request, settings, { title: '说说', body, adminUser });
  }

  // ---------- 友链 ----------
  if (path === '/links') {
    const links = await all(env, 'SELECT * FROM friend_links WHERE enabled = 1 ORDER BY sort_order, id');
    const body = `<h1 class="page-title">友链（Links）</h1><div class="link-grid">${links.map((l) => {
      const dead = l.health === 'fail' && (l.fail_streak || 0) >= 3;
      return `<a class="link-card${dead ? ' link-dead' : ''}" href="${esc(l.url)}" target="_blank" rel="noopener">
        ${l.avatar_url ? `<img src="${esc(l.avatar_url)}" alt="" loading="lazy">` : ''}
        <span class="link-name">${esc(l.name)}</span>
        <span class="link-desc">${esc(l.desc || '')}</span>
        ${dead ? '<span class="link-dead-note">暂时打不开</span>' : ''}
      </a>`;
    }).join('') || '<p class="empty">还没有友链。</p>'}</div>
    <p class="meta">想交换友链？在任意文章下留言告诉站长即可。</p>`;
    return layout(env, request, settings, { title: '友链', body, adminUser });
  }

  // ---------- 关于 ----------
  if (path === '/about') {
    const post = await first(env, "SELECT * FROM posts WHERE slug='about' AND type='page' AND status='published'");
    if (!post) return notFoundPage(env, request, settings, adminUser);
    const rendered = post.rendered_html || renderMarkdown(post.content_md).html;
    const body = `<article class="article"><h1 class="page-title">${esc(post.title)}</h1><div class="article-body">${rendered}</div></article>`;
    return layout(env, request, settings, { title: post.title, body, adminUser });
  }

  return null; // 不是访客页面路径
}

// 文章页组装（正式页与草稿预览共用）
async function renderPostPage(env, request, settings, post, { adminUser, draft }) {
  const t = nowSec();
  // 密码文：未解锁只给解锁页
  if (post.password_hash && !adminUser && !(await isUnlocked(env, request, post))) {
    const body = `<article class="article unlock-box">
      <h1>${esc(post.title)}</h1>
      <p>这篇文章设置了密码，输入后才能看。</p>
      <form id="unlockForm" data-post-id="${post.id}">
        <input type="password" name="password" placeholder="文章密码" autocomplete="off" required>
        <button type="submit">解锁</button>
      </form><p class="form-msg" id="unlockMsg"></p></article>`;
    return layout(env, request, settings, { title: post.title, body, adminUser });
  }
  const rendered = post.rendered_html || renderMarkdown(post.content_md).html;
  // TOC：从渲染结果里抽 h2/h3（锚点在 render 时已写入）
  const toc = [];
  for (const m of rendered.matchAll(/<h([23]) id="([^"]+)">([\s\S]*?)<\/h\1>/g)) {
    toc.push({ level: Number(m[1]), id: m[2], text: m[3].replace(/<[^>]+>/g, '') });
  }
  const tocHtml = toc.length ? `<details class="toc" open><summary>目录（Contents）</summary><ul>${toc.map((x) => `<li class="lv${x.level}"><a href="#${esc(x.id)}">${esc(x.text)}</a></li>`).join('')}</ul></details>` : '';
  const tags = await all(env, 'SELECT t.name, t.slug FROM tags t JOIN post_tags pt ON pt.tag_id = t.id WHERE pt.post_id = ?', post.id);
  const stale = t - (post.updated_at || 0) > 365 * 86400
    ? `<p class="stale-note">这篇文章最后更新于 ${fmtDate(post.updated_at)}，已超过一年，内容可能过时，请注意甄别。</p>` : '';
  const views = await postTotalViews(env, post.id);
  // 相关文章（共同标签数排序）与上下篇
  let related = [];
  if (tags.length) {
    related = await all(env, `SELECT p.slug, p.title, COUNT(*) AS shared FROM posts p JOIN post_tags pt ON pt.post_id = p.id
      WHERE pt.tag_id IN (SELECT tag_id FROM post_tags WHERE post_id = ?) AND p.id != ? AND p.type='post'
      AND (p.status='published' OR (p.status='scheduled' AND p.publish_at<=?))
      GROUP BY p.id ORDER BY shared DESC, p.publish_at DESC LIMIT 4`, post.id, post.id, t);
  }
  const prev = await first(env, `SELECT slug, title FROM posts WHERE type='post' AND (status='published' OR (status='scheduled' AND publish_at<=?)) AND publish_at < ? ORDER BY publish_at DESC LIMIT 1`, t, post.publish_at || 0);
  const next = await first(env, `SELECT slug, title FROM posts WHERE type='post' AND (status='published' OR (status='scheduled' AND publish_at<=?)) AND publish_at > ? ORDER BY publish_at ASC LIMIT 1`, t, post.publish_at || 0);
  // 评论（已通过，一层回复）
  let commentsHtml = '';
  if (settings.comments_on && post.comment_enabled) {
    const comments = await all(env, "SELECT * FROM comments WHERE post_id = ? AND status='approved' ORDER BY created_at ASC LIMIT 200", post.id);
    const tops = comments.filter((c) => !c.parent_id);
    const replies = new Map();
    for (const c of comments) if (c.parent_id) {
      if (!replies.has(c.parent_id)) replies.set(c.parent_id, []);
      replies.get(c.parent_id).push(c);
    }
    const one = (c, isReply) => `<div class="comment${isReply ? ' reply' : ''}" id="comment-${c.id}">
      <p class="comment-head"><strong>${esc(c.author_name)}</strong>${c.is_admin ? ' <span class="admin-badge">站长</span>' : ''} <span class="meta">${fmtDate(c.created_at)}</span>
      <button class="reply-btn" type="button" data-reply="${c.id}">回复</button></p>
      <div class="comment-body">${renderCommentText(c.content)}</div>
      ${(replies.get(c.id) || []).map((r) => one(r, true)).join('')}
    </div>`;
    const tsWidget = settings.turnstile_on && settings.turnstile_site_key
      ? `<div class="cf-turnstile" data-sitekey="${esc(settings.turnstile_site_key)}"></div><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" defer></script>` : '';
    commentsHtml = `<section class="comments" id="comments">
      <h2>评论（Comments）</h2>
      <div class="comment-list">${tops.map((c) => one(c, false)).join('') || '<p class="empty">还没有评论，来抢沙发。</p>'}</div>
      <form id="commentForm" data-post-id="${post.id}">
        <input name="author_name" placeholder="昵称" maxlength="30" required>
        <input name="contact" placeholder="联系方式（可选，不公开）" maxlength="120">
        <textarea name="content" placeholder="说点什么…" maxlength="2000" required></textarea>
        <input type="hidden" name="parent_id" value="0">
        ${tsWidget}
        <button type="submit">发表评论</button>
        <p class="form-msg" id="commentMsg"></p>
      </form>
    </section>`;
  }
  const draftBar = draft ? '<div class="draft-bar">草稿预览（Draft Preview）——这篇文章尚未公开发布</div>' : '';
  const body = `${draftBar}
  <article class="article" data-post-id="${post.id}">
    <h1 class="article-title">${esc(post.title)}</h1>
    <p class="meta">${fmtDate(post.publish_at || post.created_at)} · 约 ${post.word_count || 0} 字 · 读完约 ${readingMinutes(post.word_count || 0)} 分钟 · ${views} 次阅读</p>
    ${stale}
    ${tocHtml}
    <div class="article-body">${rendered}</div>
    ${tags.length ? `<p class="post-tags">${tags.map((x) => `<a class="tag-chip" href="/tag/${esc(x.slug)}"># ${esc(x.name)}</a>`).join(' ')}</p>` : ''}
    ${related.length ? `<section class="related"><h2>相关文章</h2><ul>${related.map((r) => `<li><a href="/post/${esc(r.slug)}">${esc(r.title)}</a></li>`).join('')}</ul></section>` : ''}
    <nav class="prev-next">
      ${prev ? `<a href="/post/${esc(prev.slug)}">← 上一篇：${esc(prev.title)}</a>` : '<span></span>'}
      ${next ? `<a href="/post/${esc(next.slug)}">下一篇：${esc(next.title)} →</a>` : '<span></span>'}
    </nav>
  </article>
  ${commentsHtml}`;
  return layout(env, request, settings, { title: post.title, body, adminUser, desc: post.excerpt || '' });
}

export async function notFoundPage(env, request, settings, adminUser) {
  const body = `<section class="notfound"><h1>404</h1><p>这一页不存在，或者还没公开。</p>
    ${settings.search_on ? '<form class="search-form" action="/search" method="get"><input name="q" type="search" placeholder="换个关键词搜搜…"><button type="submit">搜索</button></form>' : ''}
    <p><a href="/">← 回首页</a></p></section>`;
  const resp = await layout(env, request, settings, { title: '页面不存在', body, adminUser });
  return new Response(resp.body, { status: 404, headers: resp.headers });
}
