"""Account and device identity. See "Identity" in protocol/PROTOCOL.md (mirrors client/src/core/identity.ts)."""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, TypedDict

from .crypto import SigningKeyPair, b64u, from_b64u, generate_signing_keypair, sign, signed_payload, u64be, verify

if TYPE_CHECKING:
    from .devices import PrekeyPair

DEVICE_CERT_CONTEXT = "iskra/device-cert/v1"
AUTH_CONTEXT = "iskra/auth/v1"


class DeviceCert(TypedDict):
    accountKey: str
    deviceKey: str
    created: int
    sig: str


@dataclass
class Identity:
    account: SigningKeyPair
    device: SigningKeyPair
    cert: DeviceCert
    #: This device's X25519 prekeys for forward-secret DMs (see devices.py).
    prekeys: list[PrekeyPair] = field(default_factory=list)

    @property
    def account_key(self) -> str:
        return b64u(self.account.public_key)


def certify_device(account: SigningKeyPair, device_public_key: bytes, created: int) -> DeviceCert:
    sig = sign(signed_payload(DEVICE_CERT_CONTEXT, device_public_key, u64be(created)), account.secret_key)
    return {"accountKey": b64u(account.public_key), "deviceKey": b64u(device_public_key), "created": created, "sig": b64u(sig)}


def verify_device_cert(cert: object) -> bool:
    try:
        if not isinstance(cert, dict):
            return False
        created = cert["created"]
        if not isinstance(created, int) or isinstance(created, bool):
            return False
        device_key = from_b64u(cert["deviceKey"])
        if len(device_key) != 32:
            return False
        payload = signed_payload(DEVICE_CERT_CONTEXT, device_key, u64be(created))
        return verify(from_b64u(cert["sig"]), payload, from_b64u(cert["accountKey"]))
    except (KeyError, ValueError, TypeError):
        return False


def create_identity(now: int | None = None) -> Identity:
    """A brand-new account with this device as its first device."""
    account = generate_signing_keypair()
    device = generate_signing_keypair()
    created = now if now is not None else int(time.time() * 1000)
    return Identity(account, device, certify_device(account, device.public_key, created))


def sign_auth(device: SigningKeyPair, server_key: bytes, nonce: bytes) -> str:
    """The handshake signature: proves this device is talking to *this* server, *now*."""
    return b64u(sign(signed_payload(AUTH_CONTEXT, server_key, nonce), device.secret_key))
