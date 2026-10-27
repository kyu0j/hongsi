import AppIntents
import Foundation
import OSLog
import WidgetKit

struct HongsiWidgetAction: AppIntent {
    static var title: LocalizedStringResource = "홍시 위젯 동작"
    static var isDiscoverable = false
    static var openAppWhenRun = false
    @Parameter(title: "위젯") var kind: String
    @Parameter(title: "동작") var action: String
    @Parameter(title: "계정") var owner: String
    @Parameter(title: "대상") var detail: String
    @Parameter(title: "입력 시각") var inputAt: Double
    init() {}
    init(kind: String, action: String, owner: String, detail: String = "", inputAt: Double = 0) {
        self.kind = kind; self.action = action; self.owner = owner; self.detail = detail; self.inputAt = inputAt
    }
    func perform() async throws -> some IntentResult {
        let logger = Logger(subsystem: "dev.kyuyoung.hongsi.widgets", category: "interaction")
        let feedbackEnd = ContinuousClock.now.advanced(by: .seconds(2))
        if action == "refresh" { logger.info("Refresh intent started: \(kind, privacy: .public)") }
        await WidgetActions.shared.run(kind: kind, action: action, owner: owner, detail: detail, inputAt: inputAt)
        if action == "refresh" { try? await ContinuousClock().sleep(until: feedbackEnd) }
        if action == "refresh" || (kind == "ATTENDANCE" && action == "submit") {
            let related = kind == "ATTENDANCE" || kind.hasPrefix("TODAY")
                ? ["ATTENDANCE", "TODAY", "TODAY_LARGE"]
                : kind.hasPrefix("DEADLINES") ? ["DEADLINES", "DEADLINES_LARGE"] : []
            for widget in related where widget != kind { WidgetCenter.shared.reloadTimelines(ofKind: widget) }
        }
        if action == "refresh" { logger.info("Refresh intent finished: \(kind, privacy: .public)") }
        return .result()
    }
}

actor WidgetActions {
    static let shared = WidgetActions()
    private var submitting = false
    private var extending = false

    func run(kind: String, action: String, owner: String, detail: String, inputAt: Double) async {
        guard !owner.isEmpty, WidgetStore.read().text("owner") == owner else { return }
        do {
            if action == "refresh" {
                await WidgetSync.shared.refresh(kind, force: true); return
            }
            if kind == "SEAT", action == "extend" {
                guard !extending else { return }; extending = true; defer { extending = false }
                try await extend(owner: owner, detail: detail); return
            }
            guard kind == "ATTENDANCE", !submitting else { return }
            if action == "begin" {
                let data = WidgetStore.read(), status = WidgetModel.attendance(data, state: WidgetStore.state(), now: Date())
                guard status.available, let lecture = data.object("attendance").objects("active").first(where: { $0.text("identity") == status.identity }) else {
                    throw WidgetFailure("출석 가능 여부를 다시 확인해 주세요.")
                }
                try WidgetStore.changeState(owner: owner) {
                    $0["mode"] = "input"; $0["code"] = ""; $0["lecture"] = lecture; $0["inputAt"] = HongsiClock.milliseconds(); $0["message"] = ""
                }
            } else if action == "back" {
                try WidgetStore.changeState(owner: owner) {
                    $0["mode"] = "ready"; $0["code"] = ""; $0["message"] = ""
                    $0["interactionAt"] = HongsiClock.milliseconds()
                }
            } else if action == "digit" || action == "erase" {
                try WidgetStore.changeState(owner: owner) { state in
                    try validateInput(state, inputAt: inputAt)
                    let code = state.text("code")
                    if action == "erase" { state["code"] = String(code.dropLast()) }
                    else if detail.count == 1, detail.first?.isASCII == true, detail.first?.isNumber == true, code.count < 4 { state["code"] = code + detail }
                    state["message"] = ""
                }
            } else if action == "submit" {
                submitting = true; defer { submitting = false }
                try await submit(owner: owner, inputAt: inputAt)
            }
        } catch {
            try? WidgetStore.changeState(owner: owner) {
                $0[kind == "SEAT" ? "seatMessage" : "message"] = (error as? WidgetFailure)?.errorDescription ?? "다시 시도해 주세요."
                if kind == "SEAT" { $0["seatMessageId"] = Int(detail.split(separator: ":").first ?? "") ?? 0 }
                else { $0["pending"] = false; $0["interactionAt"] = HongsiClock.milliseconds() }
            }
        }
    }
    private func validateInput(_ state: JSON, inputAt: Double) throws {
        guard WidgetModel.attendanceInputActive(state, now: Date()), state.number("inputAt") == inputAt else {
            throw WidgetFailure("위젯을 새로고침해 주세요.")
        }
    }
    private func submit(owner: String, inputAt: Double) async throws {
        let state = WidgetStore.state(); try validateInput(state, inputAt: inputAt)
        let code = state.text("code"), lecture = state.object("lecture")
        guard code.count == 4, code.allSatisfy({ $0.isASCII && $0.isNumber }), !lecture.text("key").isEmpty else { throw WidgetFailure("출석번호 네 자리를 입력해 주세요.") }
        try WidgetStore.changeState(owner: owner) {
            guard $0.number("claimedInput") != inputAt else { throw WidgetFailure("출석 상태를 먼저 확인해 주세요.") }
            $0["claimedInput"] = inputAt; $0["pending"] = true; $0["pendingAt"] = HongsiClock.milliseconds(); $0["message"] = "출석을 확인하고 있어요."
        }
        var sent = false
        defer {
            try? WidgetStore.changeState(owner: owner) {
                $0["pending"] = false
                if !sent { $0.removeValue(forKey: "claimedInput") }
            }
        }
        let location = try await locate()
        let active = try await WidgetAPI.call("/api/attendance/active", owner: owner, interactive: true) as? JSON ?? [:]
        guard active.objects("items").contains(where: { $0.text("key") == lecture.text("key") }) else { throw WidgetFailure("출석할 수 있는 시간이 아니에요.") }
        let body: JSON = ["lectureKey": lecture.text("key"), "code": code, "latitude": location.0, "longitude": location.1]
        sent = true
        let result = try await WidgetAPI.call("/api/attendance/submit", method: "POST", body: body, owner: owner, interactive: true) as? JSON ?? [:]
        let receipt = result.object("receipt")
        guard AttendanceSnapshot.valid(receipt), receipt.object("lecture").text("key") == lecture.text("key") else {
            try WidgetStore.changeState(owner: owner) { $0.removeValue(forKey: "claimedInput") }
            let message = result.text("message")
            let rejection = ["출결번호를 확인해 주세요.", "출석 시간이 지났어요.", "강의실 위치를 확인해 주세요."]
            throw WidgetFailure(rejection.contains(message) ? message : "출석 결과를 확인하지 못했어요.")
        }
        var pending = WidgetStore.read().objects("pendingReceipts").filter { AttendanceSnapshot.valid($0) && $0.object("lecture").text("key") != lecture.text("key") }
        pending.append(receipt)
        try WidgetStore.merge(owner: owner, patch: ["pendingReceipts": pending])
        try WidgetStore.changeState(owner: owner) {
            $0["mode"] = "ready"; $0["code"] = ""; $0["message"] = receipt.text("kind") == "late" ? "지각으로 처리됐어요." : "출석 확인이 완료되었습니다."
            $0["localReceipt"] = ["identity": lecture.text("identity"), "date": receipt.text("date"), "kind": receipt.text("kind"), "confirmedAt": receipt.number("confirmedAt")]
        }
        try WidgetStore.markChanged(owner: owner)
        await WidgetSync.shared.refresh("ATTENDANCE", force: true)
    }
    @MainActor private func locate() async throws -> (Double, Double) {
        let locator = HongsiLocation(); let location = try await locator.locate(requestPermission: false)
        return (location.coordinate.latitude, location.coordinate.longitude)
    }
    private func extend(owner: String, detail: String) async throws {
        let fields = detail.split(separator: ":")
        guard fields.count == 3, let id = Int(fields[0]), id > 0, let count = Int(fields[1]) else { return }
        guard count == 0 else { throw WidgetFailure("이미 한 번 연장했어요.") }
        try WidgetStore.changeState(owner: owner) {
            guard !WidgetModel.seatExtending($0, seat: ["id": id], now: Date()) else { throw WidgetFailure("연장 중이에요.") }
            $0["seatPending"] = true; $0["seatPendingAt"] = HongsiClock.milliseconds(); $0["seatPendingId"] = id
            $0["seatMessage"] = ""; $0["seatMessageId"] = id
        }
        WidgetCenter.shared.reloadTimelines(ofKind: "SEAT")
        defer {
            try? WidgetStore.changeState(owner: owner) { $0["seatPending"] = false }
            WidgetCenter.shared.reloadTimelines(ofKind: "SEAT")
        }
        let response = try await WidgetAPI.call("/api/seats/session", owner: owner, interactive: true) as? JSON ?? [:]
        let before = response.object("session")
        guard before.integer("id") == id else { throw WidgetFailure("현재 이용 중인 좌석을 확인해 주세요.") }
        guard before.integer("extendCount") == 0 else {
            try WidgetStore.merge(owner: owner, patch: ["seat": before, "updatedAt": ["seats": HongsiClock.milliseconds()]])
            try await SeatReminders.rebuild(owner: owner, after: before)
            try WidgetStore.markChanged(owner: owner)
            throw WidgetFailure("이미 한 번 연장했어요.")
        }
        let result: JSON
        do {
            result = try await WidgetAPI.call("/api/seats/session/extend", method: "POST", owner: owner, interactive: true) as? JSON ?? [:]
        } catch {
            let actual = (try? await WidgetAPI.call("/api/seats/session", owner: owner, interactive: true)) as? JSON ?? [:]
            guard actual.object("session").integer("id") == id, actual.object("session").integer("extendCount") > 0 else { throw error }
            result = actual
        }
        let after = result.object("session")
        guard after.integer("id") == id else { throw WidgetFailure("좌석 상태를 새로고침해 주세요.") }
        try WidgetStore.merge(owner: owner, patch: ["seat": after, "updatedAt": ["seats": HongsiClock.milliseconds()], "errors": ["seats": ""]])
        var message = "이용 시간을 연장했어요."
        do { try await SeatReminders.rebuild(owner: owner, after: after) }
        catch { message = "연장 후 알림을 갱신하지 못했어요." }
        let finalMessage = message
        try WidgetStore.changeState(owner: owner) { $0["seatMessage"] = finalMessage }
        try WidgetStore.markChanged(owner: owner)
    }
}
