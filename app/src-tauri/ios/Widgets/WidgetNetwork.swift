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

actor WidgetSync {
    static let shared = WidgetSync()
    private var running = Set<String>()
    func refresh(_ kind: String, force: Bool = false) async {
        let resource = (kind == "ATTENDANCE" || kind.hasPrefix("TODAY")) ? "lectures" : kind == "SEAT" ? "seats" : kind == "WEEK" ? "timetable" : "calendar"
        guard !running.contains(resource) else { return }
        let before = WidgetStore.read(), owner = before.text("owner")
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
            let revisions = try await fetch("/api/school/revisions", owner: owner) as? JSON ?? [:]
            if revisions.integer("timetable") > 0 && (revisions.integer("timetable") != before.object("schoolRevisions").integer("timetable") || !WidgetModel.hasTimetable(before)) {
                let saved = try await fetch("/api/school/stored?kind=timetable", owner: owner) as? JSON ?? [:]
                let colors = before.objects("slots").reduce(into: [String: String]()) { $0[$1.text("code")] = $1.text("color", "#3b82f6") }
                patch["slots"] = saved.objects("slots").map { slot -> JSON in var value = slot; value["color"] = colors[slot.text("code")] ?? "#3b82f6"; return value }
                patch["timetableLoaded"] = true
            }
            patch["schoolRevisions"] = revisions
            var preferences = before.object("preferences"), preferencesAt = before.object("updatedAt").number("preferences")
            if let saved = (try? await fetch("/api/preferences", owner: owner)) as? JSON, saved.number("updatedAt") >= preferencesAt {
                preferences.merge(saved) { _, new in new }; preferencesAt = saved.number("updatedAt")
            }
            patch["preferences"] = ["midnight": preferences.text("midnight"), "showUndated": preferences["showUndatedAssignments"] != nil ? preferences.flag("showUndatedAssignments") : preferences.flag("showUndated"), "timetableDisplay": preferences.text("timetableDisplay"), "semesterDisplay": preferences.text("semesterDisplay")]
            patch["updatedAt"] = ["preferences": preferencesAt]
            if patch["slots"] != nil { var times = patch.object("updatedAt"); times["timetable"] = HongsiClock.milliseconds(); patch["updatedAt"] = times }
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
                var courses: [JSON] = []
                var source = before
                if patch["slots"] != nil { source["slots"] = patch["slots"]; source["timetableLoaded"] = true }
                let codes = Set(WidgetModel.today(source, now: Date()).map { $0.text("code") }.filter { !$0.isEmpty })
                for code in codes {
                    let escaped = code.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
                    if let course = (try? await fetch("/api/attendance/course?code=" + escaped, owner: owner)) as? JSON { courses.append(course) }
                }
                var attendance = AttendanceSnapshot.make(slots: source.objects("slots"), active: active.objects("items"), courses: courses, receipts: receipts + pending, previous: before.object("attendance"), now: checkedAt)
                attendance["timetableLoaded"] = WidgetModel.hasTimetable(source)
                attendance["receiptError"] = receiptError
                patch["attendance"] = attendance
            } else if resource == "calendar" {
                let display = WidgetModel.semesterDisplay(preferences.text("semesterDisplay"))
                patch["preferences"] = [
                    "midnight": preferences.text("midnight") == "same" ? "same" : "prev",
                    "showUndated": preferences["showUndatedAssignments"] != nil ? preferences.flag("showUndatedAssignments") : preferences.flag("showUndated"),
                    "timetableDisplay": preferences.text("timetableDisplay") == "full" ? "full" : "fit", "semesterDisplay": display
                ]
                let calendar = try await fetch("/api/calendar?refresh=1&semester=" + display, owner: owner) as? JSON ?? [:]
                let todos = try await fetch("/api/todos", owner: owner) as? [JSON] ?? []
                patch["deadlines"] = Self.deadlines(calendar: calendar, todos: todos, display: display)
                patch["semesterDisplay"] = display
            }
            var times = patch.object("updatedAt")
            if times[resource] == nil { times[resource] = HongsiClock.milliseconds() }
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
