// [[path]].js — 总路由：按路径把请求分发到各 handler，统一错误处理与安全头
// 分发顺序：feeds（rss/sitemap/robots）→ 访客 SSR 页面 → 公开 API → 登录类 API → 站长 API → 任务 API → 404。
// 注意：/assets/* 与 /admin/* 是纯静态文件，靠仓库根的 _routes.json 把它们 exclude 出
// Functions 调用、由 Pages 静态层直出，不经过这里。若 _routes.json 缺失或没进部署包，
// 本函数会接管这两类路径且无对应 handler → 静态资源全 404（见 MAINTENANCE.md 故障对照表）。

import { handlePages, notFoundPage } from './_handlers/pages.js';
import { handleFeeds } from './_handlers/feeds.js';
import { handlePublicApi } from './_handlers/public-api.js';
import { handleAuthApi } from './_handlers/auth-api.js';
import { handleAdminApi } from './_handlers/admin-api.js';
import { handleTasksApi } from './_handlers/tasks-api.js';
import { fail, HttpError, securityHeaders } from './_lib/http.js';
import { getSettings } from './_lib/settings.js';
import { getSessionUser } from './_lib/auth.js';

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();
  try {
    let resp = null;
    resp = await handleFeeds(env, request, method, path);
    if (!resp && method === 'GET') resp = await handlePages(env, request, method, path, url);
    if (!resp) resp = await handlePublicApi(env, request, method, path, url);
    if (!resp) resp = await handleAuthApi(env, request, method, path);
    if (!resp) resp = await handleAdminApi(env, request, method, path, url);
    if (!resp) resp = await handleTasksApi(env, request, method, path);
    if (!resp) {
      if (path.startsWith('/api/')) return fail('not_found', '接口不存在', 404);
      const settings = await getSettings(env);
      const adminUser = await getSessionUser(env, request);
      return await notFoundPage(env, request, settings, adminUser);
    }
    // 统一补安全头（不覆盖 handler 已设的）
    const headers = new Headers(resp.headers);
    for (const [k, v] of Object.entries(securityHeaders())) {
      if (!headers.has(k)) headers.set(k, v);
    }
    if (path.startsWith('/admin') || path.startsWith('/api/admin')) headers.set('X-Frame-Options', 'DENY');
    return new Response(resp.body, { status: resp.status, headers });
  } catch (e) {
    if (e instanceof HttpError) return fail(e.code, e.message, e.status);
    // 未知错误：只回中性文案，细节进日志（别把堆栈泄露给访客）
    console.error('unhandled error', e);
    return fail('internal', '服务器内部错误，请稍后再试', 500);
  }
}

export async function onRequest(context) {
  return handleRequest(context.request, context.env);
}
