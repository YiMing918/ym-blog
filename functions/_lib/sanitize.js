// sanitize.js — HTML 净化与评论安全渲染
// 原则：入库一律存原文，渲染时才净化；永不信任入库内容（评论 XSS 是最现实的被黑路径）。
// 正文 HTML 是本系统自己从 Markdown 生成的（render.js 已转义），这里再过一遍白名单兜底。
// 评论则更严：全部转义成纯文本，只允许 http(s) 链接被识别成 <a>，一律带 nofollow ugc。

import { esc } from './http.js';

const ALLOWED_TAGS = new Set(['p', 'br', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'strong', 'em', 'del', 'a', 'img', 'figure', 'figcaption', 'div', 'span', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'iframe', 'video', 'source']);
const ALLOWED_ATTRS = {
  a: ['href', 'title', 'rel', 'target'],
  img: ['src', 'alt', 'width', 'height', 'loading', 'class'],
  iframe: ['src', 'width', 'height', 'frameborder', 'allow', 'allowfullscreen', 'title', 'loading', 'class'],
  video: ['src', 'controls', 'preload', 'poster', 'class', 'playsinline'],
  source: ['src', 'type'],
  div: ['class', 'id'],
  span: ['class'],
  figure: ['class'],
  h2: ['id'], h3: ['id'], h4: ['id'],
  code: ['class'], pre: ['class'], td: ['align'], th: ['align'],
};
const EMBED_HOSTS = ['player.bilibili.com', 'www.youtube.com', 'www.youtube-nocookie.com'];

function safeUrl(url, isEmbed = false) {
  if (!url) return null;
  const u = String(url).trim();
  if (/^(https?:)?\/\//i.test(u) || u.startsWith('/')) {
    if (isEmbed) {
      try {
        const host = new URL(u.startsWith('//') ? 'https:' + u : u).host;
        return EMBED_HOSTS.includes(host) ? u : null;
      } catch { return null; }
    }
    return u;
  }
  if (/^(mailto:|tel:|#)/i.test(u)) return u;
  return null; // javascript: 等一律丢弃
}

// 白名单净化（够用的轻量实现：去 script/style、去事件属性、属性按表过滤、URL 校验）
export function sanitizeHtml(html) {
  if (!html) return '';
  // 代码块复制按钮是 render.js 生成的固定标记（属性与文本都写死、无注入面），
  // 先用一次性随机占位把它摘出保护、净化完原样放回；只精确匹配这一个按钮，
  // 其余 <button> 照旧剥除，白名单与属性过滤口径不变。
  const COPY_BTN = '<button class="copy-btn" type="button">复制</button>';
  const token = `\u0002copybtn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}\u0002`;
  let out = String(html).split(COPY_BTN).join(token)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\s*(script|style|noscript|template|form|input|button|textarea|select|link|meta|title)[\s\S]*?(?:<\/\s*\1\s*>|\/>)/gi, '');
  out = out.replace(/<(\/?)([a-zA-Z0-9]+)((?:\s+[^<>]*?)?)(\/?)>/g, (m, slash, tagRaw, attrsRaw, selfClose) => {
    const tag = tagRaw.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return '';
    if (slash) return `</${tag}>`;
    const allowed = ALLOWED_ATTRS[tag] || [];
    let attrs = '';
    const attrRe = /([a-zA-Z-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let am;
    const srcCheck = tag === 'iframe';
    while ((am = attrRe.exec(attrsRaw || '')) !== null) {
      const name = am[1].toLowerCase();
      if (name.startsWith('on')) continue;
      if (!allowed.includes(name)) continue;
      const val = am[3] ?? am[4] ?? am[5] ?? '';
      if (name === 'href' || name === 'src' || name === 'poster') {
        const ok = safeUrl(val, srcCheck && name === 'src');
        if (!ok) continue;
        attrs += ` ${name}="${esc(ok)}"`;
      } else if (name === 'allowfullscreen' || name === 'controls' || name === 'playsinline') {
        attrs += ` ${name}`;
      } else {
        attrs += ` ${name}="${esc(val)}"`;
      }
    }
    if (tag === 'a' && !/rel=/.test(attrs)) attrs += ' rel="nofollow ugc noopener"';
    return `<${tag}${attrs}${selfClose ? '/' : ''}>`;
  });
  return out.split(token).join(COPY_BTN);
}

// 评论渲染：纯文本转义 + 链接识别 + 换行；站长后台展示评论也必须走这里
export function renderCommentText(content) {
  const text = String(content ?? '').slice(0, 2000);
  const parts = text.split(/(https?:\/\/[^\s<>"']+)/g);
  return parts.map((p) => {
    if (/^https?:\/\//.test(p)) {
      return `<a href="${esc(p)}" rel="nofollow ugc noopener" target="_blank">${esc(p)}</a>`;
    }
    return esc(p);
  }).join('').replace(/\n/g, '<br>');
}

// 评论垃圾预检用的链接计数
export function countLinks(text) {
  return (String(text || '').match(/https?:\/\//gi) || []).length;
}

// 审核词（命中即进垃圾箱）。保持克制、宁缺毋滥；要增删改这里一处即可
export const SPAM_WORDS = ['博彩', '代开发票', '刷单返利', '加微信赚钱', 'casino', 'free money'];
export function hitSpamWord(text) {
  const t = String(text || '').toLowerCase();
  return SPAM_WORDS.some((w) => t.includes(w.toLowerCase()));
}
