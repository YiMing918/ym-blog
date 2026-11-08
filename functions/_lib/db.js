// db.js — D1 访问封装
// 铁律：只许参数化查询（prepare + bind），禁止把用户输入拼进 SQL 字符串——防注入全靠这一条。
// 另外顺手记录最近一次查询的 rows_read / rows_written，供后台「今日额度自检」展示。

let lastMeta = { rows_read: 0, rows_written: 0 };
export function getLastMeta() { return lastMeta; }
function track(meta) {
  if (!meta) return;
  lastMeta = {
    rows_read: meta.rows_read ?? lastMeta.rows_read,
    rows_written: meta.rows_written ?? lastMeta.rows_written,
  };
}

export async function run(env, sql, ...params) {
  const r = await env.DB.prepare(sql).bind(...params).run();
  track(r.meta);
  return r;
}
export async function first(env, sql, ...params) {
  const row = await env.DB.prepare(sql).bind(...params).first();
  return row ?? null;
}
export async function all(env, sql, ...params) {
  const r = await env.DB.prepare(sql).bind(...params).all();
  track(r.meta);
  return r.results || [];
}
// 批量执行（导入/备份登记等多语句场景）
export async function batch(env, statements) {
  const prepared = statements.map(([sql, params]) => env.DB.prepare(sql).bind(...(params || [])));
  return env.DB.batch(prepared);
}
