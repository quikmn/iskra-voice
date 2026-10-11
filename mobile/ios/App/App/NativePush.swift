import Capacitor
import Foundation
import UIKit
import UserNotifications

/// APNs registration and notification taps. The Notification Service Extension has already decrypted each push and
/// put its route (and, for calls, who and where) into userInfo. Events wait here until the web app listens
/// (IskraNative forwards them), so a tap that launched the app isn't lost.
final class NativePush: NSObject, UNUserNotificationCenterDelegate, NotificationHandlerProtocol {
    static let shared = NativePush()
    static let callCategory = "iskra.call"

    private(set) var apnsToken: String?
    private var waiting: [(Result<String, Error>) -> Void] = []
    /// Set by IskraNative once the bridge is up.
    weak var plugin: IskraNative? {
        didSet { flush() }
    }
    private var pending: [(String, [String: Any])] = []

    /// At launch, before the bridge exists: taps that launched the app arrive here first.
    func install() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let answer = UNNotificationAction(identifier: "answer", title: NSLocalizedString("Answer", comment: "call"), options: [.foreground])
        let decline = UNNotificationAction(identifier: "decline", title: NSLocalizedString("Decline", comment: "call"), options: [.destructive])
        center.setNotificationCategories([UNNotificationCategory(identifier: Self.callCategory, actions: [answer, decline], intentIdentifiers: [])])
    }

    // ── Tokens ──

    func register(completion: @escaping (Result<String, Error>) -> Void) {
        if let token = apnsToken { return completion(.success(token)) }
        waiting.append(completion)
        DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in
            guard let self, !self.waiting.isEmpty else { return }
            self.finish(.failure(NSError(domain: "Iskra", code: 1, userInfo: [NSLocalizedDescriptionKey: "Apple didn't give a push token in time."])))
        }
    }

    func didRegister(deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        let changed = apnsToken != nil && apnsToken != token
        apnsToken = token
        finish(.success(token))
        if changed { emit("pushToken", [:], retain: false) }
    }

    func didFail(error: Error) {
        finish(.failure(error))
    }

    private func finish(_ result: Result<String, Error>) {
        let callbacks = waiting
        waiting = []
        callbacks.forEach { $0(result) }
    }

    // ── Events for the web app ──

    func emit(_ event: String, _ data: [String: Any], retain: Bool = true) {
        DispatchQueue.main.async {
            if let plugin = self.plugin {
                plugin.notifyListeners(event, data: data, retainUntilConsumed: retain)
            } else if retain {
                self.pending.append((event, data))
            }
        }
    }

    private func flush() {
        guard let plugin else { return }
        let events = pending
        pending = []
        for (event, data) in events { plugin.notifyListeners(event, data: data, retainUntilConsumed: true) }
    }

    // ── Notification center (before the bridge takes over as the delegate, and through it afterwards) ──

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler(willPresent(notification: notification))
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        didReceive(response: response)
        completionHandler()
    }

    /// The server only pushes to devices nobody is looking at, so in front this is a race: keep it in the list quietly.
    func willPresent(notification: UNNotification) -> UNNotificationPresentationOptions {
        [.list]
    }

    func didReceive(response: UNNotificationResponse) {
        let info = response.notification.request.content.userInfo
        if let call = info["call"] as? [String: String], response.actionIdentifier == "answer" || response.actionIdentifier == "decline" {
            var data: [String: Any] = call
            data["action"] = response.actionIdentifier
            emit("callAction", data)
            if response.actionIdentifier == "decline" { return }
        }
        if let route = info["route"] as? String { emit("pushOpened", ["route": route]) }
    }
}
