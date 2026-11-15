/* ============================================================
   心率接收 · 崩溃转储
   任何页面只要加载了这个文件，JS 报错都会被记进 work 日志。
   配合开发者选项里的「工作日志」查看。
   ============================================================ */
(function () {
  if (window.__crashHook) return;
  window.__crashHook = true;

  var KEY = 'heart.logs';
  var MAX = 1000;  // 最多留 1000 条

  function push(msg) {
    try {
      var list = JSON.parse(localStorage.getItem(KEY) || '[]');
      list.push({ t: Date.now(), msg: String(msg), level: 'err' });
      if (list.length > MAX) list = list.slice(-MAX);
      localStorage.setItem(KEY, JSON.stringify(list));
    } catch (e) {}
  }

  /* 脚本里的同步报错 */
  window.addEventListener('error', function (ev) {
    var tgt = ev.target || {};
    /* 资源加载失败（图片/脚本） */
    if (tgt && tgt.tagName && !ev.message) {
      push('资源加载失败：' + tgt.tagName + ' ' + (tgt.src || tgt.href || ''));
      return;
    }
    var where = (ev.filename || '').split('/').pop() + ':' + (ev.lineno || 0) +
                (ev.colno ? ':' + ev.colno : '');
    push('JS 报错 [' + where + '] ' + (ev.message || '未知错误'));
  }, true);

  /* Promise 里没接住的报错 */
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev.reason;
    var msg = (r && (r.message || r.stack)) || String(r);
    push('未处理的 Promise 异常：' + msg);
  });

  /* 记一条启动标记，方便对照是哪个页面出的问题 */
  var page = (location.pathname.split('/').pop() || 'index.html');
  push('页面加载：' + page);
})();
