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
    fun make(slots: List<JSONObject>, active: List<JSONObject>, courses: List<JSONObject>, receipts: List<JSONObject>, previous: JSONObject?, checkedAt: Long = System.currentTimeMillis()): JSONObject {
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
            if (!label.isNullOrBlank() && (receipt == null || checkedAt > receipt.optLong("confirmedAt"))) return JSONObject().put("kind", entry.text("kind")).put("label", label).put("source", "school")
            return receipt?.let { JSONObject().put("kind", it.text("kind")).put("label", labels[it.text("kind")]).put("source", "app") }
        }
        val opened = active.map { lecture ->
            val item = ref(lecture)
            JSONObject(lecture.toString()).put("scheduleLabel", AttendanceState.schedule(lecture, sessions)).put("identity", identity(item)).put("mark", mark(item) ?: JSONObject.NULL)
        }
        val seen = (previous?.array("sessions").orEmpty().filter { it.optBoolean("seenOpen") }.map { it.text("identity") } + opened.map { it.text("identity") }).toSet()
        return JSONObject().put("date", dateText()).put("loaded", true).put("error", "").put("timetableLoaded", true).put("timetableError", "").put("checkedAt", now)
            .put("sessions", JSONArray(sessions.map { it.put("identity", identity(it)).put("mark", mark(it) ?: JSONObject.NULL).put("unrecorded", entry(it)?.text("kind") in listOf("planned", "none")).put("seenOpen", seen.contains(identity(it))) }))
            .put("active", JSONArray(opened))
    }
}
