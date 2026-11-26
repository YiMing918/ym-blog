// auth-api.js — 登录/退出/初始化/改密/恢复码/Passkey 预留
// 失败提示恒为「账号或密码错误」，不区分账号不存在还是密码错（防枚举）。
// 改密与恢复码重置都会吊销全部会话——被盗时改密即踢掉对方。

import { first, run } from '../_lib/db.js';
import { json, fail, readJson, nowSec, ipHash, badRequest, tooMany } from '../_lib/http.js';
import { verifyPassword, hashPassword, hashNeedsUpgrade } from '../_lib/hash.js';
import {
  createSession, revokeSession, revokeAllSessions, listSessions, requireAdmin, requireCsrf,
  sessionCookieHeader, clearCookieHeader,
  ensureInitialAdmin, needsSetup, createAdminUser,
  loginLockState, recordLoginFail, clearLoginFails,
  generateRecoveryCodes, consumeRecoveryCode,
} from '../_lib/auth.js';
import { sha256Hex } from '../_lib/http.js';

// 定长常量时间比较（先哈希再逐字节比，避免长度与时序侧信道）
async function safeEqStr(a, b) {
  const [ha, hb] = await Promise.all([sha256Hex(String(a ?? '')), sha256Hex(String(b ?? ''))]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}
import { hitLimit, peekLimit, checkLimit, limitSpec } from '../_lib/ratelimit.js';
// 登录时序兜底（低1）：用户不存在时也跑一次等价校验，避免响应快慢暴露账号是否存在
// 假哈希与真实账号同走主轨 scrypt（复审 S5）：旧版是 pbkdf2 格式，与多为
// scrypt 的真实记录耗时不等价，仍可能靠快慢猜账号是否存在。盐 16 字节、
// 键 32 字节、参数与 hash.js 的 SCRYPT 一致，校验必然算满一遍 scrypt。
const DUMMY_HASH = 'scrypt$16384,8,1$' + Buffer.from('ym-blog-dummy-sa').toString('base64') + '$' + Buffer.from('ym-blog-dummy-hash-value-32bytes').toString('base64');
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
    // 限流（中13/低1）：初始化入口按 IP 计数，防口令爆破（直用 hitLimit，不受后台限流档位 off 影响）
    try {
      const iph0 = await ipHash(env, request);
      const lim = await hitLimit(env, `setup:${iph0}`, 10, 3600);
      if (!lim.allowed) return fail('rate_limited', '初始化尝试次数过多，请一小时后再试', 429);
    } catch { /* 限流表异常不挡正常初始化 */ }
    const body = await readJson(request);
    // fail-closed（高危余项）：没配 SETUP_TOKEN 一律拒绝初始化——旧版没配就裸奔，
    // 部署完成到站长初始化之间的窗口里谁先打开谁抢注。部署时必须配 SETUP_TOKEN（见 README）。
    if (!env.SETUP_TOKEN) {
      return fail('forbidden', '服务端未配置 SETUP_TOKEN，拒绝初始化：请先在 Pages 环境变量里配好 SETUP_TOKEN 再来初始化', 403);
    }
    if (!(await safeEqStr(body.setup_token, env.SETUP_TOKEN))) {
      return fail('forbidden', '初始化口令不正确', 403);
    }
    const username = String(body.username || '').trim();
    if (!username) throw badRequest('请填写用户名');
    checkPasswordStrength(body.password);
    const userId = await createAdminUser(env, username, String(body.password));
    if (!userId) return fail('forbidden', '初始化已完成', 403); // 并发下被别人抢先
    const codes = await generateRecoveryCodes(env, userId);
    const token = await createSession(env, request, userId);
    return json({ username, recovery_codes: codes, note: '恢复码只显示这一次，请立刻抄下或截图保存到安全的地方' }, 200, { 'Set-Cookie': sessionCookieHeader(token) });
  }

  if (method === 'POST' && path === '/api/admin/login') {
    await ensureInitialAdmin(env);
    const body = await readJson(request);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const settings = await getSettings(env);
    const iph = await ipHash(env, request);
    // 锁定计数按「用户名+IP」组合：只锁攻击者自己的 IP，不再让任何人
    // 靠连错密码把站长本人锁在后台外（站长用户名随评论回复公开）。
    const guardKey = `${username}|${iph}`;
    const lock = await loginLockState(env, guardKey);
    if (lock.locked) return fail('locked', `登录失败次数过多，请 ${Math.ceil(lock.remainSec / 60)} 分钟后再试`, 429);
    // 按 IP 登录限流走 LIMITS.loginIp 配置（随后台限流档位：normal 20 次/小时、strict 10 次/小时、
    // off 关闭；此前阈值与窗口写死为 20/3600，档位改了也不生效——v1.1.2 接线）。
    // 语义不变：只数失败不数成功——先 peek 判定存量，失败后才 hit 计数（上限给足，
    // hitLimit 在这里只当计数器用，真正的拦截在下一次请求的 peek）。
    const ipSpec = limitSpec(settings, 'loginIp');
    if (ipSpec && (await peekLimit(env, `loginIp:${iph}`, ipSpec.windowSec)) >= ipSpec.limit) return fail('rate_limited', '本网络登录失败次数过多，请一小时后再试', 429);
    const user = await first(env, 'SELECT id, password_hash FROM admin_users WHERE username = ?', username);
    const ok = user ? await verifyPassword(env, password, user.password_hash) : (await verifyPassword(env, password, DUMMY_HASH), false);
    if (!ok) {
      await recordLoginFail(env, username ? guardKey : `(empty)|${iph}`);
      if (ipSpec) await hitLimit(env, `loginIp:${iph}`, 100000, ipSpec.windowSec);
      return fail('invalid', '账号或密码错误', 401);
    }
    await clearLoginFails(env, guardKey);
    // 会话轮换（Peter 2026-11-19 拍板）：每次登录先吊销这个账号此前的全部
    // 会话、再签发新令牌——旧令牌活不过下一次本人登录，被偷走的会话最多
    // 用到站长下次登录为止。与改密/恢复重置的「全吊销」口径一致。
    await revokeAllSessions(env, user.id);
    // 懒升级：老格式/低参数哈希在登录成功后按当前参数重哈希，用户无感；
    // 升级失败绝不挡登录（下次登录再试），所以整段吞错。
    if (hashNeedsUpgrade(user.password_hash)) {
      try {
        const upgraded = await hashPassword(env, password);
        await run(env, 'UPDATE admin_users SET password_hash = ? WHERE id = ?', upgraded, user.id);
      } catch { /* 忽略，下次登录重试 */ }
    }
    const token = await createSession(env, request, user.id);
    return json({ username }, 200, { 'Set-Cookie': sessionCookieHeader(token) });
  }

  if (method === 'POST' && path === '/api/admin/logout') {
    requireCsrf(request); // 与本站其他写接口同口径（复审 S3；前端 api() 本来就带该头）
    await revokeSession(env, request);
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
    // 桶名带上 IP 哈希（recovery:<username>|<iph>）：与登录锁定同理，
    // 只按用户名计数时，任何人试错 5 次就能把站长的恢复入口锁掉一小时。
    const gate = await checkLimit(env, settings, 'recovery', `${username}|${iph}`);
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
    await clearLoginFails(env, `${username}|${iph}`);
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
