import Foundation
import WidgetKit
import UserNotifications

enum WidgetAPI {
    private static let queue = DispatchQueue(label: "dev.kyuyoung.hongsi.widget.network", qos: .userInitiated)
    private static let actionQueue = DispatchQueue(label: "dev.kyuyoung.hongsi.widget.actions", qos: .userInitiated)
    static func call(_ path: String, method: String = "GET", body: JSON? = nil, owner: String, deadline: Date? = nil, interactive: Bool = false) async throws -> Any {
        try await withCheckedThrowingContinuation { continuation in
            (interactive ? actionQueue : queue).async {
                do {
                    let remaining = min(20, deadline?.timeIntervalSinceNow ?? 20)
                    guard remaining > 0 else { throw WidgetFailure("위젯을 새로고침해 주세요.") }
                    guard !owner.isEmpty, WidgetStore.read().text("owner") == owner else { throw WidgetFailure("위젯을 새로고침해 주세요.") }
                    guard let secret = try Credentials.read(), let bytes = secret.data(using: .utf8),
                          let credentials = try JSONSerialization.jsonObject(with: bytes) as? JSON else {
                        throw WidgetFailure("앱에서 자동 로그인을 켜 주세요.")
                    }
                    guard WidgetStore.owner(credentials.text("id").trimmingCharacters(in: .whitespacesAndNewlines).uppercased()) == owner else { throw WidgetFailure("위젯을 새로고침해 주세요.") }
                    let input = try JSONSerialization.data(withJSONObject: ["method": method, "path": path, "body": body as Any? ?? NSNull(), "owner": owner, "credentials": credentials, "timeoutMs": max(1, Int(remaining * 1000))])
                    let encoded = String(decoding: input, as: UTF8.self)
                    let pointer = encoded.withCString { hongsi_widget_request($0) }
                    guard let pointer else { throw WidgetFailure("정보를 불러오지 못했어요.") }
                    defer { hongsi_widget_free(pointer) }
                    guard let output = String(cString: pointer).data(using: .utf8), let response = try JSONSerialization.jsonObject(with: output) as? JSON else { throw WidgetFailure("학교 응답을 확인하지 못했어요.") }
                    if response.flag("revoked") {
                        if try Credentials.compareAndSet(expected: secret, replacement: nil), WidgetStore.read().text("owner") == owner {
                            try WidgetStore.replace(""); WidgetCenter.shared.reloadAllTimelines()
                        }
                    } else if let saved = response["credentials"] as? JSON {
                        let data = try JSONSerialization.data(withJSONObject: saved, options: [.sortedKeys])
                        try Credentials.compareAndSet(expected: secret, replacement: String(decoding: data, as: UTF8.self))
                    }
                    guard WidgetStore.read().text("owner") == owner else { throw WidgetFailure("앱에서 다시 로그인해 주세요.") }
                    guard (200..<300).contains(response.integer("status")) else {
                        let error = response.object("body").object("error")
                        throw WidgetFailure(error.text("message", "정보를 불러오지 못했어요."))
                    }
                    continuation.resume(returning: response["body"] ?? NSNull())
                } catch { continuation.resume(throwing: error) }
            }
        }
    }
}

private actor WidgetCommonSync {
    static let shared = WidgetCommonSync()
    private var pending: (owner: String, id: UUID, task: Task<Void, Error>)?

    func refresh(owner: String, force: Bool, deadline: Date) async throws {
        if let pending, pending.owner == owner { return try await pending.task.value }
        let before = WidgetStore.read()
        guard before.text("owner") == owner else { throw WidgetFailure("앱에서 다시 로그인해 주세요.") }
        let age = HongsiClock.milliseconds() - before.number("commonCheckedAt")
        if !force && before.number("commonCheckedAt") > 0 && age >= 0 && age < 3000 { return }
        let id = UUID()
        let task = Task { try await Self.load(owner: owner, deadline: deadline) }
        pending = (owner, id, task)
        defer { if pending?.id == id { pending = nil } }
        try await task.value
    }

    private static func load(owner: String, deadline: Date) async throws {
        let before = WidgetStore.read()
        guard before.text("owner") == owner else { throw WidgetFailure("앱에서 다시 로그인해 주세요.") }
        func fetch(_ path: String) async throws -> JSON {
            try await WidgetAPI.call(path, owner: owner, deadline: deadline) as? JSON ?? [:]
        }
        let revisions = try await fetch("/api/school/revisions"), previous = before.object("schoolRevisions")
        var patch: JSON = [:], updated: JSON = [:], applied: JSON = [:]
        if revisions.integer("timetable") > 0 && (revisions.integer("timetable") != previous.integer("timetable") || !WidgetModel.hasTimetable(before)) {
            let requestedAt = HongsiClock.milliseconds()
            let saved = try await fetch("/api/school/stored?kind=timetable")
            let colors = before.objects("slots").reduce(into: [String: String]()) { $0[$1.text("code")] = $1.text("color", "#3b82f6") }
            patch["slots"] = saved.objects("slots").map { slot -> JSON in var value = slot; value["color"] = colors[slot.text("code")] ?? "#3b82f6"; return value }
            patch["timetableLoaded"] = true
            updated["timetable"] = requestedAt
            applied["timetable"] = revisions.integer("timetable")
        }
        var complete = true
        if previous["preferences"] == nil || revisions.integer("preferences") != previous.integer("preferences") || before["preferences"] == nil {
            if let saved = try? await fetch("/api/preferences"), saved.number("updatedAt") >= before.object("updatedAt").number("preferences") {
                patch["preferences"] = ["midnight": saved.text("midnight") == "same" ? "same" : "prev",
                    "showUndated": saved.flag("showUndatedAssignments"), "timetableDisplay": saved.text("timetableDisplay") == "full" ? "full" : "fit",
                    "semesterDisplay": WidgetModel.semesterDisplay(saved.text("semesterDisplay"))]
                updated["preferences"] = saved.number("updatedAt")
                applied["preferences"] = revisions.integer("preferences")
            } else { complete = false }
        }
        patch["schoolRevisions"] = applied
        patch["updatedAt"] = updated
        patch["commonCheckedAt"] = complete ? HongsiClock.milliseconds() : 0
        guard try WidgetStore.merge(owner: owner, patch: patch) else { throw WidgetFailure("앱에서 다시 로그인해 주세요.") }
    }
}

actor WidgetSync {
    static let shared = WidgetSync()
    private var running = Set<String>()
    func refresh(_ kind: String, force: Bool = false) async {
        let resource = (kind == "ATTENDANCE" || kind.hasPrefix("TODAY")) ? "lectures" : kind == "SEAT" ? "seats" : kind == "WEEK" ? "timetable" : "calendar"
        guard !running.contains(resource) else { return }
        var before = WidgetStore.read()
        let owner = before.text("owner")
        guard !owner.isEmpty else { return }
        if resource == "seats" && WidgetModel.seatExtending(WidgetStore.state(), seat: before.object("seat"), now: Date()) { return }
        let age = HongsiClock.milliseconds() - before.object("updatedAt").number(resource)
        if !force && age >= 0 && age < (resource == "lectures" ? 10_000 : 60_000) { return }
        running.insert(resource); defer { running.remove(resource) }
        let deadline = Date().addingTimeInterval(15)
        func fetch(_ path: String, method: String = "GET", body: JSON? = nil, owner: String) async throws -> Any {
            try await WidgetAPI.call(path, method: method, body: body, owner: owner, deadline: deadline)
        }
        var patch: JSON = [:]
        do {
            try await WidgetCommonSync.shared.refresh(owner: owner, force: force, deadline: deadline)
            before = WidgetStore.read()
            guard before.text("owner") == owner else { throw WidgetFailure("앱에서 다시 로그인해 주세요.") }
            if resource == "seats" {
                let requestedAt = HongsiClock.milliseconds()
                let response = try await fetch("/api/seats/session", owner: owner) as? JSON ?? [:]
                var times = patch.object("updatedAt"); times["seats"] = requestedAt; patch["updatedAt"] = times
                patch["seat"] = response["session"] ?? NSNull()
            } else if resource == "lectures" {
                let active = try await fetch("/api/attendance/active", owner: owner) as? JSON ?? [:]
                let checkedAt = Date()
                var times = patch.object("updatedAt"); times[resource] = HongsiClock.milliseconds(checkedAt); patch["updatedAt"] = times
                let pending = before.objects("pendingReceipts").filter { AttendanceSnapshot.valid($0) }
                var unshared: [JSON] = []
                for receipt in pending {
                    do { _ = try await fetch("/api/attendance/receipts", method: "PUT", body: ["receipt": receipt], owner: owner) }
                    catch { unshared.append(receipt) }
                }
                patch["pendingReceipts"] = unshared
                let receipts: [JSON]
                var receiptError = ""
                do { receipts = try await fetch("/api/attendance/receipts", owner: owner) as? [JSON] ?? [] }
                catch { receipts = []; receiptError = error.localizedDescription }
                var plan = AttendanceCourseCache.plan(data: before, active: active.objects("items"), force: force, now: checkedAt)
                var cached = plan.cache.object("items")
                for code in plan.requests {
                    let requestedAt = HongsiClock.milliseconds()
                    let escaped = code.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
                    if let course = (try? await fetch("/api/attendance/course?code=" + escaped, owner: owner)) as? JSON {
                        cached[code] = ["data": course, "checkedAt": requestedAt]
                    }
                }
                plan.cache["items"] = cached
                let courses = cached.values.compactMap { ($0 as? JSON)?["data"] as? JSON }
                let courseCheckedAt = cached.mapValues { ($0 as? JSON)?.number("checkedAt") ?? 0 }
                patch["attendanceCourses"] = plan.cache
                var attendance = AttendanceSnapshot.make(slots: before.objects("slots"), active: active.objects("items"), courses: courses, receipts: receipts + pending, previous: before.object("attendance"), now: checkedAt, courseCheckedAt: courseCheckedAt)
                attendance["timetableLoaded"] = WidgetModel.hasTimetable(before)
                attendance["receiptError"] = receiptError
                patch["attendance"] = attendance
            } else if resource == "calendar" {
                let display = WidgetModel.semesterDisplay(before.object("preferences").text("semesterDisplay"))
                let calendar = try await fetch("/api/calendar?refresh=1&semester=" + display, owner: owner) as? JSON ?? [:]
                let todos = try await fetch("/api/todos", owner: owner) as? [JSON] ?? []
                patch["deadlines"] = Self.deadlines(calendar: calendar, todos: todos, display: display)
                patch["semesterDisplay"] = display
            }
            var times = patch.object("updatedAt")
            if resource != "timetable" && times[resource] == nil { times[resource] = HongsiClock.milliseconds() }
            patch["updatedAt"] = times
            patch["errors"] = [resource: ""]
        } catch {
            patch["errors"] = [resource: error.localizedDescription]
            if resource == "lectures" { var snapshot = before.object("attendance"); snapshot["error"] = error.localizedDescription; patch["attendance"] = snapshot }
        }
        _ = try? WidgetStore.merge(owner: owner, patch: patch)
    }
    static func deadlines(calendar: JSON, todos: [JSON], display: String) -> [JSON] {
        let courses = calendar.objects("courses"), ids = Set(courses.map { $0.integer("id") })
        let palette = ["#ef4444", "#f97316", "#f5a50b", "#84cc16", "#22c55e", "#14b8a6", "#0ea5e9", "#3b82f6", "#6366f1", "#a855f7"]
        let groups = Dictionary(grouping: courses) { "\($0.object("term").integer("year"))-\($0.object("term").integer("semester"))" }
        var colors: [Int: String] = [:]
        for group in groups.values {
            let sorted = group.sorted { a, b in
                if a.text("code") != b.text("code") { return a.text("code") < b.text("code") }
                if a.text("name") != b.text("name") { return a.text("name") < b.text("name") }
                return a.integer("id") < b.integer("id")
            }
            for (i, course) in sorted.enumerated() { colors[course.integer("id")] = palette[group.count == 1 ? 7 : Int((Double(i * (palette.count - 1)) / Double(group.count - 1)).rounded())] }
        }
        func course(_ id: Int) -> String { courses.first { $0.integer("id") == id }?.text("name") ?? "" }
        let statuses = ["submitted": "제출 완료", "not_submitted": "미제출", "overdue": "마감 지남", "done": "출석 인정", "partial": "부분 인정", "missed": "미인정", "todo": "미시청", "upcoming": "시청 전"]
        let items = calendar.objects("items").map { item -> JSON in
            var value: JSON = [:]; for key in ["key", "title", "due", "start", "done", "kind"] { value[key] = item[key] ?? NSNull() }
            value["course"] = course(item.integer("courseId")); value["color"] = colors[item.integer("courseId")] ?? "#3b82f6"
            value["status"] = statuses[item.text("status")] ?? "상태 확인 필요"; return value
        }
        return items + todos.filter { display == "all" || $0.isNull("courseId") || ids.contains($0.integer("courseId")) }.map { todo in
            ["key": "todo:\(todo.integer("id"))", "title": todo.text("title"), "course": course(todo.integer("courseId")).isEmpty ? "공통" : course(todo.integer("courseId")),
             "color": colors[todo.integer("courseId")] as Any? ?? NSNull(), "due": todo["due"] ?? NSNull(), "allDay": todo.flag("allDay"), "done": !todo.isNull("doneAt"), "kind": "todo", "status": ""]
        }
    }
}

enum SeatReminders {
    static func rebuild(owner: String, after: JSON) async throws {
        let data = WidgetStore.read(), policy = data.object("seatReminders")
        guard data.text("owner") == owner, WidgetStore.owner(policy.text("account")) == owner else {
            throw WidgetFailure("앱에서 알림 설정을 확인해 주세요.")
        }
        let center = UNUserNotificationCenter.current()
        let ids = await center.pendingNotificationRequests().filter { Int($0.identifier).map { (7000..<7500).contains($0) } ?? false }.map(\.identifier)
        guard WidgetStore.read().text("owner") == owner else { return }
        center.removePendingNotificationRequests(withIdentifiers: ids)
        guard policy.flag("enabled") else { return }
        let leads = Array(Set((policy["leads"] as? [Int] ?? []).filter { [60, 30, 10, 0].contains($0) })).sorted(by: >)
        for (index, lead) in leads.enumerated() {
            let date = Date(timeIntervalSince1970: after.number("expiresAt") - Double(lead * 60))
            guard date > Date() else { continue }
            guard WidgetStore.read().text("owner") == owner else { return }
            let intent: JSON = ["version": 1, "account": policy.text("account"), "at": date.timeIntervalSince1970 * 1000,
                                "target": ["kind": "seat", "id": after.integer("id")]]
            let content = UNMutableNotificationContent()
            content.title = lead == 0 ? "좌석 이용 시간이 끝났어요." : "좌석 이용 종료까지 \(lead)분 남았어요."
            content.sound = .default
            content.userInfo["__EXTRA__"] = ["intent": String(decoding: try JSONSerialization.data(withJSONObject: intent), as: UTF8.self)]
            let components = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
            try await center.add(UNNotificationRequest(identifier: String(7000 + index), content: content,
                                                       trigger: UNCalendarNotificationTrigger(dateMatching: components, repeats: false)))
        }
    }
}
