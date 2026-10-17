"""End-to-end encrypted DM attachments (PROTOCOL.md, "Encrypted DM attachments"); mirrors client/src/core/dmFiles.ts.

Each file has a random key and is encrypted with libsodium's secretstream (XChaCha20-Poly1305) in 64 KiB chunks, the
last one tagged FINAL, so a truncated, reordered or altered file never decrypts. ``hash`` is BLAKE2b-256 of the
ciphertext.
"""
from __future__ import annotations

import re
from typing import NotRequired, TypedDict

from nacl import bindings as sodium
from nacl.exceptions import CryptoError

from .crypto import b64u, from_b64u

FILE_CHUNK = 64 * 1024
MAX_DM_FILES = 10
_AD = b"iskra/dm-file/v1"
_HEADER = sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES
_ABYTES = sodium.crypto_secretstream_xchacha20poly1305_ABYTES
_TAG_MESSAGE = sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE
_TAG_FINAL = sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL


class DmError(Exception):
    """A DM (or one of its files) that can't be read. Never comes with unchecked text."""


class VoiceInfo(TypedDict):
    duration: int
    waveform: str


class DmFile(TypedDict):
    """One attachment, as it travels inside the encrypted DM content."""

    server: str
    id: str
    key: str
    hash: str
    name: str
    type: str
    size: int
    voice: NotRequired[VoiceInfo]


def encrypted_size(size: int) -> int:
    chunks = max(1, -(-size // FILE_CHUNK))
    return _HEADER + size + chunks * _ABYTES


def _hash(data: bytes) -> bytes:
    state = sodium.crypto_generichash_blake2b_init(digest_size=32)
    sodium.crypto_generichash_blake2b_update(state, data)
    return sodium.crypto_generichash_blake2b_final(state)


def encrypt_file(plain: bytes) -> tuple[bytes, str, str]:
    """A whole file in memory: (ciphertext, key, hash)."""
    key = sodium.crypto_secretstream_xchacha20poly1305_keygen()
    state = sodium.crypto_secretstream_xchacha20poly1305_state()
    parts = [sodium.crypto_secretstream_xchacha20poly1305_init_push(state, key)]
    at = 0
    while True:
        last = at + FILE_CHUNK >= len(plain)
        piece = plain[at : min(len(plain), at + FILE_CHUNK)]
        parts.append(sodium.crypto_secretstream_xchacha20poly1305_push(state, piece, _AD, _TAG_FINAL if last else _TAG_MESSAGE))
        if last:
            break
        at += FILE_CHUNK
    ciphertext = b"".join(parts)
    return ciphertext, b64u(key), b64u(_hash(ciphertext))


def decrypt_file(ciphertext: bytes, file: DmFile | dict[str, object]) -> bytes:
    """Checks and decrypts a whole file; anything off (wrong key, tampering, truncation, extra bytes) raises DmError."""
    mismatch = DmError("This file doesn't match what was sent.")
    damaged = DmError("This file is damaged.")
    try:
        key = from_b64u(str(file["key"]))
        expected = from_b64u(str(file["hash"]))
        size = file["size"]
    except (KeyError, ValueError) as e:
        raise mismatch from e
    if len(key) != 32 or len(expected) != 32 or not isinstance(size, int) or isinstance(size, bool) or size < 0:
        raise mismatch
    if not sodium.sodium_memcmp(_hash(ciphertext), expected):
        raise mismatch
    if len(ciphertext) != encrypted_size(size):
        raise damaged
    state = sodium.crypto_secretstream_xchacha20poly1305_state()
    try:
        sodium.crypto_secretstream_xchacha20poly1305_init_pull(state, ciphertext[:_HEADER], key)
        out: list[bytes] = []
        at, written, final = _HEADER, 0, False
        while at < len(ciphertext):
            if final:
                raise damaged  # bytes after the final chunk
            chunk = ciphertext[at : at + FILE_CHUNK + _ABYTES]
            message, tag = sodium.crypto_secretstream_xchacha20poly1305_pull(state, chunk, _AD)
            written += len(message)
            if written > size:
                raise damaged
            final = tag == _TAG_FINAL
            out.append(message)
            at += len(chunk)
    except (CryptoError, ValueError) as e:
        raise damaged from e
    if not final or written != size:
        raise damaged
    return b"".join(out)


_B64U = re.compile(r"^[A-Za-z0-9_-]+$")
_UNSAFE = re.compile("[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩\"*:<>?|]")


def _int(n: object) -> bool:
    return isinstance(n, int) and not isinstance(n, bool) and 0 <= n <= 2**53 - 1


def check_files(raw: object) -> list[DmFile]:
    """The ``files`` of decrypted DM content, checked field by field; anything malformed makes the message unreadable."""
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > MAX_DM_FILES:
        raise DmError("Unsupported message content.")
    files: list[DmFile] = []
    for f in raw:
        ok = (
            isinstance(f, dict)
            and isinstance(f.get("server"), str) and bool(_B64U.match(f["server"])) and len(f["server"]) <= 64
            and isinstance(f.get("id"), str) and bool(_B64U.match(f["id"])) and len(f["id"]) <= 64
            and isinstance(f.get("key"), str) and bool(_B64U.match(f["key"])) and len(f["key"]) == 43
            and isinstance(f.get("hash"), str) and bool(_B64U.match(f["hash"])) and len(f["hash"]) == 43
            and isinstance(f.get("name"), str) and 1 <= len(f["name"]) <= 200
            and isinstance(f.get("type"), str) and len(f["type"]) <= 100
            and _int(f.get("size"))
        )
        if not ok:
            raise DmError("Unsupported message content.")
        assert isinstance(f, dict)
        item: DmFile = {
            "server": f["server"], "id": f["id"], "key": f["key"], "hash": f["hash"], "name": clean_name(f["name"]),
            "type": f["type"], "size": f["size"],
        }
        v = f.get("voice")
        if (isinstance(v, dict) and _int(v.get("duration")) and 0 < v["duration"] <= 5 * 60 * 1000
                and isinstance(v.get("waveform"), str) and _B64U.match(v["waveform"]) and len(v["waveform"]) <= 172):
            item["voice"] = {"duration": v["duration"], "waveform": v["waveform"]}
        files.append(item)
    return files


def clean_name(name: str) -> str:
    """A name that is safe to show and to save under: no paths, no control characters."""
    cleaned = _UNSAFE.sub("", re.split(r"[\\/]", name)[-1]).strip().lstrip(".")
    return cleaned[:120] or "file"
