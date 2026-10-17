"""The crypto against protocol/vectors.json (the values the server and the app pin too) and against envelopes the app's
own code made (fixtures/dm-from-app.json)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from iskra.crypto import b64u, from_b64u, signed_payload, signing_keypair_from_seed, u64be
from iskra.devices import generate_prekey, rotate_prekeys, sign_prekey, usable_prekeys, verify_prekey, PREKEY_GRACE_MS, PREKEY_ROTATE_MS
from iskra.dm import decrypt_dm, encrypt_dm
from iskra.dm_files import DmError, check_files, clean_name, decrypt_file, encrypt_file, encrypted_size
from iskra.identity import certify_device, create_identity, sign_auth, verify_device_cert
from iskra.state import identity_of

ROOT = Path(__file__).resolve().parents[3]
VECTORS = json.loads((ROOT / "protocol" / "vectors.json").read_text(encoding="utf-8"))
FROM_APP = json.loads((Path(__file__).parent / "fixtures" / "dm-from-app.json").read_text(encoding="utf-8"))


def test_keys_cert_and_auth_match_the_vectors() -> None:
    v = VECTORS["v1"]
    account = signing_keypair_from_seed(from_b64u(v["accountSeed"]))
    device = signing_keypair_from_seed(from_b64u(v["deviceSeed"]))
    server = signing_keypair_from_seed(from_b64u(v["serverSeed"]))
    assert b64u(account.public_key) == v["accountKey"]
    assert b64u(device.public_key) == v["deviceKey"]
    assert b64u(server.public_key) == v["serverKey"]
    assert certify_device(account, device.public_key, v["created"]) == v["cert"]
    assert verify_device_cert(v["cert"])
    assert sign_auth(device, server.public_key, from_b64u(v["nonce"])) == v["authSig"]


def test_tampered_certs_dont_verify() -> None:
    cert = dict(VECTORS["v1"]["cert"])
    assert not verify_device_cert({**cert, "created": cert["created"] + 1})
    assert not verify_device_cert({**cert, "accountKey": VECTORS["v1"]["deviceKey"]})
    assert not verify_device_cert({**cert, "sig": "nope"})
    assert not verify_device_cert({**cert, "created": True})
    assert not verify_device_cert("cert")


def test_signed_payload_layout() -> None:
    assert signed_payload("iskra/x/v1", b"\x01", b"\x02") == b"iskra/x/v1\x00\x01\x02"
    assert u64be(1760000000000) == (1760000000000).to_bytes(8, "big") and u64be(1)[-1] == 1
    with pytest.raises(ValueError):
        u64be(-1)
    with pytest.raises(ValueError):
        from_b64u("AQ==")


def test_dm_files_from_the_vectors_decrypt() -> None:
    for f in VECTORS["dmFile"]["files"]:
        plain = decrypt_file(from_b64u(f["ciphertext"]), f)
        assert plain == bytes(i % 251 for i in range(f["size"]))
        assert len(from_b64u(f["ciphertext"])) == encrypted_size(f["size"])


def test_dm_files_refuse_tampering_truncation_and_extra_bytes() -> None:
    f = VECTORS["dmFile"]["files"][1]
    ct = bytearray(from_b64u(f["ciphertext"]))
    for bad in (bytes(ct[:-1]), bytes(ct) + b"\x00", bytes(ct[:100]) + bytes([ct[100] ^ 1]) + bytes(ct[101:])):
        with pytest.raises(DmError):
            decrypt_file(bad, f)
    with pytest.raises(DmError):
        decrypt_file(bytes(ct), {**f, "size": f["size"] - 1})
    with pytest.raises(DmError):
        decrypt_file(bytes(ct), {**f, "key": b64u(bytes(32))})


def test_dm_files_round_trip() -> None:
    for size in (0, 1, 65536, 65536 * 2 + 5):
        plain = bytes(i % 7 for i in range(size))
        ct, key, digest = encrypt_file(plain)
        assert len(ct) == encrypted_size(size)
        assert decrypt_file(ct, {"key": key, "hash": digest, "size": size}) == plain


def test_file_lists_are_checked() -> None:
    good = {"server": "abc", "id": "def", "key": "A" * 43, "hash": "B" * 43, "name": "../../etc/passwd", "type": "text/plain", "size": 3}
    assert check_files([good])[0]["name"] == "passwd"
    assert check_files(None) == []
    with pytest.raises(DmError):
        check_files([{**good, "size": -1}])
    with pytest.raises(DmError):
        check_files([good] * 11)
    assert clean_name('..\\a<b>?.txt') == "ab.txt"
    assert clean_name("...") == "file"


def test_dms_the_app_made_open() -> None:
    bot = identity_of({**FROM_APP["bot"], "v": 1})
    for m in FROM_APP["messages"]:
        opened = decrypt_dm(bot, m["envelope"], m["from"], m["to"])
        assert opened["text"] == m["text"]
        assert opened["files"] == []


def test_dms_from_the_app_refuse_rerouting_and_tampering() -> None:
    bot = identity_of({**FROM_APP["bot"], "v": 1})
    m = FROM_APP["messages"][1]
    with pytest.raises(DmError):
        decrypt_dm(bot, m["envelope"], m["to"], m["from"])  # the server claims other routing
    env = json.loads(json.dumps(m["envelope"]))
    env["header"]["sentAt"] += 1
    with pytest.raises(DmError):
        decrypt_dm(bot, env, m["from"], m["to"])
    no_prekey = identity_of({**FROM_APP["bot"], "v": 1, "prekeys": []})
    with pytest.raises(DmError, match="older key"):
        decrypt_dm(no_prekey, m["envelope"], m["from"], m["to"])


def test_dm_round_trip_static_and_forward_secret() -> None:
    alice, bob = create_identity(), create_identity()
    bob.prekeys = [generate_prekey()]
    a, b = alice.account_key, bob.account_key
    v1 = encrypt_dm(alice, b, [bob.cert], [], {"text": "hi bob 👋"})
    assert v1["v"] == 1 and "box" in v1["keys"][0]
    assert decrypt_dm(bob, v1, a, b)["text"] == "hi bob 👋"
    assert decrypt_dm(alice, v1, a, b)["text"] == "hi bob 👋"  # the sender's own device too
    v2 = encrypt_dm(alice, b, [bob.cert], [], {"text": "secret"}, prekeys=[sign_prekey(bob, bob.prekeys[0])])
    assert v2["v"] == 2 and "seal" in v2["keys"][0]
    assert decrypt_dm(bob, v2, a, b)["text"] == "secret"
    eve = create_identity()
    with pytest.raises(DmError):
        decrypt_dm(eve, v2, a, b)
    with pytest.raises(DmError):
        encrypt_dm(alice, b, [], [], {"text": "nobody"})
    with pytest.raises(DmError):
        encrypt_dm(alice, b, [bob.cert], [], {"text": "x" * 4001})


def test_prekeys_rotate_weekly_and_secrets_go_after_the_grace_period() -> None:
    now = 1_800_000_000_000
    keys, changed = rotate_prekeys([], now)
    assert changed and len(keys) == 1
    keys, changed = rotate_prekeys(keys, now + 1000)
    assert not changed
    keys, changed = rotate_prekeys(keys, now + PREKEY_ROTATE_MS)
    assert changed and len(keys) == 2 and keys[0].retired_at == now + PREKEY_ROTATE_MS
    first = keys[0].public_key
    keys, changed = rotate_prekeys(keys, now + PREKEY_ROTATE_MS + PREKEY_GRACE_MS + 1)
    assert changed and first not in [k.public_key for k in keys]  # the old secret is gone


def test_signed_prekeys_verify() -> None:
    me = create_identity()
    p = generate_prekey()
    signed = sign_prekey(me, p)
    assert verify_prekey(signed)
    assert not verify_prekey({**signed, "created": signed["created"] + 1})
    assert usable_prekeys([signed])[signed["deviceKey"]] == signed
