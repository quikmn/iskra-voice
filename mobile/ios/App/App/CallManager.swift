import AVFoundation
import CallKit
import Foundation
import PushKit
import UIKit

/// Calls and voice with the screen locked:
/// - Incoming DM and group calls ring through CallKit from a VoIP push (PushKit; iOS requires every VoIP push to be
///   reported as a call at once, so pushes that can't be read end the call straight away).
/// - The call you're in is a CallKit call, so iOS keeps its audio going and shows it on the lock screen.
/// - Voice channels keep the audio session active (background mode "audio").
/// The web app does the actual media (WebRTC in the web view); this only tells iOS what's going on.
final class CallManager: NSObject, CXProviderDelegate, PKPushRegistryDelegate {
    static let shared = CallManager()

    private let provider: CXProvider
    private let controller = CXCallController()
    private var registry: PKPushRegistry?
    private(set) var voipToken: String?

    /// Ringing incoming calls, and who/where they're from (for the web app's answer).
    private var ringing: [UUID: [String: String]] = [:]
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

    /// At launch: VoIP pushes can start the app in the background, so PushKit must be set up straight away.
    func install() {
        let registry = PKPushRegistry(queue: .main)
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
        self.registry = registry
    }

    // ── PushKit ──

    func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        let token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
        let changed = voipToken != token
        voipToken = token
        if changed { NativePush.shared.emit("pushToken", [:], retain: false) }
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        voipToken = nil
        NativePush.shared.emit("pushToken", [:], retain: false)
    }

    func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType,
                      completion: @escaping () -> Void) {
        let push = PushKeys.open(payload.dictionaryPayload["e"])
        let uuid = UUID()
        let update = CXCallUpdate()
        let caller = push?.caller ?? "Iskra"
        update.remoteHandle = CXHandle(type: .generic, value: caller)
        update.localizedCallerName = caller
        update.hasVideo = false
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false
        provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
            defer { completion() }
            guard let self, error == nil else { return }
            guard let push, push.kind == "call", push.peer != nil || push.group != nil, self.active == nil else {
                // Not a call we can answer (unreadable, or we're already in one): stop ringing right away.
                self.provider.reportCall(with: uuid, endedAt: nil, reason: .failed)
                return
            }
            self.ringing[uuid] = push.callInfo
            // The server rings for 45 s; it sends nothing when the caller gives up, so stop here too.
            DispatchQueue.main.asyncAfter(deadline: .now() + 45) { [weak self] in
                guard let self, self.ringing.removeValue(forKey: uuid) != nil else { return }
                self.provider.reportCall(with: uuid, endedAt: nil, reason: .unanswered)
            }
        }
    }

    // ── The web app in voice ──

    func voiceStarted(title: String, call: Bool, video: Bool) {
        configureAudio()
        guard call, active == nil else { return }
        // Answered in the app while CallKit still rang for it (answering from CallKit already made it the active call).
        for uuid in ringing.keys {
            provider.reportCall(with: uuid, endedAt: nil, reason: .answeredElsewhere)
        }
        ringing.removeAll()
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
        ringing.removeAll()
        active = nil
    }

    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        configureAudio()
        action.fulfill()
        provider.reportOutgoingCall(with: action.callUUID, connectedAt: Date())
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        if var info = ringing.removeValue(forKey: action.callUUID) {
            info["action"] = "answer"
            active = action.callUUID
            NativePush.shared.emit("callAction", info)
            // The web app connects when it opens: from the lock screen, iOS shows the Iskra button for that.
        }
        configureAudio()
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        let uuid = action.callUUID
        if var info = ringing.removeValue(forKey: uuid) {
            info["action"] = "decline"
            NativePush.shared.emit("callAction", info)
        } else if endingOurselves.remove(uuid) == nil, uuid == active {
            active = nil
            NativePush.shared.emit("voiceEnded", [:], retain: false)
        }
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        NativePush.shared.emit("voiceMuted", ["muted": action.isMuted], retain: false)
        action.fulfill()
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {}

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {}
}
