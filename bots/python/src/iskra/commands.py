"""The bot command convention (docs/bots.md): ``/name args``, or ``/name@BotName args`` to pick one bot; and reading a
command's typed options from text (for commands typed in DMs). Mirrors client/src/core/commands.ts and
client/src/ui/chat/commandInvoke.ts."""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Union

OptionValue = Union[str, int, float, bool]

ROLES = ("guest", "member", "trusted", "admin", "owner")

_COMMAND = re.compile(r"^/([A-Za-z0-9][A-Za-z0-9_-]{0,31})(?:@(\S{1,32}))?(?:\s+(.*))?$", re.DOTALL)
_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
_TRUE = {"true", "yes", "y", "on", "1", "ja"}
_FALSE = {"false", "no", "n", "off", "0", "nej"}


@dataclass(frozen=True)
class Command:
    #: Lower-cased command name, without the slash.
    name: str
    #: The bot named after "@", if any.
    target: str | None
    #: Everything after the name, trimmed.
    args: str


def parse_command(text: str) -> Command | None:
    match = _COMMAND.match(text.strip())
    if not match:
        return None
    return Command(match.group(1).lower(), match.group(2), (match.group(3) or "").strip())


def valid_command_name(name: str) -> bool:
    return bool(_NAME.match(name))


def role_rank(role: str | None) -> int:
    return ROLES.index(role) if role in ROLES else -1


def may_use(command: Mapping[str, Any], member: Mapping[str, Any] | None) -> bool:
    """Whether this member may use the command, as far as a bot can tell in a DM (no permissions there)."""
    if not member:
        return False
    if command.get("role") and role_rank(member.get("role")) < role_rank(command["role"]):
        return False
    if command.get("permission") and role_rank(member.get("role")) < role_rank("admin"):
        return False
    return True


def parse_options(command: Mapping[str, Any], args: str, members: Iterable[Mapping[str, Any]] = (),
                  channels: Iterable[Mapping[str, Any]] = ()) -> tuple[dict[str, OptionValue], str | None, str | None]:
    """One word per option, in order; the last string option takes the rest of the text.

    Returns ``(options, None, None)``, or ``({}, option_name, "missing" | "invalid")``.
    """
    declared = list(command.get("options") or [])
    words = args.split()
    members, channels = list(members), list(channels)
    options: dict[str, OptionValue] = {}
    for i, option in enumerate(declared):
        last = i == len(declared) - 1
        word = " ".join(words[i:]) if last and option["type"] == "string" else (words[i] if i < len(words) else "")
        if word == "":
            if option.get("required"):
                return {}, option["name"], "missing"
            continue
        value = _parse_value(option, word, members, channels)
        if value is None:
            return {}, option["name"], "invalid"
        options[option["name"]] = value
    return options, None, None


def _parse_value(option: Mapping[str, Any], word: str, members: list[Mapping[str, Any]],
                 channels: list[Mapping[str, Any]]) -> OptionValue | None:
    kind = option["type"]
    value: OptionValue | None = None
    if kind == "string":
        value = word if len(word) <= 1000 else None
    elif kind == "integer":
        if re.fullmatch(r"[+-]?[0-9]+", word):
            n = int(word)
            value = n if abs(n) <= 2**53 - 1 else None
    elif kind == "number":
        w = word.replace(",", ".", 1)
        if re.fullmatch(r"[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?", w):
            f = float(w)
            value = (int(f) if f.is_integer() and abs(f) <= 2**53 else f) if math.isfinite(f) else None
    elif kind == "boolean":
        value = True if word.lower() in _TRUE else False if word.lower() in _FALSE else None
    elif kind == "user":
        token = re.fullmatch(r"<@([A-Za-z0-9_-]{43})>", word)
        name = word.removeprefix("@").lower()
        if token and any(m.get("accountKey") == token.group(1) for m in members):
            value = token.group(1)
        else:
            value = next((m["accountKey"] for m in members if str(m.get("name", "")).lower() == name), None)
    elif kind == "channel":
        name = word.removeprefix("#").lower()
        value = next((c["id"] for c in channels if str(c.get("id")) == word or str(c.get("name", "")).lower() == name), None)
    elif kind == "role":
        value = None  # bots don't see the role list in DMs
    if value is None or not option.get("choices"):
        return value
    for choice in option["choices"]:
        if choice["value"] == value or str(choice["value"]).lower() == word.lower() or str(choice["name"]).lower() == word.lower():
            return choice["value"]  # type: ignore[no-any-return]
    return None
