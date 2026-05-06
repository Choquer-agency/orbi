import UIKit
import Capacitor
import UserNotifications
import LocalAuthentication

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {

    var window: UIWindow?
    private var privacySnapshotView: UIView?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Set self as notification center delegate for foreground handling
        UNUserNotificationCenter.current().delegate = self

        // Register notification categories with action buttons
        registerNotificationCategories()

        return true
    }

    // MARK: - Push Notification Registration

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        // Forward to Capacitor PushNotifications plugin
        NotificationCenter.default.post(
            name: .capacitorDidRegisterForRemoteNotifications,
            object: deviceToken
        )
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // Forward to Capacitor PushNotifications plugin
        NotificationCenter.default.post(
            name: .capacitorDidFailToRegisterForRemoteNotifications,
            object: error
        )
    }

    // MARK: - UNUserNotificationCenterDelegate

    // Foreground notification presentation — suppress banner (socket handles in-app toast)
    // Keep badge and sound so they still update
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.badge, .sound])
    }

    // Notification action performed (tap or action button press)
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        // Forward to Capacitor PushNotifications plugin for JS handling
        NotificationCenter.default.post(
            name: NSNotification.Name("capacitorDidReceiveRemoteNotification"),
            object: response
        )
        completionHandler()
    }

    // MARK: - Notification Categories

    private func registerNotificationCategories() {
        let replyAction = UNNotificationAction(
            identifier: "REPLY_ACTION",
            title: "Reply",
            options: [.foreground]
        )
        let archiveAction = UNNotificationAction(
            identifier: "ARCHIVE_ACTION",
            title: "Archive",
            options: [.destructive]
        )
        let markReadAction = UNNotificationAction(
            identifier: "MARK_READ_ACTION",
            title: "Mark Read",
            options: []
        )
        let viewAction = UNNotificationAction(
            identifier: "VIEW_ACTION",
            title: "View",
            options: [.foreground]
        )
        let snooze1hAction = UNNotificationAction(
            identifier: "SNOOZE_1H_ACTION",
            title: "Snooze 1hr",
            options: []
        )
        let acceptAction = UNNotificationAction(
            identifier: "ACCEPT_ACTION",
            title: "Accept",
            options: [.foreground]
        )

        let newEmailCategory = UNNotificationCategory(
            identifier: "NEW_EMAIL",
            actions: [replyAction, archiveAction, markReadAction],
            intentIdentifiers: [],
            options: []
        )
        let mentionCategory = UNNotificationCategory(
            identifier: "MENTION",
            actions: [viewAction, markReadAction],
            intentIdentifiers: [],
            options: []
        )
        let assignmentCategory = UNNotificationCategory(
            identifier: "ASSIGNMENT",
            actions: [acceptAction, viewAction],
            intentIdentifiers: [],
            options: []
        )
        let snoozeCategory = UNNotificationCategory(
            identifier: "SNOOZE_REMINDER",
            actions: [snooze1hAction, viewAction],
            intentIdentifiers: [],
            options: []
        )
        let slaCategory = UNNotificationCategory(
            identifier: "SLA_WARNING",
            actions: [replyAction, viewAction],
            intentIdentifiers: [],
            options: []
        )

        UNUserNotificationCenter.current().setNotificationCategories([
            newEmailCategory,
            mentionCategory,
            assignmentCategory,
            snoozeCategory,
            slaCategory,
        ])
    }

    // MARK: - App Lifecycle

    func applicationWillResignActive(_ application: UIApplication) {
        // Show privacy snapshot so app switcher doesn't reveal email content
        showPrivacySnapshot()
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Record timestamp for biometric grace period
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: "appBackgroundTimestamp")
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        removePrivacySnapshot()
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Clear badge when app comes to foreground
        UIApplication.shared.applicationIconBadgeNumber = 0
        removePrivacySnapshot()
    }

    func applicationWillTerminate(_ application: UIApplication) {
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

    // MARK: - Quick Actions (3D Touch / Long Press on App Icon)

    func application(_ application: UIApplication, performActionFor shortcutItem: UIApplicationShortcutItem, completionHandler: @escaping (Bool) -> Void) {
        var urlString: String

        switch shortcutItem.type {
        case "com.orbimail.app.compose":
            urlString = "orbi-mail://compose"
        case "com.orbimail.app.search":
            urlString = "orbi-mail://search"
        case "com.orbimail.app.inbox":
            urlString = "orbi-mail://inbox"
        default:
            completionHandler(false)
            return
        }

        if let url = URL(string: urlString) {
            ApplicationDelegateProxy.shared.application(
                application,
                open: url,
                options: [:]
            )
        }
        completionHandler(true)
    }

    // MARK: - Privacy Snapshot (hides content in app switcher)

    private func showPrivacySnapshot() {
        guard privacySnapshotView == nil, let window = self.window else { return }

        // Only show if biometric lock is enabled
        let lockEnabled = UserDefaults.standard.bool(forKey: "biometricLockEnabled")
        guard lockEnabled else { return }

        let snapshot = UIView(frame: window.bounds)
        snapshot.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        snapshot.backgroundColor = UIColor(red: 250/255, green: 249/255, blue: 245/255, alpha: 1) // #FAF9F5

        // Centered Orbi logo placeholder — use app icon
        let iconSize: CGFloat = 80
        if let iconImage = UIImage(named: "AppIcon") ?? UIImage(named: "AppIcon60x60") {
            let imageView = UIImageView(image: iconImage)
            imageView.contentMode = .scaleAspectFit
            imageView.frame = CGRect(
                x: (window.bounds.width - iconSize) / 2,
                y: (window.bounds.height - iconSize) / 2,
                width: iconSize,
                height: iconSize
            )
            imageView.layer.cornerRadius = 18
            imageView.clipsToBounds = true
            imageView.autoresizingMask = [
                .flexibleTopMargin, .flexibleBottomMargin,
                .flexibleLeftMargin, .flexibleRightMargin
            ]
            snapshot.addSubview(imageView)
        }

        window.addSubview(snapshot)
        privacySnapshotView = snapshot
    }

    private func removePrivacySnapshot() {
        privacySnapshotView?.removeFromSuperview()
        privacySnapshotView = nil
    }
}
