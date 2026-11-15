/* ============================================================
   心率接收 · 收尾流程 + 保存报告图
   - 停止接收 → 页面上浮出保存提示
   - 断线 10 秒 → 震动 → 弹框问要不要保存 → 回等待页
   - 保存：把这一段的波形画成一张长图，存到相册
   （真 APK 里存相册用系统接口；网页里是下载一张 PNG）
   ============================================================ */
(function () {
  const OFFLINE_SEC = 10;          // 多久没心跳算断开
  const MM_PER_SEC = 25;           // 走纸速度 25 mm/s，跟界面标注一致

  const el = (id) => document.getElementById(id);
  const sheet = el('sheet'), toast = el('toast');
  if (!sheet) return;

  /* 这一段接收的数据（演示用：由主脚本实时写进来） */
  const rec = window.HRRec = {
    start: Date.now(),
    beats: [],                     // 每次心跳的时间戳
    min: 999, max: 0, sum: 0, n: 0,
    push(bpm, at) {
      this.beats.push({ t: at || Date.now(), bpm });
      this.min = Math.min(this.min, bpm);
      this.max = Math.max(this.max, bpm);
      this.sum += bpm; this.n++;
    },
    minutes() {
      if (this.n) return (this.beats[this.beats.length - 1].t - this.start) / 60000;
      return 0;
    },
    avg() { return this.n ? Math.round(this.sum / this.n) : 0; }
  };

  let finished = false;

  /* ---------- 弹层 ---------- */
  function showSheet(kind) {
    const min = Math.round(rec.minutes());
    const avg = rec.avg() || 78;
    el('sheetTitle').textContent = kind === 'lost' ? '信号中断' : '接收已停止';
    el('sheetDesc').textContent = kind === 'lost'
      ? `${OFFLINE_SEC} 秒没收到心跳，已断开。这次接了 ${min} 分钟。`
      : `这次接了 ${min} 分钟。要保存一张记录图吗？`;
    el('shAvg').textContent = avg;
    el('shMin').textContent = rec.n ? rec.min : '--';
    el('shMax').textContent = rec.n ? rec.max : '--';
    sheet.dataset.kind = kind;
    sheet.classList.add('is-on');
  }
  function hideSheet() { sheet.classList.remove('is-on'); }

  function showToast(msg, ms) {
    toast.textContent = msg;
    toast.classList.add('is-on');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('is-on'), ms || 2200);
  }

  /* ---------- 震动 ---------- */
  function buzz() {
    try { if (navigator.vibrate) navigator.vibrate([240, 120, 240, 120, 240]); } catch (e) {}
  }

  /* ---------- 生成报告图 ---------- */
  function drawReport() {
    const W = 1080;                       // 图宽
    const H = 1250;                       // 图高（竖版长图，相册里好看）
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');

    const BG = '#F2F3F5', CARD = '#FFFFFF', TEXT = '#121417', MUTED = '#5C6270',
          LINE = '#D9DCE1', GRID = '#E9ECF0', ECG = '#14151A';

    g.fillStyle = BG; g.fillRect(0, 0, W, H);

    /* 顶部时间 */
    const d = new Date(rec.start);
    const pad = (n) => String(n).padStart(2, '0');
    const when = `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    g.fillStyle = TEXT;
    g.font = '700 44px "PingFang SC","Microsoft YaHei",sans-serif';
    g.fillText(when, 64, 120);

    /* 平均心率 + 参数行 */
    const avg = rec.avg() || 78;
    g.font = '700 38px "PingFang SC","Microsoft YaHei",sans-serif';
    g.fillStyle = TEXT;
    g.fillText(`平均心率：${avg} 次/分`, 64, 208);
    g.font = '500 26px "PingFang SC","Microsoft YaHei",sans-serif';
    g.fillStyle = MUTED;
    const secs = Math.max(1, Math.round(rec.n ? rec.minutes() * 60 : 30));
    g.fillText(`时长：${secs}s    增益：10mm/mV    走速：25mm/s`, 64, 256);

    /* 卡片 */
    const CX = 48, CY = 300, CW = W - 96, CH = 720;
    g.fillStyle = CARD;
    roundRect(g, CX, CY, CW, CH, 28); g.fill();

    /* 网格：1 mm 细格 / 5 mm 粗格，25 mm/s → 1 mm = 0.04s */
    const mm = CW / 200;                 // 一张图铺 200 mm = 8 秒
    const pxPerSec = mm * MM_PER_SEC;
    g.lineWidth = 1;
    for (let i = 0; i * mm <= CW; i++) {
      const x = CX + i * mm;
      g.strokeStyle = i % 5 === 0 ? '#E2E5EA' : GRID;
      g.beginPath(); g.moveTo(x, CY + 30); g.lineTo(x, CY + CH - 30); g.stroke();
    }
    for (let y = CY + 30; y <= CY + CH - 30; y += mm) {
      const idx = Math.round((y - (CY + 30)) / mm);
      g.strokeStyle = idx % 5 === 0 ? '#E2E5EA' : GRID;
      g.beginPath(); g.moveTo(CX, y); g.lineTo(CX + CW, y); g.stroke();
    }

    /* 波形：每一次心跳画一个完整的心电复合波（P-QRS-T），
       横轴按 25mm/s 摆；一次复合波占 0.24 秒宽 */
    const baseY = CY + CH * 0.52, amp = CH * 0.30;
    const beats = rec.beats.length
      ? rec.beats
      : Array.from({ length: 9 }, (_, i) => ({ t: rec.start + i * 800, bpm: 78 }));
    const t0 = rec.start;
    // 横轴按真实秒数铺开：一屏最多 8 秒（25mm/s × 200mm）
    const maxSec = 8;
    const lastBeat = beats.length ? beats[beats.length - 1].t : t0;
    const span = Math.max(1, Math.min(maxSec, (lastBeat - t0) / 1000));
    const pxPerSecOnImage = (CW - 40) / span;        // 实际用的像素/秒
    const CYCLE_S = 0.24;                 // 一次复合波占多少秒（P-QRS-T 全长）
    g.strokeStyle = ECG; g.lineWidth = 3.2; g.lineJoin = 'round'; g.lineCap = 'round';
    g.beginPath();
    let started = false;
    for (const b of beats) {
      const bx = CX + 20 + ((b.t - t0) / 1000) * pxPerSecOnImage;
      const bw = CYCLE_S * pxPerSecOnImage;
      if (bx > CX + CW - 20) break;
      if (!started) { g.moveTo(bx, baseY); started = true; }
      else { g.lineTo(bx, baseY); }
      const N = 72;
      for (let i = 1; i <= N; i++) {
        const u = i / N;
        const x = bx + u * bw;
        if (x > CX + CW - 20) break;
        g.lineTo(x, baseY + wf(u) * amp);
      }
      // 这次复合波收尾回基线
      g.lineTo(Math.min(CX + CW - 20, bx + bw), baseY);
    }
    if (started) g.lineTo(Math.min(CX + CW - 20, CX + 20 + span * pxPerSecOnImage), baseY);
    g.stroke();

    /* 底部时间刻度：按真实秒数标，跟记录一样长 */
    g.fillStyle = MUTED;
    g.font = '500 24px "PingFang SC","Microsoft YaHei",sans-serif';
    const tickEvery = span <= 8 ? 1 : Math.ceil(span / 8);
    for (let s = 0; s <= span; s += tickEvery) {
      const x = CX + 20 + s * pxPerSecOnImage;
      if (x > CX + CW - 20) break;
      g.fillText(s + 's', x + 2, CY + CH + 40);
    }

    /* 右下角水印 */
    g.fillStyle = '#A8ADB6';
    g.font = '600 22px "PingFang SC","Microsoft YaHei",sans-serif';
    g.textAlign = 'right';
    g.fillText('心率接收', W - 64, H - 48);
    g.textAlign = 'left';

    return c;
  }

  // 一次心跳的形状：P 小丘（u .08–.17）→ QRS 尖峰（.23–.44）→ T 波（.56–.76）
  function wf(u) {
    const sp = (a, b) => Math.sin(Math.PI * (u - a) / (b - a)) ** 1.6;
    const lp = (a, b, k) => a + (b - a) * Math.max(0, Math.min(1, k));
    if (u < .06) return 0;
    if (u < .16) return -sp(.06, .16) * .12;
    if (u < .22) return 0;
    if (u < .27) return lp(0, .12, (u - .22) / .05);
    if (u < .33) return lp(.12, -.95, (u - .27) / .06);
    if (u < .39) return lp(-.95, .18, (u - .33) / .06);
    if (u < .43) return lp(.18, 0, (u - .39) / .04);
    if (u < .46) return 0;
    if (u < .86) return -sp(.46, .86) * .30;
    return 0;
  }
  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function saveReport() {
    const c = drawReport();
    const name = '心率记录-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '') + '.png';
    c.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      showToast('已保存到相册');
    }, 'image/png');
    return c;
  }

  /* ---------- 收尾 ---------- */
  function finish(kind) {
    if (finished) return;
    finished = true;
    if (kind === 'lost') {
      buzz();
      // 先回等待页，弹框浮在等待页上
      try { sessionStorage.setItem('hr-sheet', 'lost'); } catch (e) {}
      setTimeout(() => { location.href = 'waiting.html?lost=1'; }, 120);
      return;
    }
    showSheet('stop');
  }

  el('sheetSave').addEventListener('click', () => {
    saveReport();
    const kind = sheet.dataset.kind;
    hideSheet();
    setTimeout(() => { location.href = 'waiting.html'; }, kind === 'stop' ? 600 : 300);
  });
  el('sheetSkip').addEventListener('click', () => {
    hideSheet();
    location.href = 'waiting.html';
  });

  /* 停止接收按钮 */
  const stopBtn = el('stopBtn');
  if (stopBtn) {
    stopBtn.addEventListener('click', (e) => {
      e.preventDefault();
      finish('stop');
    });
  }

  /* 对外：断线（真做时由蓝牙回调调用） */
  window.HRFinish = finish;
  window.HRSaveReport = saveReport;
  window.HRShowSheet = showSheet;

  /* 这一页是从「断线」回来的话，等页面出来后弹框 */
  if (new URLSearchParams(location.search).get('lost') === '1') {
    setTimeout(() => showSheet('lost'), 320);
  }
})();
