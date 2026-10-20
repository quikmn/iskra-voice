import Capacitor
import Foundation
import UIKit

/// The app's own bridge to the web client (client/src/platform/native.ts, "IskraNative"): voice in the background,
/// shares in (from the Share Extension, through the App Group: ShareInbox.swift).
@objc(IskraNative)
public class IskraNative: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "IskraNative"
    public let jsName = "IskraNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "voiceStart", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "voiceUpdate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "voiceStop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keepAwake", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takeShare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shareDone", returnType: CAPPluginReturnPromise),
    ]

    /** Posted when iskra://share opens the app (SceneDelegate). */
    static let shareArrived = Notification.Name("foo.iskra.app.shareArrived")

    /** Everything about shares runs here, one at a time (file work stays off the main thread). */
    private let shareQueue = DispatchQueue(label: "foo.iskra.app.shares")
    /** The newest share, ready for the page (taken once by takeShare). Only touched on shareQueue. */
    private var pendingShare: [String: Any]?

    override public func load() {
        CallManager.shared.plugin = self
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(checkShares), name: Self.shareArrived, object: nil)
        // Also when the app comes back without the link (the extension couldn't open it, or iOS didn't).
        center.addObserver(self, selector: #selector(checkShares), name: UIApplication.didBecomeActiveNotification, object: nil)
        shareQueue.async {
            // Shares offered to an earlier run's page are done with: that page is gone.
            ShareStore.removeOld(includingTaken: true)
            self.offerNewest()
        }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
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
            UIApplication.shared.isIdleTimerDisabled = false
            call.resolve()
        }
    }

    /// The screen stays on while your camera is on in a call (a locked phone stops the camera).
    @objc func keepAwake(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = on
            call.resolve()
        }
    }

    // ── Shares from other apps (ShareExtension → ShareInbox) ─────────────────

    @objc private func checkShares() {
        shareQueue.async {
            ShareStore.removeOld(includingTaken: false)
            self.offerNewest()
        }
    }

    /** On shareQueue: the newest share not offered yet becomes the pending one; older ones not offered are dropped. */
    private func offerNewest() {
        guard let manifest = ShareStore.takeNewest() else { return }
        let bridge = self.bridge
        guard let share = ShareStore.forPage(manifest, url: { bridge?.portablePath(fromLocalURL: $0)?.absoluteString }) else {
            ShareStore.remove(manifest.id)
            return
        }
        // A newer share replaces one the page hasn't taken yet (as on Android).
        if let old = pendingShare?["id"] as? String, old != manifest.id { ShareStore.remove(old) }
        pendingShare = share
        notifyListeners("shareReceived", data: [:])
    }

    @objc func takeShare(_ call: CAPPluginCall) {
        shareQueue.async {
            let share = self.pendingShare
            self.pendingShare = nil
            if let share { call.resolve(["share": share]) } else { call.resolve() }
        }
    }

    /** Sent or cancelled: the copies go (unless it's the one still waiting for the page). */
    @objc func shareDone(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        shareQueue.async {
            if (self.pendingShare?["id"] as? String) != id { ShareStore.remove(id) }
            call.resolve()
        }
    }
}

/// The app's side of the App Group's share folders (the extension writes them: ShareInbox.swift).
enum ShareStore {
    private static let day: TimeInterval = 24 * 60 * 60

    static func remove(_ id: String) {
        guard let dir = ShareInbox.folder(id) else { return }
        try? FileManager.default.removeItem(at: dir)
    }

    private static func folders() -> [URL] {
        guard let root = ShareInbox.root else { return [] }
        return (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.creationDateKey], options: [])) ?? []
    }

    private static func manifest(_ dir: URL) -> ShareInbox.Manifest? {
        guard let data = try? Data(contentsOf: dir.appendingPathComponent(ShareInbox.manifestName)),
              let m = try? JSONDecoder().decode(ShareInbox.Manifest.self, from: data),
              m.id == dir.lastPathComponent, ShareInbox.isValidId(m.id) else { return nil }
        return m
    }

    private static func isTaken(_ dir: URL) -> Bool {
        FileManager.default.fileExists(atPath: dir.appendingPathComponent(ShareInbox.takenName).path)
    }

    /**
     * Shares older than a day go, and anything that isn't a share. At start (`includingTaken`) also every share an
     * earlier run already offered to its page.
     */
    static func removeOld(includingTaken: Bool) {
        let now = Date()
        for dir in folders() {
            guard ShareInbox.isValidId(dir.lastPathComponent) else {
                try? FileManager.default.removeItem(at: dir)
                continue
            }
            let created = (try? dir.resourceValues(forKeys: [.creationDateKey]))?.creationDate ?? now
            let age = now.timeIntervalSince(created)
            // No share.json after an hour: the extension never finished.
            let unfinished = age > 60 * 60 && manifest(dir) == nil
            if age > day || unfinished || (includingTaken && isTaken(dir)) { try? FileManager.default.removeItem(at: dir) }
        }
    }

    /** The newest finished share not offered yet, now marked as offered. Older ones not offered are replaced by it. */
    static func takeNewest() -> ShareInbox.Manifest? {
        let waiting = folders()
            .filter { ShareInbox.isValidId($0.lastPathComponent) && !isTaken($0) }
            .compactMap { manifest($0) }
            .sorted { $0.created < $1.created }
        guard let newest = waiting.last, let dir = ShareInbox.folder(newest.id) else { return nil }
        for older in waiting.dropLast() { remove(older.id) }
        FileManager.default.createFile(atPath: dir.appendingPathComponent(ShareInbox.takenName).path, contents: Data())
        return newest
    }

    /** The share as the page takes it (the same shape as Android's): the copies at URLs the web view serves. */
    static func forPage(_ m: ShareInbox.Manifest, url: (URL) -> String?) -> [String: Any]? {
        guard let dir = ShareInbox.folder(m.id) else { return nil }
        var files: [[String: Any]] = []
        var skipped = max(0, m.skipped)
        for f in m.files {
            // Only plain names, inside the share's own folder.
            let plain = !f.file.isEmpty && !f.file.hasPrefix(".") && !f.file.contains("/")
            let target = dir.appendingPathComponent(f.file)
            let values = plain ? try? target.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]) : nil
            guard files.count < ShareInbox.maxFiles, values?.isRegularFile == true, let size = values?.fileSize,
                  let link = url(target) else {
                skipped += 1
                continue
            }
            files.append(["name": ShareInbox.cleanName(f.name, type: nil), "type": f.type, "size": size, "url": link])
        }
        var share: [String: Any] = ["id": m.id, "files": files, "skipped": skipped]
        if let text = m.text, !text.isEmpty { share["text"] = ShareInbox.limit(text, ShareInbox.maxText) }
        if let subject = m.subject, !subject.isEmpty { share["subject"] = ShareInbox.limit(subject, ShareInbox.maxSubject) }
        if files.isEmpty && share["text"] == nil { return nil }
        return share
    }
}
