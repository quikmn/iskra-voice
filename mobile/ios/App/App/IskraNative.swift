import Capacitor
import Foundation

/// The app's own bridge to the web client (client/src/platform/native.ts, "IskraNative"): voice in the background.
@objc(IskraNative)
public class IskraNative: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "IskraNative"
    public let jsName = "IskraNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "voiceStart", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "voiceUpdate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "voiceStop", returnType: CAPPluginReturnPromise),
    ]

    override public func load() {
        CallManager.shared.plugin = self
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
