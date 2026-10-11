import Foundation

/// A decrypted Iskra push (PROTOCOL.md, "Push notifications"): what the notification says and where a tap goes.
/// The same rules as the web app's service worker (client/public/push-sw.js) and the Android app (PushPayload.java).
struct PushPayload {
    let kind: String
    let server: String
    let serverName: String
    let title: String
    let body: String
    let tag: String
    let from: String
    let peer: String?
    let group: String?
    /// The app route a tap opens ("/open/<server>/..."), as the web client's parseOpenRoute reads it.
    let route: String

    var caller: String { from.isEmpty ? title : from }
    var notificationTag: String { "\(server):\(tag)" }

    /// Answer/decline buttons hand these to the web app (client/src/platform/native.ts parseCallAction).
    var callInfo: [String: String] {
        var info = ["server": server]
        if let peer { info["peer"] = peer }
        if let group { info["group"] = group }
        return info
    }

    private static func matches(_ value: String, _ length: Int) -> Bool {
        value.count == length && value.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) && $0.isASCII || $0 == "-" || $0 == "_" }
    }

    static func parse(_ data: Data) -> PushPayload? {
        guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        let server = o["server"] as? String ?? ""
        let title = o["title"] as? String ?? ""
        guard (o["v"] as? NSNumber)?.intValue == 1, matches(server, 43), !title.isEmpty else { return nil }
        let kind = o["kind"] as? String ?? ""
        let peer = (o["peer"] as? String).flatMap { matches($0, 43) ? $0 : nil }
        let group = (o["group"] as? String).flatMap { matches($0, 22) ? $0 : nil }
        let channelId = (o["channelId"] as? NSNumber)?.int64Value ?? 0
        return PushPayload(
            kind: kind,
            server: server,
            serverName: clip(o["serverName"] as? String, 100),
            title: clip(title, 120),
            body: clip(o["body"] as? String, 300),
            tag: clip(o["tag"] as? String, 80),
            from: clip(o["from"] as? String, 100),
            peer: peer,
            group: group,
            route: route(server: server, kind: kind, peer: peer, group: group, channelId: channelId)
        )
    }

    static func route(server: String, kind: String, peer: String?, group: String?, channelId: Int64) -> String {
        let base = "/open/\(server)"
        if let group { return "\(base)/g/\(group)" }
        if kind == "dm", let peer { return "\(base)/dm/\(peer)" }
        if channelId > 0 && channelId <= 9_007_199_254_740_991 { return "\(base)/c/\(channelId)" }
        if let peer { return "\(base)/dm/\(peer)" }
        return base
    }

    private static func clip(_ value: String?, _ max: Int) -> String {
        guard let value else { return "" }
        return value.count <= max ? value : String(value.prefix(max))
    }
}
