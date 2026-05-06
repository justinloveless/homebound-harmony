import CoreLocation
import MapKit
import UIKit

/// Which maps app opens from **Navigate** on the Today tab. iOS has no system-wide default for third-party apps.
enum MapsAppPreference: String, CaseIterable, Identifiable {
    case appleMaps
    case googleMaps

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .appleMaps: return "Apple Maps"
        case .googleMaps: return "Google Maps"
        }
    }

    static let userDefaultsKey = "preferredMapsApp"
}

enum MapsNavigation {
    static func openDrivingDirections(to address: String, preferredApp: MapsAppPreference) {
        switch preferredApp {
        case .appleMaps:
            openAppleMapsDrivingDirections(to: address)
        case .googleMaps:
            openGoogleMapsDrivingDirections(to: address)
        }
    }

    static func directionsURL(to address: String, preferredApp: MapsAppPreference) -> URL? {
        let encoded = address.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        guard !encoded.isEmpty else { return nil }
        switch preferredApp {
        case .appleMaps:
            return URL(string: "maps://?daddr=\(encoded)")
        case .googleMaps:
            return URL(string: "comgooglemaps://?daddr=\(encoded)&directionsmode=driving")
                ?? URL(string: "https://www.google.com/maps/dir/?api=1&destination=\(encoded)")
        }
    }

    private static func openAppleMapsDrivingDirections(to address: String) {
        let geocoder = CLGeocoder()
        geocoder.geocodeAddressString(address) { placemarks, _ in
            Task { @MainActor in
                if let placemark = placemarks?.first,
                   let location = placemark.location {
                    let mkPlacemark = MKPlacemark(coordinate: location.coordinate)
                    let mapItem = MKMapItem(placemark: mkPlacemark)
                    mapItem.name = placemark.name ?? address
                    mapItem.openInMaps(launchOptions: [MKLaunchOptionsDirectionsModeKey: MKLaunchOptionsDirectionsModeDriving])
                } else if let encoded = address.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
                          let url = URL(string: "maps://?daddr=\(encoded)") {
                    UIApplication.shared.open(url)
                }
            }
        }
    }

    private static func openGoogleMapsDrivingDirections(to address: String) {
        let encoded = address.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        guard !encoded.isEmpty else { return }
        if let appURL = URL(string: "comgooglemaps://?daddr=\(encoded)&directionsmode=driving"),
           UIApplication.shared.canOpenURL(appURL) {
            UIApplication.shared.open(appURL)
        } else if let webURL = URL(string: "https://www.google.com/maps/dir/?api=1&destination=\(encoded)") {
            UIApplication.shared.open(webURL)
        }
    }
}
