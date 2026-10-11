import UserNotifications

/// Decrypts each push from the Iskra push relay on the phone and shows what it says ("Alex in #general: …").
/// The push carries the server's Web Push body encrypted to this install's key (`e`); Apple and the relay only see
/// ciphertext. If it can't be read, the relay's generic text ("New notification") stays.
class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttempt: UNMutableNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        self.contentHandler = contentHandler
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        bestAttempt = content
        if let push = PushKeys.open(content.userInfo["e"]) {
            content.title = push.title
            content.body = push.body
            if !push.serverName.isEmpty { content.subtitle = push.serverName }
            content.threadIdentifier = push.notificationTag
            content.sound = .default
            var info: [AnyHashable: Any] = ["route": push.route]
            if push.kind == "call" {
                content.categoryIdentifier = "iskra.call"
                info["call"] = push.callInfo
            }
            content.userInfo = info // drops the ciphertext
        }
        contentHandler(content)
    }

    override func serviceExtensionTimeWillExpire() {
        if let contentHandler, let bestAttempt { contentHandler(bestAttempt) }
    }
}
