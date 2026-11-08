// admin.js — 后台管理单页逻辑（原生 JS，无框架、无构建步骤）
// 职责：登录/初始化/恢复码 → 仪表盘、文章（列表+编辑器）、说说、评论审核、媒体库、友链、
//       站点设置、统计、备份与数据、账号安全。所有数据都经 /api/admin/* 真接口读写，
//       响应信封 {ok:true,data} / {ok:false,error:{code,message}}（见 functions/_lib/http.js）。
// 与后端的约定（以第一批代码为准，不臆造）：
//   - 写接口必须带 X-Requested-With: fetch 头（CSRF 双保险，见 _lib/auth.js requireCsrf）；
//   - 时间字段是 Unix 秒；发布接口 publish_at 也是秒；
//   - 编辑器实时预览用本文件内的迷你渲染器（与 functions/_lib/render.js 同一子集约定，
//     发布后以服务端预渲染为准）；
//   - GET /api/admin/posts/:id 返回的 post 行含 password_hash，本文件只取「有没有密码」
//     这个布尔，绝不显示哈希本身。
'use strict';

/* ================= 小工具 ================= */
const $ = (sel, el) => (el || document).querySelector(sel);
const $$ = (sel, el) => [...(el || document).querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (sec) => (sec ? new Date(sec * 1000).toLocaleString('zh-CN', { hour12: false }) : '—');
const fmtDay = (sec) => (sec ? new Date(sec * 1000).toLocaleDateString('zh-CN') : '—');
const fmtSize = (b) => {
  b = Number(b) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
};
// datetime-local 输入框 ↔ Unix 秒 互转（按浏览器本地时区，即站长的北京时间）
const secToLocalInput = (sec) => {
  if (!sec) return '';
  const d = new Date(sec * 1000 - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
};
const localInputToSec = (v) => (v ? Math.floor(new Date(v).getTime() / 1000) : null);

function toast(msg, isErr) {
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = msg;
  $('#toastRoot').appendChild(t);
  setTimeout(() => t.remove(), 3400);
}
// 通用弹层：title + bodyHTML（调用方负责转义）+ 按钮 [{label,class,onClick(close)}]
function openModal(title, bodyHTML, actions) {
  const root = $('#modalRoot');
  root.innerHTML = `<div class="modal-mask"><div class="modal" role="dialog" aria-label="${esc(title)}">
    <h3>${esc(title)}</h3><div class="modal-body">${bodyHTML}</div>
    <div class="btnrow modal-actions"></div></div></div>`;
  const close = () => { root.innerHTML = ''; };
  $('.modal-mask', root).addEventListener('click', (e) => { if (e.target.classList.contains('modal-mask')) close(); });
  const bar = $('.modal-actions', root);
  for (const a of actions || [{ label: '关闭' }]) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn ' + (a.cls || ''); b.textContent = a.label;
    b.addEventListener('click', async () => { if (a.onClick) await a.onClick(close); else close(); });
    bar.appendChild(b);
  }
  return { close, body: $('.modal-body', root) };
}
function confirmModal(title, text, okLabel) {
  return new Promise((resolve) => {
    openModal(title, `<p>${esc(text)}</p>`, [
      { label: '取消', onClick: (close) => { close(); resolve(false); } },
      { label: okLabel || '确认', cls: 'danger-solid', onClick: (close) => { close(); resolve(true); } },
    ]);
  });
}

/* ================= API 客户端 ================= */
async function api(method, path, body) {
  const headers = { 'X-Requested-With': 'fetch' };
  const init = { method, headers, credentials: 'same-origin' };
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const resp = await fetch(path, init);
  const text = await resp.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非 JSON（如导出）不在这里处理 */ }
  if (!resp.ok || !data || data.ok !== true) {
    const err = new Error(data?.error?.message || `请求失败（${resp.status}）`);
    err.status = resp.status; err.code = data?.error?.code || '';
    throw err;
  }
  return data.data;
}

/* ================= 全局状态 ================= */
const S = {
  me: null,            // /api/admin/me
  settings: null,      // /api/admin/settings 的 settings
  view: 'dashboard',
  postsQuery: { status: '', q: '', page: 1 },
  commentsStatus: 'pending',
};
const NAVS = [
  ['dashboard', '仪表盘（Dashboard）'],
  ['posts', '文章（Posts）'],
  ['editor', '写文章（Editor）'],
  ['moments', '说说（Moments）'],
  ['comments', '评论（Comments）'],
  ['media', '媒体库（Media）'],
  ['friends', '友链（Links）'],
  ['settings', '设置（Settings）'],
  ['stats', '统计（Stats）'],
  ['backup', '备份（Backup）'],
  ['account', '账号（Account）'],
];

function applyAppearance() {
  if (!S.settings) return;
  document.documentElement.style.setProperty('--accent', S.settings.accent_color || '#e8710a');
  document.documentElement.dataset.theme = S.settings.dark_mode || 'auto';
  if (S.me) $('#brand').textContent = (S.settings.site_name || '博客') + ' · 后台';
}
function updatePendingBadge() {
  const n = S.me?.counts?.commentsPending || 0;
  const b = $('#pendingBadge');
  b.hidden = !n; b.textContent = n;
  const navBtn = $$('#viewnav button').find((x) => x.dataset.view === 'comments');
  if (navBtn) navBtn.innerHTML = `评论（Comments）${n ? `<span class="nbadge">${n}</span>` : ''}`;
}
async function refreshMe() {
  S.me = await api('GET', '/api/admin/me');
  if (!S.settings) S.settings = (await api('GET', '/api/admin/settings')).settings;
  applyAppearance(); updatePendingBadge();
}

function go(view, arg) {
  S.view = view;
  $$('#viewnav button').forEach((b) => b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false'));
  const main = $('#view');
  main.innerHTML = '<p class="loading">加载中…</p>';
  const fn = VIEWS[view];
  Promise.resolve(fn ? fn(main, arg) : null).catch((e) => {
    if (e.status === 401) return showLogin('登录已过期，请重新登录');
    main.innerHTML = `<div class="card"><h3>加载失败</h3><p class="hint">${esc(e.message)}</p>
      <button class="btn" onclick="location.reload()">刷新重试</button></div>`;
  });
  window.scrollTo({ top: 0 });
}

/* ================= 登录 / 初始化 / 恢复 ================= */
function authShell(inner) {
  $('#topbar').hidden = true;
  $('#view').innerHTML = `<div class="authwrap"><div class="card">${inner}</div></div>`;
}
function showLogin(note) {
  authShell(`
    <h2>登录后台（Login）</h2>
    ${note ? `<p class="hint">${esc(note)}</p>` : '<p class="hint">用站长账号密码登录。密码忘了可用恢复码重置。</p>'}
    <form id="loginForm">
      <label class="f"><span>用户名（Username）</span><input type="text" name="username" autocomplete="username" required></label>
      <label class="f"><span>密码（Password）</span><input type="password" name="password" autocomplete="current-password" required></label>
      <button class="btn primary block" type="submit">登录</button>
    </form>
    <div class="btnrow">
      <button class="btn ghost sm" id="toRecovery" type="button">忘记密码？用恢复码重置（Recovery）</button>
    </div>`);
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('POST', '/api/admin/login', { username: fd.get('username'), password: fd.get('password') });
      await enterApp();
    } catch (err) { toast(err.message, true); }
  });
  $('#toRecovery').addEventListener('click', showRecovery);
}
function showRecovery() {
  authShell(`
    <h2>用恢复码重置密码（Recovery）</h2>
    <p class="hint">恢复码是建站/后台生成的一次性码（形如 abcd-efgh-ijkl）。用掉一个即作废，
    重置成功后全部设备会被下线，请用新密码重新登录。</p>
    <form id="recForm">
      <label class="f"><span>用户名（Username）</span><input type="text" name="username" required></label>
      <label class="f"><span>恢复码（Recovery code）</span><input type="text" name="code" required autocomplete="off"></label>
      <label class="f"><span>新密码（至少 8 位）</span><input type="password" name="new_password" autocomplete="new-password" required></label>
      <button class="btn primary block" type="submit">重置密码</button>
    </form>
    <div class="btnrow"><button class="btn ghost sm" id="backLogin" type="button">← 返回登录</button></div>`);
  $('#recForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const r = await api('POST', '/api/admin/recovery/reset', {
        username: fd.get('username'), code: fd.get('code'), new_password: fd.get('new_password'),
      });
      toast(r.note || '密码已重置，请用新密码登录');
      showLogin('密码已重置，请用新密码登录');
    } catch (err) { toast(err.message, true); }
  });
  $('#backLogin').addEventListener('click', () => showLogin());
}
function showSetup() {
  authShell(`
    <h2>初始化站长账号（Setup）</h2>
    <p class="hint">本站还没有站长账号。设置用户名与密码后会当场生成 10 个恢复码，
    <strong>只显示这一次</strong>，请立刻抄下或截图存到安全的地方——密码忘了全靠它。</p>
    <form id="setupForm">
      <label class="f"><span>用户名（Username）</span><input type="text" name="username" autocomplete="username" required></label>
      <label class="f"><span>密码（至少 8 位）</span><input type="password" name="password" autocomplete="new-password" required></label>
      <button class="btn primary block" type="submit">创建并进入后台</button>
    </form>`);
  $('#setupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const r = await api('POST', '/api/admin/setup', { username: fd.get('username'), password: fd.get('password') });
      openModal('请保存恢复码', `<p class="hint">${esc(r.note || '恢复码只显示这一次')}</p>
        <div class="codes">${(r.recovery_codes || []).map(esc).join('<br>')}</div>`,
        [{ label: '我已保存，进后台', cls: 'primary', onClick: async (close) => { close(); await enterApp(); } }]);
    } catch (err) { toast(err.message, true); }
  });
}
async function enterApp() {
  $('#topbar').hidden = false;
  const nav = $('#viewnav');
  nav.innerHTML = '';
  for (const [key, label] of NAVS) {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.view = key; b.textContent = label;
    b.addEventListener('click', () => { if (key === 'editor') go('editor', null); else go(key); });
    nav.appendChild(b);
  }
  await refreshMe();
  go('dashboard');
}
$('#logoutBtn').addEventListener('click', async () => {
  try { await api('POST', '/api/admin/logout'); } catch { /* 已失效也照样回登录页 */ }
  S.me = null; S.settings = null;
  showLogin('已退出登录');
});

/* ================= 仪表盘 ================= */
async function viewDashboard(main) {
  await refreshMe();
  const c = S.me.counts, u = S.me.media_usage || { totalBytes: 0, totalCount: 0 };
  const last = S.me.last_backup;
  main.innerHTML = `
    <div class="stat-grid">
      <div class="stat"><b>${c.postsPublished}</b><span>已发布文章（Published）</span></div>
      <div class="stat"><b>${c.postsDraft}</b><span>草稿（Drafts）</span></div>
      <div class="stat"><b>${c.commentsPending}</b><span>待审评论（Pending）</span></div>
      <div class="stat"><b>${S.me.total_views}</b><span>总阅读（Views）</span></div>
      <div class="stat"><b>${c.moments}</b><span>说说（Moments）</span></div>
      <div class="stat"><b>${u.totalCount}</b><span>媒体文件（Media）</span></div>
      <div class="stat"><b>${fmtSize(u.totalBytes)}</b><span>媒体占用（R2）</span></div>
      <div class="stat"><b>${c.friends}</b><span>友链（Links）</span></div>
    </div>
    <div class="card" style="margin-top:12px">
      <h3>快捷入口</h3>
      <div class="btnrow">
        <button class="btn primary" data-go="editor">✎ 写新文章</button>
        <button class="btn" data-go="comments">评论待审${c.commentsPending ? `（${c.commentsPending}）` : ''}</button>
        <button class="btn" data-go="media">上传图片/视频</button>
        <button class="btn" data-go="backup">备份与导出</button>
      </div>
      <p class="hint">最近一次备份：${last ? `${fmtTime(last.created_at)}（${fmtSize(last.size_bytes)}）` : '还没有备份记录，建议到「备份」页手动跑一次'}。
      存储提示：R2（对象存储）免费额度约 10GB，媒体用量以媒体库页为准。</p>
    </div>`;
  $$('[data-go]', main).forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));
}

/* ================= 文章列表 ================= */
const STATUS_META = {
  published: ['已发布', 'pub'], draft: ['草稿', 'draft'], scheduled: ['定时', 'sched'],
  private: ['仅自己', 'priv'], trash: ['回收站', 'trash'],
};
function statusPill(p) {
  // 定时已到点的公开口径是「已上线」，列表里照实标注
  if (p.status === 'scheduled' && p.publish_at && p.publish_at <= Math.floor(Date.now() / 1000)) {
    return '<span class="pill pub">已上线（定时到点）</span>';
  }
  const m = STATUS_META[p.status] || [p.status, ''];
  return `<span class="pill ${m[1]}">${m[0]}</span>`;
}
async function viewPosts(main) {
  const q = S.postsQuery;
  const params = new URLSearchParams();
  if (q.status) params.set('status', q.status);
  if (q.q) params.set('q', q.q);
  params.set('page', q.page);
  const data = await api('GET', `/api/admin/posts?${params}`);
  const tabs = [['', '全部'], ['published', '已发布'], ['draft', '草稿'], ['scheduled', '定时'], ['private', '仅自己'], ['trash', '回收站']];
  main.innerHTML = `
    <div class="card">
      <div class="tabs" role="tablist">${tabs.map(([v, l]) =>
        `<button type="button" data-st="${v}" aria-pressed="${q.status === v}">${l}</button>`).join('')}</div>
      <form id="pq" class="btnrow" style="align-items:center">
        <input type="search" name="q" placeholder="搜标题或短链（slug）" value="${esc(q.q)}" style="flex:1;min-width:160px">
        <button class="btn" type="submit">搜索</button>
        <button class="btn primary" type="button" id="newPost">＋ 新建文章</button>
      </form>
      <div id="plist"></div>
      <div class="pager">
        <button class="btn sm" id="pgPrev" ${q.page <= 1 ? 'disabled' : ''}>上一页</button>
        <span>第 ${q.page} 页 · 共 ${data.total} 篇</span>
        <button class="btn sm" id="pgNext" ${q.page * data.per >= data.total ? 'disabled' : ''}>下一页</button>
      </div>
    </div>`;
  $$('.tabs button', main).forEach((b) => b.addEventListener('click', () => { q.status = b.dataset.st; q.page = 1; go('posts'); }));
  $('#pq', main).addEventListener('submit', (e) => { e.preventDefault(); q.q = new FormData(e.target).get('q').trim(); q.page = 1; go('posts'); });
  $('#newPost', main).addEventListener('click', () => go('editor', null));
  $('#pgPrev', main).addEventListener('click', () => { q.page--; go('posts'); });
  $('#pgNext', main).addEventListener('click', () => { q.page++; go('posts'); });

  const list = $('#plist', main);
  if (!data.posts.length) { list.innerHTML = '<p class="empty">这一类下面还没有文章。</p>'; return; }
  list.innerHTML = data.posts.map((p) => `
    <div class="row" data-id="${p.id}">
      <div class="main">
        <div class="ttl">${p.is_sticky ? '📌 ' : ''}${esc(p.title)} ${statusPill(p)}${p.type === 'page' ? '<span class="pill">独立页</span>' : ''}</div>
        <div class="meta">/${esc(p.slug)} · 更新 ${fmtTime(p.updated_at)} · ${p.word_count || 0} 字 · 评论 ${p.comment_count}
        ${p.status === 'scheduled' && p.publish_at ? ` · 定时于 ${fmtTime(p.publish_at)}` : ''}</div>
      </div>
      <div class="ops">
        <button class="btn sm" data-act="edit">编辑</button>
        <button class="btn sm" data-act="preview">预览</button>
        <button class="btn sm" data-act="clone">复制</button>
        ${p.status === 'trash'
          ? '<button class="btn sm" data-act="restore">还原</button><button class="btn sm danger" data-act="purge">彻底删除</button>'
          : '<button class="btn sm danger" data-act="del">删除</button>'}
      </div>
    </div>`).join('');
  $$('.row', list).forEach((row) => {
    const id = Number(row.dataset.id);
    row.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      try {
        if (act === 'edit') go('editor', id);
        if (act === 'clone') {
          const r = await api('POST', '/api/admin/posts', { template_post_id: id });
          toast('已复制为草稿'); go('editor', r.post.id);
        }
        if (act === 'preview') {
          const p = data.posts.find((x) => x.id === id);
          if (p.status === 'published' || (p.status === 'scheduled' && p.publish_at <= Date.now() / 1000)) {
            window.open(`/post/${p.slug}`, '_blank');
          } else {
            const r = await api('POST', `/api/admin/posts/${id}/preview-token`, {});
            window.open(r.url, '_blank');
          }
        }
        if (act === 'del') { await api('DELETE', `/api/admin/posts/${id}`); toast('已移入回收站（30 天内可还原）'); go('posts'); }
        if (act === 'restore') { await api('POST', `/api/admin/posts/${id}/restore-trash`, {}); toast('已还原为草稿'); go('posts'); }
        if (act === 'purge') {
          if (await confirmModal('彻底删除', '彻底删除后无法恢复，确定吗？', '彻底删除')) {
            await api('DELETE', `/api/admin/posts/${id}?purge=1`); toast('已彻底删除'); go('posts');
          }
        }
      } catch (err) { toast(err.message, true); }
    });
  });
}

/* ================= 编辑器：迷你 Markdown 预览 =================
   与 functions/_lib/render.js 同一子集约定（标题/段落/粗斜体/行内代码/代码块/列表/
   引用/表格/图片组图/视频行）。这是「近似预览」：发布后访客看到的是服务端预渲染结果，
   两者在上述子集内一致；原始 HTML 一律转义不透传，与服务端一致。 */
function parseVideoLine(s) {
  const t = String(s || '').trim();
  let m = t.match(/BV[0-9A-Za-z]{10}/);
  if (m && /bilibili\.com|b23\.tv/i.test(t)) return { platform: 'bilibili', id: m[0] };
  if (/^BV[0-9A-Za-z]{10}$/.test(t)) return { platform: 'bilibili', id: t };
  m = t.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([0-9A-Za-z_-]{6,})/);
  if (m) return { platform: 'youtube', id: m[1] };
  return null;
}
function embedPreviewHtml(v) {
  if (!v) return '';
  if (v.platform === 'bilibili') {
    return `<div class="video-embed"><iframe src="https://player.bilibili.com/player.html?bvid=${encodeURIComponent(v.id)}&page=1&high_quality=1" loading="lazy" allowfullscreen></iframe></div>`
      + `<p class="hint"><a href="https://www.bilibili.com/video/${encodeURIComponent(v.id)}" target="_blank" rel="noopener">在 B 站打开原视频 ↗</a></p>`;
  }
  return `<div class="video-embed"><iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(v.id)}" loading="lazy" allowfullscreen></iframe></div>`
    + `<p class="hint"><a href="https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}" target="_blank" rel="noopener">在 YouTube 打开原视频 ↗</a></p>`;
}
function miniInline(text) {
  let s = esc(text);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, src) =>
    /\.(mp4|webm|mov)(\?|#|$)/i.test(src)
      ? `<video src="${src}" controls preload="metadata"></video>`
      : `<img src="${src}" alt="${alt}" loading="lazy">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) =>
    /^(https?:\/\/|\/|#|mailto:)/i.test(url) ? `<a href="${url}" target="_blank" rel="noopener">${label}</a>` : label);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  return s;
}
function miniRender(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let para = [];
  const flush = () => {
    if (!para.length) return;
    const raw = para.join('\n'); para = [];
    const v = parseVideoLine(raw.trim());
    if (v && raw.trim().split('\n').length === 1) { out.push(embedPreviewHtml(v)); return; }
    const lv = raw.trim().match(/^\[video\]\(([^)]+)\)$/i);
    if (lv) { out.push(`<figure><video src="${esc(lv[1])}" controls preload="metadata"></video></figure>`); return; }
    const onlyImg = raw.replace(/!\[[^\]]*\]\([^)]+\)/g, '').trim() === '' && /!\[.*?\]\(.*?\)/.test(raw);
    if (onlyImg) {
      const imgs = [...raw.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)].map((m) => ({ alt: m[1], src: m[2] }));
      const cls = imgs.length === 2 ? '（双图并排）' : imgs.length === 3 ? '（三图组图）' : imgs.length > 3 ? '（图集条）' : '';
      out.push(`<figure>${imgs.map((im) => miniInline(`![${im.alt}](${im.src})`)).join('')}${cls ? `<figcaption class="hint">${cls}访客页按组图排版</figcaption>` : ''}</figure>`);
      return;
    }
    out.push(`<p>${miniInline(raw).replace(/\n/g, '<br>')}</p>`);
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      flush(); const code = []; i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { code.push(lines[i]); i++; }
      i++;
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flush(); out.push(`<h${h[1].length}>${miniInline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
    if (/^>\s?/.test(line)) {
      flush(); const q = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push(`<blockquote><p>${miniInline(q.join('\n')).replace(/\n/g, '<br>')}</p></blockquote>`);
      continue;
    }
    if (/^\|/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
      flush(); const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) { rows.push(lines[i]); i++; }
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      out.push('<table class="simple"><thead><tr>' + cells(rows[0]).map((c) => `<th>${miniInline(c)}</th>`).join('') + '</tr></thead><tbody>'
        + rows.slice(2).map((r) => '<tr>' + cells(r).map((c) => `<td>${miniInline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      flush(); const ordered = /^\s*\d+\./.test(line); const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, '')); i++; }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>` + items.map((it) => `<li>${miniInline(it)}</li>`).join('') + `</${tag}>`);
      continue;
    }
    if (line.trim() === '') { flush(); i++; continue; }
    para.push(line); i++;
  }
  flush();
  return out.join('\n');
}

/* ================= 直传通道（sign → 浏览器直传 R2 → complete 登记） =================
   文件字节只在浏览器与 R2 之间走，绝不经过本站 Worker（见设计稿 ③）。 */
async function probeDims(file) {
  // 图片读宽高、视频读宽高与时长，供 complete 登记（灯箱占位/时长显示用）
  const url = URL.createObjectURL(file);
  try {
    if (file.type.startsWith('image/')) {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      return { width: img.naturalWidth, height: img.naturalHeight };
    }
    if (file.type.startsWith('video/')) {
      const v = document.createElement('video');
      v.preload = 'metadata'; v.src = url;
      await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = rej; });
      return { width: v.videoWidth, height: v.videoHeight, duration_sec: Math.round(v.duration) || null };
    }
  } catch { /* 读不到尺寸就留空，不挡上传 */ }
  finally { setTimeout(() => URL.revokeObjectURL(url), 4000); }
  return {};
}
async function uploadFile(file) {
  const dims = await probeDims(file);
  const sign = await api('POST', '/api/admin/media/sign', {
    mime: file.type, size: file.size, orig_name: file.name, display_name: file.name,
  });
  const put = await fetch(sign.put_url, { method: 'PUT', headers: sign.headers || { 'Content-Type': file.type }, body: file });
  if (!put.ok) throw new Error(`直传失败（${put.status}），请重试`);
  const done = await api('POST', '/api/admin/media/complete', { media_id: sign.media_id, ...dims });
  return { media_id: sign.media_id, media_url: done.media_url, kind: file.type.startsWith('video/') ? 'video' : 'image' };
}

/* ================= 编辑器 ================= */
const ED = {
  post: null,          // 当前文章行（新建时 null）
  tags: [],
  dirty: false,
  clearPassword: false,
  serverSaveTimer: null,
  localKey: 'ymblog-new',
};
function edLocalSave() {
  try {
    localStorage.setItem(ED.localKey, JSON.stringify({
      title: $('#edTitle').value, content_md: $('#edBody').value, at: Date.now(),
    }));
  } catch { /* 隐私模式等存不了就跳过本地层 */ }
}
function edLocalLoad() {
  try { return JSON.parse(localStorage.getItem(ED.localKey) || 'null'); } catch { return null; }
}
function edLocalClear() { try { localStorage.removeItem(ED.localKey); } catch { /* 同上 */ } }
function edSetSaveState(text, isErr) {
  const el = $('#saveState');
  if (el) { el.textContent = text; el.classList.toggle('err', !!isErr); }
}
function edMarkDirty() {
  ED.dirty = true;
  edLocalSave();
  edSetSaveState('本地已存 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '（打字中，服务端自动保存稍后跟上）');
  clearTimeout(ED.serverSaveTimer);
  ED.serverSaveTimer = setTimeout(edServerAutosave, 60000); // 服务端层每 60 秒节流（与后端约定一致）
}
async function edServerAutosave() {
  if (!ED.post || !ED.dirty) return;
  try {
    const r = await api('PUT', `/api/admin/posts/${ED.post.id}/autosave`, {
      title: $('#edTitle').value, content_md: $('#edBody').value,
    });
    edSetSaveState('本地+服务端都已存 ' + new Date(r.saved_at * 1000).toLocaleTimeString('zh-CN', { hour12: false }));
  } catch (e) { edSetSaveState('服务端自动保存失败：' + e.message, true); }
}
function edInsertText(text) {
  const ta = $('#edBody');
  const { selectionStart: s, selectionEnd: e, value } = ta;
  ta.value = value.slice(0, s) + text + value.slice(e);
  ta.focus();
  ta.selectionStart = ta.selectionEnd = s + text.length;
  edRefreshPreview(); edMarkDirty();
}
function edRefreshPreview() { $('#edPreview').innerHTML = miniRender($('#edBody').value) || '<p class="hint">预览为空</p>'; }
function edRenderTags() {
  $('#edTags').innerHTML = ED.tags.map((t, i) =>
    `<button type="button" class="chip" data-rmtag="${i}" title="点一下移除">${esc(t)} ✕</button>`).join('')
    + '<span class="hint">（Tags 标签：点已选标签可移除；下面输入新标签回车添加）</span>';
  $$('#edTags [data-rmtag]').forEach((b) => b.addEventListener('click', () => {
    ED.tags.splice(Number(b.dataset.rmtag), 1); edRenderTags(); ED.dirty = true;
  }));
}

async function viewEditor(main, postId) {
  clearTimeout(ED.serverSaveTimer);
  ED.post = null; ED.tags = []; ED.dirty = false; ED.clearPassword = false;
  let autosave = null;
  if (postId) {
    const data = await api('GET', `/api/admin/posts/${postId}`);
    ED.post = data.post; ED.tags = data.tags || []; autosave = data.autosave;
    ED.localKey = 'ymblog-post-' + postId;
  } else {
    ED.localKey = 'ymblog-new';
  }
  const p = ED.post;
  main.innerHTML = `
  <div class="card">
    <div class="ed-head">
      <h2 style="margin:0">${p ? '编辑文章（Edit）' : '写新文章（New post）'}</h2>
      <span class="spacer"></span>
      <span id="saveState" class="savestate">${p ? '已打开，服务端正文更新于 ' + fmtTime(p.updated_at) : '新草稿：打字会自动存到本地'}</span>
    </div>
    <div id="restoreBar"></div>
    <label class="f"><span>标题（Title）</span><input type="text" id="edTitle" value="${esc(p?.title || '')}" placeholder="给文章起个标题"></label>
    <div class="grid2">
      <label class="f"><span>短链 slug（短链，留空自动按标题生成；改短链会自动登记旧链跳转）</span>
        <input type="text" id="edSlug" value="${esc(p?.slug || '')}" placeholder="如 weekend-hiking"></label>
      <label class="f"><span>封面图（Cover）：从媒体库选，或正文第一张图自动当封面</span>
        <span class="btnrow" style="margin:0">
          <input type="hidden" id="edCover" value="${p?.cover_media_id || ''}">
          <span id="coverName" class="hint">${p?.cover_media_id ? '已设封面（媒体 #' + p.cover_media_id + '）' : '未单独设置'}</span>
          <button class="btn sm" type="button" id="pickCover">选封面</button>
          <button class="btn sm ghost" type="button" id="clearCover">清除</button>
        </span></label>
    </div>
    <label class="f"><span>摘要（Excerpt，留空自动截取正文开头）</span>
      <input type="text" id="edExcerpt" value="${esc(p?.excerpt || '')}" placeholder="一两句话介绍这篇，列表与分享时显示"></label>
    <label class="f"><span>标签（Tags）</span>
      <span id="edTags" class="chips"></span>
      <input type="text" id="tagInput" placeholder="输入标签后回车添加（如：折腾、日常）" style="margin-top:6px"></label>

    <div class="btnrow" role="toolbar" aria-label="插入工具">
      <button class="btn sm" type="button" id="insImg">🖼 插入图片（本地直传）</button>
      <button class="btn sm" type="button" id="insVid">🎬 插入视频文件（本地直传）</button>
      <button class="btn sm" type="button" id="insEmbed">📺 贴 B 站 / YouTube 外链</button>
      <button class="btn sm" type="button" id="insMedia">🗂 从媒体库选</button>
      <span class="pane-toggle"><button class="btn sm" type="button" id="paneBtn">切换 编辑/预览</button></span>
    </div>
    <input type="file" id="fileImg" accept="image/*" multiple hidden>
    <input type="file" id="fileVid" accept="video/*" hidden>
    <div id="embedBar" hidden>
      <label class="f"><span>把 Bilibili（哔哩哔哩）或 YouTube 的视频链接粘进来，单独成行插入正文</span>
      <span class="btnrow" style="margin:0"><input type="url" id="embedUrl" placeholder="https://www.bilibili.com/video/BV…" style="flex:1;min-width:200px">
      <button class="btn sm primary" type="button" id="embedGo">插入</button></span></label>
    </div>

    <div class="ed-panes">
      <div class="md-wrap"><label class="f"><span>正文（Markdown 标记语法，左边写、右边预览）</span>
        <textarea id="edBody" class="md" placeholder="## 小标题&#10;&#10;正文写在这里，**加粗**、列表、代码块都支持；图片单独成段会按组图排版。">${esc(p?.content_md || '')}</textarea></label></div>
      <div class="preview-wrap"><label class="f"><span>预览（Preview，与发布效果基本一致，最终以发布为准）</span>
        <div id="edPreview" class="preview"></div></label></div>
    </div>

    <h3>发布面板（Publish）</h3>
    <div class="grid2">
      <label class="f"><span>定时发布时间（留空=不用定时；选了时间点「定时发布」才生效）</span>
        <input type="datetime-local" id="edPublishAt" value="${p?.publish_at ? secToLocalInput(p.publish_at) : ''}"></label>
      <label class="f"><span>文章密码（Password，可选：设了密码的文章访客要输密码才能看；留空=保持不变）</span>
        <input type="text" id="edPostPw" placeholder="${p ? '当前' + '(接口未告知是否已设)' : '不设可留空'}" autocomplete="off">
        <span class="note"><button class="btn sm ghost" type="button" id="clearPw">清除已设的文章密码</button></span></label>
    </div>
    <div class="btnrow">
      <label class="switch"><input type="checkbox" id="edSticky" ${p?.is_sticky ? 'checked' : ''}><i></i>置顶（Sticky）</label>
      <label class="switch"><input type="checkbox" id="edCmt" ${p ? (p.comment_enabled ? 'checked' : '') : 'checked'}><i></i>允许评论（Comments）</label>
    </div>
    <div class="btnrow">
      <button class="btn" type="button" id="btnSaveDraft">保存（保持当前状态）</button>
      <button class="btn" type="button" id="btnSaveRev">保存并存一版（Revision）</button>
      <button class="btn primary" type="button" id="btnPublish">立即发布（Publish）</button>
      <button class="btn" type="button" id="btnSchedule">定时发布（Schedule）</button>
      <button class="btn" type="button" id="btnPrivate">设为仅自己（Private）</button>
    </div>
    <div class="btnrow">
      <button class="btn sm" type="button" id="btnRevisions">历史版本（Revisions）</button>
      <button class="btn sm" type="button" id="btnPreviewLink">生成草稿预览链接（Preview link）</button>
      ${p ? '<button class="btn sm danger" type="button" id="btnTrash">移入回收站</button>' : ''}
      <a class="btn sm ghost" href="#" id="backList">← 回文章列表</a>
    </div>
    <div id="revBox"></div>
    <p class="hint">防丢稿三层：打字即存本机（localStorage 本地存储）→ 每 60 秒存服务端草稿（autosave 自动保存）→
    「保存/发布」时正式落库并留版本。关页面前未保存会弹提醒。</p>
  </div>`;

  edRenderTags();
  edRefreshPreview();

  // 恢复提示：服务端 autosave 或本地草稿比正文新时给入口（不自动覆盖）
  const rb = $('#restoreBar');
  const local = edLocalLoad();
  const bars = [];
  if (autosave && (!p || autosave.updated_at > p.updated_at)) {
    bars.push({ label: `服务端有一份 ${fmtTime(autosave.updated_at)} 的自动保存，比正文新`, data: autosave });
  }
  if (local && local.content_md && (!p || local.content_md !== p.content_md) && (!p || local.title !== p.title || true)) {
    if (!p || local.content_md !== p.content_md) bars.push({ label: `本机有一份 ${new Date(local.at).toLocaleString('zh-CN', { hour12: false })} 的未保存草稿`, data: local });
  }
  if (bars.length) {
    rb.innerHTML = bars.map((b, i) => `<p class="hint">💾 ${esc(b.label)}，
      <button class="btn sm" data-restore="${i}">恢复这份</button>
      <button class="btn sm ghost" data-discard="${i}">丢弃</button></p>`).join('');
    $$('[data-restore]', rb).forEach((btn) => btn.addEventListener('click', () => {
      const b = bars[Number(btn.dataset.restore)];
      if (b.data.title !== undefined) $('#edTitle').value = b.data.title || '';
      $('#edBody').value = b.data.content_md || '';
      edRefreshPreview(); edMarkDirty(); rb.innerHTML = '';
      toast('已恢复到编辑器，记得保存');
    }));
    $$('[data-discard]', rb).forEach((btn) => btn.addEventListener('click', () => { edLocalClear(); rb.innerHTML = ''; }));
  }

  // 输入联动
  $('#edBody').addEventListener('input', () => { edRefreshPreview(); edMarkDirty(); });
  $('#edTitle').addEventListener('input', edMarkDirty);
  $('#edBody').addEventListener('paste', async (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    await edUploadMany(files);
  });
  $('#tagInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = e.target.value.trim().slice(0, 30);
      if (v && !ED.tags.includes(v)) { ED.tags.push(v); edRenderTags(); ED.dirty = true; }
      e.target.value = '';
    }
  });
  $('#paneBtn').addEventListener('click', () => {
    document.body.dataset.pane = document.body.dataset.pane === 'preview' ? 'edit' : 'preview';
  });
  document.body.dataset.pane = window.innerWidth < 900 ? 'edit' : 'both';
  $('#clearPw').addEventListener('click', () => { ED.clearPassword = true; $('#edPostPw').value = ''; toast('发布/保存时将清除文章密码'); });
  $('#clearCover').addEventListener('click', () => { $('#edCover').value = ''; $('#coverName').textContent = '未单独设置'; ED.dirty = true; });
  $('#pickCover').addEventListener('click', () => pickMedia((m) => {
    $('#edCover').value = m.id; $('#coverName').textContent = `已设封面：${m.display_name}（媒体 #${m.id}）`; ED.dirty = true;
  }, 'image'));
  $('#backList').addEventListener('click', (e) => { e.preventDefault(); go('posts'); });

  // 插入：图片/视频直传
  $('#insImg').addEventListener('click', () => $('#fileImg').click());
  $('#insVid').addEventListener('click', () => $('#fileVid').click());
  $('#fileImg').addEventListener('change', async (e) => { await edUploadMany([...e.target.files]); e.target.value = ''; });
  $('#fileVid').addEventListener('change', async (e) => { await edUploadMany([...e.target.files]); e.target.value = ''; });
  $('#insMedia').addEventListener('click', () => pickMedia((m) => {
    edInsertText(`\n![${m.display_name || ''}](${m.url})\n`);
  }));
  $('#insEmbed').addEventListener('click', () => { $('#embedBar').hidden = !$('#embedBar').hidden; $('#embedUrl').focus(); });
  $('#embedGo').addEventListener('click', () => {
    const url = $('#embedUrl').value.trim();
    const v = parseVideoLine(url);
    if (!v) { toast('没认出这个链接：只支持 Bilibili（BV 号）与 YouTube 链接', true); return; }
    edInsertText(`\n${url}\n`);
    $('#embedUrl').value = ''; $('#embedBar').hidden = true;
    toast('已插入，发布后访客页会显示播放器');
  });

  async function edUploadMany(files) {
    for (const f of files) {
      try {
        toast(`正在直传 ${f.name} …`);
        const r = await uploadFile(f);
        edInsertText(`\n![${f.name.replace(/\.[^.]+$/, '')}](${r.media_url})\n`);
        toast(`${f.name} 已上传并插入`);
      } catch (err) { toast(err.message, true); }
    }
  }

  // 保存/发布：先确保有 post 行（新建时先 POST 建草稿再 PUT 全量字段）
  async function ensurePost() {
    if (ED.post) return ED.post;
    const r = await api('POST', '/api/admin/posts', { title: $('#edTitle').value || '未命名草稿' });
    ED.post = r.post; ED.localKey = 'ymblog-post-' + ED.post.id;
    return ED.post;
  }
  function collectBody() {
    const body = {
      title: $('#edTitle').value.trim() || '未命名草稿',
      content_md: $('#edBody').value,
      slug: $('#edSlug').value.trim() || undefined,
      excerpt: $('#edExcerpt').value.trim() || undefined,
      cover_media_id: $('#edCover').value ? Number($('#edCover').value) : null,
      is_sticky: $('#edSticky').checked,
      comment_enabled: $('#edCmt').checked,
      tags: ED.tags,
      base_updated_at: ED.post?.updated_at,
    };
    const pw = $('#edPostPw').value;
    if (pw) body.post_password = pw;
    else if (ED.clearPassword) body.post_password = '';
    return body;
  }
  async function saveWith(body, okMsg) {
    const post = await ensurePost();
    try {
      const r = await api('PUT', `/api/admin/posts/${post.id}`, body);
      ED.post = r.post; ED.dirty = false; edLocalClear();
      edSetSaveState('已保存 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }));
      toast(okMsg || '已保存');
      return r.post;
    } catch (e) {
      if (e.status === 409 && e.code === 'conflict') {
        if (await confirmModal('内容冲突', e.message, '强行覆盖')) {
          return saveWith({ ...body, force: true, base_updated_at: undefined }, okMsg);
        }
        throw e;
      }
      throw e;
    }
  }
  $('#btnSaveDraft').addEventListener('click', async () => {
    try { await edServerAutosaveFlush(); await saveWith(collectBody(), '已保存'); } catch (e) { toast(e.message, true); }
  });
  $('#btnSaveRev').addEventListener('click', async () => {
    try { await saveWith({ ...collectBody(), save_revision: true, revision_note: '手动保存' }, '已保存并留了一版'); } catch (e) { toast(e.message, true); }
  });
  async function edServerAutosaveFlush() { /* 保存前不用等服务端 autosave，正式保存已覆盖 */ }
  $('#btnPublish').addEventListener('click', async () => {
    try {
      const post = await ensurePost();
      await saveWith(collectBody(), '正文已保存');
      const r = await api('POST', `/api/admin/posts/${post.id}/publish`, { status: 'published' });
      ED.post = r.post; toast('已发布，去首页就能看到'); go('posts');
    } catch (e) { toast(e.message, true); }
  });
  $('#btnSchedule').addEventListener('click', async () => {
    const at = localInputToSec($('#edPublishAt').value);
    if (!at) { toast('先选一个定时发布时间', true); return; }
    if (at <= Math.floor(Date.now() / 1000)) { toast('定时时间已过：到点即上线，等同立即发布', false); }
    try {
      const post = await ensurePost();
      await saveWith(collectBody(), '正文已保存');
      const r = await api('POST', `/api/admin/posts/${post.id}/publish`, { status: 'scheduled', publish_at: at });
      ED.post = r.post; toast(`已定时，将在 ${fmtTime(at)} 自动上线（读时判断，不靠任务）`); go('posts');
    } catch (e) { toast(e.message, true); }
  });
  $('#btnPrivate').addEventListener('click', async () => {
    try {
      const post = await ensurePost();
      await saveWith(collectBody(), '正文已保存');
      const r = await api('POST', `/api/admin/posts/${post.id}/publish`, { status: 'private' });
      ED.post = r.post; toast('已设为仅自己可见'); go('posts');
    } catch (e) { toast(e.message, true); }
  });
  const trashBtn = $('#btnTrash');
  if (trashBtn) trashBtn.addEventListener('click', async () => {
    try { await api('DELETE', `/api/admin/posts/${ED.post.id}`); ED.dirty = false; edLocalClear(); toast('已移入回收站'); go('posts'); }
    catch (e) { toast(e.message, true); }
  });
  $('#btnPreviewLink').addEventListener('click', async () => {
    try {
      const post = await ensurePost();
      if (ED.dirty) await saveWith(collectBody(), '已先保存再生成预览链接');
      const r = await api('POST', `/api/admin/posts/${post.id}/preview-token`, {});
      const full = location.origin + r.url;
      openModal('草稿预览链接', `<p class="hint">7 天内有效（到期 ${fmtTime(r.expires_at)}），发给朋友可直接看草稿，页面带 noindex 不被收录。</p>
        <div class="codes" style="font-size:13px">${esc(full)}</div>`, [
        { label: '打开预览', onClick: () => { window.open(r.url, '_blank'); } },
        { label: '复制链接', cls: 'primary', onClick: async (close) => { try { await navigator.clipboard.writeText(full); toast('已复制'); } catch { toast('复制失败，请长按链接手动复制', true); } close(); } },
      ]);
    } catch (e) { toast(e.message, true); }
  });
  $('#btnRevisions').addEventListener('click', async () => {
    const box = $('#revBox');
    if (!ED.post) { toast('先保存一次，正文有版本后这里才有内容'); return; }
    try {
      const data = await api('GET', `/api/admin/posts/${ED.post.id}/revisions`);
      box.innerHTML = `<div class="card" style="margin-top:10px"><h3>历史版本（最近 20 版）</h3>${
        data.revisions.length ? data.revisions.map((r) => `
          <div class="row"><div class="main"><div class="ttl">#${r.id} ${esc(r.title)}</div>
          <div class="meta">${fmtTime(r.created_at)} · ${esc(r.note || '—')} · 约 ${r.size} 字节</div></div>
          <div class="ops"><button class="btn sm" data-rev="${r.id}">一键还原到这版</button></div></div>`).join('')
        : '<p class="empty">还没有版本。发布或「保存并存一版」后会出现。</p>'}</div>`;
      $$('[data-rev]', box).forEach((b) => b.addEventListener('click', async () => {
        if (!(await confirmModal('还原版本', '还原前会自动把当前内容存一版（可再反悔），确定还原吗？', '还原'))) return;
        try {
          const r = await api('POST', `/api/admin/posts/${ED.post.id}/revisions/${b.dataset.rev}/restore`, {});
          ED.post = r.post;
          $('#edTitle').value = r.post.title; $('#edBody').value = r.post.content_md;
          edRefreshPreview(); toast('已还原到该版本'); box.innerHTML = '';
        } catch (e) { toast(e.message, true); }
      }));
    } catch (e) { toast(e.message, true); }
  });
}

/* 离开编辑器拦截（有未保存改动时） */
window.addEventListener('beforeunload', (e) => {
  if (S.view === 'editor' && ED.dirty) { e.preventDefault(); e.returnValue = ''; }
});

/* 媒体选择弹层（编辑器封面/插入、说说配图共用）：拉媒体库真数据点选 */
async function pickMedia(onPick, kindFilter) {
  const { close, body } = openModal('从媒体库选', '<p class="loading">加载中…</p>', [{ label: '取消' }]);
  try {
    const data = await api('GET', '/api/admin/media?page=1');
    const rows = data.media.filter((m) => m.status === 'ready' && (!kindFilter || m.kind === kindFilter));
    body.innerHTML = rows.length ? `<div class="mgrid">${rows.map((m) => `
      <div class="mitem"><div class="thumb">${m.kind === 'image' ? `<img src="${esc(m.url)}" alt="">` : m.kind === 'video' ? `<video src="${esc(m.url)}" preload="metadata"></video>` : '📄'}</div>
      <div class="info"><div class="nm">${esc(m.display_name)}</div><div>${fmtSize(m.size_bytes)}</div></div>
      <div class="ops"><button class="btn sm primary" data-pick="${m.id}">选这个</button></div></div>`).join('')}</div>`
      : '<p class="empty">媒体库里还没有可选的文件，先去媒体库上传。</p>';
    $$('[data-pick]', body).forEach((b) => b.addEventListener('click', () => {
      const m = rows.find((x) => x.id === Number(b.dataset.pick));
      close(); onPick(m);
    }));
  } catch (e) { body.innerHTML = `<p class="hint">${esc(e.message)}</p>`; }
}

/* ================= 说说管理 ================= */
async function viewMoments(main) {
  const data = await api('GET', '/api/admin/moments');
  main.innerHTML = `
    <div class="card">
      <h3>发说说（Moment，短动态）</h3>
      <label class="f"><span>内容（可带一张配图）</span><textarea id="moText" placeholder="随手记一句…" style="min-height:70px"></textarea></label>
      <input type="hidden" id="moMedia" value="">
      <div class="btnrow">
        <button class="btn" type="button" id="moPick">配图（媒体库选）</button>
        <span id="moMediaName" class="hint"></span>
        <span class="spacer"></span>
        <button class="btn" type="button" id="moDraft">存草稿</button>
        <button class="btn primary" type="button" id="moPub">发布说说</button>
      </div>
    </div>
    <div class="card"><h3>全部说说</h3><div id="moList"></div></div>`;
  $('#moPick').addEventListener('click', () => pickMedia((m) => {
    $('#moMedia').value = m.id; $('#moMediaName').textContent = '配图：' + m.display_name;
  }, 'image'));
  const post = async (status) => {
    const content = $('#moText').value.trim();
    if (!content) { toast('先写点内容', true); return; }
    try {
      await api('POST', '/api/admin/moments', { content, media_id: Number($('#moMedia').value) || null, status });
      toast(status === 'draft' ? '已存草稿' : '已发布'); go('moments');
    } catch (e) { toast(e.message, true); }
  };
  $('#moPub').addEventListener('click', () => post('published'));
  $('#moDraft').addEventListener('click', () => post('draft'));
  const list = $('#moList');
  list.innerHTML = data.moments.length ? data.moments.map((m) => `
    <div class="row"><div class="main"><div>${esc(m.content)}</div>
      <div class="meta">${fmtTime(m.created_at)} · ${m.status === 'draft' ? '<span class="pill draft">草稿</span>' : '<span class="pill pub">已发布</span>'}${m.media_id ? ' · 带图' : ''}</div></div>
      <div class="ops">
        ${m.status === 'draft' ? `<button class="btn sm" data-mpub="${m.id}">发布</button>` : ''}
        <button class="btn sm" data-medit="${m.id}">改内容</button>
        <button class="btn sm danger" data-mdel="${m.id}">删除</button>
      </div></div>`).join('') : '<p class="empty">还没有说说。</p>';
  list.addEventListener('click', async (e) => {
    const pub = e.target.closest('[data-mpub]'); const ed = e.target.closest('[data-medit]'); const del = e.target.closest('[data-mdel]');
    try {
      if (pub) { const m = data.moments.find((x) => x.id === Number(pub.dataset.mpub)); await api('PUT', `/api/admin/moments/${m.id}`, { content: m.content, status: 'published' }); go('moments'); }
      if (ed) {
        const m = data.moments.find((x) => x.id === Number(ed.dataset.medit));
        const { body } = openModal('改说说', `<label class="f"><span>内容</span><textarea id="moEditText" style="min-height:80px">${esc(m.content)}</textarea></label>`, [
          { label: '取消' },
          { label: '保存', cls: 'primary', onClick: async (close) => { await api('PUT', `/api/admin/moments/${m.id}`, { content: $('#moEditText').value, status: m.status }); close(); go('moments'); } },
        ]);
        body.querySelector('#moEditText').focus();
      }
      if (del) { await api('DELETE', `/api/admin/moments/${Number(del.dataset.mdel)}`); toast('已删除（进回收站口径，清理任务到期真删）'); go('moments'); }
    } catch (err) { toast(err.message, true); }
  });
}

/* ================= 评论审核 ================= */
async function viewComments(main) {
  const st = S.commentsStatus;
  const data = await api('GET', `/api/admin/comments?status=${encodeURIComponent(st)}`);
  const tabs = [['pending', '待审（Pending）'], ['approved', '已通过'], ['spam', '垃圾（Spam）'], ['trash', '已删']];
  main.innerHTML = `
    <div class="card">
      <div class="tabs">${tabs.map(([v, l]) => `<button type="button" data-cst="${v}" aria-pressed="${st === v}">${l}</button>`).join('')}</div>
      <p class="hint">访客评论默认先审后显（可在设置里关）。通过=访客可见；驳回=移到已删；垃圾=标记 spam（垃圾）供识别；
      站长回复直接通过并带站长标记。待审数与顶栏角标、仪表盘实时联动。</p>
      <div id="cmtList"></div>
    </div>`;
  $$('[data-cst]', main).forEach((b) => b.addEventListener('click', () => { S.commentsStatus = b.dataset.cst; go('comments'); }));
  const list = $('#cmtList', main);
  if (!data.comments.length) { list.innerHTML = '<p class="empty">这一类下面没有评论。</p>'; return; }
  list.innerHTML = data.comments.map((c) => `
    <div class="row" data-id="${c.id}">
      <div class="main">
        <div><strong>${esc(c.author_name)}</strong>${c.is_admin ? '<span class="pill pub">站长</span>' : ''} <span class="meta">在《${esc(c.post_title)}》下 · ${fmtTime(c.created_at)}</span></div>
        <div style="margin-top:4px">${c.html}</div>
        ${c.parent_id ? '<div class="meta">（回复评论 #' + c.parent_id + '）</div>' : ''}
      </div>
      <div class="ops">
        ${c.status === 'pending' ? '<button class="btn sm primary" data-ca="approve">通过</button><button class="btn sm" data-ca="reject">驳回</button>' : ''}
        ${c.status !== 'spam' ? '<button class="btn sm" data-ca="spam">标垃圾</button>' : ''}
        <button class="btn sm" data-ca="reply">回复</button>
        ${c.status !== 'trash' ? '<button class="btn sm danger" data-ca="del">删除</button>' : ''}
      </div>
    </div>`).join('');
  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-ca]');
    if (!btn) return;
    const row = btn.closest('.row'); const id = Number(row.dataset.id);
    const c = data.comments.find((x) => x.id === id);
    try {
      if (btn.dataset.ca === 'reply') {
        const { body } = openModal('以站长身份回复', `<label class="f"><span>回复内容（直接通过、带站长标记）</span>
          <textarea id="replyText" style="min-height:80px"></textarea></label>`, [
          { label: '取消' },
          { label: '发表回复', cls: 'primary', onClick: async (close) => {
            await api('POST', '/api/admin/comments', { post_id: c.post_id, parent_id: id, content: $('#replyText').value });
            close(); toast('已回复'); await refreshMe(); go('comments');
          } },
        ]);
        body.querySelector('#replyText').focus();
        return;
      }
      if (btn.dataset.ca === 'del') await api('DELETE', `/api/admin/comments/${id}`);
      else await api('POST', `/api/admin/comments/${id}/${btn.dataset.ca}`, {});
      toast('已处理');
      await refreshMe(); // 待审计数联动（顶栏角标/仪表盘）
      go('comments');
    } catch (err) { toast(err.message, true); }
  });
}

/* ================= 媒体库 ================= */
async function viewMedia(main) {
  const data = await api('GET', '/api/admin/media?page=1');
  const u = data.usage || { totalBytes: 0, totalCount: 0, byKind: {} };
  const FREE = 10 * 1024 * 1024 * 1024; // R2 免费额度约 10GB（界面提示口径）
  const pct = Math.min(100, (u.totalBytes / FREE) * 100);
  const seg = (kind, cls) => {
    const b = u.byKind?.[kind]?.bytes || 0;
    return b ? `<i class="${cls}" style="width:${Math.max(1, (b / FREE) * 100)}%" title="${esc(kind)}"></i>` : '';
  };
  const albums = [...new Set(data.media.map((m) => m.album).filter(Boolean))];
  main.innerHTML = `
    <div class="card">
      <h3>用量（R2 对象存储）</h3>
      <div class="usage">${seg('image', 'u-img')}${seg('video', 'u-vid')}${seg('file', 'u-file')}</div>
      <p class="hint">已用 ${fmtSize(u.totalBytes)} / 免费约 10 GB（${pct.toFixed(2)}%）· 共 ${u.totalCount} 个文件
      （图片 ${u.byKind?.image?.count || 0} · 视频 ${u.byKind?.video?.count || 0} · 文件 ${u.byKind?.file?.count || 0}）。
      删除是软删：先进入媒体回收站，30 天后清理任务才真删对象。</p>
      <div class="btnrow">
        <button class="btn primary" id="upBtn">⬆ 上传图片/视频/文件（可多选）</button>
        <input type="file" id="upFile" multiple hidden>
        <input type="search" id="mq" placeholder="搜文件名" style="flex:1;min-width:140px" >
        <select id="albumSel" style="width:auto"><option value="">全部分组（Album）</option>${albums.map((a) => `<option>${esc(a)}</option>`).join('')}</select>
      </div>
      <div id="mUpState" class="hint"></div>
      <div class="mgrid" id="mGrid"></div>
    </div>`;
  const renderGrid = (rows) => {
    $('#mGrid', main).innerHTML = rows.length ? rows.map((m) => `
      <div class="mitem">
        <div class="thumb">${m.kind === 'image' ? `<img src="${esc(m.url)}" alt="" loading="lazy">` : m.kind === 'video' ? `<video src="${esc(m.url)}" preload="metadata"></video>` : '<span style="font-size:34px">📄</span>'}</div>
        <div class="info">
          <div class="nm">${esc(m.display_name)}</div>
          <div>${m.kind === 'image' ? '图片' : m.kind === 'video' ? '视频' : '文件'} · ${fmtSize(m.size_bytes)}${m.width ? ` · ${m.width}×${m.height}` : ''}${m.duration_sec ? ` · ${m.duration_sec}s` : ''}</div>
          <div>${m.album ? '分组：' + esc(m.album) + ' · ' : ''}被 ${m.ref_count || 0} 篇引用${m.status === 'pending' ? ' · <span class="pill draft">未完成登记</span>' : ''}</div>
          <div class="meta">${fmtDay(m.created_at)}</div>
        </div>
        <div class="ops">
          <button class="btn sm" data-mrename="${m.id}">改名/分组</button>
          <button class="btn sm" data-mcopy="${m.id}">复制链接</button>
          <button class="btn sm danger" data-mdel="${m.id}">删除</button>
        </div>
      </div>`).join('') : '<p class="empty">没有符合条件的文件。</p>';
  };
  let rows = data.media;
  renderGrid(rows);
  const refilter = async () => {
    const q = $('#mq', main).value.trim(); const album = $('#albumSel', main).value;
    const params = new URLSearchParams({ page: '1' });
    if (q) params.set('q', q); if (album) params.set('album', album);
    const d = await api('GET', `/api/admin/media?${params}`);
    rows = d.media; renderGrid(rows);
  };
  $('#mq', main).addEventListener('change', refilter);
  $('#albumSel', main).addEventListener('change', refilter);
  $('#upBtn').addEventListener('click', () => $('#upFile').click());
  $('#upFile').addEventListener('change', async (e) => {
    const files = [...e.target.files]; e.target.value = '';
    const state = $('#mUpState', main);
    for (const f of files) {
      try { state.textContent = `正在直传 ${f.name} …`; await uploadFile(f); state.textContent = `${f.name} 上传完成`; }
      catch (err) { state.textContent = ''; toast(err.message, true); }
    }
    go('media');
  });
  $('#mGrid', main).addEventListener('click', async (e) => {
    const rn = e.target.closest('[data-mrename]'); const cp = e.target.closest('[data-mcopy]'); const del = e.target.closest('[data-mdel]');
    try {
      if (cp) {
        const m = rows.find((x) => x.id === Number(cp.dataset.mcopy));
        await navigator.clipboard.writeText(m.url); toast('链接已复制');
      }
      if (rn) {
        const m = rows.find((x) => x.id === Number(rn.dataset.mrename));
        const { body } = openModal('改名 / 分组', `
          <label class="f"><span>显示名（Display name，只影响后台与插入时的 alt，不动存储位置）</span>
          <input type="text" id="rnName" value="${esc(m.display_name)}"></label>
          <label class="f"><span>分组 / 相册（Album，可空）</span>
          <input type="text" id="rnAlbum" value="${esc(m.album || '')}" placeholder="如：旅行、截图"></label>`, [
          { label: '取消' },
          { label: '保存', cls: 'primary', onClick: async (close) => {
            await api('PATCH', `/api/admin/media/${m.id}`, { display_name: $('#rnName').value, album: $('#rnAlbum').value });
            close(); toast('已保存'); go('media');
          } },
        ]);
        body.querySelector('#rnName').focus();
      }
      if (del) {
        const m = rows.find((x) => x.id === Number(del.dataset.mdel));
        try {
          await api('DELETE', `/api/admin/media/${m.id}`);
          toast('已移入媒体回收站'); go('media');
        } catch (err) {
          if (err.status === 409) {
            if (await confirmModal('文件还在被引用', err.message, '仍然删除')) {
              await api('DELETE', `/api/admin/media/${m.id}?force=1`); toast('已强制移入媒体回收站'); go('media');
            }
          } else throw err;
        }
      }
    } catch (err) { toast(err.message, true); }
  });
}

/* ================= 友链管理 ================= */
async function viewFriends(main) {
  const data = await api('GET', '/api/admin/friends');
  main.innerHTML = `
    <div class="card">
      <h3>友链（Friend links）</h3>
      <p class="hint">任务会每 20 分钟自动探活；连续失败 ≥3 次前台自动置灰（不删）。这里也能单个立即探活。</p>
      <div id="frList"></div>
    </div>
    <div class="card">
      <h3 id="frFormTitle">加友链</h3>
      <form id="frForm">
        <input type="hidden" name="id">
        <div class="grid2">
          <label class="f"><span>名称（Name）*</span><input type="text" name="name" required></label>
          <label class="f"><span>链接（URL）*</span><input type="url" name="url" required placeholder="https://example.com"></label>
          <label class="f"><span>头像地址（Avatar，可空）</span><input type="url" name="avatar_url"></label>
          <label class="f"><span>RSS 地址（可空，朋友圈功能用）</span><input type="url" name="rss_url"></label>
          <label class="f"><span>排序（数字小在前）</span><input type="number" name="sort_order" value="0"></label>
          <label class="f"><span>简介（Description）</span><input type="text" name="desc"></label>
        </div>
        <label class="switch"><input type="checkbox" name="enabled" checked><i></i>启用（前台显示）</label>
        <div class="btnrow"><button class="btn primary" type="submit">保存</button>
        <button class="btn ghost" type="button" id="frCancel" hidden>取消编辑</button></div>
      </form>
    </div>`;
  const list = $('#frList', main);
  list.innerHTML = data.friends.length ? data.friends.map((f) => `
    <div class="row"><div class="main">
      <div class="ttl">${esc(f.name)} ${f.enabled ? '' : '<span class="pill">已停用</span>'}
        <span class="${f.health === 'ok' ? 'health-ok' : f.health === 'fail' ? 'health-fail' : 'health-unknown'}">● ${f.health === 'ok' ? '正常' : f.health === 'fail' ? `不通（连败 ${f.fail_streak} 次）` : '未探活'}</span></div>
      <div class="meta">${esc(f.url)}${f.desc ? ' · ' + esc(f.desc) : ''} · 上次探活 ${fmtTime(f.last_checked_at)}</div></div>
      <div class="ops">
        <button class="btn sm" data-fcheck="${f.id}">立即探活</button>
        <button class="btn sm" data-fedit="${f.id}">编辑</button>
        <button class="btn sm danger" data-fdel="${f.id}">删除</button>
      </div></div>`).join('') : '<p class="empty">还没有友链。</p>';
  const form = $('#frForm', main);
  list.addEventListener('click', async (e) => {
    const ck = e.target.closest('[data-fcheck]'); const ed = e.target.closest('[data-fedit]'); const del = e.target.closest('[data-fdel]');
    try {
      if (ck) { const r = await api('POST', `/api/admin/friends/${ck.dataset.fcheck}/check`, {}); toast('探活结果：' + r.health); go('friends'); }
      if (del) { if (await confirmModal('删除友链', '确定删除这条友链吗？', '删除')) { await api('DELETE', `/api/admin/friends/${del.dataset.fdel}`); go('friends'); } }
      if (ed) {
        const f = data.friends.find((x) => x.id === Number(ed.dataset.fedit));
        form.id.value = f.id; form.name.value = f.name; form.url.value = f.url;
        form.avatar_url.value = f.avatar_url || ''; form.rss_url.value = f.rss_url || '';
        form.sort_order.value = f.sort_order || 0; form.desc.value = f.desc || '';
        form.enabled.checked = !!f.enabled;
        $('#frFormTitle', main).textContent = '编辑友链'; $('#frCancel', main).hidden = false;
        form.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    } catch (err) { toast(err.message, true); }
  });
  $('#frCancel', main).addEventListener('click', () => go('friends'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const body = {
      name: fd.get('name'), url: fd.get('url'), avatar_url: fd.get('avatar_url') || null,
      rss_url: fd.get('rss_url') || null, sort_order: Number(fd.get('sort_order')) || 0,
      desc: fd.get('desc') || '', enabled: form.enabled.checked,
    };
    try {
      if (fd.get('id')) await api('PUT', `/api/admin/friends/${fd.get('id')}`, body);
      else await api('POST', '/api/admin/friends', body);
      toast('已保存'); go('friends');
    } catch (err) { toast(err.message, true); }
  });
}

/* ================= 站点设置 ================= */
const SETTING_GROUPS = [
  ['站点信息', [
    ['site_name', '博客名（Site name）', 'text'],
    ['site_desc', '博客介绍（Description，首页与分享描述用）', 'text'],
    ['hero_title', '首页大标题（Hero title）', 'text'],
    ['hero_text', '首页介绍语（Hero text）', 'textarea'],
    ['avatar_media_id', '头像（媒体 ID，在媒体库里看编号；0=不用）', 'int'],
  ]],
  ['外观（Appearance）', [
    ['accent_color', '主题色（Accent color）：改完访客页即时生效', 'color'],
    ['layout_home', '首页布局（Layout）：卡片=图大好看，列表=紧凑省翻页', 'enum', ['cards', 'list'], { cards: '卡片（Cards）', list: '紧凑列表（List）' }],
    ['layout_post_width', '文章页宽度', 'enum', ['normal', 'wide'], { normal: '常规（Normal）', wide: '宽版（Wide）' }],
    ['dark_mode', '深色模式策略（Dark mode）：自动=跟随访客系统与时段', 'enum', ['auto', 'light', 'dark'], { auto: '自动（Auto）', light: '总是浅色', dark: '总是深色' }],
    ['code_theme', '代码块配色（Code theme）', 'text'],
  ]],
  ['开关组（Switches，全部默认温和）', [
    ['search_on', '站内搜索（Search）：关掉后搜索页与入口消失', 'bool'],
    ['comments_on', '评论总开关（Comments）：关掉全站评论区消失', 'bool'],
    ['comments_moderation', '评论先审后显（Moderation）：关掉后评论直接上墙（人多易进垃圾，慎关）', 'bool'],
    ['comments_link_limit', '评论含链接 ≥N 条进待审（0=不按链接审）', 'int'],
    ['rss_on', 'RSS 订阅（RSS）：关掉后 /rss.xml 返回 404', 'bool'],
    ['ratelimit_level', '限流档位（Rate limit）：off 关 / normal 适中 / strict 从严', 'enum', ['off', 'normal', 'strict'], { off: '关闭（Off）', normal: '适中（Normal）', strict: '从严（Strict）' }],
    ['turnstile_on', '人机验证 Turnstile（真人验证）：开启需同时填下面的站点 key 且服务端配好 secret', 'bool'],
    ['turnstile_site_key', 'Turnstile 站点 key（Site key，公开值）', 'text'],
    ['friend_circle_on', '友链朋友圈抓取（默认关，开后任务会抓友链 RSS 标题）', 'bool'],
    ['og_auto', '自动生成分享图元信息（OG）', 'bool'],
  ]],
  ['发文与上传', [
    ['posts_per_page', '首页每页篇数（1–50）', 'int'],
    ['trash_keep_days', '回收站保留天数（到期清理任务真删）', 'int'],
    ['backup_keep', '自动备份保留期数', 'int'],
    ['upload_image_max_mb', '图片大小上限 MB', 'int'],
    ['upload_video_max_mb', '视频大小上限 MB（大视频更建议贴外链）', 'int'],
    ['upload_file_max_mb', '普通文件大小上限 MB', 'int'],
  ]],
];
async function viewSettings(main) {
  const data = await api('GET', '/api/admin/settings');
  S.settings = data.settings;
  applyAppearance();
  const st = data.settings;
  const fieldHtml = ([key, label, type, values, labels]) => {
    const v = st[key];
    if (type === 'bool') return `<label class="f"><span>${esc(label)}</span>
      <span class="switch"><input type="checkbox" data-set="${key}" ${v ? 'checked' : ''}><i></i><span>${v ? '开' : '关'}</span></span></label>`;
    if (type === 'color') return `<label class="f"><span>${esc(label)}</span>
      <span class="btnrow" style="margin:0"><input type="color" data-set="${key}" value="${esc(v)}">
      <input type="text" data-set-text="${key}" value="${esc(v)}" style="width:110px"></span></label>`;
    if (type === 'enum') return `<label class="f"><span>${esc(label)}</span><span class="radio-cards">
      ${values.map((val) => `<label><input type="radio" name="set-${key}" value="${val}" ${v === val ? 'checked' : ''}>${esc(labels?.[val] || val)}</label>`).join('')}
      </span></label>`;
    if (type === 'textarea') return `<label class="f"><span>${esc(label)}</span>
      <textarea data-set="${key}" style="min-height:64px">${esc(v)}</textarea></label>`;
    return `<label class="f"><span>${esc(label)}</span>
      <input type="${type === 'int' ? 'number' : 'text'}" data-set="${key}" value="${esc(v)}"></label>`;
  };
  main.innerHTML = SETTING_GROUPS.map(([gname, fields]) => `
    <div class="card"><h3>${esc(gname)}</h3>${fields.map(fieldHtml).join('')}</div>`).join('')
    + `<div class="card"><div class="btnrow">
        <button class="btn primary" id="setSave" type="button">保存设置（存完即时生效）</button>
        <span class="hint">设置存数据库、带版本号缓存，保存后访客页立刻按新设置走，不用重新部署。</span>
      </div><div id="setPreview" class="hint"></div></div>`;
  // 主题色即时预览（只预览本页色板，点保存才真生效到全站）
  const previewAccent = (val) => {
    $('#setPreview', main).innerHTML = `即时预览：<span class="pill" style="color:${esc(val)};border-color:${esc(val)}">主题色样例</span>
      <button class="btn sm" style="background:${esc(val)};border-color:${esc(val)};color:#fff" type="button">按钮样例</button>`;
  };
  const colorInput = $('[data-set="accent_color"]', main);
  const colorText = $('[data-set-text="accent_color"]', main);
  previewAccent(colorInput.value);
  colorInput.addEventListener('input', () => { colorText.value = colorInput.value; previewAccent(colorInput.value); });
  colorText.addEventListener('change', () => { colorInput.value = colorText.value; previewAccent(colorText.value); });
  $('#setSave', main).addEventListener('click', async () => {
    const patch = {};
    $$('[data-set]', main).forEach((el) => {
      const key = el.dataset.set;
      if (el.type === 'checkbox') patch[key] = el.checked ? 1 : 0;
      else if (el.type === 'number') patch[key] = Number(el.value);
      else patch[key] = el.value;
    });
    $$('[name^="set-"]', main).forEach((el) => { if (el.checked) patch[el.name.slice(4)] = el.value; });
    try {
      const r = await api('PUT', '/api/admin/settings', { settings: patch });
      S.settings = r.settings; applyAppearance();
      toast('设置已保存并即时生效（版本 v' + r.version + '）');
      go('settings');
    } catch (e) { toast(e.message, true); }
  });
}

/* ================= 统计 ================= */
async function viewStats(main) {
  const data = await api('GET', '/api/admin/stats');
  const c = data.counts; const u = data.media_usage || { totalBytes: 0, totalCount: 0, byKind: {} };
  main.innerHTML = `
    <div class="stat-grid">
      <div class="stat"><b>${data.total_views}</b><span>总阅读（按天聚合累计）</span></div>
      <div class="stat"><b>${c.postsPublished}</b><span>已发布文章</span></div>
      <div class="stat"><b>${c.commentsApproved}</b><span>已通过评论</span></div>
      <div class="stat"><b>${fmtSize(u.totalBytes)}</b><span>媒体占用（${u.totalCount} 个文件）</span></div>
    </div>
    <div class="card" style="margin-top:12px">
      <h3>热门文章 · 近 30 天（Hot posts）</h3>
      ${data.hot.length ? `<table class="simple"><thead><tr><th>文章</th><th style="width:90px">阅读</th></tr></thead>
        <tbody>${data.hot.map((h) => `<tr><td><a href="/post/${esc(h.slug)}" target="_blank" rel="noopener">${esc(h.title)}</a></td><td>${h.pv}</td></tr>`).join('')}</tbody></table>`
        : '<p class="empty">还没有阅读数据。计数是按「一篇文章一天聚合一行」记的，不烧数据库额度。</p>'}
      <p class="hint">计数口径：访客打开文章页时静默上报，服务端按天聚合（见设计稿 view_stats）；前台不单独显示计数，不额外烧读额度。</p>
    </div>
    <div class="card">
      <h3>内容概览</h3>
      <table class="simple"><tbody>
        <tr><td>草稿</td><td>${c.postsDraft}</td></tr>
        <tr><td>回收站文章</td><td>${c.postsTrash}</td></tr>
        <tr><td>说说（已发布）</td><td>${c.moments}</td></tr>
        <tr><td>待审评论</td><td>${c.commentsPending}</td></tr>
        <tr><td>友链（启用中）</td><td>${c.friends}</td></tr>
        <tr><td>媒体：图片 / 视频 / 文件</td><td>${u.byKind?.image?.count || 0} / ${u.byKind?.video?.count || 0} / ${u.byKind?.file?.count || 0}</td></tr>
      </tbody></table>
    </div>`;
}

/* ================= 备份与数据 ================= */
async function viewBackup(main) {
  const me = S.me || (await refreshMe(), S.me);
  const last = me.last_backup;
  main.innerHTML = `
    <div class="card">
      <h3>备份（Backup）</h3>
      <p class="hint">最近一次备份：${last ? `${fmtTime(last.created_at)}（${fmtSize(last.size_bytes)}）` : '暂无记录'}。
      自动备份每周由任务跑一次并存进私有备份桶，保留期数见设置；这里也能手动立刻跑一次。</p>
      <div class="btnrow">
        <button class="btn primary" id="bkRun" type="button">立即备份一次</button>
        <span id="bkResult" class="hint"></span>
      </div>
    </div>
    <div class="card">
      <h3>导出逃生（Export）</h3>
      <p class="hint">逃生包=全部文章的 Markdown（标记语法）原文 + 附件清单 + 评论与设置 JSON，任何博客系统都能接；
      整站 JSON 可被本站「导入恢复」原样吃回。导出不含会话/限流等运行态数据。</p>
      <div class="btnrow">
        <a class="btn" href="/api/admin/export/markdown">⬇ 导出 Markdown 逃生包（.zip）</a>
        <a class="btn" href="/api/admin/export/full.json">⬇ 导出整站 JSON</a>
      </div>
    </div>
    <div class="card">
      <h3>导入恢复（Import）</h3>
      <p class="hint">选一份本站导出的整站 JSON。导入前系统会<strong>自动先备份当前站</strong>；
      同 slug（短链）冲突会自动改名并登记跳转，导入完会给出对账报告。</p>
      <div class="btnrow">
        <button class="btn" id="impBtn" type="button">选 JSON 文件并导入</button>
        <input type="file" id="impFile" accept="application/json,.json" hidden>
      </div>
      <pre class="report" id="impReport" hidden></pre>
    </div>
    <div class="card">
      <h3>恢复码（Recovery codes）</h3>
      <p class="hint">恢复码是忘记密码时的第一层自救：一组 10 个一次性码，生成后旧码全部作废、新码只显示一次。</p>
      <div class="btnrow"><button class="btn" id="genCodes" type="button">重新生成恢复码</button></div>
    </div>`;
  $('#bkRun', main).addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const r = await api('POST', '/api/admin/backup/run', {});
      $('#bkResult', main).textContent = `完成：${r.backup.r2_key}（${fmtSize(r.backup.size_bytes)}，文章 ${r.backup.posts} / 附件 ${r.backup.media} / 评论 ${r.backup.comments}）`;
      await refreshMe();
    } catch (err) { toast(err.message, true); } finally { e.target.disabled = false; }
  });
  $('#impBtn', main).addEventListener('click', () => $('#impFile', main).click());
  $('#impFile', main).addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    let data;
    try { data = JSON.parse(await f.text()); } catch { toast('这个文件不是合法 JSON', true); return; }
    if (!(await confirmModal('导入恢复', '将先自动备份当前站，再按表导入这份数据，确定继续吗？', '开始导入'))) return;
    try {
      const r = await api('POST', '/api/admin/import', { confirm: true, data });
      const pre = $('#impReport', main);
      pre.hidden = false;
      pre.textContent = '对账报告：\n' + JSON.stringify(r.report, null, 2);
      toast('导入完成，见对账报告');
      await refreshMe();
    } catch (err) { toast(err.message, true); }
  });
  $('#genCodes', main).addEventListener('click', async () => {
    if (!(await confirmModal('重新生成恢复码', '旧恢复码会全部作废，确定重新生成吗？', '生成'))) return;
    try {
      const r = await api('POST', '/api/admin/recovery/generate', {});
      openModal('新恢复码（只显示这一次）', `<p class="hint">${esc(r.note || '')}</p>
        <div class="codes">${(r.recovery_codes || []).map(esc).join('<br>')}</div>`,
        [{ label: '我已保存', cls: 'primary' }]);
    } catch (err) { toast(err.message, true); }
  });
}

/* ================= 账号安全 ================= */
async function viewAccount(main) {
  const sessions = (await api('GET', '/api/admin/sessions')).sessions;
  main.innerHTML = `
    <div class="card">
      <h3>修改密码（Password）</h3>
      <p class="hint">改密后<strong>全部设备会被下线</strong>（含当前这个），请用新密码重新登录；建议改完顺手重新生成恢复码。</p>
      <form id="pwForm">
        <label class="f"><span>旧密码</span><input type="password" name="old_password" autocomplete="current-password" required></label>
        <label class="f"><span>新密码（至少 8 位）</span><input type="password" name="new_password" autocomplete="new-password" required></label>
        <button class="btn primary" type="submit">改密码并下线全部设备</button>
      </form>
    </div>
    <div class="card">
      <h3>登录会话（Sessions）</h3>
      ${sessions.length ? sessions.map((s) => `
        <div class="row"><div class="main"><div class="ttl">会话 #${s.id}</div>
        <div class="meta">登录于 ${fmtTime(s.created_at)} · 最近活动 ${fmtTime(s.last_seen_at)} · 过期 ${fmtTime(s.expires_at)}</div>
        <div class="meta">${esc(s.ua || '未知设备')}</div></div></div>`).join('') : '<p class="empty">无会话记录。</p>'}
      <div class="btnrow"><button class="btn danger" id="revokeAll" type="button">一键下线全部会话</button></div>
    </div>
    <div class="card">
      <h3>通行密钥（Passkey）</h3>
      <p class="hint">Passkey（指纹/刷脸登录）本期未启用：接口与数据表已预留，启用后账密会降为备用通道。现在请用账号密码 + 恢复码。</p>
      <button class="btn" disabled>添加 Passkey（未启用）</button>
    </div>`;
  $('#pwForm', main).addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const r = await api('POST', '/api/admin/password', { old_password: fd.get('old_password'), new_password: fd.get('new_password') });
      toast(r.note || '密码已修改');
      S.me = null; showLogin('密码已修改，请用新密码登录');
    } catch (err) { toast(err.message, true); }
  });
  $('#revokeAll', main).addEventListener('click', async () => {
    if (!(await confirmModal('下线全部会话', '包括你当前这个会话也会被下线，需要重新登录，确定吗？', '全部下线'))) return;
    try {
      await api('POST', '/api/admin/sessions/revoke-all', {});
      S.me = null; showLogin('全部会话已下线，请重新登录');
    } catch (err) { toast(err.message, true); }
  });
}

/* ================= 视图注册与启动 ================= */
const VIEWS = {
  dashboard: viewDashboard,
  posts: viewPosts,
  editor: viewEditor,
  moments: viewMoments,
  comments: viewComments,
  media: viewMedia,
  friends: viewFriends,
  settings: viewSettings,
  stats: viewStats,
  backup: viewBackup,
  account: viewAccount,
};
(async function boot() {
  try {
    const st = await api('GET', '/api/admin/setup-status');
    if (st.needs_setup) { showSetup(); return; }
  } catch { /* 状态接口异常时按未登录走登录页 */ }
  try {
    await enterApp();
  } catch (e) {
    showLogin(e.status === 401 ? undefined : '连接后台失败：' + e.message);
  }
})();
