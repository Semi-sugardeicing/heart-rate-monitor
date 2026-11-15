package com.example.heart

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * 蓝牙心率接收
 * - 扫描附近广播了心率服务（0x180D）的设备
 * - 连上之后订阅心跳通知（0x2A37）
 * - 设备断开或者 10 秒收不到心跳都算断开，回调通知页面
 */
class BleHeart(private val ctx: Context, private val onEvent: (String, JSONObject) -> Unit) {

    companion object {
        // 标准心率服务 / 心率数值特征
        val SERVICE_HEART_RATE: UUID = UUID.fromString("0000180D-0000-1000-8000-00805F9B34FB")
        val CHAR_HEART_RATE: UUID = UUID.fromString("00002A37-0000-1000-8000-00805F9B34FB")
        // 电量服务（有就读，没有就不显示）
        val SERVICE_BATTERY: UUID = UUID.fromString("0000180F-0000-1000-8000-00805F9B34FB")
        val CHAR_BATTERY: UUID = UUID.fromString("00002A19-0000-1000-8000-00805F9B34FB")
        private val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805F9B34FB")

        /** 10 秒收不到心跳就算真断开 */
        const val LOST_AFTER_MS = 10_000L
    }

    private val main = Handler(Looper.getMainLooper())
    private val adapter: BluetoothAdapter? =
        (ctx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

    private var gatt: BluetoothGatt? = null
    private var scanning = false
    private var lostPosted = false
    private var connectedName: String = ""

    /** 扫描到的设备：地址 -> 名字 */
    private val found = LinkedHashMap<String, JSONObject>()
    private var scanTimeout: Runnable? = null

    /* ---------------- 权限 ---------------- */

    fun hasPermission(): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val scanOk = ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.BLUETOOTH_SCAN) ==
                    PackageManager.PERMISSION_GRANTED
            val connOk = ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.BLUETOOTH_CONNECT) ==
                    PackageManager.PERMISSION_GRANTED
            // 定位权限一并检查：有些 ROM 认这个，缺了扫描会静默返回空列表
            val locOk = ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.ACCESS_FINE_LOCATION) ==
                    PackageManager.PERMISSION_GRANTED
            return scanOk && connOk && locOk
        }
        return true
    }

    fun isBluetoothOn(): Boolean = adapter?.isEnabled == true

    /* ---------------- 扫描 ---------------- */

    @SuppressLint("MissingPermission")
    fun startScan() {
        if (!hasPermission()) { emit("onBleError", msg("permission", "没有蓝牙权限")); return }
        if (adapter == null) { emit("onBleError", msg("noadapter", "这台手机没有蓝牙")); return }
        if (!adapter.isEnabled) { emit("onBleError", msg("off", "蓝牙没开")); return }

        stopScan(silent = true)
        found.clear()
        scanning = true
        emit("onScanState", JSONObject().put("scanning", true))

        val scanner = adapter.bluetoothLeScanner
        if (scanner == null) { emit("onBleError", msg("noscanner", "蓝牙扫描不可用")); return }

        // 不过滤：OPPO 这类手表广播包里不一定会带服务 UUID，过滤了可能一台都看不到。
        // 列出来之后在界面上标明「有没有心率服务」。
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build()

        try {
            scanner.startScan(null, settings, scanCallback)
        } catch (e: Exception) {
            emit("onBleError", msg("scan", "扫描失败：" + (e.message ?: "")))
            return
        }

        // 15 秒后自动停
        scanTimeout?.let { main.removeCallbacks(it) }
        val t = Runnable {
            if (scanning) {
                stopScan()
            }
        }
        scanTimeout = t
        main.postDelayed(t, 15_000)
    }

    @SuppressLint("MissingPermission")
    fun stopScan(silent: Boolean = false) {
        scanTimeout?.let { main.removeCallbacks(it) }
        scanTimeout = null
        if (!scanning) return
        scanning = false
        try { adapter?.bluetoothLeScanner?.stopScan(scanCallback) } catch (_: Exception) {}
        if (!silent) emit("onScanState", JSONObject().put("scanning", false))
    }

    private val scanCallback = object : ScanCallback() {
        @SuppressLint("MissingPermission")
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val dev = result.device ?: return
            val address = dev.address ?: return
            val rec = result.scanRecord

            // 名字只从广播包里读。
            // 不能用 dev.name：未配对设备上它会触发一次同步远程名称读取，
            // 在 ColorOS 这类系统上会卡住回调线程，后面的服务 UUID 就取不到了。
            val name = rec?.deviceName

            // 有没有心率服务：广播包里有，或者 services 里有
            val uuids = try { rec?.serviceUuids } catch (e: Exception) { null }
            val hasHr = uuids?.any { it.uuid == SERVICE_HEART_RATE } == true ||
                    (rec?.getServiceData(ParcelUuid(SERVICE_HEART_RATE)) != null)

            val o = JSONObject()
            o.put("id", address)
            o.put("name", if (name.isNullOrBlank()) "未知设备" else name)
            o.put("hasHeart", hasHr)
            o.put("rssi", result.rssi)
            found[address] = o

            // 每台设备记一行，排查「扫不到手表」时直接 adb logcat -s HEARTSCAN 看
            android.util.Log.d("HEARTSCAN", "$address rssi=${result.rssi} name=${name ?: "-"} " +
                    "uuid=${uuids?.joinToString { it.uuid.toString().take(8) } ?: "无"} hasHeart=$hasHr")

            // 每次都推一份完整列表，页面直接替换
            val arr = JSONArray()
            found.values
                .sortedWith(compareByDescending<JSONObject> { it.optBoolean("hasHeart") }
                    .thenByDescending { it.optInt("rssi") })
                .forEach { arr.put(it) }
            emit("onDevices", JSONObject().put("list", arr))
        }

        override fun onScanFailed(errorCode: Int) {
            scanning = false
            emit("onBleError", msg("scanfail", "扫描失败，错误码 $errorCode"))
        }
    }

    /* ---------------- 连接 ---------------- */

    @SuppressLint("MissingPermission")
    fun connect(address: String) {
        if (!hasPermission()) { emit("onBleError", msg("permission", "没有蓝牙权限")); return }
        stopScan()
        disconnect(silent = true)

        val dev = try { adapter?.getRemoteDevice(address) } catch (e: Exception) { null }
        if (dev == null) { emit("onBleError", msg("nodevice", "找不到这台设备")); return }

        // 名字优先用扫描时记下的（来自广播），拿不到再用固定文案。
        // 这里同样不调 dev.name：未配对设备上它是同步远程读取，会在主线程卡住。
        connectedName = found[address]?.optString("name")?.takeIf { it.isNotBlank() && it != "未知设备" }
            ?: "心率传感器"
        emit("onConnectState", JSONObject().put("state", "connecting").put("name", connectedName))

        gatt = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            // TRANSPORT_LE 在 BluetoothDevice 里，不在 BluetoothProfile 里
            dev.connectGatt(ctx, false, gattCallback, android.bluetooth.BluetoothDevice.TRANSPORT_LE)
        } else {
            dev.connectGatt(ctx, false, gattCallback)
        }
        lostPosted = false
        main.removeCallbacks(lostCheck)
        main.postDelayed(lostCheck, LOST_AFTER_MS)
    }

    @SuppressLint("MissingPermission")
    fun disconnect(silent: Boolean = false) {
        main.removeCallbacks(lostCheck)
        lostPosted = false
        try { gatt?.disconnect() } catch (_: Exception) {}
        try { gatt?.close() } catch (_: Exception) {}
        gatt = null
        if (!silent) emit("onConnectState", JSONObject().put("state", "disconnected"))
    }

    @SuppressLint("MissingPermission")
    private val gattCallback = object : BluetoothGattCallback() {

        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                val cur = gatt ?: g
                main.post { cur.discoverServices() }
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                try { g.close() } catch (_: Exception) {}
                if (gatt === g) gatt = null
                main.post {
                    main.removeCallbacks(lostCheck)
                    emit("onConnectState", JSONObject()
                        .put("state", "disconnected")
                        .put("reason", "device"))
                }
            }
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            val svc = g.getService(SERVICE_HEART_RATE)
            if (svc == null) {
                main.post {
                    emit("onBleError", msg("nohrservice", "这台设备没有心率服务"))
                    disconnect()
                }
                return
            }
            val ch = svc.getCharacteristic(CHAR_HEART_RATE)
            if (ch == null) {
                main.post {
                    emit("onBleError", msg("nochar", "没有心率数值"))
                    disconnect()
                }
                return
            }

            g.setCharacteristicNotification(ch, true)
            // 打开通知：不同系统版本写法不一样，这里按版本判断
            val descriptor = ch.getDescriptor(CCCD)
            if (descriptor != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    g.writeDescriptor(descriptor, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
                } else {
                    @Suppress("DEPRECATION")
                    descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                    @Suppress("DEPRECATION")
                    g.writeDescriptor(descriptor)
                }
            }

            // 有电量服务就顺手读一下
            g.getService(SERVICE_BATTERY)?.getCharacteristic(CHAR_BATTERY)?.let {
                try { g.readCharacteristic(it) } catch (_: Exception) {}
            }

            main.post {
                emit("onConnectState", JSONObject()
                    .put("state", "connected")
                    .put("name", connectedName))
            }
        }

        override fun onDescriptorWrite(g: BluetoothGatt, d: BluetoothGattDescriptor, status: Int) {
            main.post { emit("onSubscribe", JSONObject().put("ok", status == BluetoothGatt.GATT_SUCCESS)) }
        }

        override fun onCharacteristicChanged(
            g: BluetoothGatt,
            ch: BluetoothGattCharacteristic,
            value: ByteArray
        ) {
            parseHeartRate(ch.uuid, value)
        }

        @Deprecated("老版本回调")
        override fun onCharacteristicChanged(g: BluetoothGatt, ch: BluetoothGattCharacteristic) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
                @Suppress("DEPRECATION")
                val v = ch.value
                if (v != null) parseHeartRate(ch.uuid, v)
            }
        }

        override fun onCharacteristicRead(
            g: BluetoothGatt,
            ch: BluetoothGattCharacteristic,
            value: ByteArray,
            status: Int
        ) {
            if (ch.uuid == CHAR_BATTERY && status == BluetoothGatt.GATT_SUCCESS && value.isNotEmpty()) {
                val pct = value[0].toInt() and 0xFF
                main.post { emit("onBattery", JSONObject().put("pct", pct)) }
            }
        }
    }

    /** 心率数值格式（蓝牙标准）：第 1 个字节的 bit0 决定是 uint8 还是 uint16 */
    private fun parseHeartRate(uuid: UUID, value: ByteArray) {
        if (uuid != CHAR_HEART_RATE) {
            if (uuid == CHAR_BATTERY && value.isNotEmpty()) {
                main.post { emit("onBattery", JSONObject().put("pct", value[0].toInt() and 0xFF)) }
            }
            return
        }
        if (value.isEmpty()) return
        val flags = value[0].toInt() and 0xFF
        val bpm: Int = if ((flags and 0x01) != 0) {
            if (value.size >= 3) ((value[1].toInt() and 0xFF) or ((value[2].toInt() and 0xFF) shl 8))
            else 0
        } else {
            value[1].toInt() and 0xFF
        }
        if (bpm <= 0) return

        // 收到心跳：重置 10 秒断开计时
        lostPosted = false
        main.removeCallbacks(lostCheck)
        main.postDelayed(lostCheck, LOST_AFTER_MS)

        val rr = mutableListOf<Double>()
        if ((flags and 0x10) != 0 && value.size >= 4) {
            // RR 间期（单位 1/1024 秒）：有就一起发，以后做心率变异性能用
            var i = 1
            while (i + 1 < value.size) {
                val raw = ((value[i].toInt() and 0xFF) or ((value[i + 1].toInt() and 0xFF) shl 8))
                rr.add(raw / 1024.0 * 1000.0)
                i += 2
            }
        }
        val o = JSONObject()
        o.put("bpm", bpm)
        o.put("t", System.currentTimeMillis())
        if (rr.isNotEmpty()) o.put("rr", JSONArray(rr))
        main.post { emit("onHeart", o) }
    }

    /** 10 秒没心跳：算断开 */
    private val lostCheck = Runnable {
        if (lostPosted) return@Runnable
        lostPosted = true
        disconnect(silent = true)
        emit("onConnectState", JSONObject()
            .put("state", "disconnected")
            .put("reason", "lost"))
    }

    /* ---------------- 工具 ---------------- */

    private fun msg(code: String, text: String): JSONObject =
        JSONObject().put("code", code).put("msg", text)

    private fun emit(fn: String, o: JSONObject) {
        onEvent(fn, o)
    }
}
