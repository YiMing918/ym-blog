// turnstile.js — Cloudflare Turnstile 服务端校验
// 注意：只在前端放组件不算开启，必须服务端拿 token 去 siteverify 验（token 5 分钟内有效、一次性）。
// secret 只从环境变量 TURNSTILE_SECRET 读，永不进数据库/仓库。

export async function verifyTurnstile(env, request, token) {
  const secret = env.TURNSTILE_SECRET;
  if (!secret) return { ok: false, reason: '未配置 TURNSTILE_SECRET' };
  if (!token) return { ok: false, reason: '缺少人机验证令牌' };
  try {
    const form = new URLSearchParams();
    form.set('secret', secret);
    form.set('response', token);
    const ip = request.headers.get('cf-connecting-ip');
    if (ip) form.set('remoteip', ip);
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
    });
    const data = await resp.json();
    return { ok: !!data.success, reason: data.success ? '' : '人机验证未通过' };
  } catch {
    return { ok: false, reason: '人机验证服务不可用' };
  }
}
