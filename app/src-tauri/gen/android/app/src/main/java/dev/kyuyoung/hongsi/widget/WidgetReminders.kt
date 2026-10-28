package dev.kyuyoung.hongsi.widget

import android.content.Context
import app.tauri.notification.NotificationStorage
import app.tauri.notification.NotificationSchedule
import app.tauri.notification.TauriNotificationManager
import app.tauri.plugin.JSObject
import com.fasterxml.jackson.core.JsonParser
import com.fasterxml.jackson.databind.DeserializationContext
import com.fasterxml.jackson.databind.DeserializationFeature
import com.fasterxml.jackson.databind.JsonDeserializer
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.module.SimpleModule
import org.json.JSONObject
import java.util.Date

internal data class WidgetReminder(val at: Long, val title: String, val body: String, val intent: JSONObject) {
    val key: String get() = reminderKey(intent)
}

private fun reminderKey(intent: JSONObject): String {
    val target = intent.optJSONObject("target") ?: JSONObject()
    return "${intent.text("account")}:${target.text("kind")}:${target.text("key", target.optLong("id").toString())}:${intent.optLong("at")}"
}

internal object WidgetReminders {
    fun plan(data: JSONObject, channel: String, now: Long = System.currentTimeMillis()): List<WidgetReminder>? {
        val policy = data.optJSONObject("${channel}Reminders") ?: return null
        val account = policy.text("account")
        if (account.isBlank() || WidgetData.ownerHash(account) != data.text("owner")) return null
        if (!policy.optBoolean("enabled")) return emptyList()
        val output = mutableListOf<WidgetReminder>()
        fun add(at: Long, title: String, body: String, target: JSONObject) {
            if (at <= now) return
            val intent = JSONObject().put("version", 1).put("account", account).put("at", at).put("target", target)
            output.add(WidgetReminder(at, title, body, intent))
        }
        fun leads(value: org.json.JSONArray?, allowed: Set<Int>): List<Int> = if (value == null) emptyList() else
            (0 until value.length()).map { value.optInt(it, -1) }.filter { it in allowed }.distinct()
        if (channel == "seat") {
            val seat = data.optJSONObject("seat") ?: return emptyList()
            if (seat.optLong("id") <= 0 || !seat.isNull("endedAt")) return emptyList()
            for (lead in leads(policy.optJSONArray("leads"), setOf(60, 30, 10, 0))) {
                add(seat.optLong("expiresAt") * 1000 - lead * 60_000L,
                    if (lead == 0) "좌석 이용 시간이 끝났어요." else "좌석 이용 종료까지 ${lead}분 남았어요.", "",
                    JSONObject().put("kind", "seat").put("id", seat.optLong("id")))
            }
        } else {
            val preferences = data.optJSONObject("preferences") ?: return null
            if (data.text("semesterDisplay") != WidgetData.semesterDisplay(preferences.text("semesterDisplay", "current"))) return null
            val defaults = preferences.optJSONArray("alertLeads") ?: return null
            for (item in data.array("deadlines")) {
                if (item.optBoolean("done") || (!item.isNull("alert") && !item.optBoolean("alert")) || item.isNull("due")) continue
                val key = item.text("key")
                val todo = item.text("kind") == "todo"
                val target = if (todo) {
                    val id = key.removePrefix("todo:").toLongOrNull()?.takeIf { it > 0 } ?: continue
                    JSONObject().put("kind", "todo").put("id", id)
                } else {
                    if (!key.matches(Regex("(assign|vod):[0-9]+"))) continue
                    JSONObject().put("kind", "item").put("key", key)
                }
                val kind = if (todo) "할 일" else if (item.text("kind") == "vod") "온라인 강의" else "과제"
                val due = item.optLong("due")
                val previous = preferences.text("midnight", "prev") != "same" && dateText(due, "HH:mm") == "00:00"
                val day = if (previous) due - 60 else due
                val time = if (previous) "24:00" else dateText(due, "HH:mm")
                val course = if (todo) item.text("reminderCourse") else item.text("course").split(Regex("[\\s(]")).firstOrNull().orEmpty()
                val title = item.text("title")
                val name = if (course.isNotBlank() && (todo || !title.startsWith(course))) "$course · $title" else title
                for (lead in leads(item.optJSONArray("alertLeads") ?: defaults, setOf(1440, 180, 60, 10, 0))) {
                    val at = due * 1000 - lead * 60_000L
                    val sameDay = dateText(at / 1000) == dateText(day)
                    val whenText = if (todo && item.optBoolean("allDay")) {
                        if (sameDay) "오늘" else dateText(day, "M/d(E)")
                    } else if (sameDay) time else "${dateText(day, "M/d(E)")} $time"
                    val leadText = when (lead) { 1440 -> "하루 전"; 180 -> "3시간 전"; 60 -> "1시간 전"; else -> "${lead}분 전" }
                    add(at, if (lead == 0) "$kind 마감 시간이에요." else "$kind 마감 ${leadText}이에요.", "$name · ${whenText}까지", target)
                }
            }
        }
        return output.distinctBy { it.key }.sortedWith(compareBy({ it.at }, { it.key })).take(if (channel == "seat") 6 else 400)
    }

    @Synchronized fun rebuild(context: Context, owner: String, channel: String) {
        val data = WidgetData.read(context)
        if (owner.isBlank() || data.text("owner") != owner) return
        val plan = plan(data, channel) ?: return
        val mapper = ObjectMapper().disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES).registerModule(
            SimpleModule().addDeserializer(JSObject::class.java, object : JsonDeserializer<JSObject>() {
                override fun deserialize(parser: JsonParser, context: DeserializationContext): JSObject = JSObject(parser.codec.readTree<JsonNode>(parser).toString())
            })
        )
        val storage = NotificationStorage(context, mapper)
        val manager = TauriNotificationManager(storage, null, context, null)
        val base = if (channel == "seat") 7000 else 8000
        val ids = storage.getSavedNotificationIds().mapNotNull(String::toIntOrNull).filter { it in base until base + 500 }
        val saved = ids.mapNotNull { id -> storage.getSavedNotification(id.toString())?.let { id to it } }.toMap()
        val byKey = saved.values.mapNotNull { n ->
            runCatching { JSONObject(n.extra?.optString("intent").orEmpty()) }.getOrNull()?.let { reminderKey(it) to n.id }
        }.toMap()
        val assigned = plan.mapNotNull { r -> byKey[r.key]?.let { r.key to it } }.toMap().toMutableMap()
        val used = assigned.values.toMutableSet()
        for (r in plan) if (r.key !in assigned) {
            val id = (base until base + 500).first { it !in used }
            assigned[r.key] = id; used.add(id)
        }
        val retained = plan.mapNotNull { r -> assigned[r.key]?.takeIf { saved[it]?.title == r.title && saved[it]?.body.orEmpty() == r.body && byKey[r.key] == it } }.toSet()
        if (WidgetData.read(context).text("owner") != owner) return
        manager.cancel(ids.filter { it !in retained })
        for (r in plan) {
            val id = assigned.getValue(r.key)
            if (id in retained || r.at <= System.currentTimeMillis()) continue
            if (WidgetData.read(context).text("owner") != owner) return
            val notification = app.tauri.notification.Notification().apply {
                this.id = id; title = r.title; body = r.body
                icon = "ic_notification"; iconColor = "#FF7A3D"; isAutoCancel = true
                extra = JSObject().apply { put("intent", r.intent.toString()) }
                schedule = NotificationSchedule.At().apply { date = Date(r.at); repeating = false; allowWhileIdle = true }
            }
            val date = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US).apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }.format(Date(r.at))
            notification.sourceJson = JSONObject().put("id", id).put("title", r.title).put("body", r.body)
                .put("icon", notification.icon).put("iconColor", notification.iconColor).put("autoCancel", true).put("extra", notification.extra)
                .put("schedule", JSONObject().put("at", JSONObject().put("date", date).put("repeating", false).put("allowWhileIdle", true))).toString()
            storage.appendNotifications(listOf(notification))
            try { manager.schedule(notification) }
            catch (e: Exception) { manager.cancel(listOf(id)); throw e }
        }
    }
}
