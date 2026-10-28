package dev.kyuyoung.hongsi.widget

import androidx.core.net.toUri
import androidx.core.graphics.withClip
import androidx.core.graphics.toColorInt
import androidx.core.graphics.createBitmap
import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.app.PendingIntent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.Icon
import android.os.Build
import android.os.SystemClock
import android.text.SpannableString
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.text.style.RelativeSizeSpan
import android.text.style.StyleSpan
import android.view.View
import android.widget.RemoteViews
import android.widget.FrameLayout
import dev.kyuyoung.hongsi.R
import org.json.JSONObject
import kotlin.math.roundToInt
import kotlin.math.max
import kotlin.math.min

internal object WidgetViews {
    private fun color(context: Context, resource: Int) = context.getColor(resource)
    private fun layout(context: Context, resource: Int) = WidgetTheme.layout(context, resource)
    private fun RemoteViews.text(id: Int, value: String) = setTextViewText(id, value)
    private fun RemoteViews.action(context: Context, id: Int, kind: WidgetKind, view: Int, operation: String) = setOnClickPendingIntent(view, Widgets.pending(context, id, kind, operation))
    private fun RemoteViews.page(context: Context, id: Int, kind: WidgetKind, view: Int, detail: String = "") = setOnClickPendingIntent(view, Widgets.page(context, id, kind, detail))
    private fun RemoteViews.themeText(context: Context, view: Int, resource: Int) {
        if (Build.VERSION.SDK_INT >= 31) setColor(view, "setTextColor", WidgetTheme.resource(context, resource))
        else setTextColor(view, color(context, resource))
    }
    private fun keypad(context: Context, id: Int, kind: WidgetKind, height: Int): RemoteViews = layout(context, R.layout.widget_keypad).apply {
        page(context, id, kind, R.id.widget_root)
        val codeAdapter = Intent(context, WidgetKeyService::class.java).setData(("hongsi-widget://code/$id/${WidgetTheme.mode(context)}").toUri()).putExtra("widget", id).putExtra("codeDisplay", true)
        @Suppress("DEPRECATION")
        setRemoteAdapter(R.id.widget_code_host, codeAdapter)
        setPendingIntentTemplate(R.id.widget_code_host, Widgets.page(context, id, kind))
        page(context, id, kind, R.id.widget_code_label)
        val adapter = Intent(context, WidgetKeyService::class.java).setData(("hongsi-widget://keys/$id/$height/${WidgetTheme.mode(context)}").toUri()).putExtra("height", height)
        @Suppress("DEPRECATION")
        setRemoteAdapter(R.id.widget_keys, adapter)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
        setPendingIntentTemplate(R.id.widget_keys, PendingIntent.getBroadcast(context, 0,
            Intent(context, kind.receiver).setAction(Widgets.ACTION).setData(("hongsi-widget://keys-action/$id").toUri()).putExtra("widget", id).addFlags(Intent.FLAG_RECEIVER_FOREGROUND), flags))
        action(context, id, kind, R.id.widget_back, "back")
        action(context, id, kind, R.id.widget_erase, "erase")
        setOnClickPendingIntent(R.id.widget_submit, WidgetAttendanceService.intent(context, id))
    }
    fun render(base: Context, id: Int, kind: WidgetKind): RemoteViews {
        WidgetTheme.observe(base)
        val context = WidgetTheme.context(base)
        val state = WidgetData.state(context, id)
        val data = WidgetData.read(context)
        val resource = if (kind.deadlines) "calendar" else if (kind == WidgetKind.SEAT) "seats" else "timetable"
        val failed = !kind.savedTimetable && !kind.today && WidgetData.error(context, resource).isNotBlank()
        val mode = state.text("mode", "ready")
        val options = if (id > 0) AppWidgetManager.getInstance(context).getAppWidgetOptions(id) else android.os.Bundle()
        val height = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, kind.height)
        val width = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 340)
        if (kind == WidgetKind.SEAT) return seatView(context, id, kind)
        if (kind.attendance && WidgetAttendanceService.pending(context)) return attendanceView(context, id, kind, state, height)
        if (kind.attendance && mode == "input" && data.length() > 0 && System.currentTimeMillis() - state.optLong("inputAt") < 600_000) return keypad(context, id, kind, height)
        val weekOnly = kind == WidgetKind.WEEK
        val view = layout(context, if (weekOnly) R.layout.widget_week else R.layout.widget_list_card)
        if (kind.attendance) return attendanceView(context, id, kind, state, height)
        view.page(context, id, kind, if (weekOnly) R.id.widget_body else R.id.widget_list_root)
        if (kind.deadlines) {
            val density = context.resources.displayMetrics.density
            val horizontal = (12 * density).toInt()
            val vertical = (6 * density).toInt()
            view.setViewPadding(R.id.widget_list_root, horizontal, vertical, horizontal, vertical)
        }
        if (!weekOnly) {
            view.text(R.id.widget_title, if (kind.deadlines) "다가오는 마감" else if (kind.today) "오늘 수업" else kind.title)
            view.page(context, id, kind, R.id.widget_title)
            refresh(context, id, kind, view)
        }
        view.removeAllViews(R.id.widget_body)
        if (data.length() == 0 || failed) {
            val title = if (data.length() == 0) "앱에서 로그인해 주세요." else if (failed) "정보를 불러오지 못했어요." else when {
                kind.today -> "오늘은 수업이 없어요."
                weekOnly -> "등록된 수업이 없어요."
                kind.deadlines -> "남은 일정이 없어요."
                else -> "출석할 수업이 없어요."
            }
            if (weekOnly) return weekStatus(context, id, kind, title)
            view.addView(R.id.widget_body, empty(context, title))
            return view
        }
        if ((kind.savedTimetable || kind.today) && !WidgetData.hasTimetable(data)) {
            val message = if (WidgetData.error(context, "timetable").isNotBlank() || (kind.today && WidgetData.error(context, "lectures").isNotBlank())) "정보를 불러오지 못했어요." else "앱에서 시간표를 한 번 불러와 주세요."
            if (weekOnly) return weekStatus(context, id, kind, message)
            view.addView(R.id.widget_body, empty(context, message))
            return view
        }
        when (kind) {
            WidgetKind.ATTENDANCE -> Unit
            WidgetKind.TODAY, WidgetKind.TODAY_LARGE -> {
                val all = WidgetData.today(context)
                val selected = weekday()
                view.text(R.id.widget_title, if (selected == weekday()) "오늘 수업" else "${"월화수목금토일"[selected]}요일 수업")
                val remaining = if (selected == weekday()) all.filter { minutes(it.text("start")) + (it.optJSONArray("periods")?.length() ?: 1) * 60 > minuteOfDay() } else all
                if (remaining.isEmpty()) view.addView(R.id.widget_body, empty(context, if (all.isEmpty()) "오늘은 수업이 없어요." else "오늘 수업이 모두 끝났어요."))
                view.setInt(R.id.widget_list_root, "setBackgroundResource", WidgetTheme.resource(context, R.drawable.widget_today_surface))
                view.themeText(context, R.id.widget_title, R.color.widget_app_text)
                val list = layout(context, R.layout.widget_class_list)
                list.setInt(R.id.class_rows, "setBackgroundResource", WidgetTheme.resource(context, R.drawable.widget_class_surface))
                var used = 0
                for ((index, slot) in remaining.withIndex()) {
                    val states = AttendanceState.classStates(data, slot)
                    val rowHeight = max(if (kind == WidgetKind.TODAY_LARGE) 64 else 50, states.size * 24 + 12)
                    if (used + rowHeight > height - 72 && used > 0) break
                    used += rowHeight
                    val row = row(context, slot.text("start"), slot.text("name"), slot.text("room", "강의실 미정"), "", slot.text("color"))
                    row.setInt(R.id.row_content, "setMinimumHeight", (rowHeight * context.resources.displayMetrics.density).roundToInt())
                    row.page(context, id, kind, R.id.widget_row_root, "class:${slot.text("name")}")
                    row.setViewVisibility(R.id.row_separator, if (index == 0) View.GONE else View.VISIBLE)
                    row.themeText(context, R.id.row_title, R.color.widget_app_text)
                    row.themeText(context, R.id.row_subtitle, R.color.widget_app_muted)
                    val watching = WidgetAttendanceSnapshot.sessions(listOf(slot), System.currentTimeMillis()).any { System.currentTimeMillis() in (it.optLong("at") - 180_000)..(it.optLong("at") + 600_000) }
                    row.themeText(context, R.id.row_time, if (watching) R.color.widget_app_primary_text else R.color.widget_app_text)
                    row.setInt(R.id.row_title, "setMaxLines", if (kind == WidgetKind.TODAY_LARGE) 2 else 1)
                    row.setViewVisibility(R.id.row_badge, View.GONE)
                    row.removeAllViews(R.id.row_badges)
                    states.forEach { (label, tone) ->
                        val badge = layout(context, R.layout.widget_class_status)
                        badge.text(R.id.class_status, label)
                        val appearance = when (tone) {
                            "ok" -> R.drawable.widget_class_badge_ok to R.color.widget_app_ok
                            "warn" -> R.drawable.widget_class_badge_warn to R.color.widget_app_warn
                            "danger" -> R.drawable.widget_class_badge_danger to R.color.widget_app_danger
                            "primary" -> R.drawable.widget_class_badge_primary to R.color.widget_app_primary_text
                            else -> R.drawable.widget_class_badge_muted to R.color.widget_app_muted
                        }
                        badge.setInt(R.id.class_status, "setBackgroundResource", WidgetTheme.resource(context, appearance.first))
                        badge.themeText(context, R.id.class_status, appearance.second)
                        row.addView(R.id.row_badges, badge)
                    }
                    list.addView(R.id.class_rows, row)
                }
                if (remaining.isNotEmpty()) view.addView(R.id.widget_body, list)
            }
            WidgetKind.DEADLINES, WidgetKind.DEADLINES_LARGE -> {
                val items = WidgetData.deadlines(context)
                if (items.isEmpty()) view.addView(R.id.widget_body, empty(context, "남은 일정이 없어요."))
                val density = context.resources.displayMetrics.density
                val available = (height * density).toInt() - (40 * density).roundToInt() - 2 * (6 * density).toInt()
                val rowWidth = ((width * density).toInt() - 2 * (12 * density).toInt()).coerceAtLeast(1)
                var used = 0
                var visibleCount = 0
                for (item in items) {
                    val due = if (item.isNull("due")) 0 else item.optLong("due")
                    val difference = WidgetData.deadlineDay(context, item) - Math.floorDiv(nowSeconds() + 32400, 86400)
                    val deadline = WidgetData.deadlineLabel(context, item)
                    val todo = item.text("kind") == "todo"
                    val row = layout(context, R.layout.widget_deadline_row)
                    val accent = runCatching { (item.text("color")).toColorInt() }.getOrDefault(color(context, if (todo) R.color.widget_todo_neutral else R.color.widget_muted))
                    row.setInt(R.id.deadline_accent, "setColorFilter", accent)
                    val icon = when (item.text("kind")) { "todo" -> R.drawable.ic_widget_todo; "vod" -> R.drawable.ic_widget_vod; else -> R.drawable.ic_widget_assignment }
                    row.setImageViewResource(R.id.deadline_kind, WidgetTheme.resource(context, icon))
                    row.setInt(R.id.deadline_kind, "setColorFilter", accent)
                    row.text(R.id.row_title, item.text("title"))
                    row.text(R.id.row_subtitle, item.text("course").ifBlank { if (todo) "공통" else "" })
                    row.text(R.id.row_deadline, deadline.replace(" 하루 종일", " 하루\u00a0종일").replace(" 마감", "\u00a0마감"))
                    row.text(R.id.row_badge, if (due == 0L) "미정" else if (difference <= 0) "D-DAY" else "D-$difference")
                    row.themeText(context, R.id.row_badge, if (difference <= 3 && due != 0L) R.color.widget_deadline_soon else R.color.widget_muted)
                    val status = item.text("status").ifBlank { "상태 확인 필요" }
                    val tone = when (status) {
                        "제출 완료", "출석 인정", "완료" -> R.drawable.widget_badge_ok to R.color.widget_badge_ok_text
                        "미제출", "미시청", "부분 인정", "미완료" -> R.drawable.widget_badge_warn to R.color.widget_badge_warn_text
                        "마감 지남", "미인정" -> R.drawable.widget_badge_danger to R.color.widget_badge_danger_text
                        "시청 전" -> R.drawable.widget_badge_info to R.color.widget_badge_info_text
                        else -> R.drawable.widget_badge_muted to R.color.widget_badge_muted_text
                    }
                    row.setViewVisibility(R.id.row_status, if (todo) View.GONE else View.VISIBLE)
                    row.text(R.id.row_status, status)
                    row.setInt(R.id.row_status, "setBackgroundResource", WidgetTheme.resource(context, tone.first))
                    row.themeText(context, R.id.row_status, tone.second)
                    row.page(context, id, kind, R.id.widget_row_root, "deadline:${item.text("key")}")
                    val measured = row.apply(context, FrameLayout(context))
                    measured.measure(View.MeasureSpec.makeMeasureSpec(rowWidth, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
                    val footer = if (visibleCount + 1 < items.size) (20 * density).toInt() else 0
                    if (visibleCount > 0 && used + measured.measuredHeight + footer > available) break
                    used += measured.measuredHeight
                    visibleCount++
                    view.addView(R.id.widget_body, row)
                }
                val hiddenCount = items.size - visibleCount
                view.setViewVisibility(R.id.widget_more, if (hiddenCount > 0) View.VISIBLE else View.GONE)
                view.text(R.id.widget_more, if (hiddenCount > 0) "+ ${hiddenCount}개의 마감" else "")
            }
            WidgetKind.WEEK -> {
                if (WidgetData.slots(context).isEmpty()) return weekStatus(context, id, kind, "등록된 수업이 없어요.")
                else {
                    val grid = layout(context, R.layout.widget_week_grid)
                    val gridWidth = max(260, width - 16)
                    val gridHeight = max(160, height - 16)
                    if (Build.VERSION.SDK_INT >= 31 && WidgetTheme.mode(context) == "system") {
                        grid.setIcon(R.id.widget_grid, "setImageIcon",
                            Icon.createWithBitmap(weekBitmap(WidgetTheme.context(context, "light"), gridWidth, gridHeight)),
                            Icon.createWithBitmap(weekBitmap(WidgetTheme.context(context, "dark"), gridWidth, gridHeight)))
                    } else grid.setImageViewBitmap(R.id.widget_grid, weekBitmap(context, gridWidth, gridHeight))
                    grid.page(context, id, kind, R.id.widget_grid, "week")
                    view.addView(R.id.widget_body, grid)
                }
            }
            WidgetKind.SEAT -> Unit
        }
        return view
    }
    private fun attendanceView(context: Context, id: Int, kind: WidgetKind, state: JSONObject, height: Int): RemoteViews {
        val value = if (WidgetAttendanceService.pending(context)) AttendanceState.pending(context, state) else AttendanceState.read(context, state)
        return layout(context, R.layout.widget_card).apply {
            page(context, id, kind, R.id.widget_root)
            text(R.id.attendance_course, value.title)
            val empty = value.title.isBlank()
            setViewVisibility(R.id.attendance_course, if (empty) View.GONE else View.VISIBLE)
            val active = value.available || value.kind == "waiting"
            setInt(R.id.widget_root, "setBackgroundResource", WidgetTheme.resource(context, if (active) R.drawable.widget_attendance_active else R.drawable.widget_attendance_surface))
            themeText(context, R.id.widget_title, if (active) R.color.widget_app_primary_text else R.color.widget_app_muted)
            refresh(context, id, kind, this, value.kind == "loading")
            if (height < 144) {
                val padding = (8 * context.resources.displayMetrics.density).roundToInt()
                setViewPadding(R.id.widget_root, padding, padding, padding, padding)
                setInt(R.id.attendance_course, "setMaxLines", 1)
                setTextViewTextSize(R.id.attendance_course, android.util.TypedValue.COMPLEX_UNIT_SP, 16f)
            }
            setViewVisibility(R.id.widget_body, if (empty) View.GONE else View.VISIBLE)
            setViewVisibility(R.id.widget_empty_body, if (empty) View.VISIBLE else View.GONE)
            removeAllViews(R.id.widget_body)
            removeAllViews(R.id.widget_empty_body)
            val badge = value.kind in listOf("present", "late", "excused", "absent", "other", "next")
            val tone = when (value.tone) {
                "success" -> R.color.widget_app_ok
                "error" -> R.color.widget_app_danger
                "warn", "primary" -> R.color.widget_app_primary_text
                else -> R.color.widget_app_muted
            }
            val content = layout(context, if (empty) R.layout.widget_attendance_empty else R.layout.widget_attendance_body).apply {
                text(R.id.attendance_message, value.message)
                text(R.id.attendance_detail, value.detail)
                val sharedError = WidgetData.read(context).optJSONObject("attendance")?.text("receiptError").orEmpty().isNotBlank()
                setViewVisibility(R.id.attendance_shared_error, if (sharedError) View.VISIBLE else View.GONE)
                themeText(context, R.id.attendance_message, if (empty) R.color.widget_app_muted else tone)
                setViewVisibility(R.id.attendance_detail, if (value.detail.isBlank() || height < 144) View.GONE else View.VISIBLE)
                if (!empty) {
                    setViewVisibility(R.id.attendance_status_row, if (badge) View.GONE else View.VISIBLE)
                    setViewVisibility(R.id.attendance_status_dot, if (active) View.VISIBLE else View.GONE)
                    setViewVisibility(R.id.widget_primary, if (active) View.VISIBLE else View.GONE)
                    text(R.id.widget_primary, if (value.available) "출석하기" else "확인중")
                    setTextViewCompoundDrawables(R.id.widget_primary, if (value.available) R.drawable.ic_widget_tick_on_primary else 0, 0, 0, 0)
                    setBoolean(R.id.widget_primary, "setEnabled", value.available)
                    setFloat(R.id.widget_primary, "setAlpha", if (value.available) 1f else 0.45f)
                    if (value.available) action(context, id, kind, R.id.widget_primary, "open")
                    else setOnClickPendingIntent(R.id.widget_primary, null)
                    setViewVisibility(R.id.attendance_badge_area, if (badge) View.VISIBLE else View.GONE)
                    text(R.id.attendance_badge, value.message)
                    themeText(context, R.id.attendance_badge, tone)
                    val background = when (value.tone) {
                        "success" -> R.drawable.widget_attendance_badge_ok
                        "warn" -> R.drawable.widget_attendance_badge_warn
                        "error" -> R.drawable.widget_attendance_badge_danger
                        else -> R.drawable.widget_attendance_badge_muted
                    }
                    setInt(R.id.attendance_badge_area, "setBackgroundResource", WidgetTheme.resource(context, background))
                    val icon = when (value.kind) {
                        "present", "excused" -> R.drawable.ic_widget_tick
                        "late" -> R.drawable.ic_widget_clock
                        "absent" -> R.drawable.ic_widget_cross
                        else -> null
                    }
                    setViewVisibility(R.id.attendance_badge_icon, if (icon == null) View.GONE else View.VISIBLE)
                    if (icon != null) {
                        setImageViewResource(R.id.attendance_badge_icon, WidgetTheme.resource(context, icon))
                        setInt(R.id.attendance_badge_icon, "setColorFilter", color(context, tone))
                    }
                    page(context, id, kind, R.id.attendance_badge_area)
                }
                page(context, id, kind, R.id.attendance_message)
                page(context, id, kind, R.id.attendance_detail)
            }
            addView(if (empty) R.id.widget_empty_body else R.id.widget_body, content)
        }
    }
    private fun refresh(context: Context, id: Int, kind: WidgetKind, view: RemoteViews, loading: Boolean = false) {
        view.action(context, id, kind, R.id.widget_refresh, "refresh")
        val active = loading || Widgets.refreshing(kind)
        view.setViewVisibility(R.id.refresh_icon, if (active) View.INVISIBLE else View.VISIBLE)
        view.setViewVisibility(R.id.refresh_spinner, if (active) View.VISIBLE else View.GONE)
    }
    private fun status(context: Context, id: Int, kind: WidgetKind, message: String): RemoteViews = layout(context, R.layout.widget_status).apply {
        page(context, id, kind, R.id.widget_root)
        text(R.id.widget_empty, message)
        page(context, id, kind, R.id.widget_empty)
        refresh(context, id, kind, this)
    }
    private fun weekStatus(context: Context, id: Int, kind: WidgetKind, message: String): RemoteViews = status(context, id, kind, message).apply {
        setViewVisibility(R.id.widget_refresh, View.GONE)
    }
    private fun empty(context: Context, message: String): RemoteViews = layout(context, R.layout.widget_dashed_state).apply { text(R.id.widget_empty, message) }
    private fun seatView(context: Context, id: Int, kind: WidgetKind): RemoteViews {
        val failed = WidgetData.error(context, "seats").isNotBlank()
        val seat = if (failed) null else WidgetData.seat(context)
        if (seat == null) return status(context, id, kind, if (failed) "정보를 불러오지 못했어요." else if (WidgetData.read(context).length() == 0) "앱에서 로그인해 주세요." else "이용 중인 좌석이 없어요.")
        val view = layout(context, R.layout.widget_seat)
        view.page(context, id, kind, R.id.widget_root)
        val remaining = max(0L, seat.optLong("expiresAt") * 1000 - System.currentTimeMillis())
        val expired = remaining == 0L
        val building = seat.text("buildingName")
        val code = seat.text("building").ifBlank { mapOf("제4공학관" to "T", "학생회관" to "G", "홍문관" to "R")[building].orEmpty() }
        val caption = if (code.isBlank()) building else "$building (${code}동)"
        val heading = SpannableString(caption).apply {
            setSpan(StyleSpan(Typeface.BOLD), 0, building.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            if (caption.length > building.length) {
                setSpan(RelativeSizeSpan(14f / 18f), building.length, caption.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                setSpan(ForegroundColorSpan(color(context, R.color.widget_muted)), building.length, caption.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
        }
        view.setTextViewText(R.id.seat_building, heading)
        view.text(R.id.seat_room, seat.text("roomName").replace(Regex("제\\s*(\\d+)"), "제 $1"))
        view.text(R.id.seat_number, "${seat.text("seatNo")}${if (seat.text("seatNo").all(Char::isDigit)) "번" else ""}")
        view.setChronometerCountDown(R.id.seat_remaining, true)
        view.setChronometer(R.id.seat_remaining, SystemClock.elapsedRealtime() + remaining, null, !expired)
        view.setViewVisibility(R.id.seat_countdown, if (expired) View.GONE else View.VISIBLE)
        view.setViewVisibility(R.id.seat_expired, if (expired) View.VISIBLE else View.GONE)
        view.themeText(context, R.id.seat_remaining, R.color.widget_text)
        view.themeText(context, R.id.seat_remaining_suffix, R.color.widget_text)
        view.themeText(context, R.id.seat_expired, R.color.widget_error)
        refresh(context, id, kind, view)
        val extending = SeatExtensionJob.pending(context)
        val extended = seat.optInt("extendCount") > 0
        view.text(R.id.seat_extend, if (extended) "연장됨" else if (extending) "연장 중…" else "연장")
        view.setBoolean(R.id.seat_extend, "setEnabled", !extending && !extended)
        view.setFloat(R.id.seat_extend, "setAlpha", if (extended) .5f else 1f)
        view.setBoolean(R.id.seat_end, "setEnabled", !extending)
        val operation = "extend:${WidgetData.read(context).text("owner")}:${seat.optLong("id")}:${seat.optInt("extendCount")}"
        view.setOnClickPendingIntent(R.id.seat_extend, Widgets.pending(context, id, kind, operation))
        view.setOnClickPendingIntent(R.id.seat_end, Widgets.page(context, id, kind, "endSeat:${seat.optLong("id")}"))
        view.page(context, id, kind, R.id.seat_number)
        view.page(context, id, kind, R.id.seat_building)
        view.page(context, id, kind, R.id.seat_room, "seat")
        return view
    }
    private fun row(context: Context, time: String, title: String, sub: String, badge: String, tint: String): RemoteViews = layout(context, R.layout.widget_row).apply {
        text(R.id.row_time, time); text(R.id.row_title, title); text(R.id.row_subtitle, sub); text(R.id.row_badge, badge)
        themeText(context, R.id.row_subtitle, R.color.widget_muted)
        val accent = runCatching { (tint).toColorInt() }.getOrDefault(color(context, R.color.widget_primary))
        setInt(R.id.row_accent, "setColorFilter", accent)
    }
    fun weekBitmap(context: Context, width: Int, height: Int): Bitmap {
        val scale = 2f
        val bitmap = createBitmap((width * scale).toInt(), (height * scale).toInt())
        val canvas = Canvas(bitmap); canvas.scale(scale, scale)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        val slots = WidgetData.slots(context)
        val days = max(5, (slots.maxOfOrNull { it.optInt("weekday") } ?: 4) + 1)
        val starts = slots.map { minutes(it.text("start")) }
        val fit = WidgetData.read(context).optJSONObject("preferences")?.text("timetableDisplay", "fit") != "full" && slots.isNotEmpty()
        val first = starts.minOrNull() ?: 540
        val last = slots.maxOfOrNull { minutes(it.text("start")) + (it.optJSONArray("periods")?.length() ?: 1) * 60 } ?: 1080
        val start = (if (fit) first else min(540, first)) / 60 * 60
        val end = ((if (fit) last else max(1080, last)) + 59) / 60 * 60
        val left = 26f; val top = 24f
        val col = (width - left) / days; val unit = (height - top) / (end - start)
        val muted = color(context, R.color.widget_muted)
        paint.color = muted; paint.textSize = 12f; paint.typeface = Typeface.DEFAULT
        (0 until days).forEach { day -> paint.textAlign = Paint.Align.CENTER; canvas.drawText("월화수목금토일"[day].toString(), left + (day + .5f) * col, 14f, paint) }
        for (minute in start until end step 60) {
            val y = top + (minute - start) * unit
            paint.color = muted; paint.alpha = 55; paint.strokeWidth = .5f
            canvas.drawLine(left, y, width.toFloat(), y, paint)
            paint.alpha = 255; paint.textAlign = Paint.Align.LEFT; paint.textSize = 11f
            canvas.drawText("${minute / 60}", 1f, y + 10f, paint)
        }
        slots.forEach { slot ->
            val day = slot.optInt("weekday")
            val minute = minutes(slot.text("start"))
            val finish = minute + (slot.optJSONArray("periods")?.length() ?: 1) * 60
            val box = RectF(left + day * col + 2, top + (minute - start) * unit + 1, left + (day + 1) * col - 2, top + (finish - start) * unit - 2)
            val base = runCatching { (slot.text("color")).toColorInt() }.getOrDefault(Color.rgb(88, 144, 222))
            val dark = context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
            val surface = color(context, R.color.widget_timetable_surface)
            val factor = if (dark) .24f else .16f
            fun blend(a: Int, b: Int) = (a * factor + b * (1 - factor)).roundToInt()
            paint.color = Color.rgb(blend(Color.red(base), Color.red(surface)), blend(Color.green(base), Color.green(surface)), blend(Color.blue(base), Color.blue(surface)))
            paint.style = Paint.Style.FILL; canvas.drawRoundRect(box, 5f, 5f, paint)
            canvas.withClip(box) {
                paint.color = color(context, R.color.widget_timetable_text); paint.textSize = if (days > 5) 11f else 12f; paint.typeface = Typeface.create("sans-serif", Typeface.BOLD)
                val maxLines = ((box.height() - 19) / 14).toInt().coerceIn(1, 3)
                var rest = slot.text("name"); var y = box.top + 14; var line = 0
                while (rest.isNotEmpty() && line < maxLines) {
                    var n = paint.breakText(rest, true, box.width() - 8, null).coerceAtLeast(1)
                    val last = line == maxLines - 1
                    val clipped = last && n < rest.length
                    if (clipped) while (n > 1 && paint.measureText(rest.take(n) + "…") > box.width() - 8) n--
                    val text = rest.take(n); rest = rest.drop(n)
                    canvas.drawText(text + if (clipped) "…" else "", box.left + 4, y, paint); y += 14; line++
                }
                paint.color = color(context, R.color.widget_timetable_text_secondary); paint.textSize = 10f; paint.typeface = Typeface.DEFAULT
                canvas.drawText(slot.text("room").take(10), box.left + 4, min(y + 2, box.bottom - 4), paint)
            }
        }
        return bitmap
    }
}
