#!/usr/bin/env node
// d1-dump.mjs — 备份通道二：拼整库 SQL（backup-d1.sql）存为 Actions 产物。
//
// 为什么需要它：本库自 v1.1.0 起有 FTS5 虚拟表（schema/0003 的 posts_fts），
// Cloudflare 官方整库导出（wrangler d1 export）对含虚拟表的库一律被服务端拒绝
// （官方文档 Import and export data · Known limitations：Export is not supported
// for virtual tables, including databases with virtual tables）。官方给的变通是
// 「删虚拟表→导出→重建」，对生产库不可接受，故通道二走本脚本逐表拼 SQL。
//
// 结构从哪来（2026-11-10 改版，先看这段再改本文件）：
//   旧版向 D1 问结构（SELECT FROM sqlite_master + 逐表 PRAGMA table_info），
//   2026-11-10 生产实测被拒：首查 sqlite_master 即回 HTTP 400 / code 7500 /
//   "not authorized: SQLITE_AUTH"，且换两把权限天差地别的令牌（部署宽令牌与
//   D1 Read 专用令牌）撞同一堵墙——7500 是 D1 引擎层错误，内层是 SQLite
//   authorizer 对自省类语句的拒绝（sqlite_master 里登记着平台内部 _cf_* 对象，
//   授权器不许经 API 枚举；绝大多数 PRAGMA 在 D1 同样回 SQLITE_AUTH），
//   与令牌权限无关。故本版起：**结构一律解析自仓库 schema/*.sql 迁移文件**
//   ——迁移正是生产库的构建来源、单一事实源，解析它不漂移；发给 D1 的语句
//   只剩对普通业务表的 SELECT，整类绕开自省语句。FTS 虚拟表只出建表语句
//   不出数据（外部内容表、数据可重建），文件末尾带 rebuild，恢复后索引按
//   posts 自动重建。
// 防漂移三道闸（宁可变红，绝不静默漏表/漏列）：
//   1) 解析器只认它能建模的结构语句（CREATE TABLE / VIRTUAL TABLE / INDEX /
//      TRIGGER、ALTER TABLE ... ADD COLUMN）；遇到不认识的结构语句（CREATE
//      VIEW、其他 ALTER 形式、WITHOUT ROWID 表等）直接报错终止，不猜。
//   2) 每张迁移里有的表导出时都会真 SELECT 一次：生产缺表当场按表名报错。
//   3) 每张非空表先 SELECT * LIMIT 1 探一行，返回列名集合须与迁移派生列集
//      完全一致：生产被迁移之外手工改过表（多列）当场点名终止（缺列则显式
//      列名的导出 SELECT 本身就会报错点名）。只用显式列名导出是看不见多余
//      列的，所以这行探针不能省。
// 输入只从环境变量读：D1_EXPORT_TOKEN（通道二专用令牌、只给 D1 读权限，不与
// deploy 共用）/ CLOUDFLARE_ACCOUNT_ID / D1_DATABASE_ID；任何真值不写进本文件
// 与产物。SCHEMA_DIR / --schema-dir 可指定迁移目录（默认脚本同级 ../schema，
// 即仓库根的 schema/）；D1_API_BASE 仅供离线打桩测试覆盖 API 地址，生产勿设。
// 用法：node scripts/d1-dump.mjs --output backup-d1.sql

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN = process.env.D1_EXPORT_TOKEN;
const ACCT = process.env.CLOUDFLARE_ACCOUNT_ID;
const DBID = process.env.D1_DATABASE_ID;
if (!TOKEN || !ACCT || !DBID) {
  console.error('缺 D1_EXPORT_TOKEN / CLOUDFLARE_ACCOUNT_ID / D1_DATABASE_ID 之一，终止（不生成产物）。');
  process.exit(1);
}
const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const OUT = argOf('--output') || 'backup-d1.sql';
const API_BASE = process.env.D1_API_BASE || 'https://api.cloudflare.com/client/v4';
const API = `${API_BASE}/accounts/${ACCT}/d1/database/${DBID}/query`;

async function q(sql, label) {
  let r;
  try {
    r = await fetch(API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql }),
    });
  } catch (e) {
    throw new Error(`D1 请求未达［${label}］：${e.message}（语句：${sql.slice(0, 120)}）`);
  }
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.success !== true) {
    throw new Error(`D1 查询失败［${label}］(HTTP ${r.status})：${JSON.stringify(j?.errors || j).slice(0, 300)}（语句：${sql.slice(0, 120)}）`);
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

// ---------- 从 schema/*.sql 迁移解析结构 ----------
function resolveSchemaDir() {
  const candidates = [];
  if (argOf('--schema-dir')) candidates.push(argOf('--schema-dir'));
  if (process.env.SCHEMA_DIR) candidates.push(process.env.SCHEMA_DIR);
  candidates.push(join(dirname(fileURLToPath(import.meta.url)), '..', 'schema'));
  candidates.push(join(process.cwd(), 'schema'));
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`找不到 schema 迁移目录，已试：${candidates.join('、')}`);
}

// 把 SQL 文本切成语句：处理 -- 行注释、'...' 字符串（'' 转义），
// 且 CREATE TRIGGER 体内的 BEGIN...END 内部 ; 不切分。
function splitStatements(text) {
  const stmts = [];
  let buf = '';
  let inStr = false;
  const flush = () => { const s = buf.trim(); if (s) stmts.push(s); buf = ''; };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inStr) {
      buf += ch;
      if (ch === "'") {
        if (text[i + 1] === "'") { buf += "'"; i += 2; continue; }
        inStr = false;
      }
      i++; continue;
    }
    if (ch === '-' && text[i + 1] === '-') { // 行注释：跳到行尾
      while (i < text.length && text[i] !== '\n') i++;
      buf += ' ';
      continue;
    }
    if (ch === "'") { inStr = true; buf += ch; i++; continue; }
    if (ch === ';') {
      const isTrigger = /^CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(buf.trim());
      if (isTrigger && !/\bEND\s*$/i.test(buf.trim())) { buf += ch; i++; continue; }
      flush(); i++; continue;
    }
    buf += ch; i++;
  }
  flush();
  return stmts;
}

// 在 stmt 中找从 openIdx 处 '(' 起的匹配 ')'（跳过字符串字面量）
function matchParen(stmt, openIdx) {
  let depth = 0;
  let inStr = false;
  for (let i = openIdx; i < stmt.length; i++) {
    const ch = stmt[i];
    if (inStr) {
      if (ch === "'") { if (stmt[i + 1] === "'") i++; else inStr = false; }
      continue;
    }
    if (ch === "'") { inStr = true; continue; }
    if (ch === '(') depth++;
    if (ch === ')' && --depth === 0) return i;
  }
  throw new Error(`语句括号不配平：${stmt.slice(0, 100)}`);
}

// 按顶层逗号切分（括号深度 0、字符串外）
function splitTopLevel(body) {
  const out = [];
  let depth = 0;
  let inStr = false;
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      cur += ch;
      if (ch === "'") { if (body[i + 1] === "'") { cur += "'"; i++; } else inStr = false; }
      continue;
    }
    if (ch === "'") { inStr = true; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const unquote = (tok) => tok.replace(/^["`[]/, '').replace(/["`\]]$/, '');

// 解析全部迁移 → { structure:[建表/索引/触发器/ALTER 原文，按迁移序],
//   tables: Map<表名, 列名[]>, virtual:[虚拟表名], counts:{...} }
function parseSchema(schemaDir) {
  const files = readdirSync(schemaDir).filter((f) => f.endsWith('.sql')).sort();
  if (!files.length) throw new Error(`schema 目录 ${schemaDir} 里没有 .sql 迁移文件，终止。`);
  const structure = [];
  const tables = new Map();
  const virtual = [];
  const counts = { table: 0, virtual: 0, index: 0, trigger: 0, alter: 0, skipped: 0 };
  for (const f of files) {
    const text = readFileSync(join(schemaDir, f), 'utf8');
    for (const stmt of splitStatements(text)) {
      let m;
      if ((m = stmt.match(/^CREATE\s+VIRTUAL\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)/i))) {
        virtual.push(unquote(m[1]));
        structure.push(stmt);
        counts.virtual++;
      } else if ((m = stmt.match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)\s*/i))) {
        const name = unquote(m[1]);
        if (/WITHOUT\s+ROWID/i.test(stmt)) {
          throw new Error(`迁移 ${f}：表 ${name} 是 WITHOUT ROWID，本脚本按 rowid 分页导出，拒绝猜测，终止。`);
        }
        const openIdx = stmt.indexOf('(', m[0].length - 1);
        const body = stmt.slice(openIdx + 1, matchParen(stmt, openIdx));
        const cols = [];
        for (const def of splitTopLevel(body)) {
          const first = def.trim().split(/[\s(]+/)[0];
          if (!first || /^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)$/i.test(first)) continue;
          cols.push(unquote(first));
        }
        if (!cols.length) throw new Error(`迁移 ${f}：表 ${name} 没解析出任何列，终止。`);
        tables.set(name, cols);
        structure.push(stmt);
        counts.table++;
      } else if (/^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(stmt)) {
        structure.push(stmt);
        counts.index++;
      } else if (/^CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(stmt)) {
        structure.push(stmt);
        counts.trigger++;
      } else if ((m = stmt.match(/^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([^\s]+)\s+ADD\s+(?:COLUMN\s+)?([^\s,()]+)/i))) {
        const tname = unquote(m[1]);
        const col = unquote(m[2]);
        const cols = tables.get(tname);
        if (!cols) throw new Error(`迁移 ${f}：ALTER 给未知表 ${tname} 加列 ${col}，终止。`);
        if (cols.includes(col)) throw new Error(`迁移 ${f}：ALTER 重复给表 ${tname} 加列 ${col}，终止。`);
        cols.push(col);
        structure.push(stmt);
        counts.alter++;
      } else if (/^(CREATE|ALTER|DROP)\b/i.test(stmt)) {
        throw new Error(`迁移 ${f}：不认识的结构语句（拒绝静默跳过）：${stmt.slice(0, 120)}`);
      } else {
        counts.skipped++; // INSERT/UPDATE 等数据/种子语句：刻意不进结构（数据只从 D1 导）
      }
    }
  }
  return { files, structure, tables, virtual, counts };
}

// 父表优先的数据导出顺序（与 functions/_lib/backup.js 的 EXPORT_TABLES 同序，
// friend_posts 附在 friend_links 之后；清单外的表按名排在其后，保证外键先父后子）
const PARENT_FIRST = [
  'admin_users', 'settings', 'tags', 'media', 'posts', 'post_tags', 'post_revisions',
  'moments', 'comments', 'friend_links', 'friend_posts', 'view_stats', 'redirects',
];

async function main() {
  const schemaDir = resolveSchemaDir();
  const { files, structure, tables, virtual, counts } = parseSchema(schemaDir);
  console.log(
    `结构解析（源自 ${schemaDir}，${files.length} 个迁移文件）：普通表 ${counts.table}、虚拟表 ${counts.virtual}、索引 ${counts.index}、触发器 ${counts.trigger}、ALTER ${counts.alter}，跳过数据/种子语句 ${counts.skipped} 条`,
  );
  // 解析完整性闸：核心表与 FTS 必须都在（解析器或迁移出大问题时宁可红，不要半份备份）
  const missingCore = PARENT_FIRST.filter((t) => !tables.has(t));
  if (missingCore.length) throw new Error(`结构解析缺核心表：${missingCore.join(', ')}，终止。`);
  if (!virtual.includes('posts_fts')) throw new Error('结构解析没找到虚拟表 posts_fts，终止。');

  const dataNames = [...tables.keys()];
  const ordered = [
    ...PARENT_FIRST.filter((t) => dataNames.includes(t)),
    ...dataNames.filter((t) => !PARENT_FIRST.includes(t)).sort(),
  ];

  const parts = [];
  parts.push('-- ym-blog 整库 SQL —— 备份通道二逐表导出（scripts/d1-dump.mjs）生成于 ' + new Date().toISOString());
  parts.push('-- 结构解析自仓库 schema/ 迁移文件（注释已剥离，语句与迁移一致）；数据经 D1 HTTP API 逐表导出。');
  parts.push('-- 恢复：wrangler d1 execute ym-blog-db --remote --file backup-d1.sql ；文件末尾已含 FTS rebuild，无需再跑 schema/0003。');
  for (const s of structure) parts.push(s + ';');

  const assertColSet = (t, cols, keys) => {
    const miss = cols.filter((c) => !keys.includes(c));
    const extra = keys.filter((k) => !cols.includes(k));
    if (miss.length || extra.length) {
      throw new Error(
        `表 ${t} 的生产列与迁移派生列不一致（缺：${miss.join(',') || '无'}；多：${extra.join(',') || '无'}）——疑似迁移之外的手工改表或解析错误，终止导出，绝不静默漏列。`,
      );
    }
  };

  let total = 0;
  for (const t of ordered) {
    const cols = tables.get(t);
    const colList = cols.map((c) => `"${c}"`).join(',');
    // 列集对账探针：SELECT * 才能看见迁移之外的多余列（显式列名 SELECT 看不见）；
    // 空表无行可探、也无数据可丢，跳过（该表真缺列时导出 SELECT 会报错点名）。
    const probe = await q(`SELECT * FROM "${t}" LIMIT 1`, `列集对账 表 ${t}`);
    if (probe.length) assertColSet(t, cols, Object.keys(probe[0]));
    let offset = 0;
    for (;;) {
      const rows = await q(
        `SELECT ${colList} FROM "${t}" ORDER BY rowid LIMIT 1000 OFFSET ${offset}`,
        `数据导出 表 ${t} offset ${offset}`,
      );
      if (rows.length) assertColSet(t, cols, Object.keys(rows[0])); // 逐页首行复核列集
      for (const row of rows) {
        parts.push(`INSERT INTO "${t}" (${colList}) VALUES(${cols.map((c) => lit(row[c])).join(',')});`);
        total++;
      }
      if (rows.length < 1000) break;
      offset += 1000;
    }
  }
  for (const v of virtual) parts.push(`INSERT INTO "${v}" ("${v}") VALUES ('rebuild');`);

  writeFileSync(OUT, parts.join('\n') + '\n');
  console.log(`逐表导出完成：结构 ${structure.length} 个对象（源自 schema 迁移）、数据 ${ordered.length} 张表共 ${total} 行，已写 ${OUT}`);
}

main().catch((e) => {
  console.error(`导出失败：${e.message}`);
  process.exit(1);
});
