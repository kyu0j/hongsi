package dev.kyuyoung.hongsi.widget

import android.content.Context
import org.json.JSONObject

internal data class WidgetAttendance(
    val title: String = "", val message: String, val detail: String = "",
    val available: Boolean = false, val tone: String = "muted", val identity: String = "", val kind: String = "",
)

internal object AttendanceState {
    private const val ACTIVE_MAX_AGE = 10 * 60_000L
    private val attended = setOf("present", "late", "excused")

    fun needsRefresh(data: JSONObject, now: Long = System.currentTimeMillis()): Boolean {
        if (data.text("owner").isBlank()) return false
        val snapshot = data.optJSONObject("attendance")
        val today = dateText(now / 1000)
        val sameDay = snapshot?.text("date") == today
        val age = now - (snapshot?.optLong("checkedAt") ?: 0)
        if (sameDay && age in 0 until 60_000) return false
        if (sameDay && age in 0 until ACTIVE_MAX_AGE && snapshot.array("active").any {
            it.optJSONObject("mark")?.text("kind") !in attended
        }) return true
        val saved = if (sameDay) snapshot.array("sessions") else emptyList()
        return WidgetAttendanceSnapshot.sessions(data.array("slots"), now).any { session ->
            now >= session.optLong("at") - 180_000 && now < session.optLong("at") + 3600_000 &&
                saved.firstOrNull { sameCourse(it, session) && it.optLong("at") == session.optLong("at") }
                    ?.optJSONObject("mark")?.text("kind") !in attended
        }
    }
    fun schedule(item: JSONObject, sessions: List<JSONObject> = emptyList()): String {
        item.text("scheduleLabel").takeIf(String::isNotBlank)?.let { return it }
        val matching = sessions.filter { sameCourse(it, item) }
        val clock = Regex("(?:^|\\D)(\\d{1,2}):(\\d{2})").find(item.text("time"))?.let { "${it.groupValues[1].padStart(2, '0')}:${it.groupValues[2]}" }
        val period = Regex("^\\s*([월화수목금토일])\\s*(\\d{1,2})(?:교시)?\\s*$").matchEntire(item.text("time"))
        val now = System.currentTimeMillis()
        val candidates = matching.filter {
            when {
                clock != null -> it.text("start") == clock
                period != null -> it.optInt("weekday", -1) == "월화수목금토일".indexOf(period.groupValues[1]) && it.optJSONArray("periods")?.optInt(0) == period.groupValues[2].toIntOrNull()
                else -> now in (it.optLong("at") - 180_000)..(it.optLong("at") + 600_000)
            }
        }
        val slot = if (item.has("weekday") && item.has("periods")) item else candidates.singleOrNull()
            ?: matching.singleOrNull().takeIf { clock == null && period == null }
            ?: return item.text("time")
        val day = "월화수목금토일".getOrNull(slot.optInt("weekday", -1))?.toString().orEmpty()
        val periods = slot.optJSONArray("periods")
        val index = if ((periods?.length() ?: 0) > 1 && slot.has("round")) (slot.optInt("round") - 1).coerceAtLeast(0) else 0
        val number = periods?.optInt(index)?.takeIf { it > 0 }?.toString().orEmpty()
        val start = slot.text("start").takeIf(String::isNotBlank)?.let { "$it 수업" }.orEmpty()
        return listOf(day + number, start, slot.text("room")).filter(String::isNotBlank).joinToString(" ")
    }
    fun pending(context: Context, state: JSONObject): WidgetAttendance {
        val lecture = state.optJSONObject("lecture") ?: JSONObject()
        val sessions = WidgetData.read(context).optJSONObject("attendance")?.array("sessions").orEmpty()
        return WidgetAttendance(lecture.text("name"), "출석을 확인하고 있어요.", schedule(lecture, sessions), tone = "primary", kind = "pending")
    }
    fun read(context: Context, state: JSONObject): WidgetAttendance = read(WidgetData.read(context), state)

    fun read(data: JSONObject, state: JSONObject, now: Long = System.currentTimeMillis()): WidgetAttendance {
        if (data.length() == 0) return WidgetAttendance(message = "로그인이 필요해요.", detail = "앱에서 로그인해 주세요.")
        val snapshot = data.optJSONObject("attendance")
            ?: return WidgetAttendance(message = "출석 정보를 확인해 주세요.", detail = "앱을 한 번 열어 주세요.")
        val today = dateText(now / 1000)
        val sameDay = snapshot.text("date") == today
        val age = now - snapshot.optLong("checkedAt")
        val sessions = snapshot.array("sessions").takeIf { sameDay }.orEmpty()
        val current = sessions.firstOrNull { now in (it.optLong("at") - 180_000)..(it.optLong("at") + 600_000) }
        val next = sessions.firstOrNull { it.optLong("at") > now }
        val active = if (sameDay && age in 0 until ACTIVE_MAX_AGE) snapshot.array("active") else emptyList()
        val open = active.firstOrNull { it.optJSONObject("mark")?.text("kind") !in attended }
        if (open != null) {
            return withSuccess(state, WidgetAttendance(open.text("name"), "출석할 수 있어요.", schedule(open, sessions), true, "primary", open.text("identity"), "available"), today, open.optJSONObject("mark"))
        }
        if (current != null) {
            current.optJSONObject("mark")?.let { return withSuccess(state, marked(current, it), today, it) }
            val base = WidgetAttendance(current.text("name"), "확인중", schedule(current), tone = "primary", identity = current.text("identity"), kind = "waiting")
            val confirmed = withSuccess(state, base, today)
            if (confirmed != base) return confirmed
            if (snapshot.text("error").isNotBlank()) return base.copy(message = "출석 정보를 불러오지 못했어요.", tone = "error", kind = "error")
            return base
        }
        if (active.isNotEmpty()) {
            val item = active.first()
            item.optJSONObject("mark")?.let { return withSuccess(state, marked(item, it, sessions), today, it) }
        }
        if (snapshot.text("error").isNotBlank() || snapshot.text("timetableError").isNotBlank()) return WidgetAttendance(message = "출석 정보를 불러오지 못했어요.", tone = "error", kind = "error")
        if (!snapshot.optBoolean("timetableLoaded")) return WidgetAttendance(message = "시간표를 확인해 주세요.", detail = "앱에서 시간표를 한 번 불러와 주세요.")
        if (!snapshot.optBoolean("loaded")) return WidgetAttendance(message = "출석 정보를 확인하고 있어요.", kind = "loading")
        if (!sameDay) return WidgetAttendance(message = "출석 정보를 확인해 주세요.", detail = "새로고침을 눌러 주세요.")
        if (sessions.isEmpty()) return WidgetAttendance(message = "오늘은 수업이 없어요.")
        if (next != null) return WidgetAttendance(next.text("name"), "다음 수업", schedule(next), kind = "next")
        if (sessions.any { now < it.optLong("at") + 3600_000 }) return WidgetAttendance(message = "출석할 수업이 없어요.")
        return WidgetAttendance(message = "오늘 수업이 모두 끝났어요.")
    }
    fun classStates(data: JSONObject, slot: JSONObject, now: Long = System.currentTimeMillis()): List<Pair<String, String>> {
        val snapshot = data.optJSONObject("attendance") ?: JSONObject()
        val sameDay = snapshot.text("date") == dateText(now / 1000)
        val saved = snapshot.array("sessions").takeIf { sameDay }.orEmpty()
        val sessions = WidgetAttendanceSnapshot.sessions(listOf(slot), now)
        return sessions.map { session ->
            val at = session.optLong("at")
            val item = saved.firstOrNull { sameCourse(it, session) && it.optLong("at") == at }
            val mark = item?.optJSONObject("mark")
            val state = if (mark != null) markLabel(mark) to when (markKind(mark)) { "absent" -> "danger"; "late" -> "warn"; "present", "excused" -> "ok"; else -> "muted" }
                else "확인 불가" to "muted"
            (if (sessions.size > 1) "${session.optInt("round")}회차 ${state.first}" else state.first) to state.second
        }
    }
    private fun markKind(mark: JSONObject) = if (mark.text("source") == "app") "present" else mark.text("kind")
    private fun markLabel(mark: JSONObject) = if (mark.text("source") == "app") "출석" else mark.text("label")
    private fun marked(item: JSONObject, mark: JSONObject, sessions: List<JSONObject> = emptyList()): WidgetAttendance {
        val kind = markKind(mark)
        val title = if (kind == "present") "출석 완료" else "${markLabel(mark)} 처리됨"
        return WidgetAttendance(item.text("name"), title, schedule(item, sessions), tone = when (kind) { "present", "excused" -> "success"; "absent" -> "error"; "late" -> "warn"; else -> "muted" }, identity = item.text("identity"), kind = kind)
    }
    private fun withSuccess(state: JSONObject, value: WidgetAttendance, today: String, mark: JSONObject? = null): WidgetAttendance {
        val receipt = state.optJSONObject("localReceipt") ?: return value
        if (mark?.text("source") == "school" && mark.optLong("at") > receipt.optLong("confirmedAt")) return value
        return if (value.identity.isNotBlank() && receipt.text("identity") == value.identity && receipt.text("date") == today) value.copy(message = "출석 완료", available = false, tone = "success", kind = "present") else value
    }
}
