-- ym-blog 迁移 0003：中文全文搜索（FTS5 + trigram 分词）
-- 借鉴 EdgeBlog 的做法：trigram 分词器把文本切成 3 字片段，中文任意子串都能命中，
-- 不再靠 LIKE 全表扫；量级再大一个数量级也稳。
-- 设计要点：
--   1) 外部内容表（content='posts'）：正文只存一份在 posts 里，FTS 只存倒排索引。
--   2) 同步靠触发器：posts 增/删/改自动维护索引，写路径零改动。
--   3) 这张表是「可重建的索引数据」：不进按表 JSON 备份（backup.js 的导出清单本就不含它），
--      整站恢复后重跑本文件的最后一条 rebuild 即可重建。
--   4) 搜索代码对本表缺失有 LIKE 兜底：迁移没跑也不会 500，只是退回旧搜索。
-- 执行方式：D1 控制台粘贴全文执行一次，或 wrangler d1 execute --file。

CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
  title,
  content_md,
  content='posts',
  content_rowid='id',
  tokenize='trigram'
);

-- 同步触发器（外部内容表的标准写法：删旧行要用 'delete' 指令带旧值）
CREATE TRIGGER IF NOT EXISTS posts_fts_ai AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts (rowid, title, content_md) VALUES (new.id, new.title, new.content_md);
END;

CREATE TRIGGER IF NOT EXISTS posts_fts_ad AFTER DELETE ON posts BEGIN
  INSERT INTO posts_fts (posts_fts, rowid, title, content_md) VALUES ('delete', old.id, old.title, old.content_md);
END;

CREATE TRIGGER IF NOT EXISTS posts_fts_au AFTER UPDATE OF title, content_md ON posts BEGIN
  INSERT INTO posts_fts (posts_fts, rowid, title, content_md) VALUES ('delete', old.id, old.title, old.content_md);
  INSERT INTO posts_fts (rowid, title, content_md) VALUES (new.id, new.title, new.content_md);
END;

-- 首次建表后把存量文章灌进索引（重复执行也安全：rebuild 会按 posts 现状重建）
INSERT INTO posts_fts (posts_fts) VALUES ('rebuild');
