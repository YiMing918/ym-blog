-- ym-blog 迁移 0004：媒体回收站保留期（给 media 加 trashed_at）
-- 背景：README 承诺「媒体删错先进回收站，30 天后清理任务才真删存储对象」，但 media 表
-- 此前没有记录进回收站时间的列，purge 对 trashed 媒体无时间条件、次日即真删
-- （文章表 posts 早就有 trashed_at，一直按保留期执行，媒体是漏网的一处）。
-- 本迁移做三件事：
--   1) 给 media 加 trashed_at 列（Unix 秒；NULL = 不在回收站，或进站时间未知）；
--      代码口径：移入回收站时落时间戳、还原时清空，purge 只真删已到期者。
--   2) 迁移时已在回收站的存量行，以迁移时刻起算保留期（trashed_at = 现在）：
--      真实进站时间无从考证，按最宽容口径让它们再享完整保留期，绝不追溯速删。
--   3) 加索引，让 purge 的到期扫描走索引而不是全表扫。
-- 执行方式：D1 控制台粘贴全文执行一次，或 wrangler d1 execute --file。
-- 注意：ALTER TABLE ADD COLUMN 不可重复执行——执行前先确认 media 表还没有 trashed_at 列
-- （控制台跑 PRAGMA table_info(media); 核对），已执行过就不要再跑。

ALTER TABLE media ADD COLUMN trashed_at INTEGER;

UPDATE media SET trashed_at = CAST(strftime('%s', 'now') AS INTEGER)
WHERE status = 'trashed' AND trashed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_media_trash ON media(status, trashed_at);
