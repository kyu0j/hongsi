package dev.kyuyoung.hongsi

import android.annotation.SuppressLint
import android.app.Activity
import android.hardware.GeomagneticField
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Location
import android.location.LocationManager
import android.os.Looper
import android.os.SystemClock
import android.view.Surface
import androidx.core.location.LocationListenerCompat
import androidx.core.location.LocationManagerCompat
import androidx.core.location.LocationRequestCompat
import app.tauri.plugin.Channel
import app.tauri.plugin.JSObject
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import kotlin.math.abs

internal class MapTracking(private val host: Activity) : SensorEventListener {
    private val fused = LocationServices.getFusedLocationProviderClient(host)
    private val locations = host.getSystemService(LocationManager::class.java)
    private val sensors = host.getSystemService(SensorManager::class.java)
    private val compass = sensors.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
    private var events: Channel? = null
    private var wanted = false
    private var active = false
    private var generation = 0
    private var heading = false
    private var last: Location? = null
    private var lastHeadingAt = 0L
    private val rotation = FloatArray(9)
    private val remapped = FloatArray(9)
    private val orientation = FloatArray(3)
    private val callback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) { result.locations.forEach(::position) }
    }
    private val fallback = object : LocationListenerCompat {
        override fun onLocationChanged(location: Location) { position(location) }
    }

    fun start(channel: Channel) { stop(); events = channel; wanted = true; resume() }

    @SuppressLint("MissingPermission")
    fun resume() {
        if (!wanted || active) return
        active = true
        val current = ++generation
        try {
            if (!LocationManagerCompat.isLocationEnabled(locations)) throw IllegalStateException("기기의 위치 기능을 켜 주세요.")
            if (GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(host) == ConnectionResult.SUCCESS) {
                val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 1000)
                    .setMinUpdateIntervalMillis(500).setMaxUpdateDelayMillis(0).setWaitForAccurateLocation(true).build()
                fused.requestLocationUpdates(request, callback, Looper.getMainLooper()).addOnFailureListener {
                    if (active && generation == current) { stopUpdates(); platformUpdates() }
                }
                fused.lastLocation.addOnSuccessListener { location ->
                    if (generation == current && location != null && location.hasAccuracy() && location.accuracy <= 50) position(location)
                }
            } else platformUpdates()
            if (heading) startCompass()
        } catch (error: Exception) {
            pause()
            events?.send(JSObject().put("type", "error").put("message", error.message ?: "현재 위치를 확인하지 못했어요."))
        }
    }

    @SuppressLint("MissingPermission")
    private fun platformUpdates() {
        if (!active) return
        val request = LocationRequestCompat.Builder(1000).setMinUpdateIntervalMillis(500)
            .setQuality(LocationRequestCompat.QUALITY_HIGH_ACCURACY).build()
        var count = 0
        listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER).forEach { provider ->
            if (runCatching { locations.isProviderEnabled(provider) }.getOrDefault(false)) {
                runCatching { LocationManagerCompat.requestLocationUpdates(locations, provider, request, fallback, Looper.getMainLooper()) }.onSuccess { count++ }
            }
        }
        if (count == 0) events?.send(JSObject().put("type", "error").put("message", "기기의 위치 기능을 켜 주세요."))
    }

    private fun position(location: Location) {
        if (!active || !location.hasAccuracy() || SystemClock.elapsedRealtimeNanos() - location.elapsedRealtimeNanos !in 0..15_000_000_000L) return
        last = location
        val age = (SystemClock.elapsedRealtimeNanos() - location.elapsedRealtimeNanos) / 1_000_000L
        events?.send(JSObject().put("type", "position").put("position", JSObject()
            .put("latitude", location.latitude).put("longitude", location.longitude)
            .put("accuracy", location.accuracy).put("timestamp", System.currentTimeMillis() - age)))
    }

    fun heading(enabled: Boolean): Boolean {
        heading = enabled
        sensors.unregisterListener(this)
        return !enabled || (active && startCompass())
    }

    private fun startCompass(): Boolean = compass?.let { sensors.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME) } ?: false

    @Suppress("DEPRECATION")
    override fun onSensorChanged(event: SensorEvent) {
        if (!active || !heading || event.accuracy == SensorManager.SENSOR_STATUS_UNRELIABLE) return
        val now = SystemClock.elapsedRealtime()
        if (now - lastHeadingAt < 33) return
        lastHeadingAt = now
        SensorManager.getRotationMatrixFromVector(rotation, event.values)
        val display = host.windowManager.defaultDisplay.rotation
        val axes = when (display) {
            Surface.ROTATION_90 -> SensorManager.AXIS_Y to SensorManager.AXIS_MINUS_X
            Surface.ROTATION_180 -> SensorManager.AXIS_MINUS_X to SensorManager.AXIS_MINUS_Y
            Surface.ROTATION_270 -> SensorManager.AXIS_MINUS_Y to SensorManager.AXIS_X
            else -> SensorManager.AXIS_X to SensorManager.AXIS_Y
        }
        SensorManager.remapCoordinateSystem(rotation, axes.first, axes.second, remapped)
        SensorManager.getOrientation(remapped, orientation)
        val declination = last?.let { GeomagneticField(it.latitude.toFloat(), it.longitude.toFloat(), it.altitude.toFloat(), System.currentTimeMillis()).declination } ?: 0f
        val bearing = (Math.toDegrees(orientation[0].toDouble()) + declination + 360) % 360
        val accuracy = if (event.values.size > 4 && event.values[4] >= 0) Math.toDegrees(event.values[4].toDouble()) else 15.0
        if (bearing.isFinite() && abs(accuracy) <= 60) events?.send(JSObject().put("type", "heading").put("heading", bearing).put("accuracy", accuracy))
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
    private fun stopUpdates() { fused.removeLocationUpdates(callback); locations.removeUpdates(fallback) }
    fun pause() { generation++; active = false; stopUpdates(); sensors.unregisterListener(this) }
    fun stop() { pause(); wanted = false; heading = false; events = null; last = null }
}
