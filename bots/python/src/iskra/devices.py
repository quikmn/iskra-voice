"""Device revocations and signed prekeys. See "Devices" and "Forward secrecy" in protocol/PROTOCOL.md."""
from __future__ import annotations

import time
from dataclasses import dataclass, replace
from typing import Iterable, TypedDict

from nacl import bindings as sodium

from .crypto import b64u, from_b64u, sign, signed_payload, u64be, verify
from .identity import Identity

REVOKE_CONTEXT = "iskra/device-revoke/v1"
PREKEY_CONTEXT = "iskra/prekey/v1"

DAY = 24 * 60 * 60 * 1000
#: A new prekey every week...
PREKEY_ROTATE_MS = 7 * DAY
#: ...and the old one's secret is kept this long after that, for messages still on their way, then deleted.
PREKEY_GRACE_MS = 30 * DAY
#: Senders ignore prekeys older than this.
PREKEY_MAX_AGE_MS = 60 * DAY


class Revocation(TypedDict):
    deviceKey: str
    revokedAt: int
    sig: str


class SignedPrekey(TypedDict):
    deviceKey: str
    key: str
    created: int
    sig: str


@dataclass
class PrekeyPair:
    public_key: bytes
    secret_key: bytes
    created: int
    retired_at: int | None = None


def _now() -> int:
    return int(time.time() * 1000)


def _safe_int(n: object) -> bool:
    return isinstance(n, int) and not isinstance(n, bool) and 0 <= n <= 2**53 - 1


def verify_revocation(account_key: str, r: object) -> bool:
    try:
        if not isinstance(r, dict) or not _safe_int(r.get("revokedAt")):
            return False
        device = from_b64u(r["deviceKey"])
        if len(device) != 32:
            return False
        return verify(from_b64u(r["sig"]), signed_payload(REVOKE_CONTEXT, device, u64be(r["revokedAt"])), from_b64u(account_key))
    except (KeyError, ValueError, TypeError):
        return False


def revoked_set(account_key: str, revocations: Iterable[object] | None) -> set[str]:
    """Device keys an account has revoked, counting only revocations really signed by that account."""
    return {r["deviceKey"] for r in (revocations or []) if verify_revocation(account_key, r)}  # type: ignore[index]


def generate_prekey(now: int | None = None) -> PrekeyPair:
    public, secret = sodium.crypto_box_keypair()
    return PrekeyPair(public, secret, now if now is not None else _now())


def sign_prekey(identity: Identity, prekey: PrekeyPair) -> SignedPrekey:
    payload = signed_payload(PREKEY_CONTEXT, prekey.public_key, u64be(prekey.created))
    return {
        "deviceKey": b64u(identity.device.public_key), "key": b64u(prekey.public_key), "created": prekey.created,
        "sig": b64u(sign(payload, identity.device.secret_key)),
    }


def verify_prekey(p: object) -> bool:
    try:
        if not isinstance(p, dict) or not _safe_int(p.get("created")):
            return False
        key = from_b64u(p["key"])
        if len(key) != 32:
            return False
        return verify(from_b64u(p["sig"]), signed_payload(PREKEY_CONTEXT, key, u64be(p["created"])), from_b64u(p["deviceKey"]))
    except (KeyError, ValueError, TypeError):
        return False


def current_prekey(prekeys: list[PrekeyPair] | None) -> PrekeyPair | None:
    """The prekey this device hands out right now."""
    live = [p for p in prekeys or [] if p.retired_at is None]
    return max(live, key=lambda p: p.created) if live else None


def rotate_prekeys(prekeys: list[PrekeyPair], now: int | None = None) -> tuple[list[PrekeyPair], bool]:
    """Weekly rotation: retires the current prekey once it's a week old (or makes the first one), and deletes retired
    secrets after the grace period. That deletion is what gives forward secrecy."""
    now = now if now is not None else _now()
    kept = [p for p in prekeys if not (p.retired_at is not None and now - p.retired_at > PREKEY_GRACE_MS)]
    changed = len(kept) != len(prekeys)
    current = current_prekey(kept)
    if current is None or now - current.created >= PREKEY_ROTATE_MS:
        kept = [replace(p, retired_at=now) if p.retired_at is None else p for p in kept]
        kept.append(generate_prekey(now))
        changed = True
    return kept, changed


def usable_prekeys(prekeys: Iterable[object] | None, now: int | None = None) -> dict[str, SignedPrekey]:
    """The newest usable prekey per device: correctly signed, not stale, not from the future."""
    now = now if now is not None else _now()
    best: dict[str, SignedPrekey] = {}
    for p in prekeys or []:
        if not verify_prekey(p):
            continue
        assert isinstance(p, dict)
        if now - p["created"] > PREKEY_MAX_AGE_MS or p["created"] - now > DAY:
            continue
        seen = best.get(p["deviceKey"])
        if seen is None or p["created"] > seen["created"]:
            best[p["deviceKey"]] = p  # type: ignore[assignment]
    return best
