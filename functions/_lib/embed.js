// embed.js — 视频外链识别：只接受从 URL 解析出的视频 id，再拼官方嵌入代码
// 铁律：用户提交的任何 <iframe>/<script> 都不会被透传，嵌入代码永远由这里生成。
import { esc } from './http.js';

// 支持：bilibili.com/video/BVxxx、b23.tv 短链不在此解析（需请求外站，发布时不做）、
// youtube.com/watch?v=、youtu.be/、youtube.com/shorts/
export function parseVideoUrl(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/BV[0-9A-Za-z]{10}/);
  if (m && /bilibili\.com|b23\.tv/i.test(s)) return { platform: 'bilibili', id: m[0] };
  if (/^BV[0-9A-Za-z]{10}$/.test(s)) return { platform: 'bilibili', id: s };
  m = s.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([0-9A-Za-z_-]{6,})/);
  if (m) return { platform: 'youtube', id: m[1] };
  return null;
}

export function embedHtml({ platform, id }, title = '') {
  if (platform === 'bilibili') {
    const src = `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(id)}&page=1&high_quality=1`;
    const watch = `https://www.bilibili.com/video/${encodeURIComponent(id)}`;
    return `<div class="video-embed"><iframe src="${src}" title="${esc(title || 'Bilibili 视频（哔哩哔哩）')}" loading="lazy" allowfullscreen></iframe></div>`
      + `<p class="video-fallback"><a href="${watch}" rel="nofollow noopener" target="_blank">在 B 站打开原视频 ↗</a></p>`;
  }
  if (platform === 'youtube') {
    const src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}`;
    const watch = `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
    return `<div class="video-embed"><iframe src="${src}" title="${esc(title || 'YouTube 视频')}" loading="lazy" allowfullscreen></iframe></div>`
      + `<p class="video-fallback"><a href="${watch}" rel="nofollow noopener" target="_blank">在 YouTube 打开原视频 ↗</a></p>`;
  }
  return '';
}

export function videoPageUrl({ platform, id }) {
  return platform === 'bilibili'
    ? `https://www.bilibili.com/video/${encodeURIComponent(id)}`
    : `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
}
