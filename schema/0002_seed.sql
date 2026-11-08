-- ym-blog 种子数据 0002：初始设置键 + 关于页占位 + 一篇示例文章 + 一条示例说说
-- 全部为虚构示例内容，不含任何真实个人信息；站长上线后可在后台改掉或删掉。
-- 管理员账号不在这里建：首次访问后台走「初始化站长」流程，或用环境变量 INITIAL_ADMIN_* 注入。

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('site_name',        '"示例博客"', 0),
  ('site_desc',        '"记录折腾与生活的小站。"', 0),
  ('hero_title',       '"你好，欢迎来到示例博客 👋"', 0),
  ('hero_text',        '"这里是首页介绍，在后台「站点设置」里随时可改。"', 0),
  ('accent_color',     '"#e8710a"', 0),
  ('layout_home',      '"cards"', 0),
  ('layout_post_width','"normal"', 0),
  ('dark_mode',        '"auto"', 0),
  ('code_theme',       '"auto"', 0),
  ('search_on',        '1', 0),
  ('comments_on',      '1', 0),
  ('comments_moderation', '1', 0),
  ('comments_link_limit', '2', 0),
  ('rss_on',           '1', 0),
  ('ratelimit_level',  '"normal"', 0),
  ('turnstile_on',     '0', 0),
  ('turnstile_site_key', '""', 0),
  ('friend_circle_on', '0', 0),
  ('og_auto',          '1', 0),
  ('posts_per_page',   '10', 0),
  ('trash_keep_days',  '30', 0),
  ('backup_keep',      '12', 0),
  ('upload_image_max_mb', '20', 0),
  ('upload_video_max_mb', '200', 0),
  ('upload_file_max_mb',  '50', 0),
  ('_ver',             '1', 0);

-- 关于页（page 型文章，后台当普通文章编辑）
INSERT OR IGNORE INTO posts (id, slug, type, title, content_md, rendered_html, excerpt, status, publish_at, word_count, created_at, updated_at)
VALUES (1, 'about', 'page', '关于',
  '## 关于本站' || char(10) || char(10) || '这是一个用 ym-blog 搭的小站。这段文字是占位示例，站长可以在后台把我改成真正的自我介绍。',
  '<h2 id="关于本站">关于本站</h2><p>这是一个用 ym-blog 搭的小站。这段文字是占位示例，站长可以在后台把我改成真正的自我介绍。</p>',
  '这是一个用 ym-blog 搭的小站。', 'published', 1700000000, 42, 1700000000, 1700000000);

-- 示例文章（演示 Markdown 排版用，内容虚构）
INSERT OR IGNORE INTO posts (id, slug, type, title, content_md, rendered_html, excerpt, status, publish_at, word_count, created_at, updated_at)
VALUES (2, 'hello-demo', 'post', '示例文章：这个博客的第一篇',
  '## 欢迎' || char(10) || char(10) || '这是仓库自带的**示例文章**，用来演示标题、列表、代码块和引用长什么样，上线后随手删掉即可。' || char(10) || char(10) || '- 写文章用 Markdown' || char(10) || '- 图片视频从相册直传，不经过服务器中转' || char(10) || '- 发布时自动生成排版好的页面' || char(10) || char(10) || '> 小提示：这一篇在后台的回收站里删掉后，30 天内还能找回来。',
  NULL,
  '仓库自带的示例文章，演示排版用。', 'published', 1700000100, 96, 1700000100, 1700000100);

INSERT OR IGNORE INTO moments (id, content, status, created_at, updated_at)
VALUES (1, '示例说说：小站开张了 🎉', 'published', 1700000200, 1700000200);
