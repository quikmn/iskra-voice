"""The connection and the bot against a small fake server on 127.0.0.1: the handshake, requests, reconnecting, and
commands, buttons and forms as interactions. (The real server: the interop test in client/interop/pybot.test.ts.)"""
from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path
from typing import Any, Callable

import pytest
from websockets.asyncio.server import ServerConnection, serve

from iskra import Bot, Connection, ConnectionStatus, Rejected, RequestError, create_identity
from iskra.crypto import b64u, from_b64u, generate_signing_keypair, random_bytes, signed_payload, verify
from iskra.identity import AUTH_CONTEXT, verify_device_cert
from iskra.state import load_state

PERSON = "P" * 43


class FakeServer:
    """Says hello, checks the auth signature like the real server, welcomes, and answers requests from a script."""

    def __init__(self) -> None:
        self.key = generate_signing_keypair()
        self.auths: list[dict[str, Any]] = []
        self.requests: list[tuple[str, dict[str, Any]]] = []
        self.sockets: list[ServerConnection] = []
        self.answers: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {}
        self.refuse: dict[str, Any] | None = None
        self.port = 0
        self._server: Any = None

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    async def __aenter__(self) -> FakeServer:
        self._server = await serve(self._handle, "127.0.0.1", 0)
        self.port = self._server.sockets[0].getsockname()[1]
        return self

    async def __aexit__(self, *exc: object) -> None:
        self._server.close()
        await self._server.wait_closed()

    async def _handle(self, ws: ServerConnection) -> None:
        nonce = random_bytes(32)
        await ws.send(json.dumps({"type": "hello", "body": {"v": 1, "serverKey": b64u(self.key.public_key), "nonce": b64u(nonce), "name": "Fake"}}))
        auth = json.loads(await ws.recv())["body"]
        ok = verify_device_cert(auth["cert"]) and verify(
            from_b64u(auth["sig"]), signed_payload(AUTH_CONTEXT, self.key.public_key, nonce), from_b64u(auth["cert"]["deviceKey"]))
        self.auths.append(auth)
        if not ok or self.refuse:
            await ws.send(json.dumps({"type": "error", "id": "auth", "body": self.refuse or {"code": "auth_failed", "message": "no"}}))
            await ws.close(4401)
            return
        me = {"accountKey": auth["cert"]["accountKey"], "name": auth["profile"]["name"], "role": "member", "online": True, "bot": True}
        person = {"accountKey": PERSON, "name": "Viktor", "role": "admin", "online": True, "bot": False}
        await ws.send(json.dumps({"type": "welcome", "body": {
            "you": me, "server": {"name": "Fake", "key": b64u(self.key.public_key)},
            "channels": [{"id": 1, "name": "general", "kind": "text", "position": 0, "readRole": "guest", "writeRole": "guest"}],
            "members": [me, person]}}))
        self.sockets.append(ws)
        try:
            async for raw in ws:
                frame = json.loads(raw)
                self.requests.append((frame["type"], frame["body"]))
                answer = self.answers.get(frame["type"], lambda body: {})(frame["body"])
                if "code" in answer:
                    await ws.send(json.dumps({"type": "error", "id": frame["id"], "body": answer}))
                else:
                    await ws.send(json.dumps({"type": "result", "id": frame["id"], "body": answer}))
        except Exception:  # noqa: BLE001 - the client went away
            pass

    async def event(self, type: str, body: dict[str, Any]) -> None:
        await self.sockets[-1].send(json.dumps({"type": type, "seq": 1, "body": body}))

    async def wait_for(self, type: str, count: int = 1, timeout: float = 5) -> list[dict[str, Any]]:
        async def poll() -> list[dict[str, Any]]:
            while True:
                found = [b for t, b in self.requests if t == type]
                if len(found) >= count:
                    return found
                await asyncio.sleep(0.02)
        return await asyncio.wait_for(poll(), timeout)


def invite_for(server: FakeServer) -> str:
    return f"https://app.iskra.foo/#/join/{b64u(server.url.encode())}.{b64u(server.key.public_key)}.invitecode1"


def test_connection_handshake_requests_and_reconnect() -> None:
    async def main() -> None:
        async with FakeServer() as server:
            server.answers["ping"] = lambda body: {"pong": True}
            server.answers["nope"] = lambda body: {"code": "forbidden", "message": "Not for you.", "key": "x_y"}
            statuses: list[ConnectionStatus] = []
            welcomed = asyncio.Event()
            conn = Connection(server.url, create_identity(), name=lambda: "Tester", invite="invitecode1",
                              expected_server_key=b64u(server.key.public_key), on_status=statuses.append,
                              on_welcome=lambda w: welcomed.set(), on_event=lambda t, b: None)
            conn.start()
            await asyncio.wait_for(welcomed.wait(), 5)
            assert server.auths[0]["invite"] == "invitecode1" and server.auths[0]["profile"] == {"name": "Tester", "bot": True}
            assert await conn.request("ping") == {"pong": True}
            with pytest.raises(RequestError) as e:
                await conn.request("nope", {})
            assert e.value.code == "forbidden" and e.value.key == "x_y"
            # The server restarts (1012): back within about a second, and the invite isn't sent again.
            welcomed.clear()
            await server.sockets[-1].close(1012, json.dumps({"v": 1, "reason": "update", "etaMs": 1000}))
            await asyncio.wait_for(welcomed.wait(), 5)
            assert any(s.state == "restarting" and s.update for s in statuses)
            assert "invite" not in server.auths[1]
            await conn.stop()
            with pytest.raises(RequestError):
                await conn.request("ping")
    asyncio.run(main())


def test_connection_refuses_another_server_key() -> None:
    async def main() -> None:
        async with FakeServer() as server:
            statuses: list[ConnectionStatus] = []
            conn = Connection(server.url, create_identity(), name=lambda: "T", expected_server_key=b64u(bytes(32)),
                              on_status=statuses.append, on_welcome=lambda w: None, on_event=lambda t, b: None)
            conn.start()
            for _ in range(100):
                if any(s.state == "rejected" for s in statuses):
                    break
                await asyncio.sleep(0.02)
            assert [s.code for s in statuses if s.state == "rejected"] == ["server_key_mismatch"]
            assert server.auths == []  # never signed anything for the impostor
            await conn.stop()
    asyncio.run(main())


def test_bot_answers_commands_buttons_and_forms(tmp_path: Path) -> None:
    async def main() -> None:
        async with FakeServer() as server:
            server.answers["interaction.respond"] = lambda body: {"message": {"id": 7}} if not body.get("private") else {}
            server.answers["chat.send"] = lambda body: {"message": {"id": 8, **body}}
            logs: list[str] = []
            bot = Bot("Dice Bot", invite=invite_for(server), state_file=tmp_path / "dice.bot.json", log=logs.append)
            seen: dict[str, Any] = {}

            @bot.command("roll", "Rolls dice", options=[{"name": "dice", "description": "Like 2d6", "type": "string"}])
            async def roll(ctx: Any) -> None:
                seen["roll"] = (ctx.user_name, ctx.options, ctx.args)
                await ctx.reply({"text": "7", "components": [{"type": "row", "items": [{"type": "button", "customId": "roll:2d6", "label": "Again"}]}]})

            @bot.on_component(re.compile("^roll:"))
            async def again(ctx: Any) -> None:
                seen["again"] = ctx.custom_id
                await ctx.update("rolled again")

            bot.on_modal_submit("plan", lambda ctx: seen.setdefault("plan", ctx.fields))
            bot.command("boom", "Fails", lambda ctx: 1 / 0)
            await bot.start()

            synced = (await server.wait_for("bot.commands.set"))[-1]
            assert synced["interactions"] is True
            assert [c["name"] for c in synced["commands"]] == ["help", "roll", "boom"]
            assert server.auths[0]["profile"]["bot"] is True
            state = load_state(tmp_path / "dice.bot.json")
            assert state is not None and state["server"]["key"] == b64u(server.key.public_key)
            assert (await server.wait_for("prekey.publish"))[0]["deviceKey"] == server.auths[0]["cert"]["deviceKey"]

            base = {"channelId": 1, "user": PERSON, "private": False, "expiresAt": 0}
            await server.event("interaction", {**base, "id": "i1", "kind": "command", "command": "roll", "options": {"dice": "2d6"}, "args": "2d6"})
            await server.event("interaction", {**base, "id": "i2", "kind": "component", "customId": "roll:2d6", "messageId": 7})
            await server.event("interaction", {**base, "id": "i3", "kind": "modal", "customId": "plan", "fields": {"title": "Game night"}})
            await server.event("interaction", {**base, "id": "i4", "kind": "command", "command": "help"})
            await server.event("interaction", {**base, "id": "i5", "kind": "command", "command": "boom"})
            responds = await server.wait_for("interaction.respond", 3)
            assert seen["roll"] == ("Viktor", {"dice": "2d6"}, "2d6")
            assert responds[0]["id"] == "i1" and responds[0]["components"][0]["items"][0]["customId"] == "roll:2d6"
            assert "private" not in responds[0]
            assert responds[1] == {"id": "i2", "type": "update", "text": "rolled again"}
            assert responds[2]["id"] == "i4" and responds[2]["private"] is True and "/roll" in responds[2]["text"]
            assert seen["again"] == "roll:2d6" and seen["plan"] == {"title": "Game night"}
            await asyncio.sleep(0.1)
            assert any("/boom failed" in line for line in logs)

            # Typed as text: the handler gets the message, answers are replies.
            await server.event("chat.message", {"message": {"id": 3, "channelId": 1, "author": PERSON, "text": "/roll@DiceBot d20",
                                                            "createdAt": 0, "editedAt": None, "attachments": [], "replyTo": None}})
            sent = (await server.wait_for("chat.send"))[0]
            assert sent["replyTo"] == 3 and sent["text"] == "7" and seen["roll"][2] == "d20"
            await bot.stop()
    asyncio.run(main())


def test_bot_explains_a_refused_invite(tmp_path: Path) -> None:
    async def main() -> None:
        async with FakeServer() as server:
            server.refuse = {"code": "invite_required", "message": "No."}
            bot = Bot("Dice", invite=invite_for(server), state_file=tmp_path / "d.bot.json", log=lambda _: None)
            with pytest.raises(Rejected, match="bot invite") as e:
                await bot.start()
            assert e.value.code == "invite_required"
            # The keys are kept for the next try.
            assert (tmp_path / "d.bot.json").exists()
    asyncio.run(main())


def test_bot_needs_an_invite_the_first_time(tmp_path: Path) -> None:
    async def main() -> None:
        with pytest.raises(ValueError, match="No server yet"):
            await Bot("Dice", state_file=tmp_path / "x.bot.json").start()
        with pytest.raises(ValueError, match="invite link"):
            await Bot("Dice", invite="https://example.com", state_file=tmp_path / "x.bot.json").start()
    asyncio.run(main())
    with pytest.raises(ValueError):
        Bot("Dice").command("/roll", "no slash", lambda ctx: None)
