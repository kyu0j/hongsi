package dev.kyuyoung.hongsi.widget

import org.json.JSONArray
import org.json.JSONObject

internal fun sameCourse(a: JSONObject, b: JSONObject): Boolean {
    if (a.text("code").isNotBlank() && b.text("code").isNotBlank()) return a.text("code") == b.text("code")
    fun name(o: JSONObject) = o.text("name").replace(Regex("\\(\\*\\)|\\s"), "")
    return name(a) == name(b)
}
internal object WidgetAttendanceSnapshot {
    private val labels = mapOf("present" to "출석", "late" to "지각", "excused" to "공결", "absent" to "결석")
    fun valid(receipt: JSONObject) = receipt.text("date") == dateText() && receipt.text("kind") in listOf("present", "late", "excused") && receipt.optJSONObject("lecture")?.text("key")?.isNotBlank() == true && dateText(receipt.optLong("confirmedAt") / 1000) == dateText()
    private fun identity(item: JSONObject) = "${dateText()}|${item.text("code").ifBlank { item.text("name").replace(Regex("\\(\\*\\)|\\s"), "") }}|${if (item.has("at")) item.optLong("at").toString() else item.text("key", "course") }"
    fun sessions(slots: List<JSONObject>, now: Long): List<JSONObject> {
        val midnight = Math.floorDiv(now + 32400_000, 86400_000) * 86400_000 - 32400_000
        return slots.filter { it.optInt("weekday") == weekday(now / 1000) }.flatMap { slot ->
            val periods = slot.optJSONArray("periods") ?: JSONArray().put(1)
            (0 until periods.length()).map { i ->
                val start = minutes(slot.text("start")) + (periods.optInt(i) - periods.optInt(0)) * 60
                JSONObject(slot.toString()).put("start", hm(start)).put("at", midnight + start * 60_000L).put("round", i + 1).put("periods", JSONArray().put(periods.optInt(i)))
            }
        }.sortedBy { it.optLong("at") }
    }
    fun make(slots: List<JSONObject>, active: List<JSONObject>, courses: List<JSONObject>, receipts: List<JSONObject>, checkedAt: Long = System.currentTimeMillis(), courseCheckedAt: JSONObject = JSONObject()): JSONObject {
        val now = checkedAt
        val sessions = sessions(slots, now)
        fun ref(lecture: JSONObject, at: Long = now): JSONObject {
            val time = Regex("(?:^|\\D)(\\d{1,2}):(\\d{2})").find(lecture.text("time"))?.let { "${it.groupValues[1].padStart(2, '0')}:${it.groupValues[2]}" }
            val period = Regex("^\\s*([월화수목금토일])\\s*(\\d{1,2})(?:교시)?\\s*$").matchEntire(lecture.text("time"))
            val matching = sessions.filter { sameCourse(it, lecture) }
            val matches = matching.filter {
                when {
                    time != null -> it.text("start") == time
                    period != null -> it.optInt("weekday") == "월화수목금토일".indexOf(period.groupValues[1]) && it.optJSONArray("periods")?.optInt(0) == period.groupValues[2].toInt()
                    else -> at in (it.optLong("at") - 180_000)..(it.optLong("at") + 600_000)
                }
            }
            val session = matches.singleOrNull() ?: matching.singleOrNull()?.takeIf { time == null && period == null }
            return if (session != null) JSONObject(session.toString()).put("key", lecture.text("key")) else JSONObject(lecture.toString())
        }
        fun entry(item: JSONObject): JSONObject? {
            val course = courses.filter { sameCourse(it, item) }.singleOrNull()
            if (course?.optBoolean("published") != true || course.optBoolean("cyber") || !item.has("at")) return null
            val lessonSessions = sessions.filter { sameCourse(it, item) }
            val index = lessonSessions.indexOfFirst { it.optLong("at") == item.optLong("at") }
            if (index < 0) return null
            val matching = slots.filter { sameCourse(it, item) }
            val weekly = (0..6).flatMap { day -> WidgetAttendanceSnapshot.sessions(matching, now + (day - weekday(now / 1000)) * 86400_000L) }
            val position = weekly.indexOfFirst { it.optLong("at") == item.optLong("at") }
            val dates = weekly.map { dateText(it.optLong("at") / 1000, "M/d") }
            val weeks = course.array("weeks").map { it.array("sessions") }.filter { entries ->
                entries.size == weekly.size && entries.withIndex().any { (i, e) -> e.text("date") == dates[i] } &&
                    entries.withIndex().all { (i, e) -> !Regex("\\d{1,2}/\\d{1,2}").matches(e.text("date")) || e.text("date") == dates[i] }
            }
            if (weeks.size == 1 && position >= 0) return weeks[0][position]
            val entries = course.array("weeks").flatMap { it.array("sessions") }.filter { it.text("date") == dateText(now / 1000, "M/d") }
            return if (entries.size == lessonSessions.size) entries[index] else null
        }
        fun mark(item: JSONObject): JSONObject? {
            val entry = entry(item)
            val label = entry?.let { labels[it.text("kind")] ?: it.text("mark").takeIf { _ -> it.text("kind") == "other" } }
            val receipt = receipts.filter { valid(it) }.sortedByDescending { it.optLong("confirmedAt") }.firstOrNull {
                val lecture = it.getJSONObject("lecture")
                (item.text("key").isNotBlank() && lecture.text("key") == item.text("key")) || identity(ref(lecture, it.optLong("confirmedAt"))) == identity(item)
            }
            val course = courses.singleOrNull { sameCourse(it, item) }
            val schoolAt = courseCheckedAt.optLong(course?.text("code").orEmpty(), checkedAt)
            if (!label.isNullOrBlank() && (receipt == null || schoolAt > receipt.optLong("confirmedAt"))) return JSONObject().put("kind", entry.text("kind")).put("label", label).put("source", "school").put("at", schoolAt)
            return receipt?.let { JSONObject().put("kind", "present").put("label", "출석").put("source", "app").put("at", it.optLong("confirmedAt")) }
        }
        val opened = active.map { lecture ->
            val item = ref(lecture)
            JSONObject(lecture.toString()).put("scheduleLabel", AttendanceState.schedule(lecture, sessions)).put("identity", identity(item)).put("mark", mark(item) ?: JSONObject.NULL)
        }
        return JSONObject().put("date", dateText()).put("loaded", true).put("error", "").put("timetableLoaded", true).put("timetableError", "").put("checkedAt", now)
            .put("sessions", JSONArray(sessions.map { it.put("identity", identity(it)).put("mark", mark(it) ?: JSONObject.NULL) }))
            .put("active", JSONArray(opened))
    }
}

internal object WidgetAttendanceCourses {
    data class Plan(val cache: JSONObject, val requests: List<String>)
    fun plan(data: JSONObject, active: List<JSONObject>, force: Boolean, now: Long): Plan {
        val today = dateText(now / 1000)
        val timetableAt = data.optJSONObject("updatedAt")?.optLong("timetable") ?: 0
        val slots = data.array("slots")
        val sessions = WidgetAttendanceSnapshot.sessions(slots, now)
        val activeCodes = active.mapNotNull { lecture ->
            lecture.text("code").takeIf(String::isNotBlank)
                ?: slots.filter { sameCourse(it, lecture) }.map { it.text("code") }.distinct().singleOrNull()?.takeIf(String::isNotBlank)
        }.toSet()
        val codes = (sessions.map { it.text("code") } + activeCodes).filter(String::isNotBlank).distinct().sorted()
        val previous = data.optJSONObject("attendance")
        val saved = previous?.array("sessions").orEmpty().takeIf { previous?.text("date") == today }.orEmpty()
        val hot = activeCodes + sessions.filter { session ->
            now >= session.optLong("at") - 180_000 && now < session.optLong("at") + 3600_000 &&
                saved.firstOrNull { sameCourse(it, session) && it.optLong("at") == session.optLong("at") }
                    ?.optJSONObject("mark")?.text("kind") !in listOf("present", "late", "excused")
        }.map { it.text("code") }
        val previousCache = data.optJSONObject("attendanceCourses") ?: JSONObject()
        val stored = previousCache.optJSONObject("items")?.takeIf {
            previousCache.text("date") == today && previousCache.optLong("timetableAt") == timetableAt
        }
        val items = JSONObject()
        codes.forEach { code -> stored?.optJSONObject(code)?.takeIf {
            it.optLong("checkedAt") in 1..now && it.optJSONObject("data") != null
        }?.let { items.put(code, JSONObject(it.toString())) } }
        val requests = codes.filter { code ->
            val entry = items.optJSONObject(code)
            val age = now - (entry?.optLong("checkedAt") ?: 0)
            force || code in hot || entry?.optJSONObject("data") == null || age !in 0 until 15 * 60_000L
        }.sortedBy { if (it in hot) 0 else 1 }
        return Plan(JSONObject().put("date", today).put("timetableAt", timetableAt).put("items", items), requests)
    }
}
