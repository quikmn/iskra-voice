"""A bot's keys and server address, kept in one JSON file (readable only by its owner).

The same format as the Node SDK's ``<name>.bot.json`` (bots/sdk/src/state.ts), so a bot can switch languages and keep
its identity::

    { "v": 1, "accountSeed": "<b64u 32>", "deviceSeed": "<b64u 32>", "created": <ms>,
      "server": { "url": "https://...", "key": "<b64u>" },            # after the first join
      "prekeys": [{ "publicKey", "secretKey", "created", "retiredAt"? }] }
"""
from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import Any

from .crypto import b64u, from_b64u, random_bytes, signing_keypair_from_seed
from .devices import PrekeyPair
from .identity import Identity, certify_device

BotState = dict[str, Any]


def default_state_file(name: str) -> Path:
    """``<name>.bot.json`` in the current folder: lowercase, runs of other characters become a dash."""
    return Path(re.sub(r"[^A-Za-z0-9_-]+", "-", name).lower() + ".bot.json").resolve()


def new_state(now: int | None = None) -> BotState:
    return {
        "v": 1, "accountSeed": b64u(random_bytes(32)), "deviceSeed": b64u(random_bytes(32)),
        "created": now if now is not None else int(time.time() * 1000),
    }


def identity_of(state: BotState) -> Identity:
    account = signing_keypair_from_seed(from_b64u(state["accountSeed"]))
    device = signing_keypair_from_seed(from_b64u(state["deviceSeed"]))
    prekeys = [
        PrekeyPair(from_b64u(p["publicKey"]), from_b64u(p["secretKey"]), p["created"], p.get("retiredAt"))
        for p in state.get("prekeys") or []
    ]
    return Identity(account, device, certify_device(account, device.public_key, state["created"]), prekeys)


def stored_prekeys(prekeys: list[PrekeyPair]) -> list[dict[str, Any]]:
    out = []
    for p in prekeys:
        item: dict[str, Any] = {"publicKey": b64u(p.public_key), "secretKey": b64u(p.secret_key), "created": p.created}
        if p.retired_at is not None:
            item["retiredAt"] = p.retired_at
        out.append(item)
    return out


def load_state(path: str | os.PathLike[str]) -> BotState | None:
    path = Path(path)
    if not path.exists():
        return None
    state = json.loads(path.read_text(encoding="utf-8"))
    if (not isinstance(state, dict) or state.get("v") != 1 or not isinstance(state.get("accountSeed"), str)
            or not isinstance(state.get("deviceSeed"), str) or not isinstance(state.get("created"), int)):
        raise ValueError(f"{path} isn't a bot state file.")
    return state


def save_state(path: str | os.PathLike[str], state: BotState) -> None:
    """Written to a temp file (owner-only) and renamed, so a crash never leaves half a key file."""
    path = Path(path)
    temp = path.with_name(path.name + ".tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(state, indent=2, ensure_ascii=False) + "\n")
    os.replace(temp, path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass  # not supported on every file system
