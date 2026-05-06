import CoreLocation
import Foundation

enum ArrivalVerificationResult {
    case verified
    case outsideRadius(distanceMeters: Double)
    case unavailable
}

final class ArrivalVerificationService: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var continuation: CheckedContinuation<CLLocation?, Never>?
    private var requested = false

    func verifyArrival(client: Client, radiusMeters: Double = 200) async -> ArrivalVerificationResult {
        guard let coords = client.coords else { return .unavailable }
        guard let current = await oneShotLocation() else { return .unavailable }

        let target = CLLocation(latitude: coords.lat, longitude: coords.lon)
        let distance = current.distance(from: target)
        return distance <= radiusMeters ? .verified : .outsideRadius(distanceMeters: distance)
    }

    private func oneShotLocation() async -> CLLocation? {
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters

        let status = manager.authorizationStatus
        if status == .notDetermined {
            manager.requestWhenInUseAuthorization()
        } else if status == .denied || status == .restricted {
            return nil
        }

        return await withCheckedContinuation { continuation in
            self.continuation = continuation
            self.requested = true
            self.manager.requestLocation()
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard requested else { return }
        requested = false
        continuation?.resume(returning: locations.last)
        continuation = nil
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        guard requested else { return }
        requested = false
        continuation?.resume(returning: nil)
        continuation = nil
    }
}
