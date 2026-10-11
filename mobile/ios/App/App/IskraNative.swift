import Capacitor
import Foundation
import UserNotifications

/// The app's own bridge to the web client (client/src/platform/native.ts, "IskraNative"): native push registration
/// (APNs and PushKit tokens + this install's Web Push keys), notification taps and call buttons, voice in the background.
@objc(IskraNative)
public class IskraNative: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "IskraNative"
    public let jsName = "IskraNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pushPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pushRegister", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "voiceStart", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "voiceUpdate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "voiceStop", returnType: CAPPluginReturnPromise),
    ]

    override public func load() {
        // Capacitor's notification router becomes the delegate; it hands push taps to us.
        bridge?.notificationRouter.pushNotificationHandler = NativePush.shared
        NativePush.shared.plugin = self
    }

    private static func permission(_ status: UNAuthorizationStatus) -> String {
        switch status {
        case .authorized, .provisional, .ephemeral: return "granted"
        case .denied: return "denied"
        default: return "prompt"
        }
    }

    @objc func pushPermission(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            call.resolve(["permission": Self.permission(settings.authorizationStatus)])
        }
    }

    @objc func pushRegister(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in
            NativePush.shared.register { result in
                switch result {
                case .failure(let error):
                    call.reject(error.localizedDescription)
                case .success(let token):
                    do {
                        let keys = try PushKeys.loadOrCreate()
                        var data: [String: Any] = ["platform": "ios", "token": token, "p256dh": keys.p256dh, "auth": keys.authSecret]
                        if let voip = CallManager.shared.voipToken { data["voip"] = voip }
                        #if DEBUG
                        data["sandbox"] = true
                        #endif
                        call.resolve(data)
                    } catch {
                        call.reject("Couldn't make push keys.")
                    }
                }
            }
        }
    }

    @objc func voiceStart(_ call: CAPPluginCall) {
        let title = call.getString("title") ?? ""
        let isCall = call.getBool("call") ?? false
        let video = call.getBool("video") ?? false
        DispatchQueue.main.async {
            CallManager.shared.voiceStarted(title: title, call: isCall, video: video)
            call.resolve()
        }
    }

    @objc func voiceUpdate(_ call: CAPPluginCall) {
        let title = call.getString("title") ?? ""
        DispatchQueue.main.async {
            CallManager.shared.voiceUpdated(title: title)
            call.resolve()
        }
    }

    @objc func voiceStop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            CallManager.shared.voiceStopped()
            call.resolve()
        }
    }
}
