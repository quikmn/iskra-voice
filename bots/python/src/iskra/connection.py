"""One connection to one Iskra server: handshake, requests, events and automatic reconnects.

Mirrors client/src/core/connection.ts (PROTOCOL.md "Connection" and "Restarts and reconnecting"):
the server says ``hello`` with its key and a nonce, the device signs ``"iskra/auth/v1" || 0 || serverKey || nonce``
and sends ``auth`` with its certificate; the server answers ``welcome`` (or an error and a close).
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
import time
from dataclasses import dataclass
from typing import Any, Callable

import websockets
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, InvalidHandshake, InvalidURI

from .crypto import from_b64u
from .errors import RequestError
from .identity import Identity, sign_auth
from .invite import socket_url

log = logging.getLogger("iskra")

MIN_BACKOFF_MS = 500
MAX_BACKOFF_MS = 30_000
#: After a restart signal: retry about this often (±25%), for at least RESTART_WINDOW_MS.
RESTART_RETRY_MS = 1000
RESTART_WINDOW_MS = 120_000
#: While a moderator decides whether to let us in.
PENDING_RETRY_MS = 15_000

CLOSE_GOING_AWAY = 1001
CLOSE_RESTARTING = 1012
CLOSE_AUTH_FAILED = 4401
CLOSE_FORBIDDEN = 4403
CLOSE_ROTATED = 4409

#: Frames from the server can be big (a welcome with many members); the server limits what it accepts from us.
MAX_FRAME = 32 * 1024 * 1024


@dataclass(frozen=True)
class ConnectionStatus:
    """``state`` is ``connecting``, ``online``, ``offline`` (``retry_in_ms``, ``stopped``), ``restarting`` (``since``,
    ``eta_ms``, ``update``), ``pending`` (a moderator has to let the bot in) or ``rejected`` (``code``, ``message``)."""

    state: str
    retry_in_ms: int | None = None
    stopped: bool = False
    since: int | None = None
    eta_ms: int | None = None
    update: bool = False
    code: str | None = None
    message: str | None = None


def restart_hint(reason: str) -> tuple[str, int | None]:
    """The reason of a 1012 or 1001 close: ``{"v": 1, "reason", "etaMs"?}``. Anything else counts as ``restart``."""
    try:
        body = json.loads(reason)
        eta = body.get("etaMs")
        eta_ms = eta if isinstance(eta, (int, float)) and not isinstance(eta, bool) and 0 <= eta <= 600_000 else None
        r = body.get("reason")
        return (r[:32] if isinstance(r, str) else "restart"), (int(eta_ms) if eta_ms is not None else None)
    except (ValueError, AttributeError):
        return "restart", None


def _now() -> int:
    return int(time.time() * 1000)


class Connection:
    def __init__(
        self,
        server_url: str,
        identity: Identity,
        *,
        name: Callable[[], str],
        on_status: Callable[[ConnectionStatus], None],
        on_welcome: Callable[[dict[str, Any]], None],
        on_event: Callable[[str, dict[str, Any]], None],
        expected_server_key: str | None = None,
        invite: str | None = None,
        bot: bool = True,
        request_timeout: float = 15.0,
        open_timeout: float = 15.0,
    ) -> None:
        self.server_url = server_url
        self.identity = identity
        self.expected_server_key = expected_server_key
        self.invite = invite
        self.bot = bot
        self._name = name
        self._on_status = on_status
        self._on_welcome = on_welcome
        self._on_event = on_event
        self._request_timeout = request_timeout
        self._open_timeout = open_timeout
        self._socket: ClientConnection | None = None
        self._pending: dict[str, tuple[str, asyncio.Future[dict[str, Any]]]] = {}
        self._next_id = 0
        self._attempts = 0
        self._ready = False
        self._stopped = False
        self._rejected = False
        self._restart: dict[str, Any] | None = None
        self._server_stopped = False
        self._awaiting_approval = False
        self._task: asyncio.Task[None] | None = None
        self._wake = asyncio.Event()

    @property
    def is_online(self) -> bool:
        return self._ready

    def start(self) -> None:
        self._stopped = False
        self._rejected = False
        self._restart = None
        self._server_stopped = False
        if self._task is None or self._task.done():
            self._task = asyncio.get_running_loop().create_task(self._run(), name="iskra-connection")

    async def stop(self) -> None:
        self._stopped = True
        self._wake.set()
        socket = self._socket
        if socket is not None:
            try:
                await socket.close(1000)
            except Exception:  # noqa: BLE001 - already closed
                pass
        self._fail_pending("disconnected", "Disconnected.")
        if self._task is not None and self._task is not asyncio.current_task():
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self._task = None

    async def request(self, type: str, body: dict[str, Any] | None = None, timeout: float | None = None) -> dict[str, Any]:
        """Sends a request and waits for its ``result`` (raises RequestError for an ``error``)."""
        socket = self._socket
        if socket is None or not self._ready:
            raise RequestError("disconnected", "Not connected.", type)
        self._next_id += 1
        frame_id = f"c{self._next_id}"
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[frame_id] = (type, future)
        try:
            await socket.send(json.dumps({"type": type, "id": frame_id, "body": body or {}}, ensure_ascii=False))
        except ConnectionClosed:
            self._pending.pop(frame_id, None)
            raise RequestError("disconnected", "Not connected.", type) from None
        try:
            return await asyncio.wait_for(future, timeout or self._request_timeout)
        except asyncio.TimeoutError:
            raise RequestError("timeout", "The server took too long to answer.", type) from None
        finally:
            self._pending.pop(frame_id, None)

    # ── the loop ─────────────────────────────────────────────────────────────

    def _status(self, status: ConnectionStatus) -> None:
        try:
            self._on_status(status)
        except Exception:  # noqa: BLE001 - a listener must never stop the reconnect loop
            log.exception("A status listener failed")

    async def _run(self) -> None:
        while not self._stopped and not self._rejected:
            self._ready = False
            self._status(self._restart_status() or (ConnectionStatus("pending") if self._awaiting_approval else ConnectionStatus("connecting")))
            code, reason = 1006, ""
            try:
                async with connect(socket_url(self.server_url), max_size=MAX_FRAME, open_timeout=self._open_timeout,
                                   user_agent_header=f"iskra-bots-python websockets/{websockets.__version__}") as socket:
                    self._socket = socket
                    try:
                        async for raw in socket:
                            await self._handle_frame(raw if isinstance(raw, str) else raw.decode("utf-8", "replace"))
                            if self._rejected or self._stopped:
                                break
                    except ConnectionClosed:
                        pass
                    if socket.close_code is not None:
                        code, reason = socket.close_code, socket.close_reason or ""
            except asyncio.CancelledError:
                raise
            except (OSError, InvalidHandshake, InvalidURI, asyncio.TimeoutError, ConnectionClosed):
                pass
            except Exception:  # noqa: BLE001 - whatever went wrong in one attempt, the next one is scheduled
                log.exception("Connection attempt failed")
            self._socket = None
            delay = self._handle_close(code, reason)
            if delay is None:
                return
            self._wake.clear()
            try:
                await asyncio.wait_for(self._wake.wait(), delay / 1000)
            except asyncio.TimeoutError:
                pass

    async def _handle_frame(self, text: str) -> None:
        try:
            frame = json.loads(text)
        except ValueError:
            return
        if not isinstance(frame, dict):
            return
        body = frame.get("body") if isinstance(frame.get("body"), dict) else {}
        kind = frame.get("type")
        if kind == "hello":
            await self._send_auth(body)
        elif kind == "welcome":
            self._ready = True
            self._attempts = 0
            self._restart = None
            self._server_stopped = False
            self._awaiting_approval = False
            self.invite = None  # a member now
            self._status(ConnectionStatus("online"))
            self._on_welcome(body)
        elif kind in ("result", "error"):
            pending = self._pending.get(frame.get("id")) if isinstance(frame.get("id"), str) else None
            if pending is not None:
                request_type, future = pending
                if not future.done():
                    if kind == "result":
                        future.set_result(body)
                    else:
                        key = body.get("key") if isinstance(body.get("key"), str) else None
                        args = body.get("args") if isinstance(body.get("args"), dict) else None
                        future.set_exception(RequestError(str(body.get("code")), str(body.get("message") or "Request failed."), request_type, key, args))
            elif kind == "error" and not self._ready:
                if body.get("code") == "join_pending":
                    # Not a no: a moderator has to let us in. The socket closes; we knock again in a while.
                    self._awaiting_approval = True
                    self._status(ConnectionStatus("pending"))
                    return
                await self._reject(str(body.get("code") or "auth_failed"), str(body.get("message") or "The server refused the connection."))
        elif kind == "kicked":
            await self._reject("kicked", str(body.get("reason") or "You were removed from this server."))
            self._on_event("kicked", body)
        elif isinstance(kind, str) and self._ready:
            self._on_event(kind, body)

    async def _send_auth(self, hello: dict[str, Any]) -> None:
        server_key = hello.get("serverKey")
        if self.expected_server_key and server_key != self.expected_server_key:
            await self._reject("server_key_mismatch", "This server's identity doesn't match the invite link. It may be an impostor.")
            return
        try:
            sig = sign_auth(self.identity.device, from_b64u(str(server_key)), from_b64u(str(hello.get("nonce"))))
        except ValueError:
            await self._reject("auth_failed", "The server sent an invalid handshake.")
            return
        profile: dict[str, Any] = {"name": self._name()}
        if self.bot:
            profile["bot"] = True
        body: dict[str, Any] = {"cert": self.identity.cert, "sig": sig, "profile": profile}
        if self.invite:
            body["invite"] = self.invite
        if self._socket is not None:
            try:
                await self._socket.send(json.dumps({"type": "auth", "id": "auth", "body": body}, ensure_ascii=False))
            except ConnectionClosed:
                pass

    async def _reject(self, code: str, message: str) -> None:
        self._rejected = True
        self._ready = False
        if self._socket is not None:
            try:
                await self._socket.close(1000)
            except Exception:  # noqa: BLE001
                pass
        self._status(ConnectionStatus("rejected", code=code, message=message))

    def _handle_close(self, code: int, reason: str) -> int | None:
        """What happens after a close: the delay before the next attempt in ms, or None to give up."""
        self._ready = False
        self._fail_pending("disconnected", "Connection lost.")
        if self._stopped or self._rejected:
            return None
        if self._awaiting_approval and code == CLOSE_AUTH_FAILED:
            return PENDING_RETRY_MS
        if code == CLOSE_ROTATED:
            self._rejected = True
            self._status(ConnectionStatus("rejected", code="account_rotated", message="This account moved to a new key."))
            return None
        if code == CLOSE_FORBIDDEN:
            self._rejected = True
            self._status(ConnectionStatus("rejected", code="forbidden", message="You no longer have access to this server."))
            return None
        if code == CLOSE_RESTARTING:
            now = _now()
            hint, eta_ms = restart_hint(reason)
            since = self._restart["since"] if self._restart else now
            update = hint == "update" or bool(self._restart and self._restart.get("update"))
            self._restart = {"since": since, "eta_ms": eta_ms, "update": update,
                             "until": now + max(RESTART_WINDOW_MS, (eta_ms or 0) + 60_000)}
            self._attempts = 0
            self._server_stopped = False
        elif code == CLOSE_GOING_AWAY and reason and restart_hint(reason)[0] == "stop":
            self._restart = None
            self._server_stopped = True
            self._attempts = 0
        restarting = self._restart_status()
        if restarting:
            # Fast and steady while the server comes back; jitter so everyone doesn't knock at the same moment.
            self._status(restarting)
            return round(RESTART_RETRY_MS * (0.75 + random.random() * 0.5))
        self._restart = None
        base = min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** self._attempts)
        delay = round(base * (0.7 + random.random() * 0.6))
        self._attempts += 1
        self._status(ConnectionStatus("offline", retry_in_ms=delay, stopped=self._server_stopped))
        return delay

    def _restart_status(self) -> ConnectionStatus | None:
        r = self._restart
        if not r or _now() >= r["until"]:
            return None
        return ConnectionStatus("restarting", since=r["since"], eta_ms=r["eta_ms"], update=r["update"])

    def _fail_pending(self, code: str, message: str) -> None:
        for request_type, future in self._pending.values():
            if not future.done():
                future.set_exception(RequestError(code, message, request_type))
        self._pending.clear()

