#!/usr/bin/env node
// d1-dump.mjs — 备份通道二兜底：经 D1 HTTP API 逐表拼整库 SQL（backup-d1.sql）
//
// 为什么需要它：本库自 v1.1.0 起有 FTS5 虚拟表（schema/0003 的 posts_fts），
// Cloudflare 官方整库导出（wrangler d1 export）对含虚拟表的库一律被服务端拒绝
// （官方文档 Known limitations：Export is not supported for virtual tables）。
// 官方给的变通是「删虚拟表→导出→重建」，对生产库不可接受，故 backup.yml 在官方
// 导出被拒时改走本脚本：结构取自 sqlite_master、数据按父表优先顺序逐表导出，
// 生成一份可整库恢复的 SQL；FTS 虚拟表只出 CREATE 语句不出数据（它是外部内容
// 表、数据可重建），文件末尾已带 rebuild，恢复后索引自动按 posts 重建。
//
// 输入只从环境变量读：CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / D1_DATABASE_ID
// （与 deploy / backup 工作流共用的三个 Secret）；任何真值不写进本文件与产物。
// 用法：node scripts/d1-dump.mjs --output backup-d1.sql

import { writeFileSync } from 'node:fs';

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCT = process.env.CLOUDFLARE_ACCOUNT_ID;
const DBID = process.env.D1_DATABASE_ID;
if (!TOKEN || !ACCT || !DBID) {
  console.error('缺 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / D1_DATABASE_ID 之一，终止（不生成产物）。');
  process.exit(1);
}
const outIdx = process.argv.indexOf('--output');
const OUT = outIdx >= 0 ? process.argv[outIdx + 1] : 'backup-d1.sql';
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCT}/d1/database/${DBID}/query`;

async function q(sql) {
  const r = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.success !== true) {
    throw new Error(`D1 查询失败 (HTTP ${r.status})：${JSON.stringify(j?.errors || j).slice(0, 300)}`);
  }
  return j.result[0].results || [];
}

// SQL 字面量渲染（本库无 BLOB 列，数组分支仅作防御：按字节数组转 hex 字面量）
function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return `'${v.replaceAll("'", "''")}'`;
  if (Array.isArray(v)) return `X'${v.map((b) => Number(b).toString(16).padStart(2, '0')).join('')}'`;
  return `'${String(v).replaceAll("'", "''")}'`;
}

// 父表优先的数据导出顺序（与 functions/_lib/backup.js 的 EXPORT_TABLES 同序，
// friend_posts 附在 friend_links 之后；清单外的表按名排在其后，保证外键先父后子）
const PARENT_FIRST = [
  'admin_users', 'settings', 'tags', 'media', 'posts', 'post_tags', 'post_revisions',
  'moments', 'comments', 'friend_links', 'friend_posts', 'view_stats', 'redirects',
];

const master = await q(
  `SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid`,
);
const isFts = (o) => /USING\s+fts5/i.test(o.sql || '');
const plainTables = master.filter((o) => o.type === 'table' && !isFts(o));
const virtTables = master.filter((o) => o.type === 'table' && isFts(o));
const indexes = master.filter((o) => o.type === 'index');
const triggers = master.filter((o) => o.type === 'trigger');
// 虚拟表的影子表（posts_fts_data 等）在 sqlite_master 里 sql 为 NULL，已被上面的过滤排除
const dataNames = plainTables.map((o) => o.name);
const ordered = [
  ...PARENT_FIRST.filter((t) => dataNames.includes(t)),
  ...dataNames.filter((t) => !PARENT_FIRST.includes(t)).sort(),
];

const parts = [];
parts.push('-- ym-blog 整库 SQL —— 备份通道二逐表导出（scripts/d1-dump.mjs）生成于 ' + new Date().toISOString());
parts.push('-- 官方 wrangler d1 export 因库含 FTS5 虚拟表被平台拒绝时，backup.yml 自动改走本路线；内容为全库结构 + 全部普通表数据。');
parts.push('-- 恢复：wrangler d1 execute ym-blog-db --remote --file backup-d1.sql ；文件末尾已含 FTS rebuild，无需再跑 schema/0003。');
for (const o of plainTables) parts.push(o.sql + ';');

let total = 0;
for (const t of ordered) {
  const cols = (await q(`PRAGMA table_info("${t}")`)).map((c) => c.name);
  const colList = cols.map((c) => `"${c}"`).join(',');
  let offset = 0;
  for (;;) {
    const rows = await q(`SELECT ${colList} FROM "${t}" ORDER BY rowid LIMIT 1000 OFFSET ${offset}`);
    for (const row of rows) {
      parts.push(`INSERT INTO "${t}" (${colList}) VALUES(${cols.map((c) => lit(row[c])).join(',')});`);
      total++;
    }
    if (rows.length < 1000) break;
    offset += 1000;
  }
}
for (const o of virtTables) parts.push(o.sql + ';');
for (const o of indexes) parts.push(o.sql + ';');
for (const o of triggers) parts.push(o.sql + ';');
for (const o of virtTables) parts.push(`INSERT INTO "${o.name}" ("${o.name}") VALUES ('rebuild');`);

writeFileSync(OUT, parts.join('\n') + '\n');
console.log(`逐表导出完成：结构 ${master.length} 对象、数据 ${ordered.length} 张表共 ${total} 行，已写 ${OUT}`);
