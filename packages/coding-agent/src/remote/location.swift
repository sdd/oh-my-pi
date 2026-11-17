import CoreLocation
import Foundation

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

final class LocationRecorder: NSObject, CLLocationManagerDelegate {
    let manager = CLLocationManager()

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
        manager.distanceFilter = 50
        manager.requestWhenInUseAuthorization()
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            manager.startUpdatingLocation()
        case .denied, .restricted:
            emit(["unavailable": "Location permission denied"])
        case .notDetermined:
            emit(["unavailable": "Location permission pending"])
        @unknown default:
            emit(["unavailable": "Unknown location authorization"])
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        for location in locations where location.horizontalAccuracy >= 0 {
            emit([
                "source": "macos",
                "timestamp": location.timestamp.timeIntervalSince1970 * 1000,
                "latitude": location.coordinate.latitude,
                "longitude": location.coordinate.longitude,
                "accuracyM": location.horizontalAccuracy,
            ])
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        emit(["unavailable": "Location update unavailable"])
    }
}

let recorder = LocationRecorder()
RunLoop.main.run()
