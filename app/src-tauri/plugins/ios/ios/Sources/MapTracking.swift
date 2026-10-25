import Foundation
import CoreLocation
import UIKit
import Tauri

@MainActor
final class MapTracking: NSObject, @preconcurrency CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var events: Channel?
    private var wanted = false
    private var heading = false
    private var active = false

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        manager.distanceFilter = kCLDistanceFilterNone
        manager.headingFilter = 1
        manager.activityType = .otherNavigation
        manager.pausesLocationUpdatesAutomatically = false
    }

    func start(_ channel: Channel) {
        stop(); events = channel; wanted = true; resume()
    }

    func resume() {
        guard wanted, !active, UIApplication.shared.applicationState == .active else { return }
        active = true
        guard manager.authorizationStatus == .authorizedWhenInUse || manager.authorizationStatus == .authorizedAlways else {
            fail("위치 권한을 허용해 주세요."); return
        }
        manager.startUpdatingLocation()
        if heading { updateHeadingOrientation(); manager.startUpdatingHeading() }
    }

    func setHeading(_ enabled: Bool) -> Bool {
        heading = enabled
        manager.stopUpdatingHeading()
        guard enabled else { manager.dismissHeadingCalibrationDisplay(); return true }
        guard active, CLLocationManager.headingAvailable() else { return false }
        updateHeadingOrientation(); manager.startUpdatingHeading(); return true
    }

    private func updateHeadingOrientation() {
        let orientation = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }?.interfaceOrientation
        switch orientation {
        case .landscapeLeft: manager.headingOrientation = .landscapeLeft
        case .landscapeRight: manager.headingOrientation = .landscapeRight
        case .portraitUpsideDown: manager.headingOrientation = .portraitUpsideDown
        default: manager.headingOrientation = .portrait
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard active else { return }
        for location in locations where location.horizontalAccuracy >= 0 && abs(location.timestamp.timeIntervalSinceNow) <= 15 {
            events?.send(["type": "position", "position": ["latitude": location.coordinate.latitude, "longitude": location.coordinate.longitude,
                "accuracy": location.horizontalAccuracy, "timestamp": location.timestamp.timeIntervalSince1970 * 1000]])
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateHeading value: CLHeading) {
        guard active, heading, value.headingAccuracy >= 0, value.headingAccuracy <= 60 else { return }
        updateHeadingOrientation()
        events?.send(["type": "heading", "heading": value.trueHeading >= 0 ? value.trueHeading : value.magneticHeading, "accuracy": value.headingAccuracy])
    }

    func locationManagerShouldDisplayHeadingCalibration(_ manager: CLLocationManager) -> Bool {
        return active && heading
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        if active && manager.authorizationStatus != .authorizedWhenInUse && manager.authorizationStatus != .authorizedAlways {
            pause(); fail("위치 권한을 허용해 주세요.")
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        if (error as? CLError)?.code != .locationUnknown { fail("현재 위치를 확인하지 못했어요. 다시 시도해 주세요.") }
    }

    private func fail(_ message: String) { try? events?.send(["type": "error", "message": message]) }
    func pause() { active = false; manager.stopUpdatingLocation(); manager.stopUpdatingHeading(); manager.dismissHeadingCalibrationDisplay() }
    func stop() { pause(); wanted = false; heading = false; events = nil }
}
