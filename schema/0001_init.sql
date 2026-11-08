-- ym-blog 数据库迁移 0001：全部表与索引
-- 对应设计稿《① D1 表结构》。约定：时间存 Unix 秒；布尔用 0/1；不使用 FTS5（整库导出会失败）。
-- 改表须新增编号迁移文件，不要改本文件（已部署的库不会重跑本文件）。

-- 1) 文章：文章/独立页共用，type 区分
CREATE TABLE IF NOT EXISTS posts (
  id             INTEGER PRIMARY KEY,
  slug           TEXT UNIQUE NOT NULL,
  type           TEXT NOT NULL DEFAULT 'post',           -- post 文章 / page 独立页
  title          TEXT NOT NULL,
  content_md     TEXT NOT NULL,                            -- Markdown 源，唯一真相源
  rendered_html  TEXT,                                     -- 发布时预渲染的安全 HTML，读时直出
  excerpt        TEXT,
  cover_media_id INTEGER,
  status         TEXT NOT NULL DEFAULT 'draft',            -- draft/scheduled/published/private/trash
  publish_at     INTEGER,                                  -- 定时发布时间（读时判断是否已到点）
  password_hash  TEXT,                                     -- 文章密码（可选），与登录同哈希格式
  is_sticky      INTEGER NOT NULL DEFAULT 0,
  comment_enabled INTEGER NOT NULL DEFAULT 1,
  word_count     INTEGER NOT NULL DEFAULT 0,
  trashed_at     INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
-- 公开列表主查询：状态过滤 + 置顶 + 发布时间倒序，全程走此索引
CREATE INDEX IF NOT EXISTS idx_posts_public ON posts(status, is_sticky DESC, publish_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_trash  ON posts(status, trashed_at);
CREATE INDEX IF NOT EXISTS idx_posts_type   ON posts(type, status);

-- 2) 修订版本：只存发布/手动保存节点，每篇保留最近 20 版（写入时在代码里收敛）
CREATE TABLE IF NOT EXISTS post_revisions (
  id         INTEGER PRIMARY KEY,
  post_id    INTEGER NOT NULL,
  title      TEXT NOT NULL,
  content_md TEXT NOT NULL,
  note       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rev_post ON post_revisions(post_id, created_at DESC);

-- 3) 服务端自动保存：一人一篇一行滚动覆盖，绝不覆盖已发布正文
CREATE TABLE IF NOT EXISTS autosaves (
  post_id    INTEGER PRIMARY KEY,
  title      TEXT,
  content_md TEXT,
  updated_at INTEGER NOT NULL
);

-- 4) 标签
CREATE TABLE IF NOT EXISTS tags (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS post_tags (
  post_id INTEGER NOT NULL,
  tag_id  INTEGER NOT NULL,
  PRIMARY KEY (post_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_pt_tag ON post_tags(tag_id, post_id);

-- 5) 说说（短动态）
CREATE TABLE IF NOT EXISTS moments (
  id         INTEGER PRIMARY KEY,
  content    TEXT NOT NULL,
  media_id   INTEGER,
  status     TEXT NOT NULL DEFAULT 'published',            -- published/draft/trash
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moments_time ON moments(status, created_at DESC);

-- 6) 本体评论：原文入库，渲染时统一转义净化，永不信任入库内容
CREATE TABLE IF NOT EXISTS comments (
  id          INTEGER PRIMARY KEY,
  post_id     INTEGER NOT NULL,
  parent_id   INTEGER NOT NULL DEFAULT 0,                  -- 0=顶层，只做一层回复
  author_name TEXT NOT NULL,
  author_hash TEXT,                                        -- 联系方式只存哈希，不明文落库
  content     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',             -- pending/approved/spam/trash
  is_admin    INTEGER NOT NULL DEFAULT 0,                  -- 站长回复标记
  ip_hash     TEXT,                                        -- IP 只存哈希
  ua          TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cmt_post  ON comments(post_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_cmt_queue ON comments(status, created_at);
CREATE INDEX IF NOT EXISTS idx_cmt_ip    ON comments(ip_hash, created_at);

-- 7) 媒体库：对象键与展示名解耦；原文件名仅记录，不作存储路径
CREATE TABLE IF NOT EXISTS media (
  id            INTEGER PRIMARY KEY,
  r2_key        TEXT UNIQUE NOT NULL,
  kind          TEXT NOT NULL,                             -- image/video/file
  display_name  TEXT,
  orig_name     TEXT,
  mime          TEXT,
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  width         INTEGER,
  height        INTEGER,
  duration_sec  INTEGER,
  album         TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',           -- pending/ready/trashed
  ref_count     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_list  ON media(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_album ON media(album, status);

-- 8) 站点设置：键值表，value 存 JSON 文本；键以 _ 开头为内部状态（如设置版本号、改密窗口）
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER NOT NULL
);

-- 9) 账号与会话
CREATE TABLE IF NOT EXISTS admin_users (
  id                  INTEGER PRIMARY KEY,
  username            TEXT UNIQUE NOT NULL,
  password_hash       TEXT NOT NULL,                       -- 格式 scrypt$N$r$p$salt$hash，见 _lib/hash.js
  role                TEXT NOT NULL DEFAULT 'owner',       -- 预留 contributor，本期不启用投稿者界面
  password_updated_at INTEGER,
  created_at          INTEGER NOT NULL
);
-- 会话只存令牌的 SHA-256，库泄露不等于会话被盗
CREATE TABLE IF NOT EXISTS sessions (
  id           INTEGER PRIMARY KEY,
  token_hash   TEXT UNIQUE NOT NULL,
  user_id      INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,                           -- 绝对过期（30 天）
  last_seen_at INTEGER,
  ip_hash      TEXT,
  ua           TEXT
);
CREATE INDEX IF NOT EXISTS idx_sess_token ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sess_user  ON sessions(user_id);
-- 一次性恢复码：一组 10 个，只存哈希，生成时明文只显示一次
CREATE TABLE IF NOT EXISTS recovery_codes (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  code_hash  TEXT NOT NULL,
  used_at    INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rc_user ON recovery_codes(user_id, used_at);
-- Passkey 预留位：本期只建表不启用
CREATE TABLE IF NOT EXISTS passkey_credentials (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL,
  credential_id TEXT UNIQUE NOT NULL,
  public_key    TEXT NOT NULL,
  counter       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);

-- 10) 友链与探活（探活结果只回写当前状态，不建历史表）
CREATE TABLE IF NOT EXISTS friend_links (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  url             TEXT NOT NULL,
  rss_url         TEXT,
  avatar_url      TEXT,
  desc            TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  enabled         INTEGER NOT NULL DEFAULT 1,
  health          TEXT NOT NULL DEFAULT 'unknown',         -- ok/fail/unknown
  fail_streak     INTEGER NOT NULL DEFAULT 0,
  last_checked_at INTEGER,
  created_at      INTEGER NOT NULL
);
-- 朋友圈缓存（默认关，开启时才写数据）
CREATE TABLE IF NOT EXISTS friend_posts (
  id         INTEGER PRIMARY KEY,
  link_id    INTEGER NOT NULL,
  title      TEXT NOT NULL,
  post_url   TEXT NOT NULL,
  posted_at  INTEGER,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fp_time ON friend_posts(posted_at DESC);

-- 11) 浏览计数：按天聚合，一篇文章一天最多占一行写，防烧 D1 写额度
CREATE TABLE IF NOT EXISTS view_stats (
  post_id INTEGER NOT NULL,
  day     TEXT NOT NULL,                                   -- YYYY-MM-DD（北京时间）
  pv      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (post_id, day)
);
CREATE INDEX IF NOT EXISTS idx_vs_day  ON view_stats(day);
CREATE INDEX IF NOT EXISTS idx_vs_post ON view_stats(post_id, day);

-- 12) 限流与登录保护
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket       TEXT NOT NULL,                              -- 如 cmt:<ip_hash> / login:<ip_hash>
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
-- 登录锁定要跨窗口累计，单独一张小表
CREATE TABLE IF NOT EXISTS login_guards (
  username     TEXT PRIMARY KEY,
  fail_streak  INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0
);

-- 13) 草稿预览令牌：只存哈希，可撤销可过期
CREATE TABLE IF NOT EXISTS preview_tokens (
  id         INTEGER PRIMARY KEY,
  post_id    INTEGER NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pt_post ON preview_tokens(post_id);

-- 14) 备份登记（备份包本体在备份桶里）
CREATE TABLE IF NOT EXISTS backups (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,                               -- auto-weekly/manual/export
  r2_key      TEXT,
  size_bytes  INTEGER,
  post_count  INTEGER,
  media_count INTEGER,
  note        TEXT,                                        -- 对账结果写这里
  created_at  INTEGER NOT NULL
);

-- 15) 改链兜底：改 slug 时登记旧链，访问时 301 跳转
CREATE TABLE IF NOT EXISTS redirects (
  old_slug   TEXT PRIMARY KEY,
  post_id    INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
