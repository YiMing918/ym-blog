// r2sign.js — R2 的 S3 预签名 URL 签发（浏览器直传，文件字节绝不经过 Worker）
// 做法：用 WebCrypto 手写 SigV4 查询串签名（aws4fetch 同款轻量路线，不引重 SDK）。
// 凭据只从环境变量读：R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_S3_ENDPOINT / R2_S3_BUCKET。
// 注意（官方限制）：预签名 URL 只能用 S3 API 域名，不能用自定义域名签名——上传域名与访问域名分离是正常形态。
// 对象键铁律：不用原始文件名（避中文名/重名/隐私）、不用自增 ID（防枚举），一律 uuid。

const enc = new TextEncoder();
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
async function sha256HexOf(text) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const hexOf = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const uriEnc = (s) => encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export function newObjectKey(kind, ext) {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const uuid = crypto.randomUUID().replace(/-/g, '');
  const prefix = kind === 'image' ? 'img' : kind === 'video' ? 'vid' : 'file';
  return `${prefix}/${yyyy}/${mm}/${uuid}.${ext}`;
}

// mime → {kind, ext} 白名单：扩展名由服务端按 mime 映射，绝不信前端给的后缀
export const MIME_MAP = {
  'image/jpeg': { kind: 'image', ext: 'jpg' },
  'image/png': { kind: 'image', ext: 'png' },
  'image/webp': { kind: 'image', ext: 'webp' },
  'image/gif': { kind: 'image', ext: 'gif' },
  'image/avif': { kind: 'image', ext: 'avif' },
  'video/mp4': { kind: 'video', ext: 'mp4' },
  'video/webm': { kind: 'video', ext: 'webm' },
  'video/quicktime': { kind: 'video', ext: 'mov' },
  'application/pdf': { kind: 'file', ext: 'pdf' },
  'application/zip': { kind: 'file', ext: 'zip' },
  'text/plain': { kind: 'file', ext: 'txt' },
};

// 签发一个 PUT 预签名 URL：签名里锁死 Content-Type，类型不符上传会被 S3 拒绝
export async function presignPut(env, key, contentType, expiresSec = 600) {
  const endpoint = (env.R2_S3_ENDPOINT || '').replace(/\/$/, '');
  const bucket = env.R2_S3_BUCKET;
  const accessKey = env.R2_ACCESS_KEY_ID;
  const secretKey = env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKey || !secretKey) {
    throw new Error('R2 S3 凭据未配置（R2_S3_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY）');
  }
  const region = 'auto';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const url = new URL(`${endpoint}/${bucket}/${key.split('/').map(uriEnc).join('/')}`);
  const params = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKey}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresSec),
    'X-Amz-SignedHeaders': 'content-type;host',
  });
  url.search = params.toString();
  const canonicalHeaders = `content-type:${contentType}\nhost:${url.host}\n`;
  const canonicalRequest = ['PUT', url.pathname, url.searchParams.toString(), canonicalHeaders, 'content-type;host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256HexOf(canonicalRequest)].join('\n');
  const kDate = await hmac('AWS4' + secretKey, dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, 's3');
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = hexOf(await hmac(kSigning, stringToSign));
  url.searchParams.set('X-Amz-Signature', signature);
  return { url: url.toString(), headers: { 'Content-Type': contentType }, expires_in: expiresSec };
}

// 公开访问 URL（走绑在媒体桶上的自定义域名）
export function publicMediaUrl(env, key) {
  const base = (env.MEDIA_PUBLIC_BASE || '').replace(/\/$/, '');
  return base ? `${base}/${key}` : `/${key}`;
}
