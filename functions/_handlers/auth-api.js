// auth-api.js — 登录/退出/初始化/改密/恢复码/Passkey 预留
// 失败提示恒为「账号或密码错误」，不区分账号不存在还是密码错（防枚举）。
// 改密与恢复码重置都会吊销全部会话——被盗时改密即踢掉对方。

import { first, run } from '../_lib/db.js';
import { json, fail, readJson, nowSec, ipHash, badRequest, tooMany } from '../_lib/http.js';
import { verifyPassword, hashPassword, hashNeedsUpgrade } from '../_lib/hash.js';
import {
  createSession, revokeSession, revokeAllSessions, listSessions, requireAdmin, requireCsrf,
  ensureInitialAdmin, needsSetup, createAdminUser,
  loginLockState, recordLoginFail, clearLoginFails,
  generateRecoveryCodes, consumeRecoveryCode,
} from '../_lib/auth.js';
import { hitLimit, peekLimit, checkLimit, limitSpec } from '../_lib/ratelimit.js';
import { getSettings } from '../_lib/settings.js';

function checkPasswordStrength(pw) {
  if (!pw || String(pw).length < 8) throw badRequest('密码至少 8 位');
  if (String(pw).length > 200) throw badRequest('密码太长');
}

export async function handleAuthApi(env, request, method, path) {
  // 初始化状态（公开）：告诉前端要不要走建站长流程
  if (method === 'GET' && path === '/api/admin/setup-status') {
    return json({ needs_setup: await needsSetup(env) });
  }

  // 首次初始化：库里没有任何站长时才能用，建完即永久关闭
  if (method === 'POST' && path === '/api/admin/setup') {
    if (!(await needsSetup(env))) return fail('forbidden', '初始化已完成', 403);
    const body = await readJson(request);
    const username = String(body.username || '').trim();
    if (!username) throw badRequest('请填写用户名');
    checkPasswordStrength(body.password);
    const userId = await createAdminUser(env, username, String(body.password));
    const codes = await generateRecoveryCodes(env, userId);
    const token = await createSession(env, request, userId);
    return json({ username, recovery_codes: codes, note: '恢复码只显示这一次，请立刻抄下或截图保存到安全的地方' }, 200, { 'Set-Cookie': (await import('../_lib/auth.js')).sessionCookieHeader(token) });
  }

  if (method === 'POST' && path === '/api/admin/login') {
    await ensureInitialAdmin(env);
    const body = await readJson(request);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const lock = await loginLockState(env, username);
    if (lock.locked) return fail('locked', `账号已锁定，请 ${Math.ceil(lock.remainSec / 60)} 分钟后再试`, 429);
    const settings = await getSettings(env);
    const iph = await ipHash(env, request);
    // 按 IP 登录限流走 LIMITS.loginIp 配置（随后台限流档位：normal 20 次/小时、strict 10 次/小时、
    // off 关闭；此前阈值与窗口写死为 20/3600，档位改了也不生效——v1.1.2 接线）。
    // 语义不变：只数失败不数成功——先 peek 判定存量，失败后才 hit 计数（上限给足，
    // hitLimit 在这里只当计数器用，真正的拦截在下一次请求的 peek）。
    const ipSpec = limitSpec(settings, 'loginIp');
    if (ipSpec && (await peekLimit(env, `loginIp:${iph}`, ipSpec.windowSec)) >= ipSpec.limit) return fail('rate_limited', '本网络登录失败次数过多，请一小时后再试', 429);
    const user = await first(env, 'SELECT id, password_hash FROM admin_users WHERE username = ?', username);
    const ok = user ? await verifyPassword(env, password, user.password_hash) : false;
    if (!ok) {
      await recordLoginFail(env, username || '(empty)');
      if (ipSpec) await hitLimit(env, `loginIp:${iph}`, 100000, ipSpec.windowSec);
      return fail('invalid', '账号或密码错误', 401);
    }
    await clearLoginFails(env, username);
    // 懒升级：老格式/低参数哈希在登录成功后按当前参数重哈希，用户无感；
    // 升级失败绝不挡登录（下次登录再试），所以整段吞错。
    if (hashNeedsUpgrade(user.password_hash)) {
      try {
        const upgraded = await hashPassword(env, password);
        await run(env, 'UPDATE admin_users SET password_hash = ? WHERE id = ?', upgraded, user.id);
      } catch { /* 忽略，下次登录重试 */ }
    }
    const token = await createSession(env, request, user.id);
    const { sessionCookieHeader } = await import('../_lib/auth.js');
    return json({ username }, 200, { 'Set-Cookie': sessionCookieHeader(token) });
  }

  if (method === 'POST' && path === '/api/admin/logout') {
    await revokeSession(env, request);
    const { clearCookieHeader } = await import('../_lib/auth.js');
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookieHeader() });
  }

  // 恢复码重置（公开入口，但凭码+限试）
  if (method === 'POST' && path === '/api/admin/recovery/reset') {
    const body = await readJson(request);
    const username = String(body.username || '').trim();
    checkPasswordStrength(body.new_password);
    const settings = await getSettings(env);
    const iph = await ipHash(env, request);
    // 恢复入口同样是猜码面，与登录共用按 IP 的失败限流（LIMITS.loginIp，随档位）：
    // 在登录侧攒下的同 IP 失败计数在这里同样生效，恢复失败也回写同一计数桶。
    const ipSpec = limitSpec(settings, 'loginIp');
    if (ipSpec && (await peekLimit(env, `loginIp:${iph}`, ipSpec.windowSec)) >= ipSpec.limit) return fail('rate_limited', '本网络登录失败次数过多，请一小时后再试', 429);
    // 恢复码试错上限走 LIMITS.recovery 配置（随档位，此前写死 5/3600 与配置脱节——v1.1.2 接线）；
    // checkLimit 的桶名 recovery:<username> 与旧写死版一致，计数连续不清零。
    const gate = await checkLimit(env, settings, 'recovery', username);
    if (!gate.allowed) return fail('locked', '恢复码试错次数过多，恢复入口锁定一小时', 429);
    const user = await first(env, 'SELECT id FROM admin_users WHERE username = ?', username);
    if (!user) {
      if (ipSpec) await hitLimit(env, `loginIp:${iph}`, 100000, ipSpec.windowSec);
      return fail('invalid', '账号或恢复码错误', 400);
    }
    const ok = await consumeRecoveryCode(env, user.id, body.code);
    if (!ok) {
      if (ipSpec) await hitLimit(env, `loginIp:${iph}`, 100000, ipSpec.windowSec);
      return fail('invalid', '账号或恢复码错误', 400);
    }
    const hash = await hashPassword(env, String(body.new_password));
    await run(env, 'UPDATE admin_users SET password_hash = ?, password_updated_at = ? WHERE id = ?', hash, nowSec(), user.id);
    await revokeAllSessions(env, user.id);
    await clearLoginFails(env, username);
    return json({ ok: true, note: '密码已重置，请用新密码登录；建议登录后重新生成恢复码' });
  }

  // 以下为已登录接口
  if (method === 'POST' && path === '/api/admin/password') {
    const me = await requireAdmin(env, request);
    requireCsrf(request);
    const body = await readJson(request);
    const user = await first(env, 'SELECT password_hash FROM admin_users WHERE id = ?', me.id);
    if (!(await verifyPassword(env, String(body.old_password || ''), user.password_hash))) {
      return fail('invalid', '旧密码错误', 400);
    }
    checkPasswordStrength(body.new_password);
    const hash = await hashPassword(env, String(body.new_password));
    await run(env, 'UPDATE admin_users SET password_hash = ?, password_updated_at = ? WHERE id = ?', hash, nowSec(), me.id);
    await revokeAllSessions(env, me.id);
    return json({ ok: true, note: '密码已修改，全部设备已下线，请重新登录' });
  }

  if (method === 'POST' && path === '/api/admin/recovery/generate') {
    const me = await requireAdmin(env, request);
    requireCsrf(request);
    const codes = await generateRecoveryCodes(env, me.id);
    return json({ recovery_codes: codes, note: '旧恢复码已全部作废；新码只显示这一次' });
  }

  if (method === 'GET' && path === '/api/admin/sessions') {
    const me = await requireAdmin(env, request);
    return json({ sessions: await listSessions(env, me.id) });
  }
  if (method === 'POST' && path === '/api/admin/sessions/revoke-all') {
    const me = await requireAdmin(env, request);
    requireCsrf(request);
    await revokeAllSessions(env, me.id);
    return json({ ok: true });
  }

  // Passkey 预留端点：本期未启用（表与路径先占位，启用时补 WebAuthn 流程）
  if (path.startsWith('/api/admin/passkey') || path.startsWith('/api/passkey')) {
    return fail('not_implemented', 'Passkey 登录尚未启用，请用账号密码或恢复码', 501);
  }

  return null; // 不归我管，交回总路由
}
