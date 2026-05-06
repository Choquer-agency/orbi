import Foundation
import Capacitor
import BackgroundTasks
import UIKit

@objc(BackgroundSyncPlugin)
public class BackgroundSyncPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BackgroundSyncPlugin"
    public let jsName = "BackgroundSync"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "registerBackgroundTask", returnType: CAPPluginReturnPromise),
    ]

    private static let taskIdentifier = "com.orbimail.app.refresh"

    @objc func registerBackgroundTask(_ call: CAPPluginCall) {
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: BackgroundSyncPlugin.taskIdentifier,
            using: nil
        ) { task in
            self.handleAppRefresh(task: task as! BGAppRefreshTask)
        }

        scheduleAppRefresh()
        call.resolve()
    }

    private func scheduleAppRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: BackgroundSyncPlugin.taskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60) // 15 minutes minimum

        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            print("[BackgroundSync] Failed to schedule: \(error.localizedDescription)")
        }
    }

    private func handleAppRefresh(task: BGAppRefreshTask) {
        // Schedule the next refresh before doing work
        scheduleAppRefresh()

        task.expirationHandler = {
            task.setTaskCompleted(success: false)
        }

        // Fetch unread count and update badge
        fetchUnreadCountAndUpdateBadge { success in
            task.setTaskCompleted(success: success)
        }
    }

    private func fetchUnreadCountAndUpdateBadge(completion: @escaping (Bool) -> Void) {
        // Get the API URL and token from the web view's state
        guard let bridge = self.bridge,
              let webView = bridge.webView else {
            completion(false)
            return
        }

        // Execute JS to get the stored auth token and API URL
        webView.evaluateJavaScript("""
            (function() {
                try {
                    const stored = localStorage.getItem('orbi-auth');
                    if (!stored) return null;
                    const parsed = JSON.parse(stored);
                    return JSON.stringify({
                        token: parsed.state?.token,
                        apiUrl: window.__ORBI_API_URL || ''
                    });
                } catch { return null; }
            })()
        """) { result, error in
            guard let jsonString = result as? String,
                  let data = jsonString.data(using: .utf8),
                  let config = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let token = config["token"] as? String else {
                completion(false)
                return
            }

            let apiUrl = (config["apiUrl"] as? String) ?? "https://api.orbimail.com/api"
            let url = URL(string: "\(apiUrl)/notifications/unread-count")!
            var request = URLRequest(url: url)
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.timeoutInterval = 25 // iOS gives ~30s for background tasks

            URLSession.shared.dataTask(with: request) { data, response, error in
                guard let data = data,
                      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let dataObj = json["data"] as? [String: Any],
                      let count = dataObj["count"] as? Int else {
                    completion(error == nil)
                    return
                }

                DispatchQueue.main.async {
                    UIApplication.shared.applicationIconBadgeNumber = count
                }
                completion(true)
            }.resume()
        }
    }
}
