import SwiftUI
import WidgetKit
import UIKit

struct HongsiEntry: TimelineEntry {
    let date: Date
    let data: JSON
    let state: JSON
    let theme: String
}

struct HongsiProvider: TimelineProvider {
    let kind: String
    func placeholder(in context: Context) -> HongsiEntry { Self.preview(kind: kind) }
    func getSnapshot(in context: Context, completion: @escaping (HongsiEntry) -> Void) {
        completion(context.isPreview ? Self.preview(kind: kind) : entry())
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<HongsiEntry>) -> Void) {
        Task {
            let localReload = kind == "ATTENDANCE" ? WidgetModel.attendanceLocalReloadDate(WidgetStore.state(), now: Date()) : nil
            if localReload == nil && (kind != "SEAT" || !WidgetModel.seatExtending(WidgetStore.state(), seat: WidgetStore.read().object("seat"), now: Date())) {
                await WidgetSync.shared.refresh(kind)
            }
            let value = entry(), now = value.date
            var dates = [now]
            var reload = now.addingTimeInterval(15 * 60)
            if kind == "ATTENDANCE" {
                dates = WidgetModel.attendanceTimelineDates(value.data, state: value.state, now: now)
                reload = localReload ?? WidgetModel.attendanceReloadDate(value.data, now: now)
            } else {
                for minute in 1...60 { dates.append(Date(timeIntervalSince1970: floor(now.timeIntervalSince1970 / 60) * 60 + Double(minute * 60))) }
            }
            let entries = dates.sorted().map { HongsiEntry(date: $0, data: value.data, state: value.state, theme: value.theme) }
            completion(Timeline(entries: entries, policy: .after(reload)))
        }
    }
    private func entry() -> HongsiEntry { HongsiEntry(date: Date(), data: WidgetStore.read(), state: WidgetStore.state(), theme: WidgetStore.theme) }

}

struct WidgetPalette {
    let dark: Bool
    var app = false
    var background: Color { Color(hex: app ? (dark ? "1a2028" : "ffffff") : (dark ? "1C232B" : "FFFAF6")) }
    var text: Color { Color(hex: app ? (dark ? "eef1f6" : "202735") : (dark ? "EFF2F7" : "292321")) }
    var muted: Color { Color(hex: app ? (dark ? "b6c0cf" : "535e6e") : (dark ? "ADB5C1" : "756C67")) }
    var key: Color { Color(hex: app ? (dark ? "202730" : "f7f8fa") : (dark ? "2C3642" : "F3EAE3")) }
    var primary: Color { Color(hex: app ? (dark ? "ff8f5a" : "cf4510") : (dark ? "FF9156" : "CB470D")) }
    var onPrimary: Color { Color(hex: app ? (dark ? "1a0c04" : "ffffff") : (dark ? "321A0D" : "FFFFFF")) }
    var success: Color { Color(hex: app ? (dark ? "3fcf8e" : "147448") : (dark ? "4BD697" : "147447")) }
    var error: Color { Color(hex: app ? (dark ? "ff6b6f" : "bf3037") : (dark ? "FF858C" : "BF3340")) }
    var warning: Color { Color(hex: dark ? "FFD178" : "93620D") }
    var border: Color { Color(hex: app ? (dark ? "303945" : "e4e8ed") : (dark ? "495563" : "D7CDC6")) }
    var attendanceActive: Color { Color(hex: dark ? "3a2014" : "fff0e8") }
    var attendanceStatus: Color { Color(hex: dark ? "FFB088" : "B3390B") }
    var deadlineSoon: Color { Color(hex: dark ? "ff6b6f" : "bf3037") }
    func attendanceText(_ tone: String, quick: Bool = true) -> Color {
        if tone == "warn" && !quick { return Color(hex: dark ? "f3b44a" : "925700") }
        switch tone {
        case "success": return Color(hex: dark ? "3fcf8e" : "147448")
        case "error": return Color(hex: dark ? "ff6b6f" : "bf3037")
        case "primary", "warn": return attendanceStatus
        default: return Color(hex: dark ? "b6c0cf" : "535e6e")
        }
    }
    func attendanceBackground(_ tone: String, quick: Bool = true) -> Color {
        switch tone {
        case "success": return Color(hex: dark ? "0f2e22" : "e3f6ec")
        case "error": return Color(hex: dark ? "3a1618" : "fde8e8")
        case "warn" where !quick: return Color(hex: dark ? "33260c" : "fff3dc")
        case "primary", "warn": return attendanceActive
        default: return quick ? Color(hex: "94a3b8").opacity(0.1) : Color(hex: dark ? "1b2638" : "eef1f5")
        }
    }
    func badgeText(_ tone: String) -> Color {
        switch tone {
        case "info": return Color(hex: dark ? "95BEFF" : "2463AA")
        case "success": return Color(hex: dark ? "6BE0A5" : "147447")
        case "error": return Color(hex: dark ? "FF929A" : "BF3340")
        default: return self.tone(tone)
        }
    }
    func badgeBackground(_ tone: String) -> Color {
        let colors = dark ? ["success": "3CAB78", "warn": "EAAE3F", "error": "E85D70", "info": "5991E4", "muted": "7E8B9F"] :
            ["success": "147447", "warn": "CA8800", "error": "BF3340", "info": "2463AA", "muted": "756C67"]
        return Color(hex: colors[tone] ?? colors["muted"]!).opacity(Double(dark ? 36 : tone == "success" ? 24 : 31) / 255)
    }
    func tone(_ name: String) -> Color {
        switch name { case "primary": return primary; case "success": return success; case "error": return error; case "warn": return warning; default: return muted }
    }
}

extension Color {
    init(hex: String) {
        let number = UInt64(hex.trimmingCharacters(in: CharacterSet(charactersIn: "#")), radix: 16) ?? 0x3b82f6
        self.init(.sRGB, red: Double((number >> 16) & 255) / 255, green: Double((number >> 8) & 255) / 255, blue: Double(number & 255) / 255, opacity: 1)
    }
}

private struct WidgetRefreshStyle: ToggleStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        Toggle(configuration)
        .toggleStyle(.button)
        .buttonStyle(.plain)
        .contentShape(.interaction, Rectangle())
        .rotationEffect(.degrees(configuration.isOn && !reduceMotion ? 720 : 0))
        .animation(configuration.isOn && !reduceMotion ? .linear(duration: 2) : nil, value: configuration.isOn)
        .disabled(configuration.isOn)
        .accessibilityValue(configuration.isOn ? "새로고침 중" : "")
    }
}

private struct WidgetPendingStyle: ToggleStyle {
    let palette: WidgetPalette
    let title: String
    let pendingTitle: String
    var icon: String? = nil
    var height: CGFloat = 44
    var fontSize: CGFloat = 15
    func makeBody(configuration: Configuration) -> some View {
        Toggle(configuration)
            .toggleStyle(.button).buttonStyle(.plain).foregroundStyle(.clear)
            .frame(maxWidth: .infinity).frame(height: height)
            .contentShape(.interaction, Rectangle())
            .background(palette.primary, in: RoundedRectangle(cornerRadius: 12))
            .overlay {
                HStack(spacing: 5) {
                    if let icon { Image("Widget-" + icon).renderingMode(.template).resizable().scaledToFit().frame(width: 18, height: 18) }
                    Text(configuration.isOn ? pendingTitle : title).font(.system(size: fontSize, weight: .semibold)).lineLimit(1).minimumScaleFactor(0.75)
                }.foregroundStyle(palette.onPrimary).allowsHitTesting(false)
            }
            .opacity(configuration.isOn ? 0.75 : 1)
            .disabled(configuration.isOn)
            .accessibilityLabel(configuration.isOn ? pendingTitle : title)
    }
}

struct HongsiWidgetView: View {
    let kind: String
    let entry: HongsiEntry
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.widgetFamily) private var family
    private var data: JSON { entry.data }
    private var owner: String { data.text("owner") }
    private var enteringAttendance: Bool {
        kind == "ATTENDANCE" && WidgetModel.attendanceInputActive(entry.state, now: entry.date)
    }
    private var palette: WidgetPalette { WidgetPalette(dark: entry.theme == "dark" || (entry.theme == "system" && colorScheme == .dark), app: kind == "ATTENDANCE" || kind.hasPrefix("TODAY")) }
    private var attendanceStatus: AttendanceStatus { WidgetModel.attendance(data, state: entry.state, now: entry.date) }
    private var active: Bool { kind == "ATTENDANCE" && !enteringAttendance && (attendanceStatus.available || attendanceStatus.kind == "waiting") }
    private var title: String {
        switch kind { case "ATTENDANCE": return "빠른 출결"; case "SEAT": return "열람실 좌석"; case "WEEK": return "주간 시간표"; case "TODAY", "TODAY_LARGE": return "오늘 수업"; default: return "다가오는 마감" }
    }
    private func url(_ detail: String = "") -> URL { WidgetStore.url(kind: kind, detail: detail, owner: owner) }
    private func intent(_ action: String, detail: String = "") -> HongsiWidgetAction {
        HongsiWidgetAction(kind: kind, action: action, owner: owner, detail: detail, inputAt: entry.state.number("inputAt"))
    }
    var body: some View {
        GeometryReader { geometry in
            let compactHeight: CGFloat = kind.hasPrefix("DEADLINES") ? 204 : 192
            let scale = family == .systemLarge ? 1 : min(1, geometry.size.height / compactHeight)
            let size = CGSize(width: geometry.size.width / scale, height: geometry.size.height / scale)
            content(size: size)
                .frame(width: size.width, height: size.height, alignment: .topLeading)
                .scaleEffect(scale, anchor: .topLeading)
        }
        .font(.system(size: 12))
        .foregroundStyle(palette.text)
        .containerBackground(active ? palette.attendanceActive : palette.background, for: .widget)
        .widgetURL(url())
    }
    @ViewBuilder private func content(size: CGSize) -> some View {
        let horizontal: CGFloat = enteringAttendance || kind == "WEEK" ? 8 : kind == "SEAT" ? 10 : kind == "ATTENDANCE" ? 17 : 12
        let vertical: CGFloat = kind.hasPrefix("DEADLINES") ? 6 : horizontal
        let height = size.height - 2 * vertical
        VStack(alignment: .leading, spacing: 0) {
            if kind != "WEEK" && kind != "SEAT" && kind != "ATTENDANCE" { heading }
            if kind == "ATTENDANCE" { attendance(height: height) }
            else if owner.isEmpty && kind == "SEAT" { seatStatus("앱에서 로그인해 주세요.") }
            else if owner.isEmpty { empty("앱에서 로그인해 주세요.", row: kind != "WEEK") }
            else if kind == "SEAT" { seat }
            else if kind == "WEEK" { week }
            else if kind.hasPrefix("TODAY") { today(height: height - 40) }
            else { deadlines(height: height - 40, width: size.width - 2 * horizontal) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(.horizontal, horizontal).padding(.vertical, vertical)
    }
    private func icon(_ name: String, size: CGFloat) -> some View {
        Image("Widget-" + name).renderingMode(.template).resizable().scaledToFit().frame(width: size, height: size)
    }
    private func refresh(size: CGFloat = 40) -> some View {
        Toggle(isOn: false, intent: intent("refresh")) {
            icon("refresh", size: 18)
                .frame(width: size, height: size)
                .contentShape(.interaction, Rectangle())
        }
        .toggleStyle(WidgetRefreshStyle())
        .foregroundStyle(palette.muted)
        .accessibilityLabel("\(title) 새로고침")
    }
    private func seatStatus(_ message: String) -> some View {
        ZStack(alignment: .topTrailing) {
            empty(message).padding(.horizontal, 8)
            refresh()
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var heading: some View {
        HStack(spacing: 0) {
            Link(destination: url()) { Text(title).font(.system(size: 20, weight: .bold)).lineLimit(1) }
            Spacer(minLength: 4)
            refresh()
        }.frame(height: 40)
    }
    @ViewBuilder private func empty(_ text: String, row: Bool = false) -> some View {
        let label = Text(text).font(.system(size: row ? 16 : 17)).foregroundStyle(palette.muted)
            .multilineTextAlignment(.center).frame(maxWidth: .infinity)
        if row {
            label.frame(height: 64)
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
                .padding(.top, 4)
        } else { label.frame(maxHeight: .infinity) }
    }
    private func attendanceHeader(_ status: AttendanceStatus) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
                Text("빠른 출결").font(.system(size: 12, weight: .bold)).foregroundStyle(active ? palette.attendanceStatus : palette.muted)
                if !status.title.isEmpty { Text(status.title).font(.system(size: 19, weight: .bold)).lineLimit(2) }
            }.frame(maxWidth: .infinity, alignment: .leading)
            refresh()
        }
    }
    private func attendanceBadge(_ status: AttendanceStatus) -> some View {
        HStack(spacing: 5) {
            if ["present", "excused", "late", "absent"].contains(status.kind) {
                icon(status.kind == "late" ? "clock" : status.kind == "absent" ? "cross" : "tick", size: 14)
            }
            Text(status.message).font(.system(size: 12, weight: .semibold)).lineLimit(1)
        }.foregroundStyle(palette.attendanceText(status.tone)).padding(.horizontal, 9).padding(.vertical, 7)
            .background(palette.attendanceBackground(status.tone), in: RoundedRectangle(cornerRadius: 9)).fixedSize()
    }
    @ViewBuilder private func attendance(height: CGFloat) -> some View {
        if enteringAttendance { keypad(height: height) }
        else {
            let status = attendanceStatus
            let badge = ["present", "late", "excused", "absent", "other", "next"].contains(status.kind)
            if status.title.isEmpty {
                ZStack(alignment: .topLeading) {
                    VStack(spacing: 4) {
                        Text(status.message).font(.system(size: 15)).foregroundStyle(palette.muted)
                        if !status.detail.isEmpty { Text(status.detail).font(.system(size: 12)).foregroundStyle(palette.muted) }
                        if !data.object("attendance").text("receiptError").isEmpty { Text("출석 기록을 불러오지 못했어요.").font(.system(size: 12)).foregroundStyle(palette.muted) }
                    }.multilineTextAlignment(.center).padding(.horizontal, 36).frame(maxWidth: .infinity, maxHeight: .infinity)
                    attendanceHeader(status)
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                VStack(alignment: .leading, spacing: 14) {
                    attendanceHeader(status)
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 5) {
                            if !badge {
                                HStack(spacing: 6) {
                                    if active { Circle().fill(palette.attendanceStatus).frame(width: 5, height: 5) }
                                    Text(status.message).font(.system(size: 12.5, weight: .medium))
                                        .foregroundStyle(palette.attendanceText(status.tone)).lineLimit(2)
                                }
                            }
                            if !status.detail.isEmpty { Text(status.detail).font(.system(size: 12)).foregroundStyle(palette.muted).lineLimit(1) }
                        }.frame(maxWidth: .infinity, alignment: .leading)
                        if status.available {
                            Toggle(isOn: false, intent: intent("begin")) { Text("출석하기") }
                                .toggleStyle(WidgetPendingStyle(palette: palette, title: "출석하기", pendingTitle: "확인 중", icon: "tick"))
                                .frame(width: 108)

                        } else if status.kind == "waiting" {
                            Button {} label: { Text("확인중").font(.system(size: 15, weight: .semibold)).frame(width: 108, height: 44) }
                                .buttonStyle(.plain).disabled(true)
                                .foregroundStyle(palette.onPrimary).background(palette.primary, in: RoundedRectangle(cornerRadius: 12))
                                .opacity(0.45)
                        } else if badge { attendanceBadge(status) }
                    }.frame(maxHeight: .infinity)
                    if !data.object("attendance").text("receiptError").isEmpty { Text("출석 기록을 불러오지 못했어요.").font(.system(size: 12)).foregroundStyle(palette.muted) }
                }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
    }
    private func keypad(height: CGFloat) -> some View {
        let code = entry.state.text("code")
        let symbols = (0..<4).map { $0 < code.count ? String(Array(code)[$0]) : "–" }.joined(separator: "  ")
        let busy = entry.state.flag("pending") && HongsiClock.milliseconds(entry.date) - entry.state.number("pendingAt") < 45_000
        let message = entry.state.text("message")
        let keyHeight = max(24, (height - 54 - (message.isEmpty ? 0 : 14) - 8) / 2)
        return VStack(spacing: 0) {
            HStack(spacing: 0) {
                Button(intent: intent("back")) { Text("‹").font(.system(size: 24)).frame(width: 58, height: 54) }.buttonStyle(.plain).accessibilityLabel("출결 입력 닫기")
                Text(symbols).font(.system(size: 28, weight: .bold)).frame(maxWidth: .infinity).accessibilityLabel("출석번호 \(code)")
                Text("출석번호").font(.system(size: 14)).foregroundStyle(palette.muted).frame(width: 58)
            }.frame(height: 54)
            ForEach(0..<2) { row in
                HStack(spacing: 4) {
                    ForEach(0..<5) { column in
                        let digit = String((row * 5 + column + 1) % 10)
                        Button(intent: intent("digit", detail: digit)) {
                            Text(digit).font(.system(size: 22)).frame(maxWidth: .infinity).frame(height: keyHeight)
                        }.buttonStyle(.plain).background(palette.key, in: RoundedRectangle(cornerRadius: 12)).disabled(busy)
                    }
                    if row == 0 {
                        Button(intent: intent("erase")) {
                            Text("삭제").font(.system(size: 18)).frame(maxWidth: .infinity).frame(height: keyHeight)
                        }.buttonStyle(.plain).background(palette.key, in: RoundedRectangle(cornerRadius: 12))
                            .disabled(busy).accessibilityLabel("한 자리 지우기")
                    } else {
                        Toggle(isOn: busy, intent: intent("submit")) { Text("출석") }
                            .toggleStyle(WidgetPendingStyle(palette: palette, title: "출석", pendingTitle: "확인 중", height: keyHeight, fontSize: 18))
                            .disabled(busy || code.count != 4).accessibilityLabel("출석 확인")
                    }
                }.padding(2)
            }
            if !message.isEmpty { Text(message).font(.system(size: 10)).foregroundStyle(palette.warning).lineLimit(1).minimumScaleFactor(0.7).frame(height: 14) }
        }
    }
    @ViewBuilder private var seat: some View {
        let seat = data.object("seat")
        if !data.object("errors").text("seats").isEmpty { seatStatus("정보를 불러오지 못했어요.") }
        else if seat.isEmpty || !seat.isNull("endedAt") { seatStatus("이용 중인 좌석이 없어요.") }
        else {
            let remaining = max(0, Int(((seat.number("expiresAt") - entry.date.timeIntervalSince1970) / 60).rounded()))
            let hours = remaining / 60, minutes = remaining % 60
            let duration = hours == 0 ? "\(minutes)분" : minutes == 0 ? "\(hours)시간" : "\(hours)시간 \(minutes)분"
            let expired = seat.number("expiresAt") <= entry.date.timeIntervalSince1970
            let extended = seat.integer("extendCount") > 0
            let extending = WidgetModel.seatExtending(entry.state, seat: seat, now: entry.date)
            let detail = "\(seat.integer("id")):\(seat.integer("extendCount")):\(Int64(data.object("updatedAt").number("seats")))"
            let building = seat.text("buildingName")
            let code = seat.text("building", ["제4공학관": "T", "학생회관": "G", "홍문관": "R"][building] ?? "")
            let number = seat.integer("seatNo")
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 0) {
                    (Text(building).font(.system(size: 18, weight: .bold)) + Text(code.isEmpty ? "" : " (\(code)동)").font(.system(size: 14)).foregroundColor(palette.muted))
                        .lineLimit(1).minimumScaleFactor(0.7).frame(maxWidth: .infinity, alignment: .leading)
                    refresh(size: 28)
                }.frame(height: 28)
                Text(seat.text("roomName").replacingOccurrences(of: "제\\s*(\\d+)", with: "제 $1", options: .regularExpression))
                    .font(.system(size: 14)).foregroundStyle(palette.muted).lineLimit(1).padding(.top, 2)
                Text("\(number)번").font(.system(size: 32, weight: .bold))
                    .lineLimit(1).minimumScaleFactor(0.7).frame(maxHeight: .infinity, alignment: .leading)
                (Text(expired ? "만료" : duration).font(.system(size: 17)) + Text(expired ? "" : " 남음").font(.system(size: 13.6)))
                    .foregroundStyle(expired ? palette.error : palette.text).lineLimit(1).minimumScaleFactor(0.8).frame(maxWidth: .infinity)
                HStack(spacing: 6) {
                    Toggle(isOn: extending, intent: intent("extend", detail: detail)) { Text("연장") }
                        .toggleStyle(WidgetPendingStyle(palette: palette, title: extended ? "연장됨" : "연장", pendingTitle: "연장 중…", icon: "extend"))
                        .disabled(extended).opacity(extended ? 0.5 : 1)
                    Link(destination: url("endSeat:\(seat.integer("id"))")) { HStack(spacing: 6) { icon("exit", size: 18); Text("퇴실") }.frame(maxWidth: .infinity).frame(height: 44) }
                        .foregroundStyle(Color(hex: palette.dark ? "eef1f6" : "202735"))
                        .background(Color(hex: palette.dark ? "202730" : "f7f8fa"), in: RoundedRectangle(cornerRadius: 12))
                        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(hex: palette.dark ? "303945" : "e4e8ed"), lineWidth: 1))
                }.font(.system(size: 15, weight: .semibold)).padding(.top, 8)
                if entry.state.integer("seatMessageId") == seat.integer("id"), !extending, !entry.state.text("seatMessage").isEmpty { Text(entry.state.text("seatMessage")).font(.system(size: 10)).foregroundStyle(palette.muted).lineLimit(1).minimumScaleFactor(0.7) }
            }
        }
    }
    @ViewBuilder private func today(height: CGFloat) -> some View {
        if !WidgetModel.hasTimetable(data) { empty(data.object("errors").text("timetable").isEmpty && data.object("errors").text("lectures").isEmpty ? "앱에서 시간표를 한 번 불러와 주세요." : "정보를 불러오지 못했어요.", row: true) }
        else {
            let all = WidgetModel.today(data, now: entry.date)
            let items = all.filter { HongsiClock.minutes($0.text("start")) + (($0["periods"] as? [Int])?.count ?? 1) * 60 > HongsiClock.minute(entry.date) }
            if items.isEmpty { empty(all.isEmpty ? "오늘은 수업이 없어요." : "오늘 수업이 모두 끝났어요.", row: true) }
            else {
                let rowHeight: CGFloat = family == .systemLarge ? 64 : 50
                let visible: [JSON] = {
                    var result: [JSON] = [], used: CGFloat = 0
                    for slot in items {
                        let size = max(rowHeight, CGFloat(WidgetModel.classStates(data, slot: slot, now: entry.date).count * 24 + 12))
                        if !result.isEmpty && used + size > height - 8 { break }
                        result.append(slot); used += size
                    }
                    return result
                }()
                VStack(spacing: 0) {
                    ForEach(Array(visible.enumerated()), id: \.offset) { index, slot in
                        let states = WidgetModel.classStates(data, slot: slot, now: entry.date)
                        let current = AttendanceSnapshot.sessions(slots: [slot], now: entry.date).contains { HongsiClock.milliseconds(entry.date) >= $0.number("at") - 180_000 && HongsiClock.milliseconds(entry.date) <= $0.number("at") + 600_000 }
                        let actualHeight = max(rowHeight, CGFloat(states.count * 24 + 12))
                        Link(destination: url("class:" + slot.text("name"))) {
                            HStack(spacing: 0) {
                                Text(slot.text("start")).font(.system(size: 15, weight: .bold)).foregroundStyle(current ? palette.attendanceStatus : palette.text).frame(width: 52, alignment: .leading)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(slot.text("name")).font(.system(size: 14.5, weight: .bold)).lineLimit(family == .systemLarge ? 2 : 1)
                                    Text(slot.text("room", "강의실 미정")).font(.system(size: 12.5)).foregroundStyle(palette.muted).lineLimit(1)
                                }.frame(maxWidth: .infinity, alignment: .leading)
                                VStack(alignment: .trailing, spacing: 5) {
                                    ForEach(Array(states.enumerated()), id: \.offset) { _, state in
                                        Text(state.label).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                                            .foregroundStyle(palette.attendanceText(state.tone, quick: false))
                                            .padding(.horizontal, 8).padding(.vertical, 4)
                                            .background(palette.attendanceBackground(state.tone, quick: false), in: Capsule())
                                    }
                                }.fixedSize().padding(.leading, 6)
                            }.padding(.leading, 12).padding(.trailing, 8).frame(height: actualHeight)
                                .overlay(alignment: .leading) { RoundedRectangle(cornerRadius: 2).fill(Color(hex: slot.text("color"))).frame(width: 3, height: actualHeight - 20) }
                                .overlay(alignment: .top) { if index > 0 { Rectangle().fill(palette.border).frame(height: 0.5) } }
                        }
                    }
                }.padding(.vertical, 2).overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(palette.border, lineWidth: 1)).padding(.top, 4)
            }
        }
    }
    @ViewBuilder private func deadlines(height: CGFloat, width: CGFloat) -> some View {
        if !data.object("errors").text("calendar").isEmpty { empty("정보를 불러오지 못했어요.", row: true) }
        else {
            let items = WidgetModel.deadlines(data, now: entry.date)
            if items.isEmpty { empty("남은 일정이 없어요.", row: true) }
            else {
                let sizes = items.map { deadlineHeight($0, width: width) }
                let count: Int = {
                    var count = 0, used: CGFloat = 0
                    for size in sizes {
                        let next = used + size + 4
                        let footer: CGFloat = count + 1 < items.count ? 20 : 0
                        if count > 0 && next + footer > height { break }
                        count += 1; used = next
                    }
                    return count
                }()
                VStack(spacing: 0) {
                    ForEach(Array(items.prefix(count).enumerated()), id: \.offset) { index, item in
                        deadlineRow(item).frame(height: sizes[index]).padding(.bottom, 4)
                    }
                    if items.count > count { Text("+ \(items.count - count)개의 마감").font(.system(size: 14)).foregroundStyle(palette.muted).frame(maxWidth: .infinity).frame(height: 20) }
                }

            }
        }
    }
    private func deadlineHeight(_ item: JSON, width: CGFloat) -> CGFloat {
        let status = item.text("status", "상태 확인 필요")
        let badge = item.text("kind") == "todo" ? 0 : (status as NSString).size(withAttributes: [.font: UIFont.systemFont(ofSize: 13)]).width + 22
        let textWidth = max(20, width - 18 - 54 - badge)
        func height(_ text: String, font: UIFont, width: CGFloat, lines: Int) -> CGFloat {
            let size = (text as NSString).boundingRect(with: CGSize(width: max(20, width), height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: font], context: nil)
            return min(font.lineHeight * CGFloat(lines), max(font.lineHeight, size.height))
        }
        let title = height(item.text("title"), font: .systemFont(ofSize: 16, weight: .bold), width: textWidth - 20, lines: 2)
        let date = height(WidgetModel.deadlineLabel(item, data: data), font: .systemFont(ofSize: 12), width: textWidth, lines: 2)
        return max(62, ceil(title + UIFont.systemFont(ofSize: 12).lineHeight + date + 12))
    }
    private func deadlineRow(_ item: JSON) -> some View {
        let days = WidgetModel.deadlineDay(item, data: data) - Int(floor((entry.date.timeIntervalSince1970 + 32400) / 86400))
        let todo = item.text("kind") == "todo"
        let accent = Color(hex: item.text("color", palette.dark ? "f3f4f6" : "111827"))
        return Link(destination: url("deadline:" + item.text("key"))) {
            HStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 5) {
                        icon(todo ? "todo" : item.text("kind") == "vod" ? "vod" : "assignment", size: 15).foregroundStyle(accent)
                        Text(item.text("title")).font(.system(size: 16, weight: .bold)).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    }
                    Text(item.text("course", todo ? "공통" : "")).font(.system(size: 12)).foregroundStyle(palette.muted).lineLimit(1)
                    Text(WidgetModel.deadlineLabel(item, data: data)).font(.system(size: 12)).foregroundStyle(palette.muted).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                }.frame(maxWidth: .infinity, alignment: .leading)
                if !todo { badge(item.text("status", "상태 확인 필요"), tone: statusTone(item.text("status")), size: 13).padding(.leading, 6) }
                Text(item.isNull("due") ? "미정" : days <= 0 ? "D-DAY" : "D-\(days)").font(.system(size: 14, weight: .bold))
                    .foregroundStyle(days <= 3 ? palette.deadlineSoon : palette.muted).frame(width: 54)
            }.padding(.leading, 12).padding(.trailing, 6).padding(.vertical, 3).frame(maxHeight: .infinity)
                .overlay(alignment: .leading) { RoundedRectangle(cornerRadius: 2).fill(accent).frame(width: 3).padding(.vertical, 14).padding(.leading, 1) }
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(palette.border, lineWidth: 1))
        }
    }
    private func statusTone(_ status: String) -> String {
        switch status {
        case "제출 완료", "출석 인정", "완료": return "success"
        case "미제출", "미시청", "부분 인정", "미완료": return "warn"
        case "마감 지남", "미인정": return "error"
        case "시청 전": return "info"
        default: return "muted"
        }
    }
    private func badge(_ text: String, tone: String, size: CGFloat) -> some View {
        Text(text).font(.system(size: size)).foregroundStyle(palette.badgeText(tone)).lineLimit(1)
            .padding(.horizontal, size == 12 ? 7 : 8).padding(.vertical, size == 12 ? 4 : 5)
            .background(palette.badgeBackground(tone), in: Capsule())
    }
    @ViewBuilder private var week: some View {
        if !WidgetModel.hasTimetable(data) { empty(data.object("errors").text("timetable").isEmpty ? "앱에서 시간표를 한 번 불러와 주세요." : "정보를 불러오지 못했어요.") }
        else if data.objects("slots").isEmpty { empty("등록된 수업이 없어요.") }
        else { WeekGrid(data: data, date: entry.date, palette: palette) }
    }
}

struct WeekGrid: View {
    let data: JSON, date: Date, palette: WidgetPalette
    var body: some View {
        Canvas { context, size in
            let slots = data.objects("slots")
            let days = min(7, max(5, (slots.map { $0.integer("weekday") }.max() ?? 4) + 1))
            let starts = slots.map { HongsiClock.minutes($0.text("start")) }
            let ends = slots.map { HongsiClock.minutes($0.text("start")) + max(1, ($0["periods"] as? [Int])?.count ?? 1) * 60 }
            let fit = data.object("preferences").text("timetableDisplay", "fit") != "full"
            let first = starts.min() ?? 540, last = ends.max() ?? 1080
            let start = (fit ? first : min(540, first)) / 60 * 60
            let end = max(start + 60, ((fit ? last : max(1080, last)) + 59) / 60 * 60)
            let left: CGFloat = 26, top: CGFloat = 24, column = (size.width - left) / CGFloat(days), unit = (size.height - top) / CGFloat(end - start)
            for day in 0..<days {
                context.draw(Text(String(Array("월화수목금토일")[day])).font(.system(size: 12)).foregroundColor(palette.muted), at: CGPoint(x: left + (CGFloat(day) + 0.5) * column, y: 8))
            }
            for minute in stride(from: start, to: end, by: 60) {
                let y = top + CGFloat(minute - start) * unit
                var line = Path(); line.move(to: CGPoint(x: left, y: y)); line.addLine(to: CGPoint(x: size.width, y: y))
                context.stroke(line, with: .color(palette.muted.opacity(55.0 / 255)), lineWidth: 0.5)
                context.draw(Text("\(minute / 60)").font(.system(size: 11)).foregroundColor(palette.muted), at: CGPoint(x: 0, y: y + 7), anchor: .leading)
            }
            for slot in slots {
                let day = slot.integer("weekday"), minute = HongsiClock.minutes(slot.text("start"))
                guard (0..<days).contains(day) else { continue }
                let finish = minute + max(1, (slot["periods"] as? [Int])?.count ?? 1) * 60
                let box = CGRect(x: left + CGFloat(day) * column + 2, y: top + CGFloat(minute - start) * unit + 1, width: column - 4, height: max(4, CGFloat(finish - minute) * unit - 3))
                let path = Path(roundedRect: box, cornerRadius: 5)
                context.fill(path, with: .color(Color(hex: palette.dark ? "aeb8c6" : "ffffff")))
                context.fill(path, with: .color(Color(hex: slot.text("color")).opacity(palette.dark ? 0.24 : 0.16)))
                var clipped = context; clipped.clip(to: path)
                let textColor = Color(hex: palette.dark ? "1b2433" : "202735")
                let fontSize: CGFloat = days > 5 ? 11 : 12
                let maxLines = min(3, max(1, Int((box.height - 19) / 14)))
                let lines = Self.wrap(slot.text("name"), width: box.width - 8, fontSize: fontSize, maxLines: maxLines)
                for (index, line) in lines.enumerated() {
                    clipped.draw(Text(line).font(.system(size: fontSize, weight: .bold)).foregroundColor(textColor),
                                 at: CGPoint(x: box.minX + 4, y: box.minY + 1 + CGFloat(index) * 14), anchor: .topLeading)
                }
                let roomColor = Color(hex: palette.dark ? "293548" : "535e6e")
                clipped.draw(Text(String(slot.text("room").prefix(10))).font(.system(size: 10)).foregroundColor(roomColor),
                             at: CGPoint(x: box.minX + 4, y: min(box.minY + CGFloat(lines.count) * 14 + 3, box.maxY - 14)), anchor: .topLeading)
            }
            let today = HongsiClock.weekday(date), minute = HongsiClock.minute(date)
            if today < days && minute >= start && minute < end {
                let x = left + CGFloat(today) * column, y = top + CGFloat(minute - start) * unit
                var line = Path(); line.move(to: CGPoint(x: x, y: y)); line.addLine(to: CGPoint(x: x + column, y: y))
                context.stroke(line, with: .color(palette.deadlineSoon), lineWidth: 2)
                context.fill(Path(ellipseIn: CGRect(x: x - 3, y: y - 3, width: 6, height: 6)), with: .color(palette.deadlineSoon))
            }
        }
        .accessibilityLabel("주간 시간표. " + data.objects("slots").map { "\($0.text("name")), \($0.text("start")), \($0.text("room"))" }.joined(separator: ". "))
    }
    private static func wrap(_ value: String, width: CGFloat, fontSize: CGFloat, maxLines: Int) -> [String] {
        let font = UIFont.systemFont(ofSize: fontSize, weight: .bold)
        func fits(_ text: String) -> Bool { (text as NSString).size(withAttributes: [.font: font]).width <= width }
        var remaining = Array(value), result: [String] = []
        while !remaining.isEmpty && result.count < maxLines {
            var count = 1
            while count < remaining.count && fits(String(remaining.prefix(count + 1))) { count += 1 }
            let clipped = result.count == maxLines - 1 && count < remaining.count
            if clipped { while count > 1 && !fits(String(remaining.prefix(count)) + "…") { count -= 1 } }
            result.append(String(remaining.prefix(count)) + (clipped ? "…" : ""))
            remaining.removeFirst(count)
        }
        return result
    }
}

private func configuration(_ kind: String, _ title: String, _ description: String, _ families: [WidgetFamily]) -> some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: HongsiProvider(kind: kind)) { HongsiWidgetView(kind: kind, entry: $0) }
            .configurationDisplayName(title).description(description).supportedFamilies(families)
            .contentMarginsDisabled()
}

struct AttendanceWidget: Widget {
    var body: some WidgetConfiguration { configuration("ATTENDANCE", "빠른 출결", "홈 화면에서 출석번호를 입력하고 출결해요.", [.systemMedium]) }
}
struct TodayWidget: Widget {
    var body: some WidgetConfiguration { configuration("TODAY", "오늘 수업", "오늘 남은 수업과 강의실을 확인해요.", [.systemMedium]) }
}
struct TodayLargeWidget: Widget {
    var body: some WidgetConfiguration { configuration("TODAY_LARGE", "오늘 수업 크게", "오늘의 수업과 강의실을 넓게 확인해요.", [.systemLarge]) }
}
struct DeadlinesWidget: Widget {
    var body: some WidgetConfiguration { configuration("DEADLINES", "다가오는 마감", "과제와 강의, 할 일의 마감과 상태를 확인해요.", [.systemMedium]) }
}
struct DeadlinesLargeWidget: Widget {
    var body: some WidgetConfiguration { configuration("DEADLINES_LARGE", "다가오는 마감 크게", "더 많은 일정의 마감과 상태를 한눈에 확인해요.", [.systemLarge]) }
}
struct SeatWidget: Widget {
    var body: some WidgetConfiguration { configuration("SEAT", "열람실 좌석", "내 좌석과 남은 시간을 확인하고 연장하거나 퇴실해요.", [.systemSmall]) }
}
struct WeekWidget: Widget {
    var body: some WidgetConfiguration { configuration("WEEK", "주간 시간표", "한 주의 수업과 강의실을 한눈에 확인해요.", [.systemLarge]) }
}
@main
struct HongsiWidgetBundle: WidgetBundle {
    var body: some Widget {
        AttendanceWidget()
        TodayWidget()
        TodayLargeWidget()
        DeadlinesWidget()
        DeadlinesLargeWidget()
        SeatWidget()
        WeekWidget()
    }
}
