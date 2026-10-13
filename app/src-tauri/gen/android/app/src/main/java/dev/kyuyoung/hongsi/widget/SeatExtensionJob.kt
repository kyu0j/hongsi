package dev.kyuyoung.hongsi.widget

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.os.PersistableBundle
import android.widget.Toast
import app.tauri.notification.NotificationStorage
import app.tauri.notification.NotificationSchedule
import app.tauri.notification.TauriNotificationManager
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.DeserializationFeature
import com.fasterxml.jackson.databind.module.SimpleModule
import com.fasterxml.jackson.databind.JsonDeserializer
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.DeserializationContext
import com.fasterxml.jackson.core.JsonParser
import app.tauri.plugin.JSObject
import org.json.JSONObject
import java.util.Date
import java.util.UUID
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

class SeatExtensionJob : JobService() {
    companion object {
        private const val JOB = 7490
        @Volatile private var running = false
        fun pending(context: Context) = running || context.getSystemService(JobScheduler::class.java).getPendingJob(JOB) != null
        internal fun enqueue(context: Context, operation: String) {
            if (pending(context)) return
            val fields = operation.split(':')
            if (fields.size != 4 || fields[1].isBlank() || fields[1] != WidgetData.read(context).text("owner")) return
            val seat = fields[2].toLongOrNull()?.takeIf { it > 0 } ?: return
            val count = fields[3].toIntOrNull() ?: return
            if (count > 0) {
                result(context, "이미 한 번 연장했어요.")
                return
            }
            val extras = PersistableBundle().apply {
                putString("owner", fields[1]); putLong("seat", seat); putInt("count", count)
                putLong("created", System.currentTimeMillis()); putString("request", UUID.randomUUID().toString())
            }
            val job = JobInfo.Builder(JOB, ComponentName(context, SeatExtensionJob::class.java)).setExtras(extras).setOverrideDeadline(0).build()
            val accepted = context.getSystemService(JobScheduler::class.java).schedule(job) == JobScheduler.RESULT_SUCCESS
            if (!accepted) result(context, "다시 시도해 주세요.")
            Widgets.updateAll(context, preserveInput = true)
        }
        internal fun result(context: Context, message: String) {
            Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
        }
        internal fun rebuildReminders(context: Context, owner: String, after: JSONObject) {
            val mapper = ObjectMapper().disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES).registerModule(
                SimpleModule().addDeserializer(JSObject::class.java, object : JsonDeserializer<JSObject>() {
                    override fun deserialize(parser: JsonParser, context: DeserializationContext): JSObject = JSObject(parser.codec.readTree<JsonNode>(parser).toString())
                })
            )
            val storage = NotificationStorage(context, mapper)
            val manager = TauriNotificationManager(storage, null, context, null)
            val data = WidgetData.read(context)
            if (data.text("owner") != owner) return
            val policy = data.optJSONObject("seatReminders") ?: throw WidgetFailure(409, "앱에서 알림 설정을 확인해 주세요.")
            val account = policy.text("account")
            if (WidgetData.ownerHash(account) != owner) return
            val ids = storage.getSavedNotificationIds().mapNotNull { it.toIntOrNull() }.filter { it in 7000..7499 }
            manager.cancel(ids)
            if (!policy.optBoolean("enabled")) return
            val configured = policy.optJSONArray("leads") ?: return
            val leads = (0 until configured.length()).map { configured.optInt(it, -1) }.filter { it in listOf(60, 30, 10, 0) }.distinct()
            for ((index, lead) in leads.withIndex()) {
                if (WidgetData.read(context).text("owner") != owner) return
                val at = after.optLong("expiresAt") * 1000 - lead * 60_000L
                if (at <= System.currentTimeMillis()) continue
                val intent = JSONObject().put("version", 1).put("account", account).put("at", at)
                    .put("target", JSONObject().put("kind", "seat").put("id", after.optLong("id")))
                val notification = app.tauri.notification.Notification().apply {
                    id = 7000 + index
                    title = if (lead == 0) "좌석 이용 시간이 끝났어요." else "좌석 이용 종료까지 ${lead}분 남았어요."
                    body = ""; icon = "ic_notification"; iconColor = "#FF7A3D"; isAutoCancel = true
                    extra = JSObject().apply { put("intent", intent.toString()) }
                    schedule = NotificationSchedule.At().apply { date = Date(at); repeating = false; allowWhileIdle = true }
                }
                val date = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US).apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }.format(Date(at))
                notification.sourceJson = JSONObject().put("id", notification.id).put("title", notification.title).put("body", "")
                    .put("icon", notification.icon).put("iconColor", notification.iconColor).put("autoCancel", true).put("extra", notification.extra)
                    .put("schedule", JSONObject().put("at", JSONObject().put("date", date).put("repeating", false).put("allowWhileIdle", true))).toString()
                storage.appendNotifications(listOf(notification))
                try { manager.schedule(notification) }
                catch (e: Exception) { manager.cancel(listOf(notification.id)); throw e }
            }
        }
    }
    @Volatile private var stopped = false
    override fun onStartJob(params: JobParameters): Boolean {
        running = true
        stopped = false
        val context = applicationContext
        val extras = params.extras
        val owner = extras.getString("owner").orEmpty()
        Widgets.updateAll(context, preserveInput = true)
        WidgetSync.worker.execute {
            val outcome = runCatching {
                WidgetSync.locks.getOrPut("seats") { ReentrantLock() }.withLock {
                    if (owner.isBlank() || WidgetData.read(context).text("owner") != owner) throw WidgetFailure(409, "위젯을 새로고침해 주세요.")
                    if (System.currentTimeMillis() - extras.getLong("created") !in 0..120_000) throw WidgetFailure(408, "다시 시도해 주세요.")
                    val marker = context.getSharedPreferences("widget-seat-actions", Context.MODE_PRIVATE)
                    val request = extras.getString("request") ?: throw WidgetFailure(400, "다시 시도해 주세요.")
                    if (marker.getString("claimed", null) == request) throw WidgetFailure(409, "위젯을 새로고침해 주세요.")
                    val claim = marker.edit()
                    claim.putString("claimed", request)
                    if (!claim.commit()) throw WidgetFailure(500, "잠시 후 다시 시도해 주세요.")
                    val current = (WidgetNative.api(context, "/api/seats/session", owner = owner).body() as JSONObject).optJSONObject("session")
                    if (current == null || current.optLong("id") != extras.getLong("seat")) throw WidgetFailure(409, "현재 이용 중인 좌석을 확인해 주세요.")
                    if (current.optInt("extendCount") > 0) {
                        WidgetData.merge(context, owner, JSONObject().put("seat", current).put("updatedAt", JSONObject().put("seats", System.currentTimeMillis())))
                        rebuildReminders(context, owner, current)
                        throw WidgetFailure(409, "이미 한 번 연장했어요.")
                    }
                    if (current.optInt("extendCount") != extras.getInt("count")) throw WidgetFailure(409, "현재 이용 중인 좌석을 확인해 주세요.")
                    if (stopped || WidgetData.read(context).text("owner") != owner) throw WidgetFailure(409, "위젯을 새로고침해 주세요.")
                    val response = try { WidgetNative.api(context, "/api/seats/session/extend", "POST", owner = owner).body() as JSONObject }
                    catch (e: Exception) {
                        val actual = runCatching { WidgetNative.api(context, "/api/seats/session", owner = owner).body() as JSONObject }.getOrNull()
                        val saved = actual?.optJSONObject("session")
                        if (saved?.optLong("id") != current.optLong("id") || saved.optInt("extendCount") == 0) throw e
                        actual
                    }
                    val seat = response.optJSONObject("session") ?: throw WidgetFailure(500, "위젯을 새로고침해 주세요.")
                    if (seat.optLong("id") != current.optLong("id")) throw WidgetFailure(409, "현재 이용 중인 좌석을 확인해 주세요.")
                    val applied = WidgetData.merge(context, owner, JSONObject().put("seat", seat).put("updatedAt", JSONObject().put("seats", System.currentTimeMillis())).put("errors", JSONObject().put("seats", "")))
                    if (!applied) throw WidgetFailure(409, "위젯을 새로고침해 주세요.")
                    val moved = runCatching { rebuildReminders(context, owner, seat) }.isSuccess
                    if (moved) "이용 시간을 연장했어요." else "연장 후 알림을 갱신하지 못했어요."
                }
            }
            WidgetSync.main.post {
                running = false
                if (!stopped) jobFinished(params, false)
                if (WidgetData.read(context).text("owner") == owner) {
                    outcome.onSuccess { result(context, it) }
                        .onFailure { result(context, (it as? WidgetFailure)?.message ?: "위젯을 새로고침해 주세요.") }
                    WidgetNavigation.changed = true
                    WidgetSync.enqueue(context, WidgetKind.SEAT)
                }
                Widgets.updateAll(context, preserveInput = true)
            }
        }
        return true
    }
    override fun onStopJob(params: JobParameters): Boolean {
        stopped = true
        return false
    }
}
