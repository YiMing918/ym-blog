// Shared SSRF guard for outbound fetches (friend-link checks).
// 本文件与 ym-nav 的 functions/_ssrf.js 是同一份守卫逻辑的副本（各仓独立
// 部署、无共享包，靠纪律同步——改一处记得同步另一处）。
//
// Why this exists: tasks-api.js 的友链探活原来用 redirect:'follow' 裸抓，
// 一个被挂马/卖域名的友站可以 302 到 127.0.0.1 / 169.254.169.254 /
// RFC-1918 地址，follow 会一路跟过去——入口没有任何校验能看见跳转目标。
// Here every hop is fetched with redirect:'manual' and re-validated
// before it is requested.
//
// blockedHost below is a superset of the per-file copies it replaces:
// the original ranges (10/8, 127/8, 0/8, 172.16/12, 192.168/16,
// 169.254/16, localhost / .local / .internal) are kept verbatim, and
// the gaps are closed: IPv6 literals (::1, fc00::/7, fe80::/10,
// v4-mapped / NAT64 / 6to4 embedded IPv4), CGNAT 100.64/10,
// benchmarking 198.18/15, documentation / reserved ranges, multicast,
// and the obvious private-ish domain suffixes. WHATWG URL parsing
// already normalises integer / hex / octal / short IPv4 spellings to
// dotted quads, but a decoder for those raw forms is kept as defence
// in depth in case a hostname ever arrives un-normalised.
// NOTE: hostnames are checked as written (literal IPs / domain
// shape). No DNS resolution happens here, so a public name that
// resolves to a private address (DNS rebinding) is out of scope for
// this layer — same limitation as the original checks.

export const MAX_REDIRECTS = 5;

export class SsrfError extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.name = 'SsrfError';
    this.code = code; // 'blocked' | 'too_many_redirects'
    if (status) this.status = status;
  }
}

function ipv4Blocked(a, b, c, d) {
  if ([a, b, c, d].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  if (a === 0) return true; // 0.0.0.0/8 "this host on this network"
  if (a === 10) return true; // RFC 1918
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF special
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay (deprecated)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224 && a < 240) return true; // multicast 224.0.0.0/4
  if (a >= 240) return true; // reserved 240.0.0.0/4 incl. 255.255.255.255
  return false;
}

// Decode a non-standard IPv4 spelling (single integer, 0x-hex parts,
// octal parts, fewer than 4 parts) the way WHATWG URL does. Returns
// [a,b,c,d] or null when it is not a numeric form / overflows.
function decodeNumericIpv4(h) {
  const parts = h.split('.');
  if (parts.length > 4) return null;
  const nums = [];
  for (const p of parts) {
    if (!/^(0x[0-9a-f]+|\d+)$/i.test(p)) return null;
    let n;
    if (/^0x/i.test(p)) n = parseInt(p, 16);
    else if (p.length > 1 && p[0] === '0') n = parseInt(p, 8);
    else n = parseInt(p, 10);
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }
  const last = nums[nums.length - 1];
  if (nums.slice(0, -1).some((n) => n > 255)) return null;
  if (last >= 256 ** (5 - nums.length)) return null;
  const bytes = nums.slice(0, -1);
  let rest = last;
  const tail = [];
  for (let i = 4 - bytes.length - 1; i >= 0; i--) {
    tail[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return [...bytes, ...tail];
}

function ipv6Blocked(host) {
  let h = host.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  const zone = h.indexOf('%');
  if (zone >= 0) h = h.slice(0, zone); // fe80::1%eth0 — zone stripped, prefix still checked
  // Embedded dotted IPv4 tail (::ffff:127.0.0.1) -> two hex groups.
  const lastColon = h.lastIndexOf(':');
  if (lastColon >= 0 && h.slice(lastColon + 1).includes('.')) {
    const p = h.slice(lastColon + 1).split('.').map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    h = h.slice(0, lastColon + 1) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = h.split('::');
  if (halves.length > 2) return true;
  const parseSide = (s) => (s === '' ? [] : s.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)));
  const left = parseSide(halves[0]);
  const right = halves.length === 2 ? parseSide(halves[1]) : [];
  if (left.some(Number.isNaN) || right.some(Number.isNaN)) return true;
  let g;
  if (halves.length === 2) {
    const missing = 8 - left.length - right.length;
    if (missing < 0) return true;
    g = [...left, ...Array(missing).fill(0), ...right];
  } else {
    if (left.length !== 8) return true;
    g = left;
  }
  const embeddedV4 = (hi, lo) => ipv4Blocked((hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255);
  if (g.every((x) => x === 0)) return true; // :: unspecified
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1 loopback
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return embeddedV4(g[6], g[7]); // ::ffff:a.b.c.d v4-mapped
  }
  if (g.slice(0, 6).every((x) => x === 0) && !(g[6] === 0 && g[7] <= 1)) {
    return embeddedV4(g[6], g[7]); // ::a.b.c.d v4-compatible (deprecated)
  }
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // 2001:db8::/32 documentation
  if (g[0] === 0x0064 && g[1] === 0xff9b) return embeddedV4(g[6], g[7]); // 64:ff9b::/96 NAT64
  if (g[0] === 0x2002) return embeddedV4(g[1], g[2]); // 2002::/16 6to4
  return false;
}

const BLOCKED_SUFFIXES = [
  '.localhost',
  '.local', // mDNS (original rule)
  '.internal', // original rule
  '.localdomain',
  '.lan',
  '.home',
  '.home.arpa',
  '.corp',
  '.intranet',
  '.private',
];

export function isBlockedHost(host) {
  let h = (host || '').toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1); // trailing root dot: "localhost." == "localhost"
  if (!h) return true;
  if (h === 'localhost' || h === 'localdomain') return true;
  if (BLOCKED_SUFFIXES.some((s) => h.endsWith(s))) return true;
  if (h.includes(':') || (h.startsWith('[') && h.endsWith(']'))) return ipv6Blocked(h);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const p = h.split('.').map(Number);
    return ipv4Blocked(p[0], p[1], p[2], p[3]);
  }
  // Raw numeric spellings (integer / hex / octal / short) — WHATWG URL
  // normally normalises these before we see them; decode anyway so an
  // un-normalised hostname can never slip a private address past.
  if (h.split('.').every((p) => /^(0x[0-9a-f]+|\d+)$/i.test(p))) {
    const quad = decodeNumericIpv4(h);
    if (!quad) return true; // numeric-looking but undecodable: fail closed
    return ipv4Blocked(quad[0], quad[1], quad[2], quad[3]);
  }
  return false;
}

// Validate an outbound URL. Returns the URL object when it is safe to
// fetch, throws SsrfError('blocked') otherwise. Only http/https, no
// embedded credentials, host must not be loopback/private/reserved.
export function assertSafeUrl(input, opts = {}) {
  let u;
  try { u = input instanceof URL ? input : new URL(String(input)); } catch {
    throw new SsrfError('blocked', 'bad url');
  }
  if (opts.requireHttps) {
    if (u.protocol !== 'https:') throw new SsrfError('blocked', 'https required: ' + u.protocol);
  } else if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new SsrfError('blocked', 'protocol not allowed: ' + u.protocol);
  }
  if (u.username || u.password) throw new SsrfError('blocked', 'credentials in url');
  // 端口限制（低2）：只许协议默认端口，显式非标准端口一律拦（opts.allowedPorts 可放宽）
  if (u.port) {
    const allowed = opts.allowedPorts || (u.protocol === 'https:' ? ['443'] : ['80']);
    if (!allowed.map(String).includes(String(u.port))) {
      throw new SsrfError('blocked', 'port not allowed: ' + u.port);
    }
  }
  if (isBlockedHost(u.hostname)) throw new SsrfError('blocked', 'blocked host: ' + u.hostname);
  return u;
}

function combineSignals(signals) {
  const list = signals.filter(Boolean);
  if (!list.length) return undefined;
  if (list.length === 1) return list[0];
  const ctl = new AbortController();
  for (const s of list) {
    if (s.aborted) { ctl.abort(s.reason); break; }
    s.addEventListener('abort', () => ctl.abort(s.reason), { once: true });
  }
  return ctl.signal;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// fetch() with manual, per-hop re-validated redirects.
// - The initial URL and EVERY redirect target go through
//   assertSafeUrl() before any request is made; an unsafe hop aborts
//   the whole chain with SsrfError('blocked').
// - At most maxRedirects hops are followed; beyond that it throws
//   SsrfError('too_many_redirects') carrying the last redirect status.
// - timeoutMs, when given, is a single deadline for the whole chain
//   (matching the previous redirect:'follow' + one-signal behaviour).
// opts.fetchImpl is injectable for local dry-run tests.
export async function safeFetch(input, init = {}, opts = {}) {
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
  const timeoutMs = opts.timeoutMs || 0;
  let url = assertSafeUrl(input, opts);
  let method = String(init.method || 'GET').toUpperCase();
  let body = init.body;
  // 请求头做一份可变副本：跨源重定向时要能剥离 Authorization（高2），不能把 Key 带到别家
  let curHeaders = new Headers(init.headers || {});
  let timer = null;
  let deadline = null;
  if (timeoutMs > 0) {
    deadline = new AbortController();
    timer = setTimeout(() => deadline.abort(new Error('timeout')), timeoutMs);
  }
  const signal = combineSignals([init.signal, deadline ? deadline.signal : null]);
  try {
    for (let hop = 0; ; hop++) {
      const res = await doFetch(url.toString(), { ...init, headers: curHeaders, method, body, redirect: 'manual', signal });
      // 响应体上限（低2）：声明的长度已超限就直接放弃，避免无界读入
      if (opts.maxResponseBytes) {
        const cl = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : 0);
        if (Number.isFinite(cl) && cl > opts.maxResponseBytes) {
          try { if (res.body) await res.body.cancel(); } catch { /* ignore */ }
          throw new SsrfError('too_large', 'response too large: ' + cl);
        }
      }
      const location = res.headers && typeof res.headers.get === 'function' ? res.headers.get('Location') : null;
      if (!REDIRECT_STATUSES.has(res.status) || !location) {
        // 响应体上限补实（复审 S4）：上面的 Content-Length 检查只拦「声明
        // 长度型」响应，chunked 响应没这个头就绕过去了。给最终响应的 body
        // 套一层计数流，读的过程中累计字节、超限即报错断开——调用方用
        // text()/json()/arrayBuffer() 读到一半就会抛 too_large。
        if (opts.maxResponseBytes && res.body && typeof res.body.pipeThrough === 'function') {
          const maxB = opts.maxResponseBytes;
          let seen = 0;
          const cap = new TransformStream({
            transform(chunk, controller) {
              seen += chunk && chunk.byteLength ? chunk.byteLength : 0;
              if (seen > maxB) { controller.error(new SsrfError('too_large', 'response too large (streamed)')); return; }
              controller.enqueue(chunk);
            },
          });
          try {
            return new Response(res.body.pipeThrough(cap), { status: res.status, statusText: res.statusText, headers: res.headers });
          } catch { return res; }
        }
        return res;
      }
      if (hop >= maxRedirects) {
        try { if (res.body) await res.body.cancel(); } catch { /* ignore */ }
        throw new SsrfError('too_many_redirects', 'more than ' + maxRedirects + ' redirects', res.status);
      }
      let next;
      try { next = new URL(location, url); } catch {
        throw new SsrfError('blocked', 'unparseable redirect location');
      }
      assertSafeUrl(next, opts); // re-validate EVERY hop before following it
      // 跨源跳转剥离 Authorization：Key 只发给最初配置的那一家（高2）
      if (opts.stripAuthOnRedirect !== false && next.origin !== url.origin) {
        curHeaders.delete('authorization');
        curHeaders.delete('Authorization');
      }
      try { if (res.body) await res.body.cancel(); } catch { /* ignore */ }
      if (res.status === 303 && method !== 'GET' && method !== 'HEAD') {
        method = 'GET';
        body = undefined;
      }
      url = next;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

