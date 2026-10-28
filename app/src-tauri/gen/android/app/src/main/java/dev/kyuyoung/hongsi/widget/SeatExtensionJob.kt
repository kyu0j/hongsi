package dev.kyuyoung.hongsi.widget

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.os.PersistableBundle
import android.widget.Toast
import org.json.JSONObject
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
                        WidgetReminders.rebuild(context, owner, "seat")
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
                    val moved = runCatching { WidgetReminders.rebuild(context, owner, "seat") }.isSuccess
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
