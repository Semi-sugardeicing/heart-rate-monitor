/* ============================================================
   心率接收 · 新手引导（聚光灯 / coach mark）
   整屏压暗，在目标那儿挖个圆角洞 + 蓝色描边呼吸光，
   说明气泡贴在洞的上方或下方。
   点「下一步」或点高亮那块都能往下走。
   ============================================================ */
(function () {
  const DONE_KEY = 'hr-guide-done';

  const STEPS = [
    {
      page: 'waiting', sel: '.btn-row .cta', r: 14, btn: '好',
      title: '先点「开始接收」',
      desc: '传感器要先连上，点这里开始接收心跳。'
    },
    {
      page: 'live', sel: '.topbar', r: 16, btn: '继续',
      title: '这里是连接状态',
      desc: '「<em>已连接</em>」和手机电量都在这。断了会变红，<b>10 秒</b>没心跳就自动断开。'
    },
    {
      page: 'live', sel: '.ecg-wrap', r: 14, btn: '继续',
      title: '这是心电波形',
      desc: '按 <em>25 mm/s</em> 走纸、<em>10 mm/mV</em> 增益，跟医院监护仪一样。'
    },
    {
      page: 'live', sel: '.mini-stats, .charts', r: 14, btn: '知道了',
      title: '这里看统计',
      desc: '这一段的最低心率、平均值、已经收了多久，都在这。'
    }
  ];

  let idx = 0, el = null, busy = false;

  function built() {
    if (el) return el;
    el = document.createElement('div');
    el.className = 'tour';
    el.innerHTML =
      '<div class="tour-mask"></div>' +
      '<div class="tour-spot"></div>' +
      '<div class="tour-tip" role="dialog" aria-live="polite">' +
        '<div class="step"></div>' +
        '<div class="title"></div>' +
        '<div class="desc"></div>' +
        '<div class="acts">' +
          '<button class="tour-skip" type="button">跳过</button>' +
          '<button class="tour-next" type="button">下一步</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.classList.contains('tour-skip')) return finish();
      if (b.classList.contains('tour-next')) return goNext();
    });
    window.addEventListener('resize', () => (el.classList.contains('is-on') ? paint() : 0));
    return el;
  }

  function pageOf() {
    const lv = document.body.dataset.level || '';
    return (lv === 'live' || lv === 'live-land') ? 'live' : (lv === 'connect' ? 'connect' : 'waiting');
  }

  function roundRect(x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    return `M${x + rr} ${y}` +
           `h${w - rr * 2}a${rr} ${rr} 0 0 1 ${rr} ${rr}v${h - rr * 2}` +
           `a${rr} ${rr} 0 0 1 ${-rr} ${rr}h${-(w - rr * 2)}` +
           `a${rr} ${rr} 0 0 1 ${-rr} ${-rr}v${-(h - rr * 2)}` +
           `a${rr} ${rr} 0 0 1 ${rr} ${-rr}z`;
  }

  function paint() {
    const s = STEPS[idx];
    if (!s) return finish();
    const target = document.querySelector(s.sel);
    if (!target) return goNext();

    const r = target.getBoundingClientRect();
    const pad = 8;
    const X = Math.max(0, r.left - pad);
    const Y = Math.max(0, r.top - pad);
    const W = Math.min(window.innerWidth - X, r.width + pad * 2);
    const H = Math.min(window.innerHeight - Y, r.height + pad * 2);
    const R = s.r || 14;
    const vw = window.innerWidth, vh = window.innerHeight;

    const mask = el.querySelector('.tour-mask');
    const spot = el.querySelector('.tour-spot');
    const tip = el.querySelector('.tour-tip');

    mask.style.clipPath =
      `path(evenodd, "M0 0H${vw}V${vh}H0Z ${roundRect(X, Y, W, H, R)}")`;

    spot.style.left = X + 'px';
    spot.style.top = Y + 'px';
    spot.style.width = W + 'px';
    spot.style.height = H + 'px';
    spot.style.borderRadius = R + 'px';

    /* 气泡放哪：先量气泡实际多高，再看上下哪边塞得下，
       哪边都塞不下就留空间大的那边，别硬贴着把内容盖住。 */
    tip.style.top = '-9999px';       // 先挪开量高度
    tip.style.bottom = 'auto';
    const tipH = tip.offsetHeight;
    const belowY = Y + H + 14;
    const belowFits = (belowY + tipH) <= vh - 8;
    /* 高亮块上方的可用空间（气泡底边贴 Y-14） */
    const aboveFits = (Y - 14 - tipH) >= 8;

    if (belowFits) {
      tip.style.top = belowY + 'px';
    } else if (aboveFits) {
      tip.style.top = (Y - 14 - tipH) + 'px';
    } else {
      /* 上下都塞不下：贴着可视区底部，保证气泡完整可见 */
      tip.style.top = Math.max(8, vh - tipH - 8) + 'px';
    }

    tip.querySelector('.step').textContent = `第 ${idx + 1} / ${STEPS.length} 步`;
    tip.querySelector('.title').textContent = s.title;
    tip.querySelector('.desc').innerHTML = s.desc || '';
    const btn = tip.querySelector('.tour-next');
    btn.textContent = s.btn || '下一步';
    btn.classList.toggle('is-done', idx === STEPS.length - 1);

    el.classList.add('is-on');
  }

  function goNext() {
    if (busy) return;
    busy = true;
    setTimeout(() => (busy = false), 460);

    /* 第 0 步「好」= 进接收页，接着讲后面三步 */
    if (idx === 0) {
      finish();
      location.href = 'index.html?tour=1';
      return;
    }

    idx++;
    if (idx >= STEPS.length) return finish();
    const n = STEPS[idx];
    if (n.page !== pageOf()) return finish();
    paint();
  }

  function finish() {
    if (el) el.classList.remove('is-on');
    try { localStorage.setItem(DONE_KEY, '1'); } catch (e) {}
  }

  window.Tour = {
    auto() {
      let done = false;
      try { done = localStorage.getItem(DONE_KEY) === '1'; } catch (e) {}
      const force = new URLSearchParams(location.search).get('tour') === '1';
      if (done && !force) return;
      const pg = pageOf();
      const i = STEPS.findIndex((s) => s.page === pg);
      if (i < 0) return;
      idx = i;
      built();
      setTimeout(paint, 320);
    },
    replay() {
      try { localStorage.removeItem(DONE_KEY); } catch (e) {}
      location.href = 'waiting.html?tour=1';
    },
    reset() { try { localStorage.removeItem(DONE_KEY); } catch (e) {} }
  };
})();
