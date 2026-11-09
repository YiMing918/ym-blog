// smoke.mjs — 仓库冒烟测试（本地运行，不进生产环境）
// 用法：npm run smoke（需要 Node ≥ 22.5，用内置 node:sqlite 真跑迁移 SQL）
// 做法：D1 用 node:sqlite 内存库替身（执行的是 schema/ 里的真 SQL），R2 用内存 Map 替身，
// 然后直接调 functions 的 handleRequest 走完整请求链：迁移→登录→发文→发布→评论审核→媒体登记→导出→任务。
// 这里的账号密码、密钥全是本地测试用的虚构值，不是任何真实凭据。

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------- D1 替身（接口形状对齐 Cloudflare D1） ----------
class D1Shim {
  constructor(db) { this.db = db; }
  prepare(sql) {
    const self = this;
    return {
      _binds: [],
      bind(...args) { this._binds = args; return this; },
      async run() {
        const info = self.db.prepare(sql).run(...this._binds);
        return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid), rows_read: 0, rows_written: info.changes } };
      },
      async first() { return self.db.prepare(sql).get(...this._binds) ?? null; },
      async all() { const rows = self.db.prepare(sql).all(...this._binds); return { results: rows, success: true, meta: { rows_read: rows.length, rows_written: 0 } }; },
    };
  }
  async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; }
  async exec(sql) { this.db.exec(sql); return { count: 0, duration: 0 }; }
}

// ---------- R2 替身 ----------
class R2Shim {
  constructor() { this.map = new Map(); }
  async put(key, body) {
    const buf = typeof body === 'string' ? new TextEncoder().encode(body) : body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
    this.map.set(key, buf);
    return { key, size: buf.byteLength };
  }
  async head(key) { const b = this.map.get(key); return b ? { key, size: b.byteLength } : null; }
  async get(key) { const b = this.map.get(key); return b ? { key, size: b.byteLength, async text() { return new TextDecoder().decode(b); } } : null; }
  async delete(key) { this.map.delete(key); }
}

// ---------- 环境 ----------
const db = new DatabaseSync(':memory:');
db.exec(readFileSync(join(root, 'schema/0001_init.sql'), 'utf8'));
db.exec(readFileSync(join(root, 'schema/0002_seed.sql'), 'utf8'));
db.exec(readFileSync(join(root, 'schema/0003_fts.sql'), 'utf8'));

const env = {
  DB: new D1Shim(db),
  MEDIA: new R2Shim(),
  BACKUPS: new R2Shim(),
  TASK_SECRET: 'smoke-task-secret',
  PASSWORD_PEPPER: 'smoke-pepper',
  IP_SALT: 'smoke-ip',
  MEDIA_PUBLIC_BASE: 'https://media.example.com',
  R2_S3_ENDPOINT: 'https://smoke-account.r2.cloudflarestorage.com',
  R2_S3_BUCKET: 'ym-blog-media',
  R2_ACCESS_KEY_ID: 'SMOKEKEY',
  R2_SECRET_ACCESS_KEY: 'smoke-secret',
  INITIAL_ADMIN_USERNAME: 'smoke-admin',
  INITIAL_ADMIN_PASSWORD: 'smoke-pass-123',
  SITE_BASE_URL: 'https://blog.example.com',
};

// 友链探活要请求外站：冒烟里把测试域名的 fetch 打桩成 200，其余照旧
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const u = typeof input === 'string' ? input : input.url;
  if (String(u).includes('friend.example.test')) return new Response('ok', { status: 200 });
  if (String(u).includes('ai-fail.example.test')) return new Response('upstream boom', { status: 500 });
  if (String(u).includes('ai.example.test')) {
    return new Response(JSON.stringify({
      model: 'test-model',
      choices: [{ message: { role: 'assistant', content: '这是 AI 生成的测试摘要' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(input, init);
};

const { handleRequest } = await import(pathToFileURL(join(root, 'functions/[[path]].js')).href);

// ---------- 小工具 ----------
let cookie = '';
async function req(method, path, { body, headers = {}, useCookie = true } = {}) {
  const h = new Headers(headers);
  if (body !== undefined) h.set('Content-Type', 'application/json');
  if (useCookie && cookie) h.set('Cookie', cookie);
  const resp = await handleRequest(new Request('https://blog.example.com' + path, {
    method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined,
  }), env);
  const setCookie = resp.headers.get('set-cookie');
  if (setCookie && setCookie.includes('bk_session=') && !setCookie.includes('Max-Age=0')) {
    cookie = setCookie.split(';')[0];
  }
  return resp;
}
const results = [];
function check(name, cond, extra = '') {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
}

// ---------- 1. 迁移 ----------
const tableCount = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n;
check('迁移可执行（0001+0002+0003）', tableCount >= 20, `共 ${tableCount} 张表`);
const ftsRow = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='posts_fts'").get();
check('【六批】FTS5 全文索引表 posts_fts 已建（0003）', !!ftsRow);

// ---------- 2. 访客页 SSR ----------
let resp = await req('GET', '/');
let html = await resp.text();
check('首页 SSR 200 且含站点名与示例文章', resp.status === 200 && html.includes('示例博客') && html.includes('示例文章'));
resp = await req('GET', '/post/hello-demo');
html = await resp.text();
check('文章页 SSR 200（种子无预渲染时现场渲染兜底）', resp.status === 200 && html.includes('欢迎') && html.includes('id="comments"') || html.includes('评论'));
resp = await req('GET', '/rss.xml');
check('RSS 可用且含示例文章', resp.status === 200 && (await resp.text()).includes('hello-demo'));
resp = await req('GET', '/sitemap.xml');
check('sitemap 可用', resp.status === 200 && (await resp.text()).includes('/post/hello-demo'));

// ---------- 3. 登录 ----------
resp = await req('POST', '/api/admin/login', { body: { username: 'smoke-admin', password: 'wrong-pass' }, headers: { 'X-Requested-With': 'fetch' }, useCookie: false });
check('错误密码登录被拒（401）', resp.status === 401);
resp = await req('POST', '/api/admin/login', { body: { username: 'smoke-admin', password: 'smoke-pass-123' }, headers: { 'X-Requested-With': 'fetch' }, useCookie: false });
check('正确密码登录成功并下发会话 Cookie', resp.status === 200 && cookie.includes('bk_session='));
resp = await req('GET', '/api/admin/me');
const me = (await resp.json()).data;
check('仪表盘 /me 可用（待审数等）', resp.status === 200 && me && me.counts && typeof me.counts.commentsPending === 'number');

// ---------- 4. 发文与发布 ----------
const md = ['## 小标题一', '', '这是一段**加粗**的冒烟正文，带一张图：', '', '![冒烟配图](https://media.example.com/img/2026/11/smoke.png)', '', '单独一行放 B 站视频：', '', 'https://www.bilibili.com/video/BV1GJ411x7h7', '', '```js', 'console.log("hi");', '```'].join('\n');
resp = await req('POST', '/api/admin/posts', { body: { title: '冒烟测试文章', content_md: md, tags: ['冒烟', '测试'] }, headers: { 'X-Requested-With': 'fetch' } });
let post = (await resp.json()).data?.post;
check('新建文章（草稿）', resp.status === 200 && post && post.status === 'draft');
const postId = post.id;
const postSlug = post.slug;
resp = await req('GET', '/');
check('草稿不出现在首页', !(await resp.text()).includes('冒烟测试文章'));
resp = await req('POST', `/api/admin/posts/${postId}/publish`, { body: {}, headers: { 'X-Requested-With': 'fetch' } });
post = (await resp.json()).data?.post;
check('发布后状态为 published 且已预渲染', post && post.status === 'published' && post.rendered_html && post.rendered_html.includes('小标题一'));
resp = await req('GET', '/');
check('发布后出现在首页', (await resp.text()).includes('冒烟测试文章'));
resp = await req('GET', `/post/${postSlug}`);
html = await resp.text();
check('文章页含 TOC 锚点、B 站嵌入与代码块', html.includes('目录') && html.includes('player.bilibili.com') && html.includes('language-js'));

// ---------- 5. 定时发布（读时判断） ----------
resp = await req('POST', '/api/admin/posts', { body: { title: '未来文章', content_md: '还没到点。' }, headers: { 'X-Requested-With': 'fetch' } });
const future = (await resp.json()).data.post;
await req('POST', `/api/admin/posts/${future.id}/publish`, { body: { status: 'scheduled', publish_at: Math.floor(Date.now() / 1000) + 3600 }, headers: { 'X-Requested-With': 'fetch' } });
resp = await req('GET', '/');
check('定时未到点的文章不出现在首页', !(await resp.text()).includes('未来文章'));
await req('POST', `/api/admin/posts/${future.id}/publish`, { body: { status: 'scheduled', publish_at: Math.floor(Date.now() / 1000) - 10 }, headers: { 'X-Requested-With': 'fetch' } });
resp = await req('GET', '/');
check('定时到点后自动出现在首页（读时判断）', (await resp.text()).includes('未来文章'));

// ---------- 6. 评论审核流 ----------
resp = await req('POST', '/api/comments', { body: { post_id: postId, author_name: '路过的朋友', content: '写得不错，学习了' }, headers: { 'X-Requested-With': 'fetch' }, useCookie: false });
let cmt = (await resp.json()).data;
check('访客评论提交成功且先进待审', resp.status === 200 && cmt && cmt.status === 'pending');
resp = await req('GET', `/api/comments?post_id=${postId}`, { useCookie: false });
check('待审评论不对访客可见', !(await resp.text()).includes('写得不错'));
resp = await req('GET', '/api/admin/comments?status=pending');
const pending = (await resp.json()).data?.comments || [];
check('后台待审队列能看到这条评论', pending.some((c) => c.id === cmt.id));
resp = await req('POST', `/api/admin/comments/${cmt.id}/approve`, { body: {}, headers: { 'X-Requested-With': 'fetch' } });
check('过审接口可用', resp.status === 200);
resp = await req('GET', `/api/comments?post_id=${postId}`, { useCookie: false });
check('过审后评论对访客可见', (await resp.text()).includes('写得不错'));

// ---------- 7. 媒体直传三步 ----------
resp = await req('POST', '/api/admin/media/sign', { body: { mime: 'image/png', size: 2048, orig_name: 'smoke.png' }, headers: { 'X-Requested-With': 'fetch' } });
const sign = (await resp.json()).data;
check('预签名签发（含签名参数与对象键）', resp.status === 200 && sign && sign.put_url.includes('X-Amz-Signature=') && sign.r2_key.startsWith('img/'));
// 模拟浏览器拿预签名 URL 直传到 R2（字节不经过 Worker，直接对桶替身 put 同一 key）
await env.MEDIA.put(sign.r2_key, new Uint8Array(2048));
resp = await req('POST', '/api/admin/media/complete', { body: { media_id: sign.media_id, width: 100, height: 50 }, headers: { 'X-Requested-With': 'fetch' } });
check('直传完成登记（HEAD 校验大小）', resp.status === 200 && (await resp.json()).data?.media_url?.includes(sign.r2_key));
resp = await req('GET', '/api/admin/media');
check('媒体库能列出该文件', (await resp.text()).includes(sign.r2_key));

// ---------- 8. 设置即时生效 ----------
resp = await req('PUT', '/api/admin/settings', { body: { settings: { accent_color: '#123456' } }, headers: { 'X-Requested-With': 'fetch' } });
check('设置保存可用', resp.status === 200);
resp = await req('GET', '/', { useCookie: false });
check('主题色改动即时反映到首页', (await resp.text()).includes('#123456'));

// ---------- 9. 版本还原与回收站 ----------
resp = await req('PUT', `/api/admin/posts/${postId}`, { body: { title: '冒烟测试文章（改过）', content_md: md + '\n\n改了一段。', save_revision: true }, headers: { 'X-Requested-With': 'fetch' } });
check('改稿并存版本', resp.status === 200);
resp = await req('GET', `/api/admin/posts/${postId}/revisions`);
const revs = (await resp.json()).data?.revisions || [];
check('版本列表至少有发布版与改稿版', revs.length >= 2, `共 ${revs.length} 版`);
resp = await req('DELETE', `/api/admin/posts/${postId}`, { headers: { 'X-Requested-With': 'fetch' } });
check('删除进回收站（软删）', resp.status === 200 && (await resp.json()).data?.post?.status === 'trash');
resp = await req('POST', `/api/admin/posts/${postId}/restore-trash`, { body: {}, headers: { 'X-Requested-With': 'fetch' } });
check('回收站可还原为草稿', resp.status === 200 && (await resp.json()).data?.post?.status === 'draft');
await req('POST', `/api/admin/posts/${postId}/publish`, { body: {}, headers: { 'X-Requested-With': 'fetch' } });

// ---------- 10. 浏览计数与导出 ----------
resp = await req('POST', '/api/view', { body: { post_id: postId }, useCookie: false });
check('浏览上报可用', resp.status === 200);
resp = await req('GET', '/api/admin/export/full.json');
const full = await resp.json().catch(() => null);
check('整站 JSON 导出', resp.status === 200 && full && full.app === 'ym-blog' && full.tables.posts.length >= 3);
resp = await req('GET', '/api/admin/export/markdown');
const zipHead = new Uint8Array(await resp.arrayBuffer().then((b) => b.slice(0, 2)));
check('Markdown 逃生包导出（zip）', resp.status === 200 && zipHead[0] === 0x50 && zipHead[1] === 0x4b);

// ---------- 11. 任务接口 ----------
resp = await req('GET', '/api/tasks/health', { useCookie: false });
check('任务接口无密钥被拒（403）', resp.status === 403);
resp = await req('GET', '/api/tasks/health', { headers: { 'X-Task-Secret': 'smoke-task-secret' }, useCookie: false });
check('任务健康探活', resp.status === 200 && (await resp.json()).data?.ok === true);
await req('POST', '/api/admin/friends', { body: { name: '示例友站', url: 'https://friend.example.test/' }, headers: { 'X-Requested-With': 'fetch' } });
resp = await req('POST', '/api/tasks/friend-check', { body: {}, headers: { 'X-Task-Secret': 'smoke-task-secret' }, useCookie: false });
check('友链探活任务', resp.status === 200 && (await resp.json()).data?.checked >= 1);
resp = await req('POST', '/api/tasks/backup', { body: {}, headers: { 'X-Task-Secret': 'smoke-task-secret' }, useCookie: false });
const bk = (await resp.json()).data?.backup;
check('每周备份任务（存备份桶+登记）', resp.status === 200 && bk && bk.r2_key && env.BACKUPS.map.size >= 1);
resp = await req('POST', '/api/tasks/purge', { body: {}, headers: { 'X-Task-Secret': 'smoke-task-secret' }, useCookie: false });
check('清理任务可用', resp.status === 200);

// ---------- 12. 恢复码 ----------
resp = await req('POST', '/api/admin/recovery/generate', { body: {}, headers: { 'X-Requested-With': 'fetch' } });
const codes = (await resp.json()).data?.recovery_codes || [];
check('恢复码生成（10 个）', codes.length === 10);
await req('POST', '/api/admin/logout', { body: {}, headers: { 'X-Requested-With': 'fetch' } });
cookie = '';
resp = await req('POST', '/api/admin/recovery/reset', { body: { username: 'smoke-admin', code: codes[0], new_password: 'smoke-new-pass-9' }, headers: { 'X-Requested-With': 'fetch' }, useCookie: false });
check('恢复码重置密码', resp.status === 200);
resp = await req('POST', '/api/admin/recovery/reset', { body: { username: 'smoke-admin', code: codes[0], new_password: 'smoke-new-pass-9' }, headers: { 'X-Requested-With': 'fetch' }, useCookie: false });
check('同一恢复码不能用第二次', resp.status !== 200);
resp = await req('POST', '/api/admin/login', { body: { username: 'smoke-admin', password: 'smoke-new-pass-9' }, headers: { 'X-Requested-With': 'fetch' }, useCookie: false });
check('新密码可登录', resp.status === 200);

// ---------- 13. 后台 SPA（第二批：admin/ 静态页 + 站长接口逐个调用） ----------
// /admin/* 靠根目录 _routes.json 的 exclude 由 Pages 静态层直出（第五批机制，第 16 段校验该文件），冒烟里按文件模拟这一层；
// JS 语法用 node:vm 只解析不执行（admin.js 顶层会碰浏览器 DOM，不能在 Node 里真跑）。
{
  const vm = await import('node:vm');
  const adminHtml = readFileSync(join(root, 'admin/index.html'), 'utf8');
  const adminJs = readFileSync(join(root, 'admin/admin.js'), 'utf8');
  const adminCss = readFileSync(join(root, 'admin/admin.css'), 'utf8');
  const page = new Response(adminHtml, { status: 200, headers: { 'Content-Type': 'text/html' } });
  check('后台页可直出（静态层模拟 200）且引用 admin.js/admin.css', page.status === 200
    && adminHtml.includes('/admin/admin.js') && adminHtml.includes('/admin/admin.css') && adminHtml.includes('id="view"'));
  let jsOk = true;
  try { new vm.Script(adminJs); } catch { jsOk = false; }
  check('后台 JS 语法可解析（node:vm 解析）', jsOk);
  check('后台 CSS 已就绪', adminCss.length > 1000, `${adminCss.length} 字节`);

  const H = { headers: { 'X-Requested-With': 'fetch' } };
  // 初始化状态：已有站长 → needs_setup=false，且 setup 入口已关闭（403）
  resp = await req('GET', '/api/admin/setup-status', { useCookie: false });
  check('setup-status：已有站长不再需要初始化', resp.status === 200 && (await resp.json()).data?.needs_setup === false);
  resp = await req('POST', '/api/admin/setup', { body: { username: 'another', password: 'another-pass-1' }, ...H, useCookie: false });
  check('初始化入口建站长后永久关闭（403）', resp.status === 403);

  resp = await req('GET', '/api/admin/settings');
  check('设置全量读（站长接口）', resp.status === 200 && (await resp.json()).data?.settings?.accent_color !== undefined);
  resp = await req('GET', '/api/admin/stats');
  const statsData = (await resp.json()).data;
  check('统计接口（热门榜数组）', resp.status === 200 && Array.isArray(statsData?.hot));

  // 说说 CRUD
  resp = await req('POST', '/api/admin/moments', { body: { content: '冒烟说说：后台发的' }, ...H });
  const moId = (await resp.json()).data?.id;
  check('说说新建', resp.status === 200 && !!moId);
  resp = await req('GET', '/api/admin/moments');
  check('说说列表含刚发的', (await resp.json()).data?.moments?.some((m) => m.id === moId));
  resp = await req('PUT', `/api/admin/moments/${moId}`, { body: { content: '冒烟说说（改过）', status: 'published' }, ...H });
  check('说说修改', resp.status === 200);
  resp = await req('DELETE', `/api/admin/moments/${moId}`, { ...H });
  check('说说删除（软删）', resp.status === 200);

  // 友链 CRUD + 单个探活
  resp = await req('POST', '/api/admin/friends', { body: { name: '冒烟友站', url: 'https://friend.example.test/' }, ...H });
  const frId = (await resp.json()).data?.id;
  check('友链新建', resp.status === 200 && !!frId);
  resp = await req('PUT', `/api/admin/friends/${frId}`, { body: { name: '冒烟友站（改名）', url: 'https://friend.example.test/', enabled: true }, ...H });
  check('友链修改', resp.status === 200);
  resp = await req('POST', `/api/admin/friends/${frId}/check`, { body: {}, ...H });
  check('友链单个立即探活', resp.status === 200 && (await resp.json()).data?.health === 'ok');
  resp = await req('DELETE', `/api/admin/friends/${frId}`, { ...H });
  check('友链删除', resp.status === 200);

  // 评论管理：驳回 / 标垃圾 / 站长回复 / 删除
  resp = await req('POST', '/api/comments', { body: { post_id: postId, author_name: '冒烟访客乙', content: '这条会被驳回' }, ...H, useCookie: false });
  const cmt2 = (await resp.json()).data;
  resp = await req('POST', `/api/admin/comments/${cmt2.id}/reject`, { body: {}, ...H });
  check('评论驳回接口', resp.status === 200);
  resp = await req('GET', '/api/admin/comments?status=trash');
  check('驳回后评论进已删队列', (await resp.json()).data?.comments?.some((c) => c.id === cmt2.id));
  resp = await req('POST', '/api/comments', { body: { post_id: postId, author_name: '冒烟访客丙', content: '这条会被标垃圾' }, ...H, useCookie: false });
  const cmt3 = (await resp.json()).data;
  resp = await req('POST', `/api/admin/comments/${cmt3.id}/spam`, { body: {}, ...H });
  check('评论标垃圾接口', resp.status === 200);
  resp = await req('POST', '/api/admin/comments', { body: { post_id: postId, content: '站长冒烟回复' }, ...H });
  const replyId = (await resp.json()).data?.id;
  check('站长回复（直接通过）', resp.status === 200 && !!replyId);
  resp = await req('DELETE', `/api/admin/comments/${replyId}`, { ...H });
  check('评论删除接口', resp.status === 200);

  // 文章：服务端自动保存、草稿预览链接、版本还原、克隆、彻底删除
  resp = await req('PUT', `/api/admin/posts/${postId}/autosave`, { body: { title: '自动保存标题', content_md: '自动保存的正文' }, ...H });
  check('服务端 autosave 保存', resp.status === 200);
  resp = await req('GET', `/api/admin/posts/${postId}`);
  check('读文章带回 autosave', (await resp.json()).data?.autosave?.content_md === '自动保存的正文');
  resp = await req('POST', `/api/admin/posts/${postId}/preview-token`, { body: {}, ...H });
  const pvUrl = (await resp.json()).data?.url || '';
  check('草稿预览链接生成', resp.status === 200 && pvUrl.startsWith(`/preview/${postId}?key=`));
  resp = await req('GET', pvUrl, { useCookie: false });
  check('预览链接能打开草稿页', resp.status === 200 && (await resp.text()).includes('冒烟测试文章'));
  resp = await req('GET', `/api/admin/posts/${postId}/revisions`);
  const revList = (await resp.json()).data?.revisions || [];
  resp = await req('POST', `/api/admin/posts/${postId}/revisions/${revList[revList.length - 1].id}/restore`, { body: {}, ...H });
  check('历史版本一键还原', resp.status === 200 && !!(await resp.json()).data?.post);
  resp = await req('POST', '/api/admin/posts', { body: { template_post_id: postId }, ...H });
  const cloneId = (await resp.json()).data?.post?.id;
  check('从模板克隆文章（副本草稿）', resp.status === 200 && !!cloneId);
  await req('DELETE', `/api/admin/posts/${cloneId}`, { ...H });
  resp = await req('DELETE', `/api/admin/posts/${cloneId}?purge=1`, { ...H });
  check('回收站彻底删除（purge=1）', resp.status === 200 && (await resp.json()).data?.purged === true);
  resp = await req('GET', `/api/admin/posts/${cloneId}`);
  check('彻底删除后文章 404', resp.status === 404);

  // 媒体改名/分组与软删
  resp = await req('POST', '/api/admin/media/sign', { body: { mime: 'image/png', size: 64, orig_name: 'admin-smoke.png' }, ...H });
  const sign2 = (await resp.json()).data;
  await env.MEDIA.put(sign2.r2_key, new Uint8Array(64));
  await req('POST', '/api/admin/media/complete', { body: { media_id: sign2.media_id, width: 8, height: 8 }, ...H });
  resp = await req('PATCH', `/api/admin/media/${sign2.media_id}`, { body: { display_name: '后台改名图', album: '冒烟相册' }, ...H });
  check('媒体改名/分组（PATCH）', resp.status === 200);
  resp = await req('GET', '/api/admin/media?album=' + encodeURIComponent('冒烟相册'));
  check('媒体按分组筛选', (await resp.json()).data?.media?.some((m) => m.id === sign2.media_id));
  resp = await req('DELETE', `/api/admin/media/${sign2.media_id}`, { ...H });
  check('媒体软删（无引用可删）', resp.status === 200);

  // 导入：无 confirm 被拒；带 confirm 导入本站自己的导出（同文跳过、报告有 inserted）
  resp = await req('GET', '/api/admin/export/full.json');
  const exportData = await resp.json();
  resp = await req('POST', '/api/admin/import', { body: { data: exportData }, ...H });
  check('导入无二次确认被拒（400）', resp.status === 400);
  resp = await req('POST', '/api/admin/import', { body: { confirm: true, data: exportData }, ...H });
  const imp = (await resp.json()).data;
  check('整站导入（先自动备份+对账报告）', resp.status === 200 && imp?.report && typeof imp.report.inserted === 'object');

  // 手动备份
  resp = await req('POST', '/api/admin/backup/run', { body: {}, ...H });
  check('手动触发备份', resp.status === 200 && !!(await resp.json()).data?.backup?.r2_key);

  // 改密（吊销全部会话）→ 新密码登录 → 会话列表 → 一键下线全部
  resp = await req('POST', '/api/admin/password', { body: { old_password: 'smoke-new-pass-9', new_password: 'smoke-pass-456' }, ...H });
  check('站长改密', resp.status === 200);
  resp = await req('GET', '/api/admin/me');
  check('改密后旧会话被吊销（401）', resp.status === 401);
  resp = await req('POST', '/api/admin/login', { body: { username: 'smoke-admin', password: 'smoke-pass-456' }, ...H, useCookie: false });
  check('新密码重新登录', resp.status === 200 && cookie.includes('bk_session='));
  resp = await req('GET', '/api/admin/sessions');
  check('会话列表', resp.status === 200 && ((await resp.json()).data?.sessions?.length || 0) >= 1);
  resp = await req('POST', '/api/admin/sessions/revoke-all', { body: {}, ...H });
  check('一键下线全部会话', resp.status === 200);
  resp = await req('GET', '/api/admin/me');
  check('下线后当前会话失效（401）', resp.status === 401);
}

// ---------- 汇总 ----------
const failed = results.filter((r) => !r.pass);

// ---------- 14. 第三批：接口缺口批修覆盖 ----------
{
  const H = { headers: { 'X-Requested-With': 'fetch' } };
  // 重新登录（第 13 段结尾已 revoke-all，cookie 已失效）
  cookie = '';
  resp = await req('POST', '/api/admin/login', { body: { username: 'smoke-admin', password: 'smoke-pass-456' }, ...H, useCookie: false });
  check('【三批】重新登录（前段已下线全部会话）', resp.status === 200 && cookie.includes('bk_session='));

  // 缺口 1：备份列表 / 下载 / 删除
  resp = await req('GET', '/api/admin/backups');
  const bkList = (await resp.json()).data;
  check('【三批】备份列表接口', resp.status === 200 && Array.isArray(bkList?.backups) && bkList.backups.length >= 1 && bkList.total >= 1);
  const bkFirst = bkList.backups[0];
  check('【三批】备份列表带 r2_key（供对账定位）', typeof bkFirst.r2_key === 'string' && bkFirst.r2_key.startsWith('backup/'));
  resp = await req('GET', `/api/admin/backups/${bkFirst.id}/download`);
  const bkText = await resp.text();
  check('【三批】备份下载（回 JSON 备份体）', resp.status === 200 && bkText.includes('"ym-blog"'));
  resp = await req('POST', '/api/admin/backup/run', { body: {}, ...H });
  const bkTmp = (await resp.json()).data?.backup;
  resp = await req('GET', '/api/admin/backups');
  const bkList2 = (await resp.json()).data;
  const tmpRow = bkList2.backups.find((b) => b.r2_key === bkTmp.r2_key);
  check('【三批】新备份出现在列表里', !!tmpRow);
  resp = await req('DELETE', `/api/admin/backups/${tmpRow.id}`, { ...H });
  check('【三批】删除备份（登记+桶对象一起删）', resp.status === 200);
  resp = await req('GET', `/api/admin/backups/${tmpRow.id}/download`);
  check('【三批】已删备份再下载 404', resp.status === 404);

  // 缺口 3：按天统计明细（先造一天计数再查序列）
  await req('POST', '/api/view', { body: { post_id: postId }, useCookie: false });
  resp = await req('GET', '/api/admin/stats/daily?days=7');
  const daily = (await resp.json()).data?.daily || [];
  check('【三批】按天明细返回 7 天序列', resp.status === 200 && daily.length === 7);
  const todayRow = daily[daily.length - 1];
  check('【三批】今日 PV 计入序列且带评论趋势字段', todayRow && todayRow.pv >= 1 && typeof todayRow.comments_approved === 'number' && typeof todayRow.comments_pending === 'number');
  resp = await req('GET', '/api/admin/stats');
  check('【三批】stats 主接口也带 daily 字段', Array.isArray((await resp.json()).data?.daily));

  // 缺口 4：文章列表 type 过滤 + tags 字段
  resp = await req('GET', '/api/admin/posts?type=post');
  const listData = (await resp.json()).data;
  check('【三批】文章列表 tags 字段（冒烟文带「冒烟」标签）', listData.posts.some((p) => p.id === postId && Array.isArray(p.tags) && p.tags.includes('冒烟')));
  resp = await req('GET', '/api/admin/posts?type=page');
  check('【三批】type=page 过滤（无 page 型文章时为空）', (await resp.json()).data.posts.every((p) => p.type === 'page'));

  // 缺口 5：标签全集
  resp = await req('GET', '/api/admin/tags');
  const tagAll = (await resp.json()).data?.tags || [];
  check('【三批】标签全集（含文章计数）', resp.status === 200 && tagAll.some((t) => t.name === '冒烟' && t.post_count >= 1));

  // 缺口 6：post 详情卫生（无 password_hash，有 has_password）
  resp = await req('GET', `/api/admin/posts/${postId}`);
  const detailPost = (await resp.json()).data?.post;
  check('【三批】详情不下发 password_hash', detailPost && !('password_hash' in detailPost));
  check('【三批】详情带 has_password 布尔', detailPost && detailPost.has_password === false);

  // 缺口 7：评论分页 + 按文章筛选
  resp = await req('GET', '/api/admin/comments?status=approved&per=1&page=1');
  const cPage1 = (await resp.json()).data;
  check('【三批】评论分页（per=1 时只回 1 条且 total 更大）', cPage1.comments.length === 1 && cPage1.total > 1 && cPage1.page === 1);
  resp = await req('GET', '/api/admin/comments?status=approved&per=1&page=2');
  check('【三批】评论第二页与第一页不同条', (await resp.json()).data.comments[0]?.id !== cPage1.comments[0]?.id);
  resp = await req('GET', `/api/admin/comments?status=approved&post_id=${future.id}`);
  check('【三批】评论按文章筛选（无评论的文章为空）', (await resp.json()).data.total === 0);

  // 缺口 8：服务端渲染预览（与发布同口径）
  resp = await req('POST', '/api/admin/render', { body: { content_md: md }, ...H });
  const rendered = (await resp.json()).data;
  check('【三批】渲染预览端点（TOC/B 站/代码块与发布口径一致）', resp.status === 200 && rendered.html.includes('player.bilibili.com') && rendered.html.includes('language-js') && rendered.toc?.length >= 1 && rendered.word_count > 0);

  // 缺口 2：媒体回收站 + 相册清单
  resp = await req('POST', '/api/admin/media/sign', { body: { mime: 'image/png', size: 32, orig_name: 'batch3.png' }, ...H });
  const sign3 = (await resp.json()).data;
  await env.MEDIA.put(sign3.r2_key, new Uint8Array(32));
  await req('POST', '/api/admin/media/complete', { body: { media_id: sign3.media_id, width: 4, height: 4 }, ...H });
  await req('PATCH', `/api/admin/media/${sign3.media_id}`, { body: { album: '三批相册' }, ...H });
  resp = await req('GET', '/api/admin/media/albums');
  check('【三批】相册清单（含文件数）', (await resp.json()).data?.albums?.some((a) => a.album === '三批相册' && a.count >= 1));
  resp = await req('DELETE', `/api/admin/media/${sign3.media_id}`, { ...H });
  check('【三批】媒体软删进回收站', resp.status === 200);
  resp = await req('GET', '/api/admin/media?status=trashed');
  check('【三批】媒体回收站可见（status=trashed）', (await resp.json()).data?.media?.some((m) => m.id === sign3.media_id));
  resp = await req('GET', '/api/admin/media');
  check('【三批】默认媒体列表不含回收站文件', !(await resp.json()).data.media.some((m) => m.id === sign3.media_id));
  resp = await req('POST', `/api/admin/media/${sign3.media_id}/restore`, { body: {}, ...H });
  check('【三批】媒体回收站还原', resp.status === 200);
  resp = await req('GET', '/api/admin/media');
  check('【三批】还原后回到默认列表', (await resp.json()).data.media.some((m) => m.id === sign3.media_id));
}

// ---------- 15. 第四批：SPA 接线（服务端渲染同口径 + 评论分页） ----------
{
  const H = { headers: { 'X-Requested-With': 'fetch' } };
  // 仍是第 14 段的登录态（cookie 有效）

  // —— 渲染一致：同一份 Markdown，/api/admin/render 的 html 必须与发布落库 rendered_html 逐字相同 ——
  const md4 = ['## 四批对照标题', '', '四批正文有 **粗体** 与 `code`，还有代码块：', '', '```py', 'print("batch4")', '```', '', '单独一行放 B 站视频：', '', 'https://www.bilibili.com/video/BV1GJ411x7h7'].join('\n');
  resp = await req('POST', '/api/admin/render', { body: { content_md: md4 }, ...H });
  const preview4 = (await resp.json()).data;
  check('【四批】渲染预览端点（html/toc/word_count 齐全）', resp.status === 200 && !!preview4?.html && Array.isArray(preview4.toc) && preview4.toc.length >= 1 && preview4.word_count > 0);
  resp = await req('POST', '/api/admin/posts', { body: { title: '四批渲染对照文章', content_md: md4 }, ...H });
  const post4 = (await resp.json()).data?.post;
  resp = await req('POST', `/api/admin/posts/${post4.id}/publish`, { body: {}, ...H });
  const post4pub = (await resp.json()).data?.post;
  check('【四批】预览渲染与发布落库 html 逐字一致', !!post4pub?.rendered_html && preview4.html === post4pub.rendered_html);
  check('【四批】预览字数与发布落库字数一致', preview4.word_count === post4pub.word_count, `预览 ${preview4.word_count} / 发布 ${post4pub.word_count}`);

  // —— 评论分页：给对照文章连发 25 条站长回复（走站长接口直接 approved，不受访客限流影响）——
  const seededIds = [];
  for (let i = 1; i <= 25; i++) {
    resp = await req('POST', '/api/admin/comments', { body: { post_id: post4.id, content: `四批分页评论 ${i}` }, ...H });
    seededIds.push((await resp.json()).data?.id);
  }
  check('【四批】分页种子评论 25 条建成', seededIds.every(Boolean) && seededIds.length === 25);
  const fetchCmtPage = async (page, per) => (await (await req('GET', `/api/admin/comments?status=approved&post_id=${post4.id}&page=${page}&per=${per}`)).json()).data;
  const cp1 = await fetchCmtPage(1, 10);
  const cp2 = await fetchCmtPage(2, 10);
  const cp3 = await fetchCmtPage(3, 10);
  check('【四批】评论分页 total 正确（按文章筛选后 25）', cp1.total === 25 && cp1.page === 1 && cp1.per === 10, `total=${cp1.total}`);
  check('【四批】三页条数 10/10/5', cp1.comments.length === 10 && cp2.comments.length === 10 && cp3.comments.length === 5);
  const unionIds = [...cp1.comments, ...cp2.comments, ...cp3.comments].map((c) => c.id);
  check('【四批】三页并集恰为种子 25 条且不重叠', new Set(unionIds).size === 25 && seededIds.every((id) => unionIds.includes(id)));
  const cpDefault = (await (await req('GET', `/api/admin/comments?status=approved&post_id=${post4.id}`)).json()).data;
  check('【四批】不传分页参数时默认第一页 20 条', cpDefault.per === 20 && cpDefault.comments.length === 20 && cpDefault.total === 25);
  resp = await req('GET', `/api/admin/comments?status=pending&post_id=${post4.id}`);
  check('【四批】状态+文章双筛选（该文无待审评论 total=0）', (await resp.json()).data.total === 0);

  // —— SPA 接线在位（文件级检查：DOM 行为留部署后线上验，与前批口径一致）——
  const adminJs4 = readFileSync(join(root, 'admin/admin.js'), 'utf8');
  check('【四批】SPA 编辑器预览已接服务端渲染端点', adminJs4.includes("'/api/admin/render'") && adminJs4.includes('miniRender'));
  check('【四批】SPA 评论队列已接分页参数与分页条', adminJs4.includes('commentsPage') && adminJs4.includes('&per=${PER}') && adminJs4.includes('id="cmtPrev"') && adminJs4.includes('id="cmtNext"'));
  check('【四批】SPA 预览提示语已改同口径（无旧话术残留）', adminJs4.includes('预览与发布同口径') && !adminJs4.includes('最终以发布为准'));
}

// ---------- 16. 第五批：静态资源路由（_routes.json，修 /assets/* 与 /admin/* 全 404） ----------
// 根因：catch-all 函数 [[path]].js 曾假设「静态文件由平台先于函数直出」，但本部署形态
// （wrangler pages deploy 仓库根目录、无 _routes.json）下该假设不成立：函数接管全部路径，
// /assets/* 与 /admin/* 无 handler 落 404（线上实证：首页 SSR 200、静态全 404）。
// 修法：根目录 _routes.json 把两个静态目录 exclude 出 Functions（Pages 官方机制），其余路径仍走函数。
// 本地冒烟只能验「文件在位且口径对」；平台是否照此直出，须重新部署后线上实拉 CSS/JS/admin 页验证。
{
  const { existsSync } = await import('node:fs');
  const routesPath = join(root, '_routes.json');
  check('【五批】_routes.json 存在于仓库根（部署包根目录）', existsSync(routesPath));
  let routes = null;
  try { routes = JSON.parse(readFileSync(routesPath, 'utf8')); } catch { routes = null; }
  check('【五批】_routes.json 是合法 JSON 且 version=1', !!routes && routes.version === 1);
  const inc = routes?.include || [];
  const exc = routes?.exclude || [];
  check('【五批】include 覆盖 /* （SSR 与全部 API 继续走函数）', inc.includes('/*'));
  check('【五批】exclude 覆盖 /assets/* 与 /admin/*', exc.includes('/assets/*') && exc.includes('/admin/*'), `exclude=${JSON.stringify(exc)}`);
  check('【五批】exclude 不误伤动态路径（/api/*、/robots.txt 不在排除内）',
    !exc.some((p) => p.startsWith('/api') || p.includes('robots')));
  // 被 exclude 的目录里确实有静态文件（排除了个空目录等于没修）
  check('【五批】assets 与 admin 目录下确有静态文件',
    existsSync(join(root, 'assets/css/site.css')) && existsSync(join(root, 'assets/js/site.js'))
    && existsSync(join(root, 'assets/js/beacon.js')) && existsSync(join(root, 'admin/index.html'))
    && existsSync(join(root, 'admin/admin.js')) && existsSync(join(root, 'admin/admin.css')));
  // 口径一致：wrangler.toml 的构建输出目录就是仓库根，_routes.json 放根才能随部署包生效
  const wt = readFileSync(join(root, 'wrangler.toml'), 'utf8');
  check('【五批】wrangler.toml 输出目录为根（_routes.json 位置与之对齐）', wt.includes('pages_build_output_dir = "."'));
  // 函数头部注释已按新机制表述，不再留「平台先于函数直出」的旧假设
  const entry = readFileSync(join(root, 'functions/[[path]].js'), 'utf8');
  check('【五批】[[path]].js 注释已与 _routes 机制对齐', entry.includes('_routes.json') && !entry.includes('平台会先于本函数直出'));
}

// ---------- 12. 六批：EdgeBlog 借鉴升级（全文搜索 / AI 管道 / 哈希懒升级） ----------
{
  const H = { 'X-Requested-With': 'fetch' };
  // 专用测试文：标题与正文都带独特中文词，发布后测搜索
  resp = await req('POST', '/api/admin/posts', { body: { title: '紫石英号观测记录', content_md: '今晚用紫石英号望远镜观测猎户座，薄雾散去后星图格外清晰。这是一篇全文搜索冒烟专用文章。', tags: ['冒烟'] }, headers: H });
  const ftsPost = (await resp.json()).data?.post;
  check('【六批】全文搜索测试文新建', resp.status === 200 && !!ftsPost);
  resp = await req('POST', `/api/admin/posts/${ftsPost.id}/publish`, { body: { status: 'published' }, headers: H });
  check('【六批】全文搜索测试文发布', resp.status === 200);
  // 正文中间的中文子串（不在标题里）：FTS trigram 应命中
  resp = await req('GET', '/search?q=' + encodeURIComponent('望远镜观测'));
  html = await resp.text();
  check('【六批】搜索中文子串命中正文（FTS trigram）', resp.status === 200 && html.includes('紫石英号观测记录'));
  // 标题里的词也应命中
  resp = await req('GET', '/search?q=' + encodeURIComponent('紫石英号'));
  html = await resp.text();
  check('【六批】搜索命中标题', resp.status === 200 && html.includes('紫石英号观测记录'));
  // 两个字的短词：trigram 切不出片段，必须靠 LIKE 兜底命中
  resp = await req('GET', '/search?q=' + encodeURIComponent('薄雾'));
  html = await resp.text();
  check('【六批】两字短词搜索靠 LIKE 兜底命中', resp.status === 200 && html.includes('紫石英号观测记录'));
  // 草稿不该被搜到（状态过滤在 FTS 路径同样生效）
  resp = await req('POST', '/api/admin/posts', { body: { title: '紫石英号草稿绝密', content_md: '紫石英号草稿内容不应出现在搜索里' }, headers: H });
  resp = await req('GET', '/search?q=' + encodeURIComponent('紫石英号'));
  html = await resp.text();
  check('【六批】草稿不进搜索结果', resp.status === 200 && !html.includes('紫石英号草稿绝密'));
  // 索引表缺失（迁移没跑的环境）时搜索自动退回 LIKE、不 500
  db.exec('DROP TABLE posts_fts');
  resp = await req('GET', '/search?q=' + encodeURIComponent('望远镜观测'));
  html = await resp.text();
  check('【六批】FTS 表缺失时搜索 LIKE 兜底不报错', resp.status === 200 && html.includes('紫石英号观测记录'));

  // ---- AI 管道 ----
  resp = await req('GET', '/api/admin/ai/config');
  let aiCfg = (await resp.json()).data?.config;
  check('【六批】AI 配置可读且初始未配置', resp.status === 200 && aiCfg && aiCfg.has_api_key === false);
  resp = await req('POST', '/api/ai/generate', { body: { mode: 'summary', title: '测试', content: '随便一段正文内容' }, headers: H });
  const aiErr = (await resp.json()).error;
  check('【六批】未配置时 generate 返回规范提示 ai_not_configured', resp.status === 400 && aiErr?.code === 'ai_not_configured');
  resp = await req('PUT', '/api/admin/ai/config', { body: { base_url: 'https://ai.example.test/v1', model: 'test-model', temperature: 0.5 }, headers: H });
  check('【六批】AI 配置可存（不带 Key）', resp.status === 200 && (await resp.json()).data?.config?.base_url === 'https://ai.example.test/v1');
  resp = await req('PUT', '/api/admin/ai/config', { body: { api_key: '<redacted>' }, headers: H });
  const cfgText = await resp.text();
  check('【六批】存 Key 后只回 has_api_key 且响应不含 Key 明文', resp.status === 200 && cfgText.includes('"has_api_key":true') && !cfgText.includes('sk-smoke-secret'));
  resp = await req('POST', '/api/ai/generate', { body: { mode: 'summary', title: '测试标题', content: '测试正文内容' }, headers: H });
  const gen = (await resp.json()).data;
  check('【六批】配好后 generate 走通上游并返回文本（fetch 打桩）', resp.status === 200 && gen?.text === '这是 AI 生成的测试摘要');
  resp = await req('PUT', '/api/admin/ai/config', { body: { base_url: 'https://ai.example.test/v1' }, headers: H });
  resp = await req('GET', '/api/admin/ai/config');
  aiCfg = (await resp.json()).data?.config;
  check('【六批】空 Key 保存不冲掉已存 Key', aiCfg?.has_api_key === true);
  resp = await req('PUT', '/api/admin/ai/config', { body: { clear_api_key: 1 }, headers: H });
  resp = await req('GET', '/api/admin/ai/config');
  aiCfg = (await resp.json()).data?.config;
  check('【六批】显式清空 Key 后回到未配置', aiCfg?.has_api_key === false);
  resp = await req('PUT', '/api/admin/ai/config', { body: { base_url: 'not-a-url' }, headers: H });
  check('【六批】非法 Base URL 被拒（400）', resp.status === 400);
  // 上游 500：应回 424 + ai_upstream_error（不用 502——会被 Cloudflare 边缘换成它自己的错误页，后台读不到中文提示）
  resp = await req('PUT', '/api/admin/ai/config', { body: { base_url: 'https://ai-fail.example.test/v1', api_key: '<redacted>' }, headers: H });
  resp = await req('POST', '/api/ai/generate', { body: { mode: 'summary', title: '测试', content: '正文' }, headers: H });
  const upErr = (await resp.json()).error;
  check('【六批】上游出错回 424 + ai_upstream_error（避开边缘 502 替换）', resp.status === 424 && upErr?.code === 'ai_upstream_error');
  resp = await req('GET', '/api/admin/ai/config', { useCookie: false });
  check('【六批】未登录读 AI 配置被拒（401）', resp.status === 401);

  // ---- 密码哈希懒升级：老 pbkdf2 记录登录成功后应被重哈希为 scrypt ----
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMat = await crypto.subtle.importKey('raw', new TextEncoder().encode('legacy-pass-123\x00' + env.PASSWORD_PEPPER), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, keyMat, 256);
  const legacyHash = `pbkdf2$100000$${Buffer.from(salt).toString('base64')}$${Buffer.from(new Uint8Array(bits)).toString('base64')}`;
  db.prepare('INSERT INTO admin_users (username, password_hash, password_updated_at, created_at) VALUES (?, ?, 0, 0)')
    .run('legacy-admin', legacyHash);
  resp = await req('POST', '/api/admin/login', { body: { username: 'legacy-admin', password: 'legacy-pass-123' }, headers: H, useCookie: false });
  check('【六批】老 pbkdf2 哈希账号仍可登录', resp.status === 200);
  const afterHash = db.prepare('SELECT password_hash FROM admin_users WHERE username = ?').get('legacy-admin')?.password_hash || '';
  check('【六批】登录后老哈希被懒升级为 scrypt', afterHash.startsWith('scrypt$'), afterHash.split('$')[0]);
  resp = await req('POST', '/api/admin/login', { body: { username: 'legacy-admin', password: 'legacy-pass-123' }, headers: H, useCookie: false });
  check('【六批】升级后的哈希二次登录仍成功', resp.status === 200);
}

// ---------- 汇总 ----------
const failedAll = results.filter((r) => !r.pass);
console.log(`\n冒烟汇总：${results.length - failedAll.length}/${results.length} 通过${failedAll.length ? '，失败：' + failedAll.map((f) => f.name).join('；') : ''}`);
process.exit(failedAll.length ? 1 : 0);
