import AVFoundation
import CallKit
import Foundation
import UIKit

/// Voice with the screen locked:
/// - The call you're in is a CallKit call, so iOS keeps its audio going and shows it on the lock screen.
/// - Voice channels keep the audio session active (background mode "audio").
/// The web app does the actual media (WebRTC in the web view); this only tells iOS what's going on.
final class CallManager: NSObject, CXProviderDelegate {
    static let shared = CallManager()

    private let provider: CXProvider
    private let controller = CXCallController()

    /// Set by IskraNative once the bridge is up: hang-ups and mutes from the system go to the web app.
    weak var plugin: IskraNative?
    /// The CallKit call for the call we're in, if any.
    private var active: UUID?
    /// Ending a call ourselves (from the web app) shouldn't be reported back as "hung up from the system".
    private var endingOurselves = Set<UUID>()

    override init() {
        let config = CXProviderConfiguration()
        config.supportsVideo = true
        config.maximumCallsPerCallGroup = 1
        config.maximumCallGroups = 1
        config.supportedHandleTypes = [.generic]
        config.includesCallsInRecents = false
        if let icon = UIImage(named: "CallIcon") { config.iconTemplateImageData = icon.pngData() }
        provider = CXProvider(configuration: config)
        super.init()
        provider.setDelegate(self, queue: nil)
    }

    private func emit(_ event: String, _ data: [String: Any] = [:]) {
        DispatchQueue.main.async { self.plugin?.notifyListeners(event, data: data) }
    }

    // ── The web app in voice ──

    func voiceStarted(title: String, call: Bool, video: Bool) {
        configureAudio()
        guard call, active == nil else { return }
        let uuid = UUID()
        active = uuid
        let start = CXStartCallAction(call: uuid, handle: CXHandle(type: .generic, value: title))
        start.isVideo = video
        controller.request(CXTransaction(action: start)) { _ in }
    }

    func voiceUpdated(title: String) {
        guard let uuid = active else { return }
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: title)
        update.localizedCallerName = title
        provider.reportCall(with: uuid, updated: update)
    }

    func voiceStopped() {
        if let uuid = active {
            active = nil
            endingOurselves.insert(uuid)
            controller.request(CXTransaction(action: CXEndCallAction(call: uuid))) { _ in }
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// Voice chat audio that keeps playing with the screen locked (the "audio" background mode).
    private func configureAudio() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker])
        try? session.setActive(true)
    }

    // ── CXProviderDelegate ──

    func providerDidReset(_ provider: CXProvider) {
        active = nil
    }

    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        configureAudio()
        action.fulfill()
        provider.reportOutgoingCall(with: action.callUUID, connectedAt: Date())
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        let uuid = action.callUUID
        if endingOurselves.remove(uuid) == nil, uuid == active {
            active = nil
            emit("voiceEnded")
        }
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        emit("voiceMuted", ["muted": action.isMuted])
        action.fulfill()
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {}

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {}
}
