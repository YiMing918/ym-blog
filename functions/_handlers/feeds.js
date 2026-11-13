// feeds.js — RSS / sitemap / robots 生成
// 生成物很小：读时生成 + 进程内缓存（以「最新文章更新时间 + 设置版本」为缓存键，变了自动失效）；
// RSS 只出摘要+链接（防全文盗采），关 RSS 开关时返回 404。

import { all } from '../_lib/db.js';
import { nowSec, esc } from '../_lib/http.js';
import { getSettings } from '../_lib/settings.js';
import { maskExcerpt } from './public-api.js';

let cache = { rssKey: '', rss: '', smKey: '', sitemap: '' };

function baseUrl(request, env) {
  if (env.SITE_BASE_URL) return env.SITE_BASE_URL.replace(/\/$/, '');
  const u = new URL(request.url);
  return `${u.protocol}//${u.host}`;
}

async function cacheKey(env) {
  // 缓存键必须覆盖一切会改变输出的变化：旧版只有 MAX(updated_at)——
  // 删掉/转私密一篇不是最新的文章时 MAX 不变、缓存照旧命中，删掉的
  // 文章还挂在 RSS 里；定时文章到点时没有任何字段变化，永远进不了
  // RSS（2026-11-13 三方审查 B#6）。改为「当前可见文章数 + 可见集合的
  // MAX(updated_at) + MAX(publish_at) + 设置版本」：可见集合一增一减、
  // 任一篇改动、定时到点（计数变化）都会换键。
  const t = nowSec();
  const rows = await all(env, `SELECT COUNT(*) AS n, MAX(updated_at) AS m, MAX(publish_at) AS mp FROM posts
    WHERE type='post' AND (status='published' OR (status='scheduled' AND publish_at<=?))`, t);
  const settings = await getSettings(env);
  return `${rows[0]?.n || 0}:${rows[0]?.m || 0}:${rows[0]?.mp || 0}:${settings._ver}`;
}

export async function handleFeeds(env, request, method, path) {
  if (method !== 'GET') return null;
  const settings = await getSettings(env);
  const base = baseUrl(request, env);
  const t = nowSec();

  if (path === '/robots.txt') {
    const body = `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nDisallow: /preview/\nSitemap: ${base}/sitemap.xml\n`;
    return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  if (path === '/rss.xml') {
    if (!settings.rss_on) return new Response('Not Found', { status: 404 });
    const key = await cacheKey(env);
    if (cache.rssKey === key && cache.rss) {
      return new Response(cache.rss, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
    }
    const posts = await all(env, `SELECT slug, title, excerpt, publish_at, password_hash FROM posts
      WHERE type='post' AND (status='published' OR (status='scheduled' AND publish_at<=?))
      ORDER BY publish_at DESC LIMIT 20`, t);
    const items = posts.map((p) => `    <item>
      <title>${esc(p.title)}</title>
      <link>${base}/post/${encodeURIComponent(p.slug)}</link>
      <guid>${base}/post/${encodeURIComponent(p.slug)}</guid>
      <pubDate>${new Date((p.publish_at || 0) * 1000).toUTCString()}</pubDate>
      <description>${esc(maskExcerpt(p))}</description>
    </item>`).join('\n');
    const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>${esc(settings.site_name)}</title>
  <link>${base}/</link>
  <description>${esc(settings.site_desc || '')}</description>
${items}
</channel></rss>`;
    cache = { ...cache, rssKey: key, rss };
    return new Response(rss, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
  }

  if (path === '/sitemap.xml') {
    const key = await cacheKey(env);
    if (cache.smKey === key && cache.sitemap) {
      return new Response(cache.sitemap, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
    }
    const posts = await all(env, `SELECT slug, updated_at FROM posts
      WHERE type='post' AND (status='published' OR (status='scheduled' AND publish_at<=?)) AND password_hash IS NULL
      ORDER BY publish_at DESC LIMIT 1000`, t);
    const urls = [`${base}/`, `${base}/archive`, `${base}/tags`, `${base}/moments`, `${base}/links`, `${base}/about`]
      .map((u) => `  <url><loc>${u}</loc></url>`).join('\n');
    const postUrls = posts.map((p) => `  <url><loc>${base}/post/${encodeURIComponent(p.slug)}</loc><lastmod>${new Date((p.updated_at || 0) * 1000).toISOString().slice(0, 10)}</lastmod></url>`).join('\n');
    const sm = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n${postUrls}\n</urlset>`;
    cache = { ...cache, smKey: key, sitemap: sm };
    return new Response(sm, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
  }

  return null;
}
