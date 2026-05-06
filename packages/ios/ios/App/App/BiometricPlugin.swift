import Capacitor
import LocalAuthentication

@objc(BiometricPlugin)
public class BiometricPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "BiometricPlugin"
    public let jsName = "BiometricPlugin"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "authenticate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getBackgroundTimestamp", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setLockEnabled", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isLockEnabled", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setGracePeriod", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getGracePeriod", returnType: CAPPluginReturnPromise),
    ]

    /// Check if biometric authentication (Face ID / Touch ID) is available
    @objc func isAvailable(_ call: CAPPluginCall) {
        let context = LAContext()
        var error: NSError?
        let available = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)

        var biometryType = "none"
        if available {
            switch context.biometryType {
            case .faceID:
                biometryType = "faceId"
            case .touchID:
                biometryType = "touchId"
            case .opticID:
                biometryType = "opticId"
            @unknown default:
                biometryType = "unknown"
            }
        }

        // Also check if device passcode is available (fallback)
        let passcodeAvailable = context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)

        call.resolve([
            "available": available,
            "biometryType": biometryType,
            "passcodeAvailable": passcodeAvailable,
        ])
    }

    /// Authenticate using biometrics with automatic fallback to device passcode
    @objc func authenticate(_ call: CAPPluginCall) {
        let reason = call.getString("reason") ?? "Unlock Orbi Mail"
        let context = LAContext()
        context.localizedFallbackTitle = "Use Passcode"

        // Use .deviceOwnerAuthentication to allow passcode fallback after biometric failure
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, error in
            DispatchQueue.main.async {
                if success {
                    call.resolve(["success": true])
                } else {
                    let errorCode = (error as? LAError)?.code ?? .authenticationFailed
                    let cancelled = errorCode == .userCancel || errorCode == .appCancel || errorCode == .systemCancel
                    call.resolve([
                        "success": false,
                        "cancelled": cancelled,
                        "errorCode": errorCode.rawValue,
                    ])
                }
            }
        }
    }

    /// Get the timestamp when the app was last backgrounded
    @objc func getBackgroundTimestamp(_ call: CAPPluginCall) {
        let timestamp = UserDefaults.standard.double(forKey: "appBackgroundTimestamp")
        call.resolve(["timestamp": timestamp])
    }

    /// Enable or disable biometric lock
    @objc func setLockEnabled(_ call: CAPPluginCall) {
        guard let enabled = call.getBool("enabled") else {
            call.reject("Missing 'enabled' parameter")
            return
        }
        UserDefaults.standard.set(enabled, forKey: "biometricLockEnabled")
        call.resolve()
    }

    /// Check if biometric lock is enabled
    @objc func isLockEnabled(_ call: CAPPluginCall) {
        let enabled = UserDefaults.standard.bool(forKey: "biometricLockEnabled")
        call.resolve(["enabled": enabled])
    }

    /// Set the grace period in seconds before requiring re-authentication
    @objc func setGracePeriod(_ call: CAPPluginCall) {
        guard let seconds = call.getInt("seconds") else {
            call.reject("Missing 'seconds' parameter")
            return
        }
        UserDefaults.standard.set(seconds, forKey: "biometricGracePeriod")
        call.resolve()
    }

    /// Get the current grace period (default: 0 = immediately)
    @objc func getGracePeriod(_ call: CAPPluginCall) {
        let seconds = UserDefaults.standard.integer(forKey: "biometricGracePeriod")
        call.resolve(["seconds": seconds])
    }
}
