// site.js — 访客侧增强脚本：阅读进度、深浅色切换、代码复制、简易灯箱、评论与解锁表单
// 原则：全部是「增强」，禁用 JS 时正文照常可读。灯箱为内置简易版（零依赖），
// 若要更完整的手势体验可换 PhotoSwipe（免费），替换点就在本文件的灯箱一节。
(function () {
  'use strict';

  // 阅读进度条
  var bar = document.getElementById('progress');
  if (bar) {
    var onScroll = function () {
      var h = document.documentElement;
      var max = h.scrollHeight - h.clientHeight;
      bar.style.width = (max > 0 ? (h.scrollTop / max) * 100 : 0) + '%';
    };
    document.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // 深浅色：站点默认（data-theme）之上，访客可用按钮循环 auto→light→dark，存 localStorage
  var root = document.documentElement;
  var saved = null;
  try { saved = localStorage.getItem('ym-blog-theme'); } catch (e) {}
  if (saved) root.setAttribute('data-theme', saved);
  var toggle = document.getElementById('themeToggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var order = ['auto', 'light', 'dark'];
      var cur = root.getAttribute('data-theme') || 'auto';
      var next = order[(order.indexOf(cur) + 1) % order.length];
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('ym-blog-theme', next); } catch (e) {}
    });
  }

  // 代码块复制按钮
  document.querySelectorAll('.codeblock .copy-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var code = btn.parentElement.querySelector('code');
      if (!code || !navigator.clipboard) return;
      navigator.clipboard.writeText(code.innerText).then(function () {
        btn.textContent = '已复制 ✓';
        setTimeout(function () { btn.textContent = '复制'; }, 1500);
      });
    });
  });

  // 简易灯箱：点正文图片看大图，支持上一张/下一张、Esc 关闭、左右滑动
  var imgs = Array.prototype.slice.call(document.querySelectorAll('.article-body img'));
  if (imgs.length) {
    var lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.innerHTML = '<button class="lb-close" aria-label="关闭">×</button><button class="lb-prev" aria-label="上一张">‹</button><img alt=""><button class="lb-next" aria-label="下一张">›</button><p class="lb-count"></p>';
    document.body.appendChild(lb);
    var lbImg = lb.querySelector('img');
    var lbCount = lb.querySelector('.lb-count');
    var idx = 0;
    var show = function (i) {
      idx = (i + imgs.length) % imgs.length;
      lbImg.src = imgs[idx].currentSrc || imgs[idx].src;
      lbImg.alt = imgs[idx].alt || '';
      lbCount.textContent = (idx + 1) + ' / ' + imgs.length;
      lb.classList.toggle('single', imgs.length <= 1);
    };
    imgs.forEach(function (im, i) {
      im.style.cursor = 'zoom-in';
      im.addEventListener('click', function () { show(i); lb.classList.add('open'); document.body.style.overflow = 'hidden'; });
    });
    var close = function () { lb.classList.remove('open'); document.body.style.overflow = ''; };
    lb.querySelector('.lb-close').addEventListener('click', close);
    lb.querySelector('.lb-prev').addEventListener('click', function () { show(idx - 1); });
    lb.querySelector('.lb-next').addEventListener('click', function () { show(idx + 1); });
    lb.addEventListener('click', function (e) { if (e.target === lb) close(); });
    document.addEventListener('keydown', function (e) {
      if (!lb.classList.contains('open')) return;
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft') show(idx - 1);
      if (e.key === 'ArrowRight') show(idx + 1);
    });
    var touchX = null;
    lb.addEventListener('touchstart', function (e) { touchX = e.touches[0].clientX; }, { passive: true });
    lb.addEventListener('touchend', function (e) {
      if (touchX === null) return;
      var dx = e.changedTouches[0].clientX - touchX;
      if (Math.abs(dx) > 40 && imgs.length > 1) show(idx + (dx < 0 ? 1 : -1));
      touchX = null;
    }, { passive: true });
  }

  function wireForm(formId, msgId, url, buildBody, after) {
    var form = document.getElementById(formId);
    if (!form) return;
    var msg = document.getElementById(msgId);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var fd = new FormData(form);
      var payload = buildBody(fd, form);
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
        body: JSON.stringify(payload),
      }).then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); })
        .then(function (res) {
          if (res.j && res.j.ok) { if (after) after(res.j.data); }
          else if (msg) msg.textContent = (res.j && res.j.error && res.j.error.message) || '提交失败，请稍后再试';
        })
        .catch(function () { if (msg) msg.textContent = '网络异常，请稍后再试'; });
    });
  }

  // 评论提交
  wireForm('commentForm', 'commentMsg', '/api/comments', function (fd, form) {
    var ts = form.querySelector('input[name="cf-turnstile-response"]');
    return {
      post_id: Number(form.getAttribute('data-post-id')),
      parent_id: Number(fd.get('parent_id') || 0),
      author_name: fd.get('author_name'),
      contact: fd.get('contact'),
      content: fd.get('content'),
      turnstile_token: ts ? ts.value : undefined,
    };
  }, function (data) {
    var msg = document.getElementById('commentMsg');
    if (msg) msg.textContent = data.message || '已提交';
    if (data.status === 'approved') setTimeout(function () { location.reload(); }, 600);
  });

  // 评论回复按钮：把 parent_id 指过去并滚到表单
  document.querySelectorAll('.reply-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var form = document.getElementById('commentForm');
      if (!form) return;
      form.querySelector('input[name="parent_id"]').value = btn.getAttribute('data-reply');
      form.querySelector('textarea').focus();
      form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });

  // 文章解锁在文件末尾单独处理（要按文章 id 拼 URL）
})();

// 文章解锁单独处理（需要按文章 id 拼 URL，成功后整页刷新）
(function () {
  var form = document.getElementById('unlockForm');
  if (!form) return;
  var msg = document.getElementById('unlockMsg');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var id = form.getAttribute('data-post-id');
    var fd = new FormData(form);
    fetch('/api/post/' + id + '/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify({ password: fd.get('password') }),
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.ok) location.reload();
      else if (msg) msg.textContent = (j.error && j.error.message) || '密码错误';
    }).catch(function () { if (msg) msg.textContent = '网络异常，请稍后再试'; });
  });
})();
