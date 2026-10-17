"""Thin wrapper around libsodium (PyNaCl). Everything crypto in the SDK goes through here.

Wire format rules live in protocol/PROTOCOL.md; this mirrors client/src/core/crypto.ts.
"""
from __future__ import annotations

import base64
from dataclasses import dataclass

from nacl import bindings as sodium
from nacl import utils as nacl_utils
from nacl.exceptions import BadSignatureError, CryptoError

__all__ = [
    "SigningKeyPair", "b64u", "from_b64u", "signing_keypair_from_seed", "generate_signing_keypair", "sign", "verify",
    "random_bytes", "signed_payload", "u64be",
]


@dataclass(frozen=True)
class SigningKeyPair:
    public_key: bytes  # 32 bytes
    secret_key: bytes  # 64 bytes (libsodium format: seed || public key)


def b64u(data: bytes) -> str:
    """base64url without padding."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def from_b64u(text: str) -> bytes:
    """Strict base64url without padding (raises ValueError on anything else)."""
    if not isinstance(text, str) or "=" in text or len(text) % 4 == 1:
        raise ValueError("not base64url")
    try:
        raw = text.encode("ascii")
    except UnicodeEncodeError as e:
        raise ValueError("not base64url") from e
    for ch in raw:
        if not (48 <= ch <= 57 or 65 <= ch <= 90 or 97 <= ch <= 122 or ch in (45, 95)):
            raise ValueError("not base64url")
    return base64.urlsafe_b64decode(raw + b"=" * (-len(raw) % 4))


def signing_keypair_from_seed(seed: bytes) -> SigningKeyPair:
    if len(seed) != 32:
        raise ValueError("a seed is 32 bytes")
    public, secret = sodium.crypto_sign_seed_keypair(seed)
    return SigningKeyPair(public, secret)


def generate_signing_keypair() -> SigningKeyPair:
    return signing_keypair_from_seed(random_bytes(32))


def sign(message: bytes, secret_key: bytes) -> bytes:
    """Ed25519 detached signature (64 bytes)."""
    return sodium.crypto_sign(message, secret_key)[: sodium.crypto_sign_BYTES]


def verify(signature: bytes, message: bytes, public_key: bytes) -> bool:
    if len(signature) != 64 or len(public_key) != 32:
        return False
    try:
        sodium.crypto_sign_open(signature + message, public_key)
        return True
    except (BadSignatureError, CryptoError, ValueError):
        return False


def random_bytes(length: int) -> bytes:
    return nacl_utils.random(length) if length else b""


def signed_payload(context: str, *parts: bytes) -> bytes:
    """``context || 0x00 || parts...``: every signed payload is domain-separated this way."""
    return context.encode("utf-8") + b"\x00" + b"".join(parts)


def u64be(value: int) -> bytes:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0 or value > 2**53 - 1:
        raise ValueError("u64be: expected a non-negative safe integer")
    return value.to_bytes(8, "big")
