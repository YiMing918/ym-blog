// beacon.js — 浏览上报：独立小文件，被广告拦截器拦了也不影响正文阅读
(function () {
  var el = document.querySelector('.article[data-post-id]');
  if (!el) return;
  var id = Number(el.getAttribute('data-post-id'));
  if (!id) return;
  var body = JSON.stringify({ post_id: id });
  if (navigator.sendBeacon) {
    navigator.sendBeacon('/api/view', new Blob([body], { type: 'application/json' }));
  } else {
    fetch('/api/view', { method: 'POST', body: body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(function () {});
  }
})();
