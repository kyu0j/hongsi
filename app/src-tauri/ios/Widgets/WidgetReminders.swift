import Foundation
import UserNotifications

struct WidgetReminder {
    let at: Double
    let title: String
    let body: String
    let intent: JSON
    var key: String { Self.key(intent) }
    static func key(_ intent: JSON) -> String {
        let target = intent.object("target")
        return "\(intent.text("account")):\(target.text("kind")):\(target.text("key", String(target.integer("id")))):\(Int(intent.number("at")))"
    }
}

actor WidgetReminders {
    static let shared = WidgetReminders()
    private var pending: (id: UUID, task: Task<Void, Error>)?

    static func plan(_ data: JSON, channel: String, now: Date = Date()) -> [WidgetReminder]? {
        let policy = data.object(channel + "Reminders"), account = policy.text("account")
        guard !account.isEmpty, WidgetStore.owner(account) == data.text("owner") else { return nil }
        guard policy.flag("enabled") else { return [] }
        var output: [WidgetReminder] = []
        func add(_ at: Double, _ title: String, _ body: String, _ target: JSON) {
            guard at.isFinite, at > HongsiClock.milliseconds(now) else { return }
            output.append(WidgetReminder(at: at, title: title, body: body,
                intent: ["version": 1, "account": account, "at": at, "target": target]))
        }
        func leads(_ value: Any?, allowed: Set<Int>) -> [Int] {
            Array(Set((value as? [Int] ?? []).filter { allowed.contains($0) }))
        }
        if channel == "seat" {
            let seat = data.object("seat")
            guard seat.integer("id") > 0, seat.isNull("endedAt") else { return [] }
            for lead in leads(policy["leads"], allowed: [60, 30, 10, 0]) {
                add(seat.number("expiresAt") * 1000 - Double(lead * 60_000),
                    lead == 0 ? "좌석 이용 시간이 끝났어요." : "좌석 이용 종료까지 \(lead)분 남았어요.", "",
                    ["kind": "seat", "id": seat.integer("id")])
            }
        } else {
            let preferences = data.object("preferences")
            guard data.text("semesterDisplay") == WidgetModel.semesterDisplay(preferences.text("semesterDisplay", "current")),
                  let defaults = preferences["alertLeads"] as? [Int] else { return nil }
            for item in data.objects("deadlines") {
                if item.flag("done") || (!item.isNull("alert") && !item.flag("alert")) || item.isNull("due") { continue }
                let key = item.text("key"), todo = item.text("kind") == "todo"
                let target: JSON
                if todo {
                    guard key.hasPrefix("todo:"), let id = Int(key.dropFirst(5)), id > 0 else { continue }
                    target = ["kind": "todo", "id": id]
                } else {
                    guard key.range(of: "^(assign|vod):[0-9]+$", options: .regularExpression) != nil else { continue }
                    target = ["kind": "item", "key": key]
                }
                let kind = todo ? "할 일" : item.text("kind") == "vod" ? "온라인 강의" : "과제"
                let due = Date(timeIntervalSince1970: item.number("due"))
                let previous = preferences.text("midnight", "prev") != "same" && HongsiClock.text(due, "HH:mm") == "00:00"
                let day = previous ? due.addingTimeInterval(-60) : due
                let time = previous ? "24:00" : HongsiClock.text(due, "HH:mm")
                let course = todo ? item.text("reminderCourse") : String(item.text("course").prefix { !$0.isWhitespace && $0 != "(" })
                let title = item.text("title"), name = !course.isEmpty && (todo || !title.hasPrefix(course)) ? course + " · " + title : title
                for lead in leads(item["alertLeads"] as? [Int] ?? defaults, allowed: [1440, 180, 60, 10, 0]) {
                    let at = item.number("due") * 1000 - Double(lead * 60_000)
                    let sameDay = HongsiClock.text(Date(timeIntervalSince1970: at / 1000)) == HongsiClock.text(day)
                    let whenText: String
                    if todo && item.flag("allDay") { whenText = sameDay ? "오늘" : HongsiClock.text(day, "M/d(E)") }
                    else { whenText = sameDay ? time : HongsiClock.text(day, "M/d(E)") + " " + time }
                    let leadText = [1440: "하루 전", 180: "3시간 전", 60: "1시간 전"][lead] ?? "\(lead)분 전"
                    add(at, lead == 0 ? "\(kind) 마감 시간이에요." : "\(kind) 마감 \(leadText)이에요.", name + " · " + whenText + "까지", target)
                }
            }
        }
        var keys = Set<String>()
        return Array(output.filter { keys.insert($0.key).inserted }.sorted {
            $0.at == $1.at ? $0.key < $1.key : $0.at < $1.at
        }.prefix(channel == "seat" ? 6 : 56))
    }

    func rebuild(owner: String, channel: String) async throws {
        let previous = pending?.task, id = UUID()
        let task = Task {
            if let previous { _ = await previous.result }
            try await Self.reconcile(owner: owner, channel: channel)
        }
        pending = (id, task)
        defer { if pending?.id == id { pending = nil } }
        try await task.value
    }

    private static func reconcile(owner: String, channel: String) async throws {
        let data = WidgetStore.read()
        guard !owner.isEmpty, data.text("owner") == owner, let plan = plan(data, channel: channel) else { return }
        let center = UNUserNotificationCenter.current(), base = channel == "seat" ? 7000 : 8000
        let saved = await center.pendingNotificationRequests().filter { Int($0.identifier).map { (base..<base + 500).contains($0) } ?? false }
        var byKey: [String: UNNotificationRequest] = [:]
        for request in saved {
            guard let extra = request.content.userInfo["__EXTRA__"] as? JSON,
                  let raw = extra["intent"] as? String, let bytes = raw.data(using: .utf8),
                  let intent = try? JSONSerialization.jsonObject(with: bytes) as? JSON else { continue }
            byKey[WidgetReminder.key(intent)] = request
        }
        var assigned: [String: Int] = [:], used = Set<Int>()
        for r in plan {
            if let request = byKey[r.key], let id = Int(request.identifier) { assigned[r.key] = id; used.insert(id) }
        }
        for r in plan where assigned[r.key] == nil {
            guard let id = (base..<base + 500).first(where: { !used.contains($0) }) else { continue }
            assigned[r.key] = id; used.insert(id)
        }
        let retained = Set(plan.compactMap { r -> String? in
            guard let request = byKey[r.key], request.content.title == r.title, request.content.body == r.body else { return nil }
            return request.identifier
        })
        guard WidgetStore.read().text("owner") == owner else { return }
        center.removePendingNotificationRequests(withIdentifiers: saved.map(\.identifier).filter { !retained.contains($0) })
        for r in plan {
            guard let id = assigned[r.key], !retained.contains(String(id)), r.at > HongsiClock.milliseconds() else { continue }
            guard WidgetStore.read().text("owner") == owner else { return }
            let content = UNMutableNotificationContent()
            content.title = r.title; content.body = r.body; content.sound = .default
            content.userInfo["__EXTRA__"] = ["intent": String(decoding: try JSONSerialization.data(withJSONObject: r.intent), as: UTF8.self)]
            let date = Date(timeIntervalSince1970: r.at / 1000)
            let components = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
            try await center.add(UNNotificationRequest(identifier: String(id), content: content,
                trigger: UNCalendarNotificationTrigger(dateMatching: components, repeats: false)))
        }
    }
}
