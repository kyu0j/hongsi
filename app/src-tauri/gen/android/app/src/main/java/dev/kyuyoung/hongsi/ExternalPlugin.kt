package dev.kyuyoung.hongsi

import androidx.core.net.toUri
import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.provider.Settings
import androidx.core.content.ContextCompat
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import app.tauri.plugin.Channel
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONArray
import java.io.FileNotFoundException
import kotlin.concurrent.thread

@InvokeArg
class ExternalArgs { lateinit var value: String }

@InvokeArg
class SaveDownloadArgs { lateinit var path: String; lateinit var name: String }

@InvokeArg
class CheckDownloadsArgs { var paths: Array<String?> = emptyArray() }

@InvokeArg
class MapTrackingArgs { lateinit var action: String; var events: Channel? = null }

internal object ExternalIntents {
    fun url(value: String): Intent {
        val uri = (value).toUri()
        require(uri.scheme in listOf("https", "http") && !uri.host.isNullOrBlank() && value.length < 16384)
        return Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)
    }
}

@TauriPlugin(permissions = [
    Permission(strings = [Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION], alias = "location"),
    Permission(strings = [Manifest.permission.WRITE_EXTERNAL_STORAGE], alias = "downloads")
])
class ExternalPlugin(private val host: Activity) : Plugin(host) {
    private val tracking = lazy { MapTracking(host) }
    override fun onPause(activity: AppCompatActivity) { if (tracking.isInitialized()) tracking.value.pause() }
    override fun onResume(activity: AppCompatActivity) { if (tracking.isInitialized()) tracking.value.resume() }
    override fun onDestroy(activity: AppCompatActivity) { if (tracking.isInitialized()) tracking.value.stop() }
    private fun locationPermissionState(): String {
        if (ContextCompat.checkSelfPermission(host, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(host, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) return "granted"
        return if (getPermissionState("location") == PermissionState.DENIED) "denied" else "default"
    }
    @Command fun locationPermission(invoke: Invoke) {
        val action = invoke.parseArgs(ExternalArgs::class.java).value
        host.runOnUiThread {
            try {
                when (action) {
                    "settings" -> host.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, "package:${host.packageName}".toUri()))
                    "request", "precise" -> if (locationPermissionState() == "default" || (action == "precise" && ContextCompat.checkSelfPermission(host, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED)) {
                        requestPermissionForAlias("location", invoke, "locationPermissionResult")
                        return@runOnUiThread
                    }
                }
                locationPermissionResult(invoke)
            } catch (_: Exception) { invoke.reject("위치 권한을 확인하지 못했어요.") }
        }
    }
    @PermissionCallback
    private fun locationPermissionResult(invoke: Invoke) {
        invoke.resolve(JSObject().put("permission", locationPermissionState())
            .put("precise", ContextCompat.checkSelfPermission(host, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED))
    }
    @Command fun mapTracking(invoke: Invoke) {
        val args = invoke.parseArgs(MapTrackingArgs::class.java)
        host.runOnUiThread {
            try {
                val available = when (args.action) {
                    "start" -> {
                        check(locationPermissionState() == "granted") { "위치 권한을 허용해 주세요." }
                        tracking.value.start(requireNotNull(args.events)); true
                    }
                    "stop" -> { if (tracking.isInitialized()) tracking.value.stop(); true }
                    "heading-on" -> tracking.value.heading(true)
                    "heading-off" -> if (tracking.isInitialized()) tracking.value.heading(false) else true
                    else -> throw IllegalArgumentException("위치 요청을 확인해 주세요.")
                }
                invoke.resolve(JSObject().put("headingAvailable", available))
            } catch (error: Exception) { invoke.reject(error.message ?: "위치를 확인하지 못했어요.") }
        }
    }
    @Command fun setWidgetTheme(invoke: Invoke) {
        val value = invoke.parseArgs(ExternalArgs::class.java).value
        host.runOnUiThread {
            try {
                dev.kyuyoung.hongsi.widget.WidgetTheme.set(host, value)
                invoke.resolve(JSObject())
            } catch (_: Exception) { invoke.reject("위젯 테마를 적용하지 못했어요.") }
        }
    }
    @Command fun syncWidget(invoke: Invoke) {
        val value = invoke.parseArgs(ExternalArgs::class.java).value
        host.runOnUiThread {
            try {
                dev.kyuyoung.hongsi.widget.WidgetData.replace(host, value)
                dev.kyuyoung.hongsi.widget.Widgets.updateAll(host, preserveInput = true)
                dev.kyuyoung.hongsi.widget.WidgetSync.schedule(host)
                invoke.resolve(JSObject())
            } catch (_: Exception) { invoke.reject("위젯 정보를 저장하지 못했어요.") }
        }
    }
    @Command fun takeWidgetIntent(invoke: Invoke) {
        host.runOnUiThread { invoke.resolve(JSObject(dev.kyuyoung.hongsi.widget.WidgetNavigation.take(host).toString())) }
    }
    private fun launch(invoke: Invoke, message: String, action: () -> Unit) {
        host.runOnUiThread {
            try { action(); invoke.resolve(JSObject()) }
            catch (_: ActivityNotFoundException) { invoke.reject(message) }
            catch (_: java.io.FileNotFoundException) { invoke.reject("파일이 없어요.") }
            catch (_: Exception) { invoke.reject("파일이나 링크를 열지 못했어요.") }
        }
    }
    @Command fun openUrl(invoke: Invoke) {
        val value = invoke.parseArgs(ExternalArgs::class.java).value
        launch(invoke, "링크를 열 브라우저가 없어요.") { host.startActivity(ExternalIntents.url(value)) }
    }
    @Command fun saveDownload(invoke: Invoke) {
        if (!PublicDownloads.canWrite(host)) {
            host.runOnUiThread { requestPermissionForAlias("downloads", invoke, "downloadPermissionResult") }
        } else saveDownloadFile(invoke)
    }
    @PermissionCallback
    private fun downloadPermissionResult(invoke: Invoke) {
        if (PublicDownloads.canWrite(host)) saveDownloadFile(invoke)
        else invoke.reject("파일 저장 권한을 허용해 주세요.")
    }
    private fun saveDownloadFile(invoke: Invoke) {
        val args = invoke.parseArgs(SaveDownloadArgs::class.java)
        thread(name = "hongsi-download-save") {
            try {
                val file = PublicDownloads.save(host, args.path, args.name)
                invoke.resolve(JSObject().put("path", file.path).put("name", file.name))
            }
            catch (_: Exception) { invoke.reject("파일을 저장하지 못했어요.") }
        }
    }
    @Command fun checkDownloads(invoke: Invoke) {
        val paths = invoke.parseArgs(CheckDownloadsArgs::class.java).paths
        if (paths.size > 100) { invoke.reject("파일을 확인하지 못했어요."); return }
        thread(name = "hongsi-download-check") {
            try {
                val checked = paths.map { path ->
                    if (path == null) null else try {
                        val file = PublicDownloads.check(host, path)
                        JSObject().put("path", file.path).put("name", file.name)
                    } catch (_: FileNotFoundException) { null }
                }
                invoke.resolve(JSObject().put("files", JSONArray(checked)))
            } catch (_: Exception) { invoke.reject("파일을 확인하지 못했어요.") }
        }
    }
    @Command fun openFile(invoke: Invoke) {
        val value = invoke.parseArgs(ExternalArgs::class.java).value
        launch(invoke, "이 파일 형식을 열 수 있는 앱이 없어요.") { host.startActivity(PublicDownloads.open(host, value)) }
    }
    @Command fun revealFile(invoke: Invoke) {
        val value = invoke.parseArgs(ExternalArgs::class.java).value
        launch(invoke, "파일 앱을 열지 못했어요.") { PublicDownloads.reveal(host, value) }
    }
}
