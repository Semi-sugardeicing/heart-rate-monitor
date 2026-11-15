/* ============================================================
   心率接收 · 原生桥（APK 版专用）
   Android 注入的对象叫 HeartNative；这里包成 window.Native。
   设计台网页里没有 HeartNative，自动降级成模拟 / 浏览器能力。
   ============================================================ */
(function () {
  const N = window.HeartNative;
  /* 判定原生环境：只要 HeartNative 这个对象被注入了就算原生。
     不要依赖 isNative() 的返回值——那个是 JS 桥方法，一旦调用抛异常，
     整个判断会变成 false，页面就把自己当成网页版了（之前就踩过这个坑）。 */
  let isNative = false;
  if (N) {
    try {
      isNative = typeof N.isNative === 'function' ? !!N.isNative() : true;
    } catch (e) {
      isNative = true;   // 方法挂了但对象在，仍然说明是 APK
    }
  }

  const Native = {
    isNative,
    listeners: {},
    on(fn, cb) { (this.listeners[fn] = this.listeners[fn] || []).push(cb); },
    fire(fn, data) { (this.listeners[fn] || []).forEach((cb) => { try { cb(data); } catch (e) {} }); },

    /* ---- 蓝牙 ---- */
    hasBlePermission() { return isNative ? N.hasBlePermission() : false; },
    requestBlePermission() { if (isNative) N.requestBlePermission(); },
    isBluetoothOn() { return isNative ? N.isBluetoothOn() : false; },
    startScan() { if (isNative) N.startScan(); },
    stopScan() { if (isNative) N.stopScan(); },
    connect(id) { if (isNative) N.connect(id); },
    disconnect() { if (isNative) N.disconnect(); },

    /* ---- 震动 ---- */
    vibrate(pattern) {
      const p = pattern || [240, 120, 240, 120, 240];
      if (isNative) { N.vibrate(p.join(',')); return; }
      try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) {}
    },

    /* ---- 权限状态检查 ---- */
    getPermissionStatus() {
      if (isNative && N.getPermissionStatus) {
        try { return JSON.parse(N.getPermissionStatus()); } catch (e) { return null; }
      }
      return null;
    },

    /* ---- 手机电量 ---- */
    getPhoneBattery() {
      if (isNative && N.getPhoneBattery) { try { return N.getPhoneBattery(); } catch (e) {} }
      return -1;
    },

    /* ---- 屏幕方向 ---- */
    setOrientation(landscape) {
      if (isNative && N.setOrientation) { try { N.setOrientation(!!landscape); } catch (e) {} }
    },

    /* ---- 存相册 ---- */
    saveToGallery(dataUrl, fileName) {
      if (isNative) { N.saveToGallery(dataUrl, fileName); return true; }
      const a = document.createElement('a');
      a.href = dataUrl; a.download = fileName;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => this.fire('onSaved', { ok: true, web: true }), 60);
      return false;
    }
  };

  window.Native = Native;
})();

/* ---------- 原生推事件进来 ---------- */
window.__hrOn = function (fn, json) {
  let data = json;
  if (typeof json === 'string') { try { data = JSON.parse(json); } catch (e) {} }
  if (window.Native) window.Native.fire(fn, data);
};
['Devices', 'ScanState', 'ConnectState', 'Heart', 'Battery', 'Subscribe', 'BleError', 'Permission', 'Saved']
  .forEach((k) => {
    window['__hrOn' + k] = (j) => window.__hrOn('on' + k, j);
  });

/* 原生有个地方会调 window.HRNative.startScan()，这里兜一个 */
window.HRNative = window.HRNative || {};
window.HRNative.startScan = function () { window.Native && window.Native.startScan(); };