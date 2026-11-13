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
    // admin_users 整行导出（含 password_hash）：整站恢复需要它；本导出只走
    // 站长接口与私有备份桶，公开通道（d1-dump 的 artifact）另有排除名单。
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
  // 标签/媒体先建「旧 id → 本站 id」映射，后面所有引用都走映射改写。
  // 旧版带旧 id INSERT OR IGNORE：id 被现站占用时静默跳过，随后
  // post_tags.tag_id、文章 cover_media_id、说说 media_id 仍写旧 id，
  // 会指到现站里不相干的标签/图片上（2026-11-13 三方审查 B#13）。
  const tagMap = new Map();
  for (const tg of T.tags || []) {
    let row = await first(env, 'SELECT id FROM tags WHERE slug = ?', tg.slug);
    if (!row) {
      await run(env, 'INSERT OR IGNORE INTO tags (name, slug) VALUES (?, ?)', tg.name, tg.slug);
      row = await first(env, 'SELECT id FROM tags WHERE slug = ?', tg.slug);
    }
    if (row) { tagMap.set(tg.id, row.id); report.inserted.tags = (report.inserted.tags || 0) + 1; }
  }
  const mediaMap = new Map();
  for (const m of T.media || []) {
    let row = await first(env, 'SELECT id FROM media WHERE r2_key = ?', m.r2_key);
    if (!row) {
      const cols = ['r2_key', 'kind', 'display_name', 'orig_name', 'mime', 'size_bytes', 'width', 'height', 'duration_sec', 'album', 'status', 'ref_count', 'trashed_at', 'created_at'];
      const keys = cols.filter((c) => m[c] !== undefined);
      const r = await run(env, `INSERT OR IGNORE INTO media (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => m[k]));
      row = r.meta.changes ? { id: r.meta.last_row_id } : await first(env, 'SELECT id FROM media WHERE r2_key = ?', m.r2_key);
    }
    if (row) { mediaMap.set(m.id, row.id); report.inserted.media = (report.inserted.media || 0) + 1; }
  }
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
    // 封面走媒体映射改写（映射里没有就置空，绝不保留旧 id 乱指）
    row.cover_media_id = row.cover_media_id != null ? (mediaMap.get(row.cover_media_id) ?? null) : null;
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
    const tid = tagMap.get(pt.tag_id);
    if (pid && tid) { await insertRow('post_tags', { post_id: pid, tag_id: tid }, ['post_id', 'tag_id']); }
  }
  for (const r of T.post_revisions || []) {
    const pid = idMap.get(r.post_id);
    if (pid) { await insertRow('post_revisions', { ...r, post_id: pid }, ['post_id', 'title', 'content_md', 'note', 'created_at']); report.inserted.revisions = (report.inserted.revisions || 0) + 1; }
  }
  for (const mo of T.moments || []) {
    const row = { ...mo };
    delete row.id; // 说说不强塞旧 id，自增新 id；配图走媒体映射
    row.media_id = mo.media_id != null ? (mediaMap.get(mo.media_id) ?? null) : null;
    await insertRow('moments', row, ['content', 'media_id', 'status', 'created_at', 'updated_at']);
    report.inserted.moments = (report.inserted.moments || 0) + 1;
  }
  // 评论两遍写：第一遍不带旧 id 插入（parent 先置 0）并记映射，
  // 第二遍按映射改写 parent_id。旧版不带 id 插入却原样写旧 parent_id，
  // 回复会挂到现站里不相干的评论上或成孤儿（审查 B#13）。
  const commentMap = new Map();
  const pendingParents = [];
  for (const c of T.comments || []) {
    const pid = idMap.get(c.post_id);
    if (!pid) continue;
    const r = await run(env, 'INSERT INTO comments (post_id, parent_id, author_name, author_hash, content, status, is_admin, ip_hash, ua, created_at) VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?)',
      pid, c.author_name, c.author_hash ?? null, c.content, c.status, c.is_admin ?? 0, c.ip_hash ?? null, c.ua ?? null, c.created_at);
    const newId = r.meta.last_row_id;
    if (newId) {
      commentMap.set(c.id, newId);
      if (c.parent_id) pendingParents.push([newId, c.parent_id]);
      report.inserted.comments = (report.inserted.comments || 0) + 1;
    }
  }
  for (const [newId, oldParent] of pendingParents) {
    const np = commentMap.get(oldParent);
    if (np) await run(env, 'UPDATE comments SET parent_id = ? WHERE id = ?', np, newId);
  }
  for (const f of T.friend_links || []) { await insertRow('friend_links', f, ['id', 'name', 'url', 'rss_url', 'avatar_url', 'desc', 'sort_order', 'enabled', 'health', 'fail_streak', 'last_checked_at', 'created_at']); report.inserted.friends = (report.inserted.friends || 0) + 1; }
  for (const v of T.view_stats || []) {
    const pid = idMap.get(v.post_id);
    if (!pid) continue; // 旧版查不到映射时回退用旧 post_id，会把浏览数记到不相干的文章上
    await run(env, 'INSERT INTO view_stats (post_id, day, pv) VALUES (?, ?, ?) ON CONFLICT(post_id, day) DO UPDATE SET pv = MAX(pv, excluded.pv)',
      pid, v.day, v.pv).catch(() => {});
  }
  return report;
}
