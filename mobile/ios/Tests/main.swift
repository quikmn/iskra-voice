// Checks the app's push decryption (App/Shared) against RFC 8291's example and the push routes, on the macOS runner
// before the app is built (mobile-ios.yml):
//   swiftc -o check mobile/ios/App/Shared/WebPushCrypto.swift mobile/ios/App/Shared/PushPayload.swift mobile/ios/Tests/main.swift && ./check
import CryptoKit
import Foundation

func b64u(_ s: String) -> Data {
    var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while t.count % 4 != 0 { t += "=" }
    return Data(base64Encoded: t)!
}

func expect(_ ok: Bool, _ what: String) {
    if !ok {
        print("FAIL: \(what)")
        exit(1)
    }
    print("ok: \(what)")
}

// RFC 8291, appendix A.
let uaPrivate = try P256.KeyAgreement.PrivateKey(rawRepresentation: b64u("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"))
let auth = b64u("BTBZMqHH6r4Tts7J_aSIgg")
let message = b64u("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN")
expect(uaPrivate.publicKey.x963Representation == b64u("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"), "RFC 8291 key")
let plain = try WebPushCrypto.decrypt(message, privateKey: uaPrivate, auth: auth)
expect(String(decoding: plain, as: UTF8.self) == "When I grow up, I want to be a watermelon", "RFC 8291 example decrypts")
var tampered = message
tampered[tampered.count - 1] ^= 1
expect((try? WebPushCrypto.decrypt(tampered, privateKey: uaPrivate, auth: auth)) == nil, "tampered push is refused")
expect((try? WebPushCrypto.decrypt(Data(count: 40), privateKey: uaPrivate, auth: auth)) == nil, "short push is refused")

let server = String(repeating: "S", count: 43)
let peer = String(repeating: "P", count: 43)
let json = #"{"v":1,"kind":"call","server":"\#(server)","serverName":"Hangout","title":"Alex is calling","body":"Tap to answer.","tag":"call:x","from":"Alex","peer":"\#(peer)"}"#
let push = PushPayload.parse(Data(json.utf8))
expect(push?.route == "/open/\(server)/dm/\(peer)", "call route")
expect(push?.caller == "Alex", "caller name")
expect(push?.callInfo == ["server": server, "peer": peer], "call info")
let channel = PushPayload.parse(Data(#"{"v":1,"kind":"mention","server":"\#(server)","title":"Alex in #general","channelId":5}"#.utf8))
expect(channel?.route == "/open/\(server)/c/5", "channel route")
expect(PushPayload.parse(Data(#"{"v":1,"server":"short","title":"x"}"#.utf8)) == nil, "bad server key is refused")
expect(PushPayload.parse(Data(#"{"v":1,"kind":"dm","server":"\#(server)","title":"x","peer":"../x"}"#.utf8))?.route == "/open/\(server)", "bad peer is ignored")
print("All push checks passed")
