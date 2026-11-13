-- ym-blog 迁移 0005：评论回收站保留期（给 comments 加 trashed_at）
-- 背景：定时清理（purge）此前按评论的 created_at 算保留期，一条很久以前
--   写的评论今天才移进回收站/垃圾箱，明天就会被真删，享受不到设置里的
--   30 天保留期（文章、说说、媒体都已按「进站时间」算，只有评论漏了）。
-- 本迁移：
--   1) 给 comments 加 trashed_at 列（Unix 秒；NULL = 不在回收站/垃圾箱，
--      或进站时间未知）；
--   2) 迁移时已在回收站/垃圾箱的存量行，以迁移时刻起算保留期
--      （trashed_at = 现在），与 0004 对媒体的回填口径一致；
--   3) 代码侧从此在评论状态变为 trash/spam 时写入 trashed_at、恢复
--      approved/pending 时清空；purge 按 trashed_at 清理。生产库还没跑
--      本迁移时，代码会自动退回旧口径（按 created_at），不会报错。
-- 注意：ALTER TABLE ADD COLUMN 不可重复执行——执行前先确认 comments 表
--   还没有 trashed_at 列（PRAGMA table_info(comments);）。
-- 执行（在仓库根目录，任选其一）：
--   npx wrangler d1 execute ym-blog-db --remote --file schema/0005_comment_trash.sql
--   或在 Cloudflare 控制台 D1 → ym-blog-db → Console 里粘贴本文件内容执行。

ALTER TABLE comments ADD COLUMN trashed_at INTEGER;

UPDATE comments SET trashed_at = CAST(strftime('%s', 'now') AS INTEGER)
WHERE status IN ('trash', 'spam') AND trashed_at IS NULL;
