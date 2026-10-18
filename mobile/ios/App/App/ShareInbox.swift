import Foundation
import UniformTypeIdentifiers

/// "Share to Iskra" on iPhone and iPad, the part both sides use: the Share Extension (ShareExtension/) copies what was
/// shared into the App Group's `Shares/<id>/` folder with a `share.json`, and the app (IskraNative.swift) hands it to the
/// page. The same limits as Android's ShareIntake.java. Compiled into both targets: nothing here may need UIApplication.
enum ShareInbox {
    static let appGroup = "group.foo.iskra.app"
    /** A message's attachment limit (PROTOCOL.md, chat.send). */
    static let maxFiles = 10
    /** Above every server's default upload limit (512 MB); the page checks the chosen server's own limit. */
    static let maxFileBytes: Int64 = 1024 * 1024 * 1024
    /** A message's text limit (UTF-16 units, like the page's). */
    static let maxText = 4000
    static let maxSubject = 200
    /** Written last: a folder without it is a share still being copied (or one the extension gave up on). */
    static let manifestName = "share.json"
    /** Set by the app once it has offered a share to the page, so it isn't offered twice. */
    static let takenName = ".taken"

    struct File: Codable {
        var name: String
        var type: String
        var size: Int64
        /** The copy's name in the share's folder ("1.jpg"). */
        var file: String
    }

    struct Manifest: Codable {
        var id: String
        /** Seconds since 1970. */
        var created: Double
        var text: String?
        var subject: String?
        var files: [File]
        var skipped: Int
    }

    static var root: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
            .appendingPathComponent("Shares", isDirectory: true)
    }

    /** Share ids are UUIDs in their canonical form, so an id can never name another folder. */
    static func isValidId(_ id: String) -> Bool {
        UUID(uuidString: id)?.uuidString == id
    }

    static func folder(_ id: String) -> URL? {
        guard isValidId(id) else { return nil }
        return root?.appendingPathComponent(id, isDirectory: true)
    }

    /** A plain file name: no folders or control characters, not too long (as ShareIntake.cleanName). */
    static func cleanName(_ name: String?, type: UTType?) -> String {
        var cleaned = ""
        var lastWasBad = false
        for scalar in (name ?? "").unicodeScalars {
            let bad = scalar.value < 0x20 || scalar.value == 0x7f || scalar == "/" || scalar == "\\" || scalar == ":"
            if bad {
                if !lastWasBad { cleaned.unicodeScalars.append("_") }
            } else {
                cleaned.unicodeScalars.append(scalar)
            }
            lastWasBad = bad
        }
        cleaned = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
        while cleaned.hasPrefix(".") { cleaned.removeFirst() }
        if cleaned.count > 120 { cleaned = String(cleaned.suffix(120)) }
        if cleaned.isEmpty {
            if let ext = type?.preferredFilenameExtension { return "file.\(ext)" }
            return "file"
        }
        return cleaned
    }

    /** The copy's name on disk: its number and a plain extension (the web view's file server picks the type by it). */
    static func diskName(index: Int, name: String) -> String {
        let ext = String((name as NSString).pathExtension.lowercased().filter { $0.isASCII && ($0.isLetter || $0.isNumber) }.prefix(10))
        return ext.isEmpty ? "\(index)" : "\(index).\(ext)"
    }

    /** At most `max` UTF-16 units, never cutting a character in half. */
    static func limit(_ s: String, _ max: Int) -> String {
        if s.utf16.count <= max { return s }
        var out = ""
        var units = 0
        for ch in s {
            let n = String(ch).utf16.count
            if units + n > max { break }
            out.append(ch)
            units += n
        }
        return out
    }
}
