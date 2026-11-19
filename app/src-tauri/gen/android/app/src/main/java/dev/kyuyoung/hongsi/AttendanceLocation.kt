package dev.kyuyoung.hongsi

import android.annotation.SuppressLint
import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import androidx.core.location.LocationListenerCompat
import androidx.core.location.LocationManagerCompat
import androidx.core.location.LocationRequestCompat
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject

internal class AttendanceLocation(private val host: Activity) {
    private var latest: Location? = null
    private var listening = false
    private val manager = host.getSystemService(LocationManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private val pending = mutableListOf<Invoke>()
    private val timeout = Runnable { cancel() }
    private val listener = object : LocationListenerCompat {
        override fun onLocationChanged(location: Location) {
            if (listening && location.validCoordinates()) finish(location)
        }
    }

    @SuppressLint("MissingPermission")
    fun locate(invoke: Invoke? = null) {
        if (ContextCompat.checkSelfPermission(host, Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED &&
            ContextCompat.checkSelfPermission(host, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            latest = null
            cancel()
            invoke?.reject("위치 권한을 허용해 주세요.")
            return
        }
        if (!LocationManagerCompat.isLocationEnabled(manager)) {
            cancel()
            invoke?.reject("기기의 위치 기능을 켜 주세요.")
            return
        }
        val recent = (manager.allProviders.mapNotNull { runCatching { manager.getLastKnownLocation(it) }.getOrNull() } +
            listOfNotNull(latest)).filter { it.validCoordinates() }.maxByOrNull { it.elapsedRealtimeNanos }
        if (invoke != null) pending.add(invoke)
        if (recent != null) {
            finish(recent)
            return
        }
        if (listening) return
        listening = true
        val providers = listOf("fused", LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
            .filter { runCatching { manager.isProviderEnabled(it) }.getOrDefault(false) }
        val request = LocationRequestCompat.Builder(1000)
            .setMinUpdateIntervalMillis(500)
            .setQuality(LocationRequestCompat.QUALITY_HIGH_ACCURACY)
            .build()
        val started = providers.map { provider ->
            runCatching { LocationManagerCompat.requestLocationUpdates(manager, provider, request, listener, Looper.getMainLooper()) }.isSuccess
        }.any { it }
        if (started) main.postDelayed(timeout, 12_000) else cancel()
    }

    fun cancel() = finish(null)

    private fun finish(location: Location?) {
        if (location != null) latest = location
        main.removeCallbacks(timeout)
        if (listening) {
            listening = false
            runCatching { LocationManagerCompat.removeUpdates(manager, listener) }
        }
        val requests = pending.toList()
        pending.clear()
        for (request in requests) {
            if (location == null) request.reject("위치를 찾지 못했어요.")
            else request.resolve(location.payload())
        }
    }

    private fun Location.validCoordinates() = latitude in -90.0..90.0 && longitude in -180.0..180.0
    private fun Location.payload() = JSObject().put("latitude", latitude).put("longitude", longitude)
        .put("accuracy", if (hasAccuracy()) accuracy else null)
}
