// ai.js — AI 辅助写作的配置存取与生成调用（只做管道：配置存取 + OpenAI 兼容接口代理）
// 借鉴 EdgeBlog 的 AI 设置页：Base URL / API Key / 模型 / 温度 / 两套提示词（摘要、正文）。
// 与 settings.js 的分工：AI 配置同样存 settings 表，但刻意不进 SETTING_DEFS 白名单——
//   通用设置接口只认白名单，AI 的 Key 永远不会被顺带序列化出去；读写只走本模块与
//   /api/admin/ai/config 专用接口，对外只回 has_api_key，Key 本身永不下发。
// 未配置（没填 Base URL 或 Key）时 generate 抛 ai_not_configured，编辑器据此给明确提示。

import { all, run } from './db.js';
import { nowSec, HttpError } from './http.js';

export const AI_DEFAULTS = {
  base_url: '',
  api_key: '',
  model: '',
  temperature: 0.7,
  prompt_summary: '你是中文写作助手。基于给出的文章标题与正文，写一段不超过 120 字的中文摘要，准确概括全文，不加引号、不加解释，只输出摘要本身。',
  prompt_body: '你是中文写作助手。根据给出的标题与已有内容（可能是要点或开头），写出/续写一篇结构完整、语言自然的中文文章正文，使用 Markdown 格式，只输出正文，不要加任何解释。',
};
const AI_KEYS = Object.keys(AI_DEFAULTS);

async function readRaw(env) {
  const rows = await all(env, `SELECT key, value FROM settings WHERE key IN (${AI_KEYS.map(() => '?').join(',')})`, ...AI_KEYS.map((k) => 'ai_' + k));
  const map = {};
  for (const r of rows) {
    try { map[r.key.slice(3)] = JSON.parse(r.value); } catch { /* 坏值当未设置 */ }
  }
  const cfg = {};
  for (const k of AI_KEYS) cfg[k] = map[k] !== undefined ? map[k] : AI_DEFAULTS[k];
  cfg.temperature = Number.isFinite(Number(cfg.temperature)) ? Number(cfg.temperature) : AI_DEFAULTS.temperature;
  return cfg;
}

// 完整配置（含 Key）：只许服务端内部用，禁止直接序列化进响应
export async function getAiConfig(env) {
  return readRaw(env);
}

// 对外配置：去掉 Key 本体，只给「配没配」
export async function getAiConfigPublic(env) {
  const cfg = await readRaw(env);
  const { api_key, ...rest } = cfg;
  return { ...rest, has_api_key: !!(api_key && String(api_key).trim()) };
}

export function aiConfigured(cfg) {
  return !!(cfg && String(cfg.base_url || '').trim() && String(cfg.api_key || '').trim());
}

// 保存配置：patch 里出现的键才写；api_key 传 null 表示保持原值不动（调用方处理清空语义）
export async function saveAiConfig(env, patch) {
  const t = nowSec();
  for (const k of AI_KEYS) {
    if (!(k in patch) || patch[k] === null || patch[k] === undefined) continue;
    let v = patch[k];
    if (k === 'temperature') {
      v = Number(v);
      if (!Number.isFinite(v) || v < 0 || v > 2) throw new HttpError('bad_request', '温度（temperature）要在 0 到 2 之间', 400);
    } else if (k === 'base_url') {
      v = String(v).trim().replace(/\/+$/, '');
      if (v && !/^https?:\/\/[^\s]+$/i.test(v)) throw new HttpError('bad_request', 'Base URL 格式不对，应以 http:// 或 https:// 开头', 400);
      if (v.length > 300) throw new HttpError('bad_request', 'Base URL 太长', 400);
    } else if (k === 'api_key') {
      v = String(v).trim().slice(0, 500);
    } else if (k === 'model') {
      v = String(v).trim().slice(0, 120);
    } else {
      v = String(v).slice(0, 4000); // 两套提示词
    }
    await run(env, 'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
      'ai_' + k, JSON.stringify(v), t);
  }
  return getAiConfigPublic(env);
}

// 调上游生成。mode: 'summary' | 'body'。未配置 → ai_not_configured（400，规范提示非报错堆栈）。
// 上游出错用 424 而非 502：站点套着 Cloudflare 区域代理时，源站返回的 502 会被边缘替换成
// Cloudflare 自己的纯文本错误页（error code: 502），后台就读不到这里的中文 JSON 提示了（实测教训）。
export async function aiGenerate(env, { mode, title, content }) {
  const cfg = await getAiConfig(env);
  if (!aiConfigured(cfg)) {
    throw new HttpError('ai_not_configured', '尚未配置 AI：请先到后台「站点设置 → AI 写作」填 Base URL 与 API Key', 400);
  }
  const isSummary = mode === 'summary';
  const system = isSummary ? cfg.prompt_summary : cfg.prompt_body;
  const userParts = [];
  if (title) userParts.push(`标题：${String(title).slice(0, 200)}`);
  userParts.push(isSummary ? `正文：\n${String(content || '').slice(0, 12000)}` : `已有内容/要点：\n${String(content || '').slice(0, 8000)}`);
  const url = cfg.base_url.replace(/\/+$/, '') + '/chat/completions';
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.api_key}` },
      body: JSON.stringify({
        model: cfg.model || 'gpt-4o-mini',
        temperature: cfg.temperature,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userParts.join('\n\n') },
        ],
      }),
      signal: AbortSignal.timeout(90000),
    });
  } catch (e) {
    throw new HttpError('ai_upstream_error', `连不上 AI 服务（${url}）：请检查 Base URL 是否正确、服务是否可达`, 424);
  }
  if (!resp.ok) {
    throw new HttpError('ai_upstream_error', `AI 服务返回 ${resp.status}：请检查 API Key 与模型名是否正确`, 424);
  }
  let data;
  try { data = await resp.json(); } catch { throw new HttpError('ai_upstream_error', 'AI 服务返回的不是合法 JSON', 424); }
  const text = data?.choices?.[0]?.message?.content;
  if (!text || !String(text).trim()) throw new HttpError('ai_upstream_error', 'AI 服务没有返回内容，请换个模型或稍后再试', 424);
  return { text: String(text).trim(), model: data.model || cfg.model || '' };
}
