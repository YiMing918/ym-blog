// ai-api.js — AI 写作接口：配置读写（站长）+ 生成代理（站长）
//   GET  /api/admin/ai/config  读配置（Key 只回 has_api_key，永不下发明文）
//   PUT  /api/admin/ai/config  存配置（api_key 留空=保持原值；clear_api_key=1 才清空）
//   POST /api/ai/generate      生成摘要/正文：{ mode: 'summary'|'body', title, content }
// 全部要会话；写操作还要 CSRF 头。未配置时 generate 返回 ai_not_configured 的规范提示。

import { json, readJson, badRequest } from '../_lib/http.js';
import { requireAdmin, requireCsrf } from '../_lib/auth.js';
import { getAiConfigPublic, saveAiConfig, aiGenerate } from '../_lib/ai.js';

export async function handleAiApi(env, request, method, path) {
  if (path === '/api/admin/ai/config') {
    await requireAdmin(env, request);
    if (method === 'GET') return json({ config: await getAiConfigPublic(env) });
    if (method === 'PUT') {
      requireCsrf(request);
      const body = await readJson(request);
      const patch = {};
      for (const k of ['base_url', 'model', 'temperature', 'prompt_summary', 'prompt_body']) {
        if (k in body) patch[k] = body[k];
      }
      // Key 语义：没传或空字符串 = 保持原值（表单不回显 Key，空提交不能把已存的冲掉）；
      // 只有显式 clear_api_key 才清空；传了非空才替换。
      if (body.clear_api_key) patch.api_key = '';
      else if (typeof body.api_key === 'string' && body.api_key.trim()) patch.api_key = body.api_key;
      return json({ config: await saveAiConfig(env, patch) });
    }
    return null;
  }
  if (path === '/api/ai/generate' && method === 'POST') {
    await requireAdmin(env, request);
    requireCsrf(request);
    const body = await readJson(request);
    const mode = body.mode === 'body' ? 'body' : 'summary';
    const content = String(body.content ?? '');
    if (!content.trim() && !String(body.title ?? '').trim()) throw badRequest('先写点标题或正文，再让 AI 生成');
    const r = await aiGenerate(env, { mode, title: String(body.title ?? ''), content });
    return json(r);
  }
  return null;
}
