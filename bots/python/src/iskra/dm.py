"""End-to-end encrypted direct messages (PROTOCOL.md "Direct messages"); mirrors client/src/core/dm.ts.

- Every device's Ed25519 key converts to an X25519 key, so the account-signed device certificates vouch for them.
- A message is encrypted once (XChaCha20-Poly1305) with a random key; the header (from, to, time, id) is the
  associated data, so it can't be swapped or replayed into another conversation.
- That key is wrapped for each recipient device and each of the sender's own devices: v2 to the device's signed prekey
  (forward secret: crypto_box inside crypto_box_seal), else to the device key (crypto_box).
- No device keys means no message. There is no plaintext fallback.
"""
from __future__ import annotations

import json
import time
from typing import Any, Iterable, TypedDict

from nacl import bindings as sodium
from nacl.exceptions import CryptoError

from .crypto import b64u, from_b64u, random_bytes
from .devices import SignedPrekey, current_prekey, usable_prekeys
from .dm_files import DmError, DmFile, check_files
from .identity import DeviceCert, Identity, verify_device_cert
from .text import utf16_len

__all__ = ["DmError", "DmEnvelope", "DmFile", "encrypt_dm", "decrypt_dm", "valid_devices", "DISAPPEAR_TIMERS"]

MAX_TEXT = 4000
#: The disappearing-message timers apps offer, in seconds (0 = off).
DISAPPEAR_TIMERS = (0, 300, 3600, 28800, 86400, 604800, 2419200)


class DmEnvelope(TypedDict):
    v: int
    #: {"from", "to", "sentAt", "id", "expires"?}
    header: dict[str, Any]
    sender: DeviceCert
    nonce: str
    ct: str
    keys: list[dict[str, str]]


def _is_expiry(n: object) -> bool:
    return isinstance(n, int) and not isinstance(n, bool) and n > 0 and n in DISAPPEAR_TIMERS


def _json(value: object) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _associated_data(v: int, header: dict[str, Any]) -> bytes:
    # An array has a fixed order, unlike object keys.
    fields: list[object] = [f"iskra/dm/v{v}", header["from"], header["to"], header["sentAt"], header["id"]]
    if v == 3:
        fields.append(header.get("expires"))
    return _json(fields)


def _x25519_public(device_key: str) -> bytes:
    return sodium.crypto_sign_ed25519_pk_to_curve25519(from_b64u(device_key))


def _x25519_secret(identity: Identity) -> bytes:
    return sodium.crypto_sign_ed25519_sk_to_curve25519(identity.device.secret_key)


def valid_devices(certs: Iterable[object], account_key: str, revoked: set[str]) -> list[DeviceCert]:
    """Only certificates actually signed by the account they claim, and not revoked."""
    seen: set[str] = set()
    out: list[DeviceCert] = []
    for c in certs:
        if not isinstance(c, dict) or c.get("accountKey") != account_key or c.get("deviceKey") in seen:
            continue
        if c.get("deviceKey") in revoked or not verify_device_cert(c):
            continue
        seen.add(c["deviceKey"])
        out.append(c)  # type: ignore[arg-type]
    return out


def _check_text(content: dict[str, Any]) -> None:
    text = content.get("text", "")
    has_files = bool(content.get("files"))
    if not isinstance(text, str) or (len(text) == 0 and not has_files) or utf16_len(text) > MAX_TEXT:
        raise DmError(f"Messages must be 1–{MAX_TEXT} characters.")


def encrypt_dm(
    identity: Identity, to: str, recipient_devices: Iterable[object], own_devices: Iterable[object], content: dict[str, Any],
    now: int | None = None, *, prekeys: list[SignedPrekey] | None = None, revoked_devices: Iterable[str] = (),
    expires: int | None = None,
) -> DmEnvelope:
    """An envelope for ``to``'s devices and the sender's own. ``prekeys`` (even empty) makes a v2 envelope."""
    now = now if now is not None else int(time.time() * 1000)
    sender = identity.account_key
    revoked = set(revoked_devices)
    revoked.discard(identity.cert["deviceKey"])  # this device is sending, so it isn't revoked as far as we know
    recipients = valid_devices(recipient_devices, to, revoked)
    if not recipients:
        raise DmError("This person hasn't got any devices we can encrypt to yet.")
    _check_text(content)
    # Always include this device, so the sender can read their own history later.
    mine = valid_devices([identity.cert, *own_devices], sender, revoked)
    targets = recipients + [d for d in mine if not any(r["deviceKey"] == d["deviceKey"] for r in recipients)]
    if expires is not None and (not _is_expiry(expires) or prekeys is None):
        raise DmError("Unsupported message format.")
    v = 3 if expires is not None else 2 if prekeys is not None else 1
    header: dict[str, Any] = {"from": sender, "to": to, "sentAt": now, "id": b64u(random_bytes(12))}
    if v == 3:
        header["expires"] = expires
    sealed = _seal_content(identity, _associated_data(v, header), targets, content, now, prekeys if v >= 2 else None)
    return {"v": v, "header": header, "sender": identity.cert, **sealed}  # type: ignore[typeddict-item]


def _seal_content(identity: Identity, aad: bytes, targets: list[DeviceCert], content: object, now: int,
                  signed_prekeys: list[SignedPrekey] | None) -> dict[str, Any]:
    usable = usable_prekeys(signed_prekeys, now)
    own = current_prekey(identity.prekeys)

    def prekey_for(device_key: str) -> bytes | None:
        if signed_prekeys is None:
            return None
        if device_key == identity.cert["deviceKey"] and own:
            return own.public_key
        signed = usable.get(device_key)
        return from_b64u(signed["key"]) if signed else None

    message_key = random_bytes(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
    nonce = random_bytes(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
    ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(_json(content), aad, nonce, message_key)
    my_secret = _x25519_secret(identity)
    keys: list[dict[str, str]] = []
    for device in targets:
        prekey = prekey_for(device["deviceKey"])
        if prekey is not None:
            inner_nonce = random_bytes(sodium.crypto_box_NONCEBYTES)
            inner = sodium.crypto_box(message_key, inner_nonce, prekey, my_secret)
            seal = sodium.crypto_box_seal(inner_nonce + inner, prekey)
            keys.append({"device": device["deviceKey"], "prekey": b64u(prekey), "seal": b64u(seal)})
        else:
            box_nonce = random_bytes(sodium.crypto_box_NONCEBYTES)
            box = sodium.crypto_box(message_key, box_nonce, _x25519_public(device["deviceKey"]), my_secret)
            keys.append({"device": device["deviceKey"], "nonce": b64u(box_nonce), "box": b64u(box)})
    return {"nonce": b64u(nonce), "ct": b64u(ct), "keys": keys}


def _open_slot(identity: Identity, slot: dict[str, Any], sender: DeviceCert) -> bytes:
    sender_public = _x25519_public(sender["deviceKey"])
    if "seal" in slot:
        prekey = next((p for p in identity.prekeys if b64u(p.public_key) == slot.get("prekey")), None)
        if prekey is None:
            raise DmError("This message was locked to an older key that this device has since deleted, so it can't be read here.")
        try:
            inner = sodium.crypto_box_seal_open(from_b64u(slot["seal"]), prekey.public_key, prekey.secret_key)
            n = sodium.crypto_box_NONCEBYTES
            return sodium.crypto_box_open(inner[n:], inner[:n], sender_public, prekey.secret_key)
        except (CryptoError, ValueError, TypeError) as e:
            raise DmError("This message couldn't be decrypted.") from e
    try:
        return sodium.crypto_box_open(from_b64u(slot["box"]), from_b64u(slot["nonce"]), sender_public, _x25519_secret(identity))
    except (CryptoError, ValueError, TypeError, KeyError) as e:
        raise DmError("This message couldn't be decrypted.") from e


def decrypt_dm(identity: Identity, envelope: object, sender_key: str, to: str) -> dict[str, Any]:
    """Decrypts an envelope (v1-v3). ``sender_key`` and ``to`` are what the server says (it routed the message); they must
    match the encrypted header. Raises DmError when it can't be read; never returns unchecked text.

    Returns ``{"text", "files", "header", ...}`` (``call``, ``friend`` and the like are passed through for completeness).
    """
    if (not isinstance(envelope, dict) or envelope.get("v") not in (1, 2, 3) or not isinstance(envelope.get("header"), dict)
            or not isinstance(envelope.get("sender"), dict) or not isinstance(envelope.get("keys"), list)):
        raise DmError("Unsupported message format.")
    header, sender, v = envelope["header"], envelope["sender"], envelope["v"]
    if (not _is_expiry(header.get("expires"))) if v == 3 else ("expires" in header):
        raise DmError("Unsupported message format.")
    me = identity.account_key
    if header.get("from") != sender_key or header.get("to") != to:
        raise DmError("This message's sender or recipient doesn't match.")
    if sender_key != me and to != me:
        raise DmError("This message isn't for you.")
    if sender.get("accountKey") != header.get("from") or not verify_device_cert(sender):
        raise DmError("The sender's device couldn't be verified.")
    if not isinstance(header.get("sentAt"), int) or not isinstance(header.get("id"), str):
        raise DmError("Unsupported message format.")

    my_device = b64u(identity.device.public_key)
    slot = next((k for k in envelope["keys"] if isinstance(k, dict) and k.get("device") == my_device), None)
    if slot is None:
        raise DmError("This message wasn't encrypted for this device.")
    if v == 1 and "seal" in slot:
        raise DmError("Unsupported message format.")
    message_key = _open_slot(identity, slot, sender)  # type: ignore[arg-type]
    try:
        plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
            from_b64u(envelope["ct"]), _associated_data(v, header), from_b64u(envelope["nonce"]), message_key)
    except (CryptoError, ValueError, TypeError, KeyError) as e:
        raise DmError("This message was tampered with.") from e
    try:
        content = json.loads(plaintext.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as e:
        raise DmError("Unsupported message content.") from e
    if not isinstance(content, dict) or not isinstance(content.get("text"), str) or utf16_len(content["text"]) > MAX_TEXT:
        raise DmError("Unsupported message content.")
    out: dict[str, Any] = {"text": content["text"], "files": check_files(content.get("files")), "header": header}
    for extra in ("call", "group", "friend", "kt"):
        if isinstance(content.get(extra), dict):
            out[extra] = content[extra]
    return out

