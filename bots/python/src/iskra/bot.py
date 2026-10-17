"""An Iskra bot: a normal identity that connects with the regular protocol, says it's a bot, and answers /commands (as
interactions from the app, or typed as text), button clicks and forms, messages meant for it and direct messages.

The Python twin of bots/sdk/src/bot.ts: same behaviour, same ``<name>.bot.json``.
"""
from __future__ import annotations

import asyncio
import inspect
import json
import re
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Iterable, Mapping, Union

from .commands import Command, may_use, parse_command, parse_options, valid_command_name
from .connection import Connection, ConnectionStatus
from .dm_files import DmError, DmFile
from .dms import DmKeys, cards_as_text
from .errors import Rejected, RequestError
from .invite import parse_invite
from .state import BotState, default_state_file, identity_of, load_state, new_state, save_state, stored_prekeys
from .text import cut, utf16_len
from .types import Channel, FileInfo, Member, Message, MessageContent, Modal

SEND_RETRIES = 4
MAX_TEXT = 4000

Content = Union[str, MessageContent, Mapping[str, Any]]
Handler = Callable[..., Any]

#: Listener names, and the camelCase spellings the Node SDK uses.
EVENTS = ("ready", "message", "dm", "member_joined", "message_edited", "message_deleted", "reactions", "poll_updated", "event", "status")
_ALIASES = {"memberJoined": "member_joined", "messageEdited": "message_edited", "messageDeleted": "message_deleted",
            "pollUpdated": "poll_updated"}


def rejection_help(code: str, message: str, joining: bool) -> str:
    """Why the server turned the bot away, in words that say what to do about it."""
    if code == "invite_required":
        if joining:
            return ("The server didn't accept this invite. A bot needs a bot invite (Bots & webhooks → Bots → Create bot invite): "
                    "an invite for people doesn't work, and each bot invite works once, for 7 days unless the admin chose otherwise.")
        return "This bot is no longer a member of the server (was it removed?). Ask an admin for a new bot invite and start the bot with it."
    if code == "banned":
        return "This bot is banned from the server."
    return message


def _content(content: Content) -> dict[str, Any]:
    return {"text": content} if isinstance(content, str) else dict(content)


def _clean(body: dict[str, Any]) -> dict[str, Any]:
    """Leaves out fields that weren't given (the wire uses absent, not null)."""
    return {k: v for k, v in body.items() if v is not None}


# ── What handlers get ────────────────────────────────────────────────────────


@dataclass
class IncomingMessage:
    """A message the bot received, with shortcuts to answer it. ``data`` is the whole wire message."""

    data: Message
    author_name: str
    channel: Channel | None
    bot: Bot = field(repr=False)

    @property
    def id(self) -> int:
        return self.data["id"]

    @property
    def channel_id(self) -> int:
        return self.data["channelId"]

    @property
    def author(self) -> str:
        return self.data["author"]

    @property
    def text(self) -> str:
        return self.data["text"]

    @property
    def attachments(self) -> list[FileInfo]:
        return self.data.get("attachments") or []

    async def reply(self, content: Content, **options: Any) -> Message:
        return await self.bot.send(self.channel_id, content, reply_to=self.id, **options)

    async def react(self, emoji: str) -> None:
        await self.bot.react(self.id, emoji)


@dataclass
class IncomingDm:
    """A direct message to the bot, decrypted (end-to-end encrypted between the person's devices and the bot)."""

    id: str
    #: Who wrote (account key) and their name.
    author: str
    author_name: str
    text: str
    sent_at: int
    #: Encrypted attachments: ``await bot.download_dm_file(file)`` gets the bytes.
    files: list[DmFile]
    bot: Bot = field(repr=False)

    async def reply(self, content: Content) -> None:
        await self.bot.send_dm(self.author, content)


@dataclass
class AnswerContext:
    """What every answerable context has: who asked, where, and how to answer."""

    bot: Bot = field(repr=False)
    #: Who asked (account key) and their name.
    user: str
    user_name: str
    #: Where it was asked (0 in a DM).
    channel_id: int
    #: Asked in a direct message: answers go back as DMs.
    dm: bool
    #: The interaction, when it came from the app (None for commands typed as text or in DMs).
    interaction: dict[str, Any] | None
    _reply: Callable[[Content, bool], Awaitable[Message | None]] = field(repr=False)
    _defer: Callable[[], Awaitable[None]] = field(repr=False)
    _show_modal: Callable[[Modal], Awaitable[None]] = field(repr=False)

    async def reply(self, content: Content, *, private: bool = False) -> Message | None:
        """Answers in public (a message that says who asked), or with ``private=True`` only to the asker. Returns the
        posted message, or None for a private answer. Up to 5 answers per interaction, within 15 minutes."""
        return await self._reply(content, private)

    async def defer(self) -> None:
        """"I'm working on it": the app shows "<bot> is thinking…" until you reply (up to 15 minutes)."""
        await self._defer()

    async def show_modal(self, modal: Modal) -> None:
        """Shows a form to the person who asked; its answer arrives at ``bot.on_modal_submit(modal["customId"])``."""
        await self._show_modal(modal)


@dataclass
class CommandContext(AnswerContext):
    command: Command = field(default=Command("", None, ""))
    #: Everything after the command name, as typed.
    args: str = ""
    #: The command's options, checked by the server against what you declared (empty for commands typed as text).
    options: dict[str, Any] = field(default_factory=dict)
    #: The message, for commands typed as text (None when the app sent the command as an interaction).
    message: IncomingMessage | None = None

    async def react(self, emoji: str) -> None:
        """Reacts to the command's message (does nothing for interactions, which have no message)."""
        if self.message is not None:
            await self.message.react(emoji)


@dataclass
class ComponentContext(AnswerContext):
    custom_id: str = ""
    #: The picked values (select menus).
    values: list[str] = field(default_factory=list)
    message_id: int | None = None
    response_id: str | None = None
    _update: Callable[[Content], Awaitable[None]] | None = field(default=None, repr=False)

    async def update(self, content: Content) -> None:
        """Replaces the text, cards and components of the message (or private answer) the click came from."""
        assert self._update is not None
        await self._update(content)


@dataclass
class ModalContext(AnswerContext):
    custom_id: str = ""
    #: Field customId → what was typed ("" for empty optional fields).
    fields: dict[str, str] = field(default_factory=dict)


@dataclass
class _Registered:
    spec: dict[str, Any]
    help: str
    handler: Handler


# ── The bot ──────────────────────────────────────────────────────────────────


class Bot:
    """An Iskra bot. ``invite`` is only needed the first time; the keys and server address are kept in ``state_file``
    (default ``<name>.bot.json``). Bots ignore other bots and webhooks unless ``hear_bots`` is true."""

    def __init__(self, name: str, invite: str | None = None, *, state_file: str | Path | None = None, hear_bots: bool = False,
                 log: Callable[[str], None] | None = None) -> None:
        self.name = name
        self.invite = invite or None
        self.hear_bots = hear_bots
        self.state_file = Path(state_file).resolve() if state_file else default_state_file(name)
        self.me: Member | None = None
        self.channels: list[Channel] = []
        self.members: dict[str, Member] = {}
        self.server: dict[str, Any] = {}
        self._log_line = log
        self._registry: dict[str, _Registered] = {}
        self._components: list[tuple[str | re.Pattern[str], Handler]] = []
        self._modals: list[tuple[str | re.Pattern[str], Handler]] = []
        self._listeners: dict[str, list[Handler]] = {e: [] for e in EVENTS}
        self._connection: Connection | None = None
        self._state: BotState | None = None
        self._server_url = ""
        self._dm_keys: DmKeys | None = None
        self._tasks: set[asyncio.Task[Any]] = set()
        self._sync_handle: asyncio.TimerHandle | None = None
        self._prekey_task: asyncio.Task[None] | None = None
        self._closed: asyncio.Event | None = None
        self._ended: str | None = None
        self.command("help", "Lists what this bot can do", lambda ctx: ctx.reply(self.help_text(), private=True))

    # ── registering ──────────────────────────────────────────────────────────

    def on(self, event: str, listener: Handler | None = None) -> Any:
        """Listens to ``ready``, ``message``, ``dm``, ``member_joined``, ``message_edited``, ``message_deleted``,
        ``reactions``, ``poll_updated``, ``event`` (every raw server event: ``listener(type, body)``) or ``status``.
        Works as a decorator too: ``@bot.on("message")``. Listeners may be ``async``."""
        name = _ALIASES.get(event, event)
        if name not in self._listeners:
            raise ValueError(f"Unknown event {event!r}; one of {', '.join(EVENTS)}.")
        if listener is None:
            return lambda fn: (self._listeners[name].append(fn), fn)[1]
        self._listeners[name].append(listener)
        return self

    def command(self, name: str, description: str, handler: Handler | None = None, *, usage: str | None = None,
                options: list[dict[str, Any]] | None = None, role: str | None = None, permission: str | None = None) -> Any:
        """Answers ``/name args``; the handler gets a CommandContext. Names are case-insensitive; a later registration
        replaces an earlier one. The server is told about every command each time the bot connects, so the app suggests
        it when people type "/". Works as a decorator: ``@bot.command("roll", "Rolls dice")``."""
        if handler is None:
            def decorate(fn: Handler) -> Handler:
                self.command(name, description, fn, usage=usage, options=options, role=role, permission=permission)
                return fn
            return decorate
        key = name.lower()
        if not valid_command_name(key):
            raise ValueError(f'Invalid command name "{name}": use 1–32 letters, digits, "_" or "-", starting with a letter or digit, no slash.')
        # The app shows one line of up to 100 characters; /help shows the description as written.
        line = " ".join(description.split()) or key
        spec: dict[str, Any] = {"name": key, "description": line if len(line) <= 100 else line[:99] + "…"}
        if usage:
            spec["usage"] = usage
        if options:
            spec["options"] = options
        if role:
            spec["role"] = role
        if permission:
            spec["permission"] = permission
        self._registry[key] = _Registered(spec, description, handler)
        self._schedule_sync()
        return self

    def commands(self, specs: Iterable[Mapping[str, Any]]) -> Bot:
        """Several commands at once: ``[{"name", "description", "handler", "usage"?, "options"?, "role"?, "permission"?}]``."""
        for c in specs:
            self.command(c["name"], c["description"], c["handler"], usage=c.get("usage"), options=c.get("options"),
                         role=c.get("role"), permission=c.get("permission"))
        return self

    def remove_command(self, name: str) -> Bot:
        if name.lower() != "help" and self._registry.pop(name.lower(), None) is not None:
            self._schedule_sync()
        return self

    def on_component(self, custom_id: str | re.Pattern[str], handler: Handler | None = None) -> Any:
        """Answers clicks on the bot's buttons and select menus: ``custom_id`` exactly, or a pattern
        (``re.compile("^roll:")``). The first match answers. Works as a decorator."""
        if handler is None:
            return lambda fn: (self._components.append((custom_id, fn)), fn)[1]
        self._components.append((custom_id, handler))
        return self

    def on_modal_submit(self, custom_id: str | re.Pattern[str], handler: Handler | None = None) -> Any:
        """Answers forms the bot showed with ``show_modal({"customId": ...})``. Works as a decorator."""
        if handler is None:
            return lambda fn: (self._modals.append((custom_id, fn)), fn)[1]
        self._modals.append((custom_id, handler))
        return self

    @property
    def command_list(self) -> list[dict[str, Any]]:
        """The commands as the server knows them."""
        return [r.spec for r in self._registry.values()]

    def help_text(self) -> str:
        lines = [f"`/{name}{' ' + r.spec['usage'] if r.spec.get('usage') else ''}` {r.help}" for name, r in self._registry.items()]
        return f"**{self.name}** can do:\n" + "\n".join(lines)

    async def sync_commands(self) -> None:
        """Tells the server the commands (done by itself on connect and after changes)."""
        if self._connection is None or self.me is None:
            return
        try:
            # interactions: the app sends commands (with checked options) straight to the bot instead of posting the text.
            await self.request("bot.commands.set", {"commands": self.command_list, "interactions": True})
        except RequestError as e:
            if e.code != "unknown_type":  # an older server: commands still work as text
                self._log(f"The server didn't take the command list ({e.code}): {e.message}")

    def _schedule_sync(self) -> None:
        if self.me is None or self._sync_handle is not None:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return

        def fire() -> None:
            self._sync_handle = None
            self._spawn(self.sync_commands())
        self._sync_handle = loop.call_later(0.2, fire)

    # ── running ──────────────────────────────────────────────────────────────

    async def start(self) -> None:
        """Connects; returns once the server has welcomed the bot and has its commands. Raises Rejected if the server
        says no, ValueError for a bad invite or a missing server."""
        loop = asyncio.get_running_loop()
        self._closed = asyncio.Event()
        self._ended = None
        state = load_state(self.state_file) or new_state()
        self._state = state
        invite = parse_invite(self.invite) if self.invite else None
        if self.invite and invite is None:
            raise ValueError("That doesn't look like an Iskra invite link. Copy the whole link from Bots & webhooks → Bots (it contains \"#/join/\").")
        if invite and (state.get("server") or {}).get("key") != invite.server_key:
            state.pop("server", None)
        server = state.get("server") or ({"url": invite.server_url, "key": invite.server_key} if invite else None)
        if not server:
            raise ValueError(f"No server yet: start the bot once with a bot invite link from a server admin (ISKRA_INVITE). It's then remembered in {self.state_file}.")
        save_state(self.state_file, state)  # keep the keys even if the first connect fails
        self._server_url = server["url"].rstrip("/")
        joining = not state.get("server")
        identity = identity_of(state)

        def save_prekeys(prekeys: Any) -> None:
            state["prekeys"] = stored_prekeys(prekeys)
            save_state(self.state_file, state)
        self._dm_keys = DmKeys(identity, self.request, save_prekeys)
        if self._prekey_task:
            self._prekey_task.cancel()
        self._prekey_task = loop.create_task(self._prekey_loop())

        first: asyncio.Future[None] = loop.create_future()
        restart_logged = {"since": 0}

        def on_status(status: ConnectionStatus) -> None:
            self._emit("status", status)
            if status.state == "rejected":
                help = rejection_help(status.code or "", status.message or "", joining)
                self._log(f"Rejected by the server: {help}")
                if not first.done():
                    first.set_exception(Rejected(status.code or "rejected", help))
                else:
                    self._end(help)
            elif status.state == "offline":
                self._log(f"Disconnected; retrying in {round((status.retry_in_ms or 0) / 1000)}s")
            elif status.state == "restarting" and status.since != restart_logged["since"]:
                restart_logged["since"] = status.since or 0  # reported on every quick retry; say it once
                self._log("The server is restarting; reconnecting as soon as it is back")

        def on_welcome(welcome: dict[str, Any]) -> None:
            self.me = welcome["you"]
            self.server = welcome.get("server") or {}
            self.channels = list(welcome.get("channels") or [])
            self.members = {m["accountKey"]: m for m in welcome.get("members") or []}
            if not state.get("server"):
                state["server"] = server
                save_state(self.state_file, state)
            self._log(f'Online in "{self.server.get("name", "")}" as {self.me["name"]} ({self.me["role"]})')

            async def after() -> None:
                await self.sync_commands()
                if not first.done():  # once the server has the commands, apps send them as commands, not as text
                    first.set_result(None)
            self._spawn(after())
            self._spawn(self._publish_prekey())
            self._emit("ready", self)

        self._connection = Connection(
            server["url"], identity, name=lambda: self.name, expected_server_key=server["key"],
            invite=None if state.get("server") else (invite.code if invite else None), bot=True,
            on_status=on_status, on_welcome=on_welcome, on_event=self._handle_event,
        )
        self._connection.start()
        try:
            await first
        except BaseException:
            await self.stop()
            raise

    async def stop(self) -> None:
        """Disconnects. The bot reconnects by itself after network trouble or a server restart until you stop it."""
        if self._sync_handle:
            self._sync_handle.cancel()
            self._sync_handle = None
        if self._prekey_task:
            self._prekey_task.cancel()
            self._prekey_task = None
        connection, self._connection = self._connection, None
        if connection is not None:
            await connection.stop()
        self._end(None)

    def _end(self, reason: str | None) -> None:
        if self._ended is None:
            self._ended = reason or ""
        if self._closed is not None:
            self._closed.set()

    async def wait_closed(self) -> None:
        """Waits until the bot is stopped (or turned away for good, e.g. removed from the server)."""
        if self._closed is not None:
            await self._closed.wait()

    def run(self) -> None:
        """Starts the bot and keeps it running until Ctrl+C (blocking). Exits with a message if it can't start."""
        async def main() -> None:
            try:
                await self.start()
            except (Rejected, ValueError) as e:
                raise SystemExit(f"{self.name} couldn't start: {e}") from None
            try:
                await self.wait_closed()
            finally:
                await self.stop()
            if self._ended:
                raise SystemExit(f"{self.name} stopped: {self._ended}")
        try:
            asyncio.run(main())
        except KeyboardInterrupt:
            pass

    async def request(self, type: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """Any protocol request (see PROTOCOL.md), for things the SDK doesn't wrap. Raises RequestError."""
        if self._connection is None:
            raise RequestError("disconnected", "The bot is not started.", type)
        return await self._connection.request(type, body or {})

    # ── posting ──────────────────────────────────────────────────────────────

    async def send(self, channel_id: int, content: Content, *, reply_to: int | None = None, attachments: list[str] | None = None,
                   cards: list[Any] | None = None, components: list[Any] | None = None) -> Message:
        """Posts a message: text (up to 4000 characters; longer text is cut), or ``{"text"?, "cards"?, "components"?,
        "attachments"?, "replyTo"?}``. Waits and retries politely if the server says to slow down."""
        c = _content(content)
        text = c.get("text") or ""
        if utf16_len(text) > MAX_TEXT:
            self._log(f"A message had {utf16_len(text)} characters; only the first {MAX_TEXT} were sent.")
        body = _clean({
            "channelId": channel_id, "text": cut(text, MAX_TEXT), "replyTo": c.get("replyTo", reply_to),
            "attachments": c.get("attachments", attachments), "cards": c.get("cards", cards),
            "components": c.get("components", components),
        })
        answer = await self._retrying(lambda: self.request("chat.send", body))
        return answer["message"]  # type: ignore[no-any-return]

    async def edit(self, message_id: int, content: Content) -> Message:
        """Changes one of the bot's own messages: new text, or ``{"text"?, "cards"?, "components"?}`` (these replace the
        old ones; ``[]`` removes them)."""
        c = _content(content)
        text = c.get("text")
        body = _clean({"id": message_id, "text": cut(text, MAX_TEXT) if isinstance(text, str) else None,
                       "cards": c.get("cards"), "components": c.get("components")})
        return (await self.request("chat.edit", body))["message"]  # type: ignore[no-any-return]

    async def delete(self, message_id: int) -> None:
        """Deletes a message: the bot's own, or someone else's if its role allows."""
        await self.request("chat.delete", {"id": message_id})

    async def react(self, message_id: int, emoji: str, on: bool = True) -> None:
        """Adds a reaction, or takes it away with ``on=False``."""
        await self._retrying(lambda: self.request("chat.react", {"id": message_id, "emoji": emoji, "on": on}))

    async def upload(self, name: str, data: bytes | str) -> FileInfo:
        """Uploads a file (up to the server's upload limit), ready for ``send(..., attachments=[file["id"]])``."""
        raw = data.encode("utf-8") if isinstance(data, str) else bytes(data)
        if not raw:
            raise ValueError(f'"{name}" is empty; files need at least 1 byte.')
        ticket = await self._retrying(lambda: self.request("upload.begin", {"name": name, "size": len(raw)}))
        target = self._server_url + ticket["url"]
        part_bytes = int(ticket.get("partBytes") or len(raw))
        offset = 0
        while True:
            part = raw[offset : offset + part_bytes]
            whole = offset == 0 and len(part) == len(raw)
            answer = await asyncio.to_thread(_put, target if whole else f"{target}?offset={offset}", part, name)
            if answer.get("file"):
                return answer["file"]  # type: ignore[no-any-return]
            offset = int(answer.get("received", offset + len(part)))

    async def send_file(self, channel_id: int, name: str, data: bytes | str, *, text: str = "", reply_to: int | None = None) -> Message:
        """Uploads a file and posts it, with optional text."""
        uploaded = await self.upload(name, data)
        return await self.send(channel_id, text, reply_to=reply_to, attachments=[uploaded["id"]])

    async def poll(self, channel_id: int, question: str, answers: list[str], *, multi: bool = False,
                   duration_ms: int | None = None) -> Message:
        """Starts a poll (2-10 answers of 1-55 characters). Votes arrive as ``poll_updated``."""
        body = _clean({"channelId": channel_id, "question": question, "options": answers, "multi": multi or None, "durationMs": duration_ms})
        return (await self._retrying(lambda: self.request("poll.create", body)))["message"]  # type: ignore[no-any-return]

    async def thread(self, message_id: int, name: str) -> dict[str, Any]:
        """Starts a thread from a message; post in it with ``send(thread["id"], ...)``."""
        return (await self.request("thread.create", {"messageId": message_id, "name": name}))["thread"]  # type: ignore[no-any-return]

    async def set_activity(self, name: str | None) -> None:
        """Shows an activity ("Playing …") under the bot's name; None clears it."""
        await self.request("activity.set", {"name": name})

    # ── direct messages ──────────────────────────────────────────────────────

    async def send_dm(self, account_key: str, content: Content) -> None:
        """Sends a direct message, end-to-end encrypted to the person's devices. DMs carry text: cards become text, and
        buttons and menus are left out. Waits and retries politely if rate limited."""
        c = _content(content)
        if c.get("components"):
            self._log("Buttons and menus don't work in DMs; sent the text only.")
        full = "\n\n".join(x for x in (c.get("text") or "", cards_as_text(c.get("cards"))) if x)
        if utf16_len(full) > MAX_TEXT:
            self._log(f"A DM had {utf16_len(full)} characters; only the first {MAX_TEXT} were sent.")
            full = cut(full, MAX_TEXT)
        if self._dm_keys is None:
            raise RequestError("disconnected", "The bot is not started.")
        envelope = await self._dm_keys.encrypt(account_key, {"text": full})
        await self._retrying(lambda: self.request("dm.send", {"accountKey": account_key, "envelope": envelope}))

    async def download_dm_file(self, file: DmFile) -> bytes:
        """The bytes of a file someone attached to a DM (decrypted and checked; anything tampered with raises)."""
        if self._dm_keys is None:
            raise RequestError("disconnected", "The bot is not started.")
        return await self._dm_keys.download(self._server_url, file)

    async def _publish_prekey(self) -> None:
        try:
            if self._dm_keys is not None:
                await self._dm_keys.publish_prekey()
        except RequestError as e:
            if e.code != "disconnected":
                self._log(f"Couldn't publish the DM key: {e.message}")

    async def _prekey_loop(self) -> None:
        while True:  # prekeys rotate weekly; check twice a day for bots that run for weeks
            await asyncio.sleep(12 * 3600)
            await self._publish_prekey()

    # ── helpers ──────────────────────────────────────────────────────────────

    def mention(self, account_key: str) -> str:
        """A mention token that shows as @Name and notifies that member."""
        return f"<@{account_key}>"

    def channel_by_name(self, name: str) -> Channel | None:
        return next((c for c in self.channels if c["name"] == name), None)

    def file_url(self, file: FileInfo | str) -> str:
        """The full address of a file on the server (an attachment's ``url``)."""
        path = file if isinstance(file, str) else file["url"]
        return path if re.match(r"^https?://", path, re.I) else self._server_url + path

    async def _retrying(self, run: Callable[[], Awaitable[dict[str, Any]]]) -> dict[str, Any]:
        """Runs a request again (up to 4 more times, waiting longer each time) while the server answers ``rate_limited``."""
        attempt = 0
        while True:
            try:
                return await run()
            except RequestError as e:
                if e.code != "rate_limited" or attempt >= SEND_RETRIES:
                    raise
                await asyncio.sleep(0.6 * 2**attempt)
                attempt += 1

    def _log(self, line: str) -> None:
        text = f"[{self.name}] {line}"
        if self._log_line:
            self._log_line(text)
        else:
            print(text, flush=True)

    def _spawn(self, coro: Awaitable[Any]) -> None:
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def _emit(self, event: str, *args: Any) -> None:
        for listener in list(self._listeners[event]):
            self._spawn(self._run(f"The {event} listener", listener, *args))

    async def _run(self, what: str, handler: Handler, *args: Any) -> None:
        """Runs a handler (plain or async); one that raises is logged and doesn't stop the bot."""
        try:
            result = handler(*args)
            if inspect.isawaitable(result):
                await result
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            code = f" ({e.code})" if isinstance(e, RequestError) else ""
            self._log(f"{what} failed{code}: {e}")

    # ── events ───────────────────────────────────────────────────────────────

    def _handle_event(self, type: str, body: dict[str, Any]) -> None:
        for listener in list(self._listeners["event"]):
            self._spawn(self._run("The event listener", listener, type, body))
        if type == "chat.message":
            self._spawn(self._handle_message(body["message"]))
        elif type == "interaction":
            self._spawn(self._handle_interaction(body))
        elif type == "dm.message":
            self._spawn(self._handle_dm(body["message"]))
        elif type == "device.revoked":
            if self._dm_keys:
                self._dm_keys.forget_bundles()
        elif type == "chat.edited":
            self._emit("message_edited", body["message"])
        elif type == "chat.deleted":
            self._emit("message_deleted", body)
        elif type == "chat.reactions":
            self._emit("reactions", body)
        elif type == "poll.updated":
            self._emit("poll_updated", body)
        elif type == "channels":
            self.channels = list(body.get("channels") or [])
        elif type in ("member.joined", "member.updated"):
            member = body["member"]
            self.members[member["accountKey"]] = member
            if self.me and member["accountKey"] == self.me["accountKey"]:
                self.me = member
            if type == "member.joined":
                self._emit("member_joined", member)
        elif type == "member.removed":
            self.members.pop(body.get("accountKey", ""), None)
        elif type == "kicked":
            self._log(f"Removed from the server: {body.get('reason', '')}")

    def _target_is_me(self, command: Command) -> bool:
        # "/roll@Dice" is only for the bot called Dice (spaces in its name may be left out).
        return command.target is None or command.target.lower() == re.sub(r"\s+", "", self.name).lower()

    async def _handle_message(self, message: Message) -> None:
        if self.me and message["author"] == self.me["accountKey"]:
            return
        # End-to-end encrypted channels: only people's devices hold the keys, so a bot has nothing to read there.
        if message.get("e2ee"):
            return
        author = self.members.get(message["author"])
        if not self.hear_bots and (message.get("webhook") or (author or {}).get("bot")):
            return
        webhook = message.get("webhook") or {}
        incoming = IncomingMessage(message, webhook.get("name") or (author or {}).get("name") or "someone",
                                   next((c for c in self.channels if c["id"] == message["channelId"]), None), self)
        self._emit("message", incoming)

        command = parse_command(message["text"])
        if command is None or not self._target_is_me(command):
            return
        entry = self._registry.get(command.name)
        if entry is None:
            return

        async def reply(content: Content, private: bool) -> Message | None:
            # Typed as text (an older app, or a bot that reads everything): answers are always messages.
            return await incoming.reply(content)

        async def no_modal(_: Modal) -> None:
            raise RuntimeError("Forms only work for commands sent from the app, not typed as text.")

        ctx = CommandContext(self, message["author"], incoming.author_name, message["channelId"], False, None, reply,
                             _nothing, no_modal, command=command, args=command.args, options={}, message=incoming)
        await self._run(f"/{command.name}", entry.handler, ctx)

    async def _handle_dm(self, wire: dict[str, Any]) -> None:
        if self._dm_keys is None or self.me is None or wire.get("from") == self.me["accountKey"]:
            return  # its own messages, echoed back
        author = self.members.get(wire.get("from", ""))
        if (author or {}).get("bot"):
            return
        try:
            opened = self._dm_keys.open(wire)
        except DmError as e:
            self._log(f"Couldn't read a DM from {(author or {}).get('name', 'someone')}: {e}")
            return
        if not opened["text"] and not opened["files"]:
            return  # a call invite or friend request: nothing for a bot
        sender = opened["from"]
        dm = IncomingDm(opened["id"], sender, (author or {}).get("name", "someone"), opened["text"], opened["sentAt"], opened["files"], self)
        self._emit("dm", dm)

        command = parse_command(dm.text)
        if command is None or not self._target_is_me(command):
            return
        entry = self._registry.get(command.name)
        if entry is None:
            return
        spec = entry.spec
        usage = f"/{command.name}" + (f" {spec['usage']}" if spec.get("usage") else "".join(
            f" <{o['name']}>" if o.get("required") else f" [{o['name']}]" for o in spec.get("options") or []))
        # The server isn't involved in DMs, so the bot checks who may use the command itself.
        if not may_use(spec, author):
            text = f"`/{command.name}` only works in a channel." if spec.get("permission") else f"You can't use `/{command.name}`."
            await self._quietly(dm.reply(text))
            return
        options, bad, reason = parse_options(spec, command.args, self.members.values(), self.channels)
        if bad:
            what = "is missing" if reason == "missing" else "isn't right"
            await self._quietly(dm.reply(f"`{bad}` {what}. Try `{usage}`"))
            return

        async def reply(content: Content, private: bool) -> Message | None:
            c = _content(content)
            c.pop("components", None)  # buttons and menus need a channel message to sit on
            await dm.reply(c)
            return None

        async def no_modal(_: Modal) -> None:
            raise RuntimeError("Forms don't work in DMs.")

        ctx = CommandContext(self, sender, dm.author_name, 0, True, None, reply, _nothing, no_modal,
                             command=command, args=command.args, options=options)
        await self._run(f"/{command.name} (DM)", entry.handler, ctx)

    async def _quietly(self, awaitable: Awaitable[Any]) -> None:
        try:
            await awaitable
        except Exception:  # noqa: BLE001
            pass

    # ── interactions ─────────────────────────────────────────────────────────

    async def _respond(self, interaction_id: str, body: dict[str, Any]) -> dict[str, Any]:
        """Answers an interaction, waiting and retrying politely when rate limited."""
        if isinstance(body.get("text"), str):
            body["text"] = cut(body["text"], MAX_TEXT)
        return await self._retrying(lambda: self.request("interaction.respond", {"id": interaction_id, **_clean(body)}))

    async def _handle_interaction(self, i: dict[str, Any]) -> None:
        iid = i["id"]

        async def reply(content: Content, private: bool) -> Message | None:
            c = _content(content)
            answer = await self._respond(iid, {"text": c.get("text"), "cards": c.get("cards"), "components": c.get("components"),
                                               "private": True if (private or i.get("private")) else None})
            return answer.get("message")  # type: ignore[return-value]

        async def defer() -> None:
            await self._respond(iid, {"type": "defer"})

        async def show_modal(modal: Modal) -> None:
            await self._respond(iid, {"type": "modal", "modal": modal})

        member = self.members.get(i.get("user", ""))
        base = dict(bot=self, user=i["user"], user_name=(member or {}).get("name", "someone"), channel_id=i["channelId"],
                    dm=False, interaction=i, _reply=reply, _defer=defer, _show_modal=show_modal)

        def matches(match: str | re.Pattern[str], value: str) -> bool:
            return match == value if isinstance(match, str) else bool(match.search(value))

        kind = i.get("kind")
        if kind == "command" and i.get("command"):
            name = i["command"]
            entry = self._registry.get(name)
            if entry is None:
                return
            args = i.get("args") or ""
            ctx = CommandContext(**base, command=Command(name, None, args), args=args, options=dict(i.get("options") or {}))
            await self._run(f"/{name}", entry.handler, ctx)
        elif kind == "component" and i.get("customId"):
            custom_id = i["customId"]
            found = next((h for m, h in self._components if matches(m, custom_id)), None)
            if found is None:
                self._log(f'Nothing answers the button "{custom_id}" (bot.on_component).')
                return

            async def update(content: Content) -> None:
                c = _content(content)
                await self._respond(iid, {"type": "update", "text": c.get("text"), "cards": c.get("cards"), "components": c.get("components")})
            cctx = ComponentContext(**base, custom_id=custom_id, values=list(i.get("values") or []), message_id=i.get("messageId"),
                                    response_id=i.get("responseId"), _update=update)
            await self._run(f"Button {custom_id}", found, cctx)
        elif kind == "modal" and i.get("customId"):
            custom_id = i["customId"]
            found = next((h for m, h in self._modals if matches(m, custom_id)), None)
            if found is None:
                self._log(f'Nothing answers the form "{custom_id}" (bot.on_modal_submit).')
                return
            await self._run(f"Form {custom_id}", found, ModalContext(**base, custom_id=custom_id, fields=dict(i.get("fields") or {})))


async def _nothing() -> None:
    return None


def _put(url: str, data: bytes, name: str) -> dict[str, Any]:
    request = urllib.request.Request(url, data=data, method="PUT", headers={"Content-Type": "application/octet-stream"})
    try:
        with urllib.request.urlopen(request, timeout=300) as response:  # noqa: S310 - the server's own http(s) address
            return json.loads(response.read().decode("utf-8"))  # type: ignore[no-any-return]
    except urllib.error.HTTPError as e:
        raise RuntimeError(f'Uploading "{name}" failed: HTTP {e.code} {e.read()[:200].decode("utf-8", "replace")}') from None


__all__ = [
    "Bot", "IncomingMessage", "IncomingDm", "AnswerContext", "CommandContext", "ComponentContext", "ModalContext", "rejection_help",
]
