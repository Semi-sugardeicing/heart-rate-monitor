/* ============================================================
   心率接收 · 页面返回（上一级）
   层级：等待接收(根) → 连接传感器 / 接收 / 设置
                      → 接收(横屏)
   <body data-level="..."> 标明这是哪一级，左上角返回键自己算该回哪
   ============================================================ */
(function () {
  const BACK = {
    'connect':   { to: 'waiting.html', label: '返回等待接收' },
    'settings':  { to: 'waiting.html', label: '返回等待接收' },
    'live':      { to: 'waiting.html', label: '返回等待接收' },
    'live-land': { to: 'index.html',   label: '返回竖屏接收' }
  };
  const lv = document.body.dataset.level;
  const cfg = BACK[lv];
  if (!cfg) return;                       // 根页（等待接收）没有返回键
  document.querySelectorAll('[data-back]').forEach((a) => {
    a.setAttribute('href', cfg.to);
    a.setAttribute('aria-label', cfg.label);
  });
})();
