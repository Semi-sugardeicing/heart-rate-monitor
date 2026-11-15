/* ============================================================
   心率接收 · 原生接蓝牙（APK 版）
   设计台网页里没有 HeartNative，这里什么都不做，还是走模拟。
   ============================================================ */
(function () {
  const N = window.Native;
  const isNative = !!(N && N.isNative);

  /* 网页里（设计台）没有原生蓝牙，但如果开发者模式开了假传感器，
     也要能显示出来，方便在设计台测界面。其余原生逻辑照旧跳过。 */
  if (!isNative) {
    document.addEventListener('DOMContentLoaded', function () {
      let fakeOn = false;
      try { fakeOn = localStorage.getItem('heart.fakesensor') === '1'; } catch (e) {}
      if (!fakeOn) return;
      const list = document.querySelector('.device-list');
      if (!list) return;
      list.innerHTML = '<button class="device is-near" data-fake="1" type="button">' +
        '<div class="avatar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
        'stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="12" height="16" rx="3"/>' +
        '<path d="M9 4V2h6v2"/><path d="M12 11v3"/></svg></div>' +
        '<div class="body"><div class="name">假传感器（测试用）</div>' +
        '<div class="meta"><span>心率广播</span><i class="sep"></i><span>-50 dBm</span></div></div>' +
        '<div class="go"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg></div>' +
        '</button>';
      const b = list.querySelector('[data-fake]');
      if (b) b.addEventListener('click', function () {
        try { localStorage.setItem('heart.fake', '1'); } catch (e) {}
        location.href = 'index.html';
      });
    });
    return;
  }

  /* 页面换了就重新挂一遍 */
  document.addEventListener('DOMContentLoaded', boot);

  function boot() {
    const lv = document.body.dataset.level || '';

    /* ---------- 连接传感器页：真扫描（只有这一页有设备列表） ---------- */
    if (document.body.querySelector('.device-list')) {
      hookConnectPage();
    }

    /* ---------- 接收页：真心跳 + 断线 ---------- */
    if (lv === 'live' || lv === 'live-land') {
      hookLivePage();
    }
  }

  /* ===================== 连接传感器 ===================== */
  function hookConnectPage() {
    const N2 = window.Native;

    /* 权限没了先要 */
    if (!N2.hasBlePermission()) N2.requestBlePermission();
    if (!N2.isBluetoothOn()) {
      const st = document.querySelector('.ble-state .t2');
      if (st) st.textContent = '蓝牙没开，先去手机设置里打开';
    }

    /* 用真实列表替换演示列表 */
    const list = document.querySelector('.device-list');
    if (!list) return;

    let devices = [];

    /* 开发者模式里开了「假传感器」：列表里固定插一台，方便没手表时测界面。
       只插一台，不动真实扫描结果。 */
    let fakeOn = false;
    try { fakeOn = localStorage.getItem('heart.fakesensor') === '1'; } catch (e) {}

    function render() {
      if (!devices.length && !fakeOn) {
        list.innerHTML = '<div class="empty-scan">' +
          '<div class="t">正在搜索附近的心率设备…</div>' +
          '<div class="d">手表要开着「心率广播」，手机离它近一点</div></div>';
        return;
      }
      const shown = fakeOn
        ? devices.concat([{ name: '假传感器（测试用）', rssi: -50, hasHeart: true, id: '__fake__' }])
        : devices;
      list.innerHTML = shown.map((d, i) => {
        const has = d.hasHeart;
        const bars = Math.max(1, Math.min(4, Math.round((d.rssi + 100) / 12)));
        const sig = [4, 7, 10, 13].map((h, k) =>
          `<i class="${k < bars ? 'on' : ''}" style="height:${h}px"></i>`).join('');
        return `<button class="device${has ? ' is-near' : ''}" data-idx="${i}" type="button">
          <div class="avatar">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="6" y="4" width="12" height="16" rx="3"/><path d="M9 4V2h6v2"/><path d="M12 11v3"/>
            </svg>
          </div>
          <div class="body">
            <div class="name">${esc(d.name)}</div>
            <div class="meta">
              <span>${has ? '心率广播' : '没有心率服务'}</span>
              <i class="sep"></i>
              <span>${d.rssi} dBm</span>
            </div>
          </div>
          <div class="signal" aria-hidden="true">${sig}</div>
          <div class="go">${has ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>' : ''}</div>
        </button>`;
      }).join('');

      list.querySelectorAll('.device').forEach((b) => {
        b.addEventListener('click', () => {
          const d = shown[+b.dataset.idx];
          if (!d) return;
          /* 假传感器：不连蓝牙，打标记直接进接收页，由页面自己产生模拟心跳 */
          if (d.id === '__fake__') {
            try { localStorage.setItem('heart.fake', '1'); } catch (e) {}
            log('使用假传感器进入接收页', 'warn');
            location.href = 'index.html';
            return;
          }
          if (!d.hasHeart) {
            // 没有心率服务的，也给个机会，万一广播包里没带呢
            const t = b.querySelector('.meta span');
            if (t) t.textContent = '试连接…';
          }
          N2.connect(d.id);
          const st = document.querySelector('.ble-state .t2');
          if (st) st.textContent = '正在连接 ' + d.name + '…';
          b.querySelector('.name').textContent = '连接中…';
        });
      });
    }
N2.on('onDevices', (o) => {
      if (!o || !o.list) return;
      const before = devices.length;
      devices = o.list;
      if (devices.length !== before) {
        log('发现设备 ' + devices.length + ' 台：' +
            devices.map((d) => (d.name || '无名') + (d.hasHeart ? '(有心率)' : '')).join('、'),
            devices.some((d) => d.hasHeart) ? 'ok' : '');
      }
      render();
    });
    N2.on('onScanState', (o) => {
      if (o && typeof o.scanning === 'boolean') {
        log(o.scanning ? '开始扫描' : '扫描结束', 'info');
      }
      const pill = document.querySelector('.ble-state .pill');
      if (pill) pill.innerHTML = o.scanning
        ? '<i class="dot"></i>扫描中'
        : '<i class="dot"></i>已停';
      if (o.scanning) {
        const st = document.querySelector('.ble-state .t2');
        if (st) st.textContent = '正在搜索…';
      }
    });
    N2.on('onBleError', (o) => {
      log('蓝牙错误：' + ((o && o.msg) || '未知'), 'err');
      const st = document.querySelector('.ble-state .t2');
      if (st) st.textContent = (o && o.msg) || '蓝牙出问题了';
    });
    N2.on('onConnectState', (o) => {
      if (!o) return;
      if (o.state === 'connecting') {
        log('正在连接 ' + (o.name || ''), 'info');
        return;
      }
      if (o.state === 'connected') {
        log('连接成功：' + (o.name || ''), 'ok');
        location.href = 'index.html';
      } else if (o.state === 'disconnected') {
        log('连接断开' + (o.reason ? '（' + o.reason + '）' : ''), 'warn');
        const st = document.querySelector('.ble-state .t2');
        if (st) st.textContent = '没连上，再试一次';
        N2.startScan();
      }
    });

    /* 进来就开始扫，按「刷新」也重扫 */
    log('打开连接页，开始扫描', 'info');
    N2.startScan();
    list.innerHTML = '<div class="empty-scan"><div class="t">正在搜索附近的心率设备…</div><div class="d">手表要开着「心率广播」</div></div>';

    const refresh = document.querySelector('.scan-row .r');
    if (refresh) {
      refresh.style.cursor = 'pointer';
      refresh.addEventListener('click', () => { N2.startScan(); });
    }
  }

  /* ===================== 接收页 ===================== */
  function hookLivePage() {
    const N2 = window.Native;

    /* 真心跳：给页面的假数据脚本一个开关 */
    window.__hrReal = { bpm: 0, at: 0, lastAt: 0 };
    let lastHrLog = 0;
    N2.on('onHeart', (o) => {
      if (!o || !o.bpm) return;
      /* 心率每 30 秒记一条，不刷爆日志；异常值立刻记 */
      const now = Date.now();
      if (now - lastHrLog > 30000 || o.bpm < 45 || o.bpm > 160) {
        lastHrLog = now;
        log('心率 ' + o.bpm + ' bpm' + (o.rr ? '（带 RR 间期）' : ''), '');
      }
      window.__hrReal.bpm = o.bpm;
      window.__hrReal.at = o.t || Date.now();
      window.__hrReal.lastAt = performance.now();
      if (window.HRRec) window.HRRec.push(o.bpm, o.t || Date.now());
    });

    /* 连上后顶栏状态 */
    const pill = document.querySelector('.topbar .pill.is-live');
    if (pill) pill.innerHTML = '<i class="dot"></i>已连接';

    N2.on('onBattery', (o) => {
      if (!o) return;
      log('手表电量 ' + o.pct + '%', '');
      const p = document.querySelectorAll('.topbar .pill');
      if (p.length > 1) p[1].innerHTML = p[1].innerHTML.replace(/\d+%/, o.pct + '%');
    });

    /* 电池不在时就先藏电量
    N2.on('onConnectState', (o) => {
      if (o && o.state === 'disconnected') {
        const go = document.querySelector('.back-btn');
        if (window.HRFinish) window.HRFinish('lost');
      }
    });*/

    /* 页面后退/返回 */
    window.__onBack = function () {
      const back = document.querySelector('.back-btn');
      if (back) { back.click(); return true; }
      return false;
    };
  }

  function log(msg, level) {
    if (window.HRLog) window.HRLog(msg, level);
  }

  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
})();
