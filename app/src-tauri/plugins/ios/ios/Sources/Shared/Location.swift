import Foundation
import CoreLocation

@MainActor
final class HongsiLocation: NSObject, @preconcurrency CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private let useLastKnown: Bool
    private var latest: CLLocation?
    private var preparing = false
    private var continuations: [CheckedContinuation<CLLocation, Error>] = []
    private var locating = false
    private var permissionContinuation: CheckedContinuation<String, Error>?
    private var timeout: Task<Void, Never>?
    private var mayRequestPermission = false

    init(useLastKnown: Bool = false) { self.useLastKnown = useLastKnown; super.init(); manager.delegate = self; manager.desiredAccuracy = kCLLocationAccuracyBest }
    var precise: Bool { manager.accuracyAuthorization == .fullAccuracy }
    var permission: String {
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse: return "granted"
        case .notDetermined: return "default"
        default: return "denied"
        }
    }
    func requestPermission() async throws -> String {
        guard permission == "default" else { return permission }
        guard permissionContinuation == nil else { throw WidgetFailure("위치 권한을 확인하고 있어요.") }
        return try await withCheckedThrowingContinuation { pending in
            permissionContinuation = pending
            manager.requestWhenInUseAuthorization()
        }
    }
    func prepare() {
        preparing = true
        if permission == "granted" { request() }
    }
    func cancel() {
        preparing = false
        finish(.failure(WidgetFailure("위치를 찾지 못했어요.")))
    }
    func locate(requestPermission: Bool) async throws -> CLLocation {
        mayRequestPermission = requestPermission
        return try await withCheckedThrowingContinuation { pending in
            continuations.append(pending)
            request()
        }
    }
    private func valid(_ location: CLLocation) -> Bool {
        location.horizontalAccuracy >= 0 && CLLocationCoordinate2DIsValid(location.coordinate)
    }
    private func request() {
        guard preparing || !continuations.isEmpty else { return }
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            let cached = [manager.location, latest].compactMap { $0 }.filter { location in
                valid(location) && (useLastKnown || (location.horizontalAccuracy <= 100 && abs(location.timestamp.timeIntervalSinceNow) <= 30))
            }.max { $0.timestamp < $1.timestamp }
            if let cached { finish(.success(cached)); return }
            guard !locating else { return }
            locating = true
            startTimeout()
            manager.requestLocation()
        case .notDetermined:
            if mayRequestPermission { startTimeout(); manager.requestWhenInUseAuthorization() }
            else { finish(.failure(WidgetFailure("앱에서 위치 권한을 허용해 주세요."))) }
        default: latest = nil; finish(.failure(WidgetFailure("설정에서 위치 권한을 허용해 주세요.")))
        }
    }
    private func startTimeout() {
        guard timeout == nil else { return }
        timeout = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 15_000_000_000)
            if !Task.isCancelled { self?.finish(.failure(WidgetFailure("위치를 찾지 못했어요."))) }
        }
    }
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        if permission != "default" {
            let pending = permissionContinuation; permissionContinuation = nil
            pending?.resume(returning: permission)
        }
        request()
    }
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard locating else { return }
        guard let location = locations.last(where: { valid($0) && (useLastKnown || abs($0.timestamp.timeIntervalSinceNow) <= 30) }) else {
            finish(.failure(WidgetFailure("위치를 찾지 못했어요."))); return
        }
        finish(.success(location))
    }
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) { finish(.failure(WidgetFailure("위치를 찾지 못했어요."))) }
    private func finish(_ result: Result<CLLocation, Error>) {
        if case let .success(location) = result, useLastKnown { latest = location }
        let pending = continuations
        continuations.removeAll()
        timeout?.cancel(); timeout = nil
        if locating { manager.stopUpdatingLocation(); locating = false }
        mayRequestPermission = false
        for item in pending { item.resume(with: result) }
    }
}
