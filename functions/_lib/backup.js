// backup.js — 按表导出 / 整站 JSON 备份 / Markdown 逃生包 / 导入恢复
// 为什么按表导出不用整库 export：官方整库导出会阻塞库、含 FTS 时直接失败、且原始导出因外键顺序不能直导回
// （调研暗病 #6）。这里按「父表优先」的固定顺序逐表导出 JSON，导入也按同序写入，绕开全部三个坑。
// 导出范围刻意排除可重建/敏感运行态数据：sessions、rate_limits、login_guards、preview_tokens、recovery_codes、autosaves、backups。

import { all, run, first } from './db.js';
import { nowSec } from './http.js';
import { renderMarkdown } from './render.js';

// 父表优先的表顺序（导入必须按这个顺序，导出同序方便对照）
export const EXPORT_TABLES = [
  'admin_users', 'settings', 'tags', 'media', 'posts', 'post_tags', 'post_revisions',
  'moments', 'comments', 'friend_links', 'view_stats', 'redirects',
];
// settings 里的内部键（_ 开头）不进导出
const SKIP_SETTING_KEYS = (k) => k.startsWith('_');
// 秘密键：值是真凭据，任何备份/导出产物都不带（2026-11-10 裁决，第五轮审计 BL-M2）。
// 只挡导出、不挡导入：老备份里带 ai_api_key 的仍可正常导入（导入侧是 INSERT OR IGNORE，不覆盖现值）。
const SECRET_SETTING_KEYS = new Set(['ai_api_key']);

export async function exportSite(env) {
  const data = { app: 'ym-blog', version: 1, exported_at: new Date().toISOString(), tables: {} };
  for (const table of EXPORT_TABLES) {
    let rows = await all(env, `SELECT * FROM ${table}`);
    if (table === 'settings') rows = rows.filter((r) => !SKIP_SETTING_KEYS(r.key) && !SECRET_SETTING_KEYS.has(r.key));
    if (table === 'admin_users') rows = rows.map(({ password_hash, ...rest }) => ({ ...rest, password_hash })); // 备份需含哈希才能整站恢复；导出接口本身仅站长可用
    data.tables[table] = rows;
  }
  return data;
}

export function countOf(data) {
  return {
    posts: data.tables.posts?.length || 0,
    media: data.tables.media?.length || 0,
    comments: data.tables.comments?.length || 0,
    moments: data.tables.moments?.length || 0,
  };
}

// ---- Markdown 逃生包：文章 → 带 front-matter 的 .md + 附件清单 + 评论/设置 JSON ----
// 返回 [{path, content}] 文件列表（打包 zip 在调用方做）
export async function buildMarkdownPack(env) {
  const data = await exportSite(env);
  const files = [];
  const tagName = new Map((data.tables.tags || []).map((t) => [t.id, t.name]));
  const postTags = new Map();
  for (const pt of data.tables.post_tags || []) {
    if (!postTags.has(pt.post_id)) postTags.set(pt.post_id, []);
    postTags.get(pt.post_id).push(tagName.get(pt.tag_id));
  }
  for (const p of data.tables.posts || []) {
    const fm = [
      '---',
      `title: ${JSON.stringify(p.title)}`,
      `slug: ${p.slug}`,
      `date: ${new Date((p.publish_at || p.created_at) * 1000).toISOString()}`,
      `status: ${p.status}`,
      `tags: [${(postTags.get(p.id) || []).filter(Boolean).join(', ')}]`,
      '---',
      '',
    ].join('\n');
    files.push({ path: `posts/${p.slug}.md`, content: fm + (p.content_md || '') });
  }
  for (const mo of data.tables.moments || []) {
    files.push({ path: `moments/${mo.id}.md`, content: mo.content || '' });
  }
  const manifest = (data.tables.media || []).map((m) => ({
    r2_key: m.r2_key, display_name: m.display_name, orig_name: m.orig_name,
    mime: m.mime, size_bytes: m.size_bytes, kind: m.kind,
  }));
  files.push({ path: 'media-manifest.json', content: JSON.stringify(manifest, null, 2) });
  files.push({ path: 'comments.json', content: JSON.stringify(data.tables.comments || [], null, 2) });
  files.push({ path: 'settings.json', content: JSON.stringify(Object.fromEntries((data.tables.settings || []).map((s) => [s.key, s.value])), null, 2) });
  files.push({ path: 'README.txt', content: 'ym-blog 逃生包：posts/ 为 Markdown 原文（带 front-matter），可直接迁往 Hugo/Astro/WordPress 等任何系统；media-manifest.json 为附件清单（文件本体在你的 R2 媒体桶里，按 r2_key 取）。' });
  return { files, counts: countOf(data) };
}

// ---- 极简 ZIP 打包（仅存储不压缩，浏览器/系统均可直接解开）----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export function zipStore(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.path);
    const data = typeof f.content === 'string' ? enc.encode(f.content) : f.content;
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 文件名标记
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(local.buffer), name, data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, data.length, true);
    cen.setUint32(24, data.length, true);
    cen.setUint16(28, name.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + data.length;
  }
  let centralSize = 0;
  for (const c of central) centralSize += c.length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

// ---- 导入恢复：按父表优先顺序写入；slug 冲突自动改名并登记 redirects；返回对账报告 ----
// 安全约定：导入前调用方必须先自动备份当前站（见 admin-api 的 import 处理）。
export async function importSite(env, data) {
  if (!data || data.app !== 'ym-blog' || !data.tables) throw new Error('不是 ym-blog 的备份文件');
  const report = { inserted: {}, slugRenamed: [], errors: [] };
  const t = nowSec();
  const insertRow = async (table, row, cols) => {
    const keys = cols.filter((c) => row[c] !== undefined);
    const sql = `INSERT OR IGNORE INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
    await run(env, sql, ...keys.map((k) => row[k]));
  };
  const T = data.tables;
  // admin_users：只在本站还没有该用户名时补（不覆盖现站长密码）
  for (const u of T.admin_users || []) {
    const exists = await first(env, 'SELECT id FROM admin_users WHERE username = ?', u.username);
    if (!exists && u.password_hash) {
      await insertRow('admin_users', u, ['id', 'username', 'password_hash', 'role', 'password_updated_at', 'created_at']);
      report.inserted.admin_users = (report.inserted.admin_users || 0) + 1;
    }
  }
  for (const s of T.settings || []) {
    if (SKIP_SETTING_KEYS(s.key)) continue;
    await insertRow('settings', s, ['key', 'value', 'updated_at']);
    report.inserted.settings = (report.inserted.settings || 0) + 1;
  }
  for (const tg of T.tags || []) { await insertRow('tags', tg, ['id', 'name', 'slug']); report.inserted.tags = (report.inserted.tags || 0) + 1; }
  for (const m of T.media || []) { await insertRow('media', m, ['id', 'r2_key', 'kind', 'display_name', 'orig_name', 'mime', 'size_bytes', 'width', 'height', 'duration_sec', 'album', 'status', 'ref_count', 'trashed_at', 'created_at']); report.inserted.media = (report.inserted.media || 0) + 1; }
  // 文章：slug 冲突 → 改名为 slug-import<ts> 并登记 redirect 指向新文（尽力保旧链可达）
  const idMap = new Map();
  for (const p of T.posts || []) {
    let row = { ...p };
    const sameId = await first(env, 'SELECT slug FROM posts WHERE id = ?', p.id);
    if (sameId && sameId.slug === p.slug) { idMap.set(p.id, p.id); continue; } // 已存在同一篇，跳过
    const slugTaken = await first(env, 'SELECT id FROM posts WHERE slug = ?', p.slug);
    if (slugTaken) {
      const oldSlug = p.slug;
      row.slug = `${p.slug}-import${t}`;
      report.slugRenamed.push({ from: oldSlug, to: row.slug });
    }
    if (sameId) row.id = undefined; // id 被占但 slug 不同：让其自增新 id
    const cols = ['slug', 'type', 'title', 'content_md', 'rendered_html', 'excerpt', 'cover_media_id', 'status', 'publish_at', 'password_hash', 'is_sticky', 'comment_enabled', 'word_count', 'trashed_at', 'created_at', 'updated_at'];
    if (row.id !== undefined) cols.unshift('id');
    await insertRow('posts', row, cols);
    const created = await first(env, 'SELECT id FROM posts WHERE slug = ?', row.slug);
    if (created) {
      idMap.set(p.id, created.id);
      if (row.slug !== p.slug) {
        await run(env, 'INSERT OR IGNORE INTO redirects (old_slug, post_id, created_at) VALUES (?, ?, ?)', p.slug, created.id, t).catch(() => {});
      }
      // 渲染兜底：老备份若 rendered_html 为空，用当前渲染器补上
      if (!row.rendered_html && row.content_md) {
        const { html } = renderMarkdown(row.content_md);
        await run(env, 'UPDATE posts SET rendered_html = ? WHERE id = ?', html, created.id);
      }
    }
    report.inserted.posts = (report.inserted.posts || 0) + 1;
  }
  for (const pt of T.post_tags || []) {
    const pid = idMap.get(pt.post_id);
    if (pid) { await insertRow('post_tags', { post_id: pid, tag_id: pt.tag_id }, ['post_id', 'tag_id']); }
  }
  for (const r of T.post_revisions || []) {
    const pid = idMap.get(r.post_id);
    if (pid) { await insertRow('post_revisions', { ...r, post_id: pid }, ['post_id', 'title', 'content_md', 'note', 'created_at']); report.inserted.revisions = (report.inserted.revisions || 0) + 1; }
  }
  for (const mo of T.moments || []) { await insertRow('moments', mo, ['id', 'content', 'media_id', 'status', 'created_at', 'updated_at']); report.inserted.moments = (report.inserted.moments || 0) + 1; }
  for (const c of T.comments || []) {
    const pid = idMap.get(c.post_id);
    if (pid) { await insertRow('comments', { ...c, post_id: pid }, ['post_id', 'parent_id', 'author_name', 'author_hash', 'content', 'status', 'is_admin', 'ip_hash', 'ua', 'created_at']); report.inserted.comments = (report.inserted.comments || 0) + 1; }
  }
  for (const f of T.friend_links || []) { await insertRow('friend_links', f, ['id', 'name', 'url', 'rss_url', 'avatar_url', 'desc', 'sort_order', 'enabled', 'health', 'fail_streak', 'last_checked_at', 'created_at']); report.inserted.friends = (report.inserted.friends || 0) + 1; }
  for (const v of T.view_stats || []) {
    await run(env, 'INSERT INTO view_stats (post_id, day, pv) VALUES (?, ?, ?) ON CONFLICT(post_id, day) DO UPDATE SET pv = MAX(pv, excluded.pv)',
      idMap.get(v.post_id) || v.post_id, v.day, v.pv).catch(() => {});
  }
  return report;
}
