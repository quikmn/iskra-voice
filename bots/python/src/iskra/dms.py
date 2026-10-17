"""Direct messages for bots: the same end-to-end encryption as the app. The bot has its own device key and publishes
signed prekeys like an app, so messages to it are forward secret; whoever runs the bot reads them.
Mirrors bots/sdk/src/dms.ts."""
from __future__ import annotations

import asyncio
import time
import urllib.request
from typing import Any, Awaitable, Callable

from .devices import PrekeyPair, current_prekey, revoked_set, rotate_prekeys, sign_prekey
from .dm import decrypt_dm, encrypt_dm
from .dm_files import DmFile, decrypt_file
from .identity import Identity

Request = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]

BUNDLE_TTL_S = 5 * 60


class DmKeys:
    def __init__(self, identity: Identity, request: Request, save: Callable[[list[PrekeyPair]], None]) -> None:
        self.identity = identity
        self._request = request
        self._save = save
        self._bundles: dict[str, tuple[float, dict[str, Any]]] = {}

    async def publish_prekey(self, now: int | None = None) -> None:
        """Rotates the prekeys when due (weekly; old secrets deleted after 30 days) and publishes the current one."""
        prekeys, changed = rotate_prekeys(self.identity.prekeys, now)
        self.identity.prekeys = prekeys
        if changed:
            self._save(prekeys)
        current = current_prekey(prekeys)
        if current is not None:
            await self._request("prekey.publish", dict(sign_prekey(self.identity, current)))

    def forget_bundles(self) -> None:
        self._bundles.clear()

    async def _bundle(self, account_key: str) -> dict[str, Any]:
        cached = self._bundles.get(account_key)
        if cached and time.monotonic() - cached[0] < BUNDLE_TTL_S:
            return cached[1]
        bundle = await self._request("dm.devices", {"accountKey": account_key})
        self._bundles[account_key] = (time.monotonic(), bundle)
        return bundle

    async def encrypt(self, peer: str, content: dict[str, Any]) -> dict[str, Any]:
        """An envelope for ``peer``'s devices (and the bot's own, so its history stays readable)."""
        me = self.identity.account_key
        theirs, ours = await asyncio.gather(self._bundle(peer), self._bundle(me))
        envelope = encrypt_dm(
            self.identity, peer, theirs.get("devices") or [], ours.get("devices") or [], content,
            prekeys=[*(theirs.get("prekeys") or []), *(ours.get("prekeys") or [])],
            revoked_devices=revoked_set(peer, theirs.get("revoked")) | revoked_set(me, ours.get("revoked")),
        )
        return dict(envelope)

    def open(self, wire: dict[str, Any]) -> dict[str, Any]:
        """Decrypts a DM the server relayed. Raises DmError when it can't be read."""
        content = decrypt_dm(self.identity, wire.get("envelope"), str(wire.get("from")), str(wire.get("to")))
        header = content["header"]
        return {"serverId": wire.get("id"), "id": header["id"], "from": wire["from"], "text": content["text"],
                "sentAt": header["sentAt"], "files": content["files"]}

    async def download(self, server_url: str, file: DmFile) -> bytes:
        """Downloads and decrypts an attachment (checked against its hash and size; anything off raises)."""
        answer = await self._request("dm.file.url", {"id": file["id"]})
        data = await asyncio.to_thread(_get, server_url + str(answer["url"]))
        return decrypt_file(data, file)


def _get(url: str) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, method="GET"), timeout=60) as response:  # noqa: S310 - http(s) only
        return bytes(response.read())


def cards_as_text(cards: list[dict[str, Any]] | None) -> str:
    """Cards as text, for DMs (which carry text only)."""
    out = []
    for card in cards or []:
        lines = []
        if card.get("title"):
            lines.append(f"**{card['title']}**" + (f" ({card['url']})" if card.get("url") else ""))
        if card.get("description"):
            lines.append(card["description"])
        for f in card.get("fields") or []:
            lines.append(f"**{f['name']}:** {f['value']}")
        if (card.get("footer") or {}).get("text"):
            lines.append(card["footer"]["text"])
        if lines:
            out.append("\n".join(lines))
    return "\n\n".join(out)
