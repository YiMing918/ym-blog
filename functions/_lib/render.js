// render.js — Markdown → 安全 HTML（发布时预渲染，读时直出，不在读路径上现算）
// 支持子集（够博客用，不追求全语法）：标题(带锚点)/段落/粗斜体/删除线/行内代码/代码块(带语言与复制键)/
// 列表/引用/表格/分割线/链接/图片（含组图约定）/视频嵌入行/本地视频行。
// 组图约定：一个段落里只包含图片时——1 张=单图，2 张=双列，3 张=一大多小，4 张以上=图集条；
// 图片 alt 以「|长图」结尾（如 ![截图|长图](…)）表示超长图：正文里限高展示、点开看全图。
// 本地视频：单独一行写 [video](/media/xxx.mp4) 或 ![](xxx.mp4) 会渲染成 <video> 播放器。
// 原始 HTML 默认转义不透传（安全优先）；确需嵌入时用视频的 URL 形式，别贴 iframe 代码。

import { esc } from './http.js';
import { parseVideoUrl, embedHtml } from './embed.js';
import { sanitizeHtml } from './sanitize.js';

const MEDIA_EXT = /\.(mp4|webm|mov)(\?|#|$)/i;

function slugifyHeading(text, seen) {
  let base = text.trim().toLowerCase().replace(/[^\p{L}\p{N}一-鿿]+/gu, '-').replace(/^-+|-+$/g, '') || 'section';
  let id = base;
  let n = 2;
  while (seen.has(id)) id = `${base}-${n++}`;
  seen.add(id);
  return id;
}

function inline(text, ctx) {
  let s = esc(text);
  // 图片 ![alt](src)
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, alt, src) => {
    const marker = `\u0001${ctx.images.length}\u0001`;
    ctx.images.push({ alt, src });
    return marker;
  });
  // 链接 [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    if (/^(https?:\/\/|\/|#|mailto:)/i.test(url) && !/^javascript:/i.test(url)) {
      return `<a href="${url}">${label}</a>`;
    }
    return label;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  // 还原图片占位
  s = s.replace(/\u0001(\d+)\u0001/g, (m, i) => imageTag(ctx.images[Number(i)]));
  return s;
}

function imageTag({ alt, src }) {
  const long = /\|长图\s*$/.test(alt || '');
  const cleanAlt = (alt || '').replace(/\|长图\s*$/, '');
  if (MEDIA_EXT.test(src)) {
    return `<video src="${esc(src)}" controls preload="metadata" playsinline></video>`;
  }
  const cls = long ? ' class="img-long"' : '';
  return `<img src="${esc(src)}" alt="${esc(cleanAlt)}" loading="lazy"${cls}>`;
}

function figureFor(images) {
  if (!images || images.length === 0) return '';
  if (images.length === 1) {
    const im = images[0];
    if (MEDIA_EXT.test(im.src)) return `<figure class="fig">${imageTag(im)}</figure>`;
    const long = /\|长图\s*$/.test(im.alt || '');
    return `<figure class="fig${long ? ' fig-long' : ''}">${imageTag(im)}${im.alt && !long ? `<figcaption>${esc(im.alt.replace(/\|长图\s*$/, ''))}</figcaption>` : ''}</figure>`;
  }
  const cls = images.length === 2 ? 'gal gal-2' : images.length === 3 ? 'gal gal-3' : 'gal gal-strip';
  const inner = images.map((im) => imageTag(im)).join('');
  return `<figure class="${cls}">${inner}</figure>`;
}

// 主渲染：返回 { html, toc:[{level,text,id}], text }（text 为纯文本，供摘要/字数）
export function renderMarkdown(md) {
  const src = String(md || '').replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  const toc = [];
  const seen = new Set();
  const blocks = [];
  const textParts = [];
  let i = 0;

  const flushPara = (buf) => {
    if (!buf.length) return;
    const raw = buf.join('\n');
    // 整段只是视频外链 → 嵌入
    const vid = parseVideoUrl(raw.trim());
    if (vid && raw.trim().split('\n').length === 1) { blocks.push(embedHtml(vid)); return; }
    // 整段只是 [video](本地文件) → 本地播放器
    const lv = raw.trim().match(/^\[video\]\(([^)]+)\)$/i);
    if (lv) { blocks.push(`<figure class="fig"><video src="${esc(lv[1])}" controls preload="metadata" playsinline></video></figure>`); return; }
    const ctx = { images: [] };
    const html = inline(raw, ctx);
    textParts.push(raw);
    // 整段全是图片 → 组图
    const onlyImgs = raw.replace(/!\[[^\]]*\]\([^)]+\)/g, '').trim() === '' && ctx.images.length > 0;
    if (onlyImgs) { blocks.push(figureFor(ctx.images)); return; }
    blocks.push(`<p>${html.replace(/\n/g, '<br>')}</p>`);
  };

  let para = [];
  while (i < lines.length) {
    const line = lines[i];
    // 代码块
    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      flushPara(para); para = [];
      const code = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { code.push(lines[i]); i++; }
      i++;
      const lang = fence[1] || '';
      blocks.push(`<div class="codeblock"><button class="copy-btn" type="button">复制</button><pre><code${lang ? ` class="language-${esc(lang)}"` : ''}>${esc(code.join('\n'))}</code></pre></div>`);
      textParts.push(code.join('\n'));
      continue;
    }
    // 标题
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushPara(para); para = [];
      const level = h[1].length;
      const text = h[2].replace(/[*`]/g, '');
      const id = slugifyHeading(text, seen);
      if (level === 2 || level === 3) toc.push({ level, text, id });
      blocks.push(`<h${level} id="${id}">${inline(h[2], { images: [] })}</h${level}>`);
      textParts.push(text);
      i++;
      continue;
    }
    // 分割线
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushPara(para); para = []; blocks.push('<hr>'); i++; continue; }
    // 引用
    if (/^>\s?/.test(line)) {
      flushPara(para); para = [];
      const q = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(lines[i].replace(/^>\s?/, '')); i++; }
      blocks.push(`<blockquote><p>${inline(q.join('\n'), { images: [] }).replace(/\n/g, '<br>')}</p></blockquote>`);
      textParts.push(q.join(' '));
      continue;
    }
    // 表格（以 | 开头且下一行是分隔行）
    if (/^\|/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
      flushPara(para); para = [];
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) { rows.push(lines[i]); i++; }
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(rows[0]);
      const body = rows.slice(2).map(cells);
      blocks.push('<table><thead><tr>' + head.map((c) => `<th>${inline(c, { images: [] })}</th>`).join('') + '</tr></thead><tbody>'
        + body.map((r) => '<tr>' + r.map((c) => `<td>${inline(c, { images: [] })}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    // 列表（连续的 - 或 1. 行）
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      flushPara(para); para = [];
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''));
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      blocks.push(`<${tag}>` + items.map((it) => `<li>${inline(it, { images: [] })}</li>`).join('') + `</${tag}>`);
      textParts.push(items.join(' '));
      continue;
    }
    if (line.trim() === '') { flushPara(para); para = []; i++; continue; }
    para.push(line);
    i++;
  }
  flushPara(para);

  const html = sanitizeHtml(blocks.join('\n'));
  const text = textParts.join(' ').replace(/[#>*`~[\]()!|-]/g, ' ').replace(/\s+/g, ' ').trim();
  return { html, toc, text };
}

export function excerptOf(md, renderedText, max = 140) {
  const t = (renderedText || '').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

export function wordCountOf(text) {
  const t = String(text || '');
  const cjk = (t.match(/[一-鿿぀-ヿ가-힯]/g) || []).length;
  const words = (t.replace(/[一-鿿぀-ヿ가-힯]/g, ' ').match(/[A-Za-z0-9]+/g) || []).length;
  return cjk + words;
}

export function readingMinutes(wordCount) {
  return Math.max(1, Math.round(wordCount / 400));
}

// 从正文里找第一张图片的 src（封面兜底用）
export function firstImageOf(md) {
  const m = String(md || '').match(/!\[[^\]]*\]\(([^)\s]+)\)/);
  return m ? m[1] : null;
}
