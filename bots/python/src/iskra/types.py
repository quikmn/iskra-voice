"""Wire objects as they arrive (JSON, camelCase keys). Source of truth: protocol/PROTOCOL.md.

These are ``TypedDict``s: plain dicts with types for editors and type checkers. Fields the server added later are
marked not required, and servers may send more than listed.
"""
from __future__ import annotations

from typing import Any, Literal, NotRequired, TypedDict, Union

Role = Literal["guest", "member", "trusted", "admin", "owner"]
OptionValue = Union[str, int, float, bool]


class Member(TypedDict):
    accountKey: str
    name: str
    role: Role
    online: bool
    bot: NotRequired[bool]
    readsMessages: NotRequired[bool | None]


class Channel(TypedDict):
    id: int
    name: str
    kind: Literal["text", "voice", "forum", "stage", "docs", "whiteboard"]
    position: int
    readRole: Role
    writeRole: Role
    createdAt: NotRequired[int]


class FileInfo(TypedDict):
    id: str
    name: str
    size: int
    type: str
    width: int | None
    height: int | None
    #: Relative to the server's address: ``bot.file_url(file)`` makes it whole.
    url: str


class CardField(TypedDict):
    name: str
    value: str
    inline: NotRequired[bool]


class Card(TypedDict, total=False):
    """A card on a bot's message: the webhook embed format plus pictures from this server or data: URLs."""

    title: str
    description: str
    url: str
    color: int
    timestamp: int
    author: dict[str, str]
    footer: dict[str, str]
    fields: list[CardField]
    thumbnail: dict[str, str]
    image: dict[str, str]


class ComponentButton(TypedDict):
    type: Literal["button"]
    label: str
    customId: NotRequired[str]
    style: NotRequired[Literal["primary", "secondary", "success", "danger", "link"]]
    url: NotRequired[str]
    disabled: NotRequired[bool]


class SelectOption(TypedDict):
    label: str
    value: str
    description: NotRequired[str]
    default: NotRequired[bool]


class ComponentSelect(TypedDict):
    type: Literal["select"]
    customId: str
    options: list[SelectOption]
    placeholder: NotRequired[str]
    minValues: NotRequired[int]
    maxValues: NotRequired[int]
    disabled: NotRequired[bool]


class ComponentRow(TypedDict):
    """Up to 5 rows; a row has 1-5 buttons or exactly one select menu."""

    type: Literal["row"]
    items: list[Union[ComponentButton, ComponentSelect]]


class ModalField(TypedDict):
    customId: str
    label: str
    style: NotRequired[Literal["short", "paragraph"]]
    required: NotRequired[bool]
    placeholder: NotRequired[str]
    maxLength: NotRequired[int]
    value: NotRequired[str]


class Modal(TypedDict):
    customId: str
    title: str
    fields: list[ModalField]


class PollOption(TypedDict):
    text: str
    votes: list[str]


class Poll(TypedDict):
    question: str
    options: list[PollOption]
    multi: bool
    expiresAt: int | None
    closedAt: int | None


class Thread(TypedDict):
    id: int
    channelId: int
    rootId: int
    name: str
    createdBy: str
    createdAt: int
    messageCount: int
    lastMessageAt: int | None


class Message(TypedDict):
    id: int
    channelId: int
    author: str
    text: str
    createdAt: int
    editedAt: int | None
    attachments: list[FileInfo]
    replyTo: dict[str, Any] | None
    reactions: NotRequired[list[dict[str, Any]]]
    webhook: NotRequired[dict[str, Any] | None]
    cards: NotRequired[list[Card] | None]
    components: NotRequired[list[ComponentRow] | None]
    poll: NotRequired[Poll | None]
    thread: NotRequired[Thread | None]
    e2ee: NotRequired[Any]


class CommandChoice(TypedDict):
    name: str
    value: Union[str, int, float]


class CommandOption(TypedDict):
    name: str
    description: str
    type: Literal["string", "integer", "number", "boolean", "user", "channel", "role"]
    required: NotRequired[bool]
    choices: NotRequired[list[CommandChoice]]


class BotCommand(TypedDict):
    name: str
    description: str
    usage: NotRequired[str]
    options: NotRequired[list[CommandOption]]
    role: NotRequired[Literal["member", "trusted", "admin"]]
    permission: NotRequired[str]


class Interaction(TypedDict):
    id: str
    kind: Literal["command", "component", "modal"]
    channelId: int
    user: str
    private: bool
    expiresAt: int
    command: NotRequired[str]
    options: NotRequired[dict[str, OptionValue]]
    args: NotRequired[str]
    messageId: NotRequired[int]
    responseId: NotRequired[str]
    customId: NotRequired[str]
    values: NotRequired[list[str]]
    fields: NotRequired[dict[str, str]]


class MessageContent(TypedDict, total=False):
    """What a message says: text, cards, buttons or menus, files, a reply."""

    text: str
    cards: list[Card]
    components: list[ComponentRow]
    attachments: list[str]
    replyTo: int
