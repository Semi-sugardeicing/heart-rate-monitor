package com.example.heart

import android.Manifest
import android.annotation.SuppressLint
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.MediaStore
import android.util.Base64
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebChromeClient
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

/**
 * 心率接收：界面是 assets/app.html（设计稿搬过来的），
 * 原生这边只管三件事：蓝牙收心率、震动、把图存进相册。
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var ble: BleHeart
    private val main = Handler(Looper.getMainLooper())
    private var pendingSave: String? = null

    /** 蓝牙权限回调 */
    private val permLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { grants ->
        val ok = grants.values.all { it }
        notifyJs("onPermission", JSONObject().put("granted", ok).toString())
        if (ok) {
            // 允许之后自动开始扫描，省得用户再点一次
            main.postDelayed({ startScanFromNative() }, 300)
        } else {
            toast("没有「附近设备」权限，就搜不到手表")
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    /** 原生/网页 console 日志缓冲 */
    private val nativeLogs = ArrayDeque<org.json.JSONObject>()

    private fun pushNativeLog(level: String, msg: String) {
        try {
            val o = org.json.JSONObject()
                .put("t", System.currentTimeMillis())
                .put("level", level)
                .put("msg", msg)
            nativeLogs.addLast(o)
            while (nativeLogs.size > 300) nativeLogs.removeFirst()
        } catch (e: Exception) {}
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, true)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // 浅色的系统栏，跟界面一致
        val wic = WindowInsetsControllerCompat(window, window.decorView)
        wic.isAppearanceLightStatusBars = true
        wic.isAppearanceLightNavigationBars = true

        ble = BleHeart(this) { fn, json -> notifyJs(fn, json.toString()) }

        webView = WebView(this)
        setContentView(webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = true
            databaseEnabled = true
            useWideViewPort = true
            loadWithOverviewMode = true
            textZoom = 100
            allowContentAccess = true
        }
        webView.setBackgroundColor(Color.parseColor("#F2F3F5"))
        webView.webViewClient = WebViewClient()
        webView.addJavascriptInterface(Bridge(), "HeartNative")

        /* 把网页的 console 和 JS 报错收进原生日志缓冲区，
           开发者选项里能读到。没有这个，网页崩了这边完全看不见。 */
        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(msg: android.webkit.ConsoleMessage?): Boolean {
                if (msg == null) return true
                val lvl = when (msg.messageLevel()) {
                    android.webkit.ConsoleMessage.MessageLevel.ERROR -> "err"
                    android.webkit.ConsoleMessage.MessageLevel.WARNING -> "warn"
                    else -> "info"
                }
                // 只收 error / warning 和带标记的，避免刷屏
                if (lvl != "info" || msg.message().contains("[HR]")) {
                    pushNativeLog(lvl, msg.message() + " @" + msg.sourceId().substringAfterLast('/') + ":" + msg.lineNumber())
                }
                return true
            }
        }

        webView.loadUrl("file:///android_asset/app.html")

        // 一进来就要蓝牙权限：不给就没法扫描
        requestBlePermission()
    }

    /* ---------------- 权限 ---------------- */

    private fun requestBlePermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return   // 安卓 11 不需要
        val need = mutableListOf<String>()
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_SCAN)
            != PackageManager.PERMISSION_GRANTED) need.add(Manifest.permission.BLUETOOTH_SCAN)
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT)
            != PackageManager.PERMISSION_GRANTED) need.add(Manifest.permission.BLUETOOTH_CONNECT)
        // 定位权限也一起要：某些 ROM 即便声明了 neverForLocation 仍会检查它，
        // 少了这个 startScan 会静默返回空结果。
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
            != PackageManager.PERMISSION_GRANTED) need.add(Manifest.permission.ACCESS_FINE_LOCATION)
        if (need.isNotEmpty()) permLauncher.launch(need.toTypedArray())
    }

    /* ---------------- 原生桥（网页调这边） ---------------- */

    inner class Bridge {

        @JavascriptInterface
        fun isNative(): Boolean = true

        /** 有没有蓝牙权限 */
        @JavascriptInterface
        fun hasBlePermission(): Boolean = ble.hasPermission()

        /** 要权限（网页里点「去授权」时调） */
        @JavascriptInterface
        fun requestBlePermission() {
            main.post { this@MainActivity.requestBlePermission() }
        }

        /** 蓝牙开没开 */
        @JavascriptInterface
        fun isBluetoothOn(): Boolean = ble.isBluetoothOn()

        /** 原生侧日志缓冲（最多 300 条），网页通过 getNativeLogs 读走 */
        @JavascriptInterface
        fun getNativeLogs(): String {
            try {
                val arr = org.json.JSONArray()
                for (it in nativeLogs) arr.put(it)
                return arr.toString()
            } catch (e: Exception) { return "[]" }
        }

        /** 网页自己也能往原生日志里写一条，比如 catch 到错误时 */
        @JavascriptInterface
        fun pushLog(level: String, msg: String) {
            pushNativeLog(level, msg)
        }

        /**
         * 检查本 App 各个权限的授权状态，返回 JSON 数组字符串。
         * 每项：{ name, label, granted, required }
         * 开发者选项里用来排查「扫不到设备是不是权限没给」。
         */
        @JavascriptInterface
        fun getPermissionStatus(): String {
            data class P(val name: String, val label: String, val required: Boolean)
            val list = mutableListOf<P>()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                list.add(P(android.Manifest.permission.BLUETOOTH_SCAN, "附近设备·扫描", true))
                list.add(P(android.Manifest.permission.BLUETOOTH_CONNECT, "附近设备·连接", true))
            }
            list.add(P(android.Manifest.permission.ACCESS_FINE_LOCATION, "定位（精确）", false))
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                list.add(P(android.Manifest.permission.READ_MEDIA_IMAGES, "读取相册图片", false))
            }
            val arr = org.json.JSONArray()
            for (p in list) {
                val granted = ContextCompat.checkSelfPermission(this@MainActivity, p.name) ==
                        PackageManager.PERMISSION_GRANTED
                arr.put(org.json.JSONObject()
                    .put("name", p.name.substringAfterLast('.'))
                    .put("label", p.label)
                    .put("granted", granted)
                    .put("required", p.required))
            }
            // 顺带带上几个系统开关，方便一次看全
            val extra = org.json.JSONObject()
            try {
                val bm = getSystemService(Context.BATTERY_SERVICE) as android.os.BatteryManager
                extra.put("bluetoothOn", ble.isBluetoothOn())
                extra.put("androidVersion", Build.VERSION.RELEASE)
                extra.put("sdk", Build.VERSION.SDK_INT)
                extra.put("model", Build.MODEL)
                extra.put("brand", Build.BRAND)
            } catch (e: Exception) {}
            return org.json.JSONObject()
                .put("perms", arr)
                .put("env", extra)
                .toString()
        }

        /**
         * 手机自己的电量（0-100）。用 BatteryManager 读系统属性，不需要额外权限。
         * 返回 -1 表示读不到。
         */
        @JavascriptInterface
        fun getPhoneBattery(): Int {
            return try {
                val bm = getSystemService(Context.BATTERY_SERVICE) as android.os.BatteryManager
                bm.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY)
            } catch (e: Exception) { -1 }
        }

        /**
         * 网页切横竖屏时调这个，真的让系统转过去。
         * 只改网页的 data-view 不改屏幕方向的话，横屏布局会被塞进竖屏窗口挤成一团。
         * landscape = true 转横屏，false 转竖屏。
         */
        @JavascriptInterface
        fun setOrientation(landscape: Boolean) {
            main.post {
                requestedOrientation = if (landscape) {
                    android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                } else {
                    android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                }
            }
        }

        /** 开始扫描 */
        @JavascriptInterface
        fun startScan() {
            main.post { ble.startScan() }
        }

        /** 停止扫描 */
        @JavascriptInterface
        fun stopScan() {
            main.post { ble.stopScan() }
        }

        /** 连接某台设备（地址来自 onDevices 列表里的 id） */
        @JavascriptInterface
        fun connect(address: String) {
            main.post { ble.connect(address) }
        }

        /** 主动断开 */
        @JavascriptInterface
        fun disconnect() {
            main.post { ble.disconnect() }
        }

        /** 震动：毫秒数，三个值就是「震-停-震」 */
        @JavascriptInterface
        fun vibrate(patternCsv: String) {
            val nums = patternCsv.split(",").mapNotNull { it.trim().toLongOrNull() }.toLongArray()
            buzz(if (nums.isEmpty()) longArrayOf(240, 120, 240, 120, 240) else nums)
        }

        /** 存图片到相册：传 dataURL（data:image/png;base64,...），存完回调 onSavedBack */
        @JavascriptInterface
        fun saveToGallery(dataUrl: String, fileName: String) {
            main.post {
                pendingSave = fileName
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                    ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.READ_MEDIA_IMAGES)
                    != PackageManager.PERMISSION_GRANTED) {
                    // 安卓 13+ 写自己的图片其实不用权限，这里只是保险，不弹也不影响
                }
                try {
                    val base64 = dataUrl.substringAfter("base64,", dataUrl)
                    val bytes = Base64.decode(base64, Base64.DEFAULT)
                    val values = ContentValues().apply {
                        put(MediaStore.Images.Media.DISPLAY_NAME, fileName)
                        put(MediaStore.Images.Media.MIME_TYPE, "image/png")
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                            put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/心率接收")
                            put(MediaStore.Images.Media.IS_PENDING, 1)
                        }
                    }
                    val resolver = contentResolver
                    val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
                    if (uri == null) {
                        notifyJs("onSaved", JSONObject().put("ok", false).put("msg", "相册打不开").toString())
                        return@post
                    }
                    resolver.openOutputStream(uri)?.use { out -> out.write(bytes) }
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        values.clear()
                        values.put(MediaStore.Images.Media.IS_PENDING, 0)
                        resolver.update(uri, values, null, null)
                    }
                    notifyJs("onSaved", JSONObject().put("ok", true).put("uri", uri.toString()).toString())
                    toast("已保存到相册")
                } catch (e: Exception) {
                    notifyJs("onSaved", JSONObject().put("ok", false)
                        .put("msg", e.message ?: "保存失败").toString())
                }
            }
        }

        /** 系统版本、屏幕信息（页面有时候要用） */
        @JavascriptInterface
        fun getInfo(): String {
            val dm = resources.displayMetrics
            val o = JSONObject()
            o.put("sdk", Build.VERSION.SDK_INT)
            o.put("widthDp", dm.widthPixels / dm.density)
            o.put("heightDp", dm.heightPixels / dm.density)
            o.put("density", dm.density)
            return o.toString()
        }

        @JavascriptInterface
        fun toast(msg: String) {
            main.post { this@MainActivity.toast(msg) }
        }
    }

    private fun startScanFromNative() {
        webView.evaluateJavascript("window.HRNative && window.HRNative.startScan && window.HRNative.startScan();", null)
    }

    /* ---------------- 震动 ---------------- */

    private fun buzz(pattern: LongArray) {
        try {
            val v: Vibrator? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
            }
            if (v == null || !v.hasVibrator()) return
            val effect = if (pattern.size == 1) {
                VibrationEffect.createOneShot(pattern[0], VibrationEffect.DEFAULT_AMPLITUDE)
            } else {
                VibrationEffect.createWaveform(pattern, -1)
            }
            v.vibrate(effect)
        } catch (_: Exception) {
        }
    }

    /* ---------------- 回调网页 ---------------- */

    private fun notifyJs(fn: String, json: String) {
        main.post {
            val safe = json.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "").replace("\r", "")
            val name = when (fn) {
                "onDevices" -> "__hrOnDevices"
                "onScanState" -> "__hrOnScanState"
                "onConnectState" -> "__hrOnConnectState"
                "onHeart" -> "__hrOnHeart"
                "onBattery" -> "__hrOnBattery"
                "onSubscribe" -> "__hrOnSubscribe"
                "onBleError" -> "__hrOnBleError"
                "onPermission" -> "__hrOnPermission"
                "onSaved" -> "__hrOnSaved"
                else -> null
            }
            val js = if (name != null) "window.$name&&window.$name('$safe')"
                     else "window.__hrOn&&window.__hrOn('$fn','$safe')"
            webView.evaluateJavascript(js, null)
        }
    }

    private fun toast(text: String) {
        Toast.makeText(this, text, Toast.LENGTH_SHORT).show()
    }

    /* ---------------- 生命周期 ---------------- */

    override fun onResume() {
        super.onResume()
    }

    override fun onPause() {
        super.onPause()
    }

    override fun onDestroy() {
        try { ble.disconnect(silent = true) } catch (_: Exception) {}
        if (::webView.isInitialized) {
            webView.removeJavascriptInterface("HeartNative")
            webView.destroy()
        }
        super.onDestroy()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        // 返回键交给网页：页面里能处理（退到上一级）就处理，不能就退出
        webView.evaluateJavascript("window.__onBack && window.__onBack()") { r ->
            val handled = r == "true"
            if (!handled) {
                @Suppress("DEPRECATION")
                super.onBackPressed()
            }
        }
    }
}
