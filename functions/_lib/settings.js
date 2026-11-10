// settings.js — 站点设置读写：settings 表键值 + 白名单 + 默认值 + 进程内缓存
// 规则：真秘密（Turnstile secret、R2 凭据、pepper 等）永不进这张表，只放环境变量；
//       这里存的都是后台表单能改的公开配置。PUT 后版本号 +1，读路径靠版本号+短 TTL 失效缓存。

import { all, run, first } from './db.js';
import { nowSec } from './http.js';

// 键白名单与默认值：新增设置项先来这里登记，否则 PUT 会被拒绝
export const SETTING_DEFS = {
  site_name:           { def: '示例博客', type: 'string' },
  site_desc:           { def: '', type: 'string' },
  hero_title:          { def: '', type: 'string' },
  hero_text:           { def: '', type: 'string' },
  avatar_media_id:     { def: 0, type: 'int' },
  accent_color:        { def: '#e8710a', type: 'color' },
  layout_home:         { def: 'cards', type: 'enum', values: ['cards', 'list'] },
  layout_post_width:   { def: 'normal', type: 'enum', values: ['normal', 'wide'] },
  dark_mode:           { def: 'auto', type: 'enum', values: ['auto', 'light', 'dark'] },
  // code_theme 已撤下（第五轮审计）：它只有定义与后台字段、全仓零消费，是个假开关；
  // 代码块配色实际由站点 CSS 的 --code-bg 跟随深浅色策略（dark_mode）。settings 表里的旧数据行残留无害，不迁移。
  search_on:           { def: 1, type: 'bool' },
  comments_on:         { def: 1, type: 'bool' },
  comments_moderation: { def: 1, type: 'bool' },       // 1=先审后显
  comments_link_limit: { def: 2, type: 'int', min: 0, max: 20 },
  rss_on:              { def: 1, type: 'bool' },
  ratelimit_level:     { def: 'normal', type: 'enum', values: ['off', 'normal', 'strict'] },
  turnstile_on:        { def: 0, type: 'bool' },
  turnstile_site_key:  { def: '', type: 'string' },    // 站点 key 是公开值，可以进设置；secret 只进环境变量
  friend_circle_on:    { def: 0, type: 'bool' },
  og_auto:             { def: 1, type: 'bool' },
  posts_per_page:      { def: 10, type: 'int', min: 1, max: 50 },
  trash_keep_days:     { def: 30, type: 'int', min: 1, max: 365 },
  backup_keep:         { def: 12, type: 'int', min: 1, max: 100 },
  upload_image_max_mb: { def: 20, type: 'int', min: 1, max: 100 },
  upload_video_max_mb: { def: 200, type: 'int', min: 1, max: 1024 },
  upload_file_max_mb:  { def: 50, type: 'int', min: 1, max: 500 },
};

let cache = { at: 0, ver: -1, data: null };
const CACHE_TTL_MS = 15000;

function parseValue(raw, def) {
  if (raw == null) return def.def;
  try {
    const v = JSON.parse(raw);
    if (def.type === 'bool') return v ? 1 : 0;
    if (def.type === 'int') return Number.isFinite(Number(v)) ? Number(v) : def.def;
    return v;
  } catch { return def.def; }
}

export async function getSettings(env, force = false) {
  const t = Date.now();
  if (!force && cache.data && t - cache.at < CACHE_TTL_MS) return cache.data;
  const rows = await all(env, 'SELECT key, value FROM settings');
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  const data = {};
  for (const [k, def] of Object.entries(SETTING_DEFS)) data[k] = parseValue(map[k], def);
  data._ver = map._ver ? Number(JSON.parse(map._ver)) || 0 : 0;
  cache = { at: t, ver: data._ver, data };
  return data;
}

export function validateSetting(key, value) {
  const def = SETTING_DEFS[key];
  if (!def) throw new Error(`未知设置项：${key}`);
  switch (def.type) {
    case 'bool': return value ? 1 : 0;
    case 'int': {
      const n = Math.trunc(Number(value));
      if (!Number.isFinite(n)) throw new Error(`设置 ${key} 需要数字`);
      if (def.min != null && n < def.min) throw new Error(`设置 ${key} 不能小于 ${def.min}`);
      if (def.max != null && n > def.max) throw new Error(`设置 ${key} 不能大于 ${def.max}`);
      return n;
    }
    case 'enum':
      if (!def.values.includes(value)) throw new Error(`设置 ${key} 取值不合法`);
      return value;
    case 'color':
      if (!/^#[0-9a-fA-F]{6}$/.test(String(value))) throw new Error('主题色需要 #RRGGBB 格式');
      return String(value);
    default:
      return String(value ?? '').slice(0, 2000);
  }
}

// 保存一组设置（已校验的值对象），并把版本号 +1 让缓存失效
export async function saveSettings(env, patch) {
  const t = nowSec();
  for (const [k, v] of Object.entries(patch)) {
    await run(env, 'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
      k, JSON.stringify(v), t);
  }
  const cur = await first(env, "SELECT value FROM settings WHERE key='_ver'");
  const ver = (cur ? Number(JSON.parse(cur.value)) || 0 : 0) + 1;
  await run(env, "INSERT INTO settings (key, value, updated_at) VALUES ('_ver', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    JSON.stringify(ver), t);
  cache = { at: 0, ver: -1, data: null };
  return ver;
}
