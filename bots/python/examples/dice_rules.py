"""The dice bot's rules, kept apart from the bot so they're easy to test (the same rules as bots/examples/dice-rules.ts)."""
from __future__ import annotations

import random as _random
import re
from dataclasses import dataclass
from typing import Callable

from iskra import Card, ComponentRow

_DICE = re.compile(r"^(\d{0,3})d(\d{1,4})([+-]\d{1,4})?$", re.IGNORECASE)


@dataclass
class Roll:
    count: int
    sides: int
    modifier: int
    rolls: list[int]
    total: int


def roll(spec: str, random: Callable[[], float] = _random.random) -> Roll | None:
    """"d20", "2d6", "3d8+2", "d100-5". None if it isn't dice notation (or is silly: at most 100 dice of 2-1000 sides)."""
    match = _DICE.match(spec.strip() or "d6")
    if not match:
        return None
    count = int(match.group(1)) if match.group(1) else 1
    sides = int(match.group(2))
    modifier = int(match.group(3)) if match.group(3) else 0
    if not 1 <= count <= 100 or not 2 <= sides <= 1000:
        return None
    rolls = [1 + int(random() * sides) for _ in range(count)]
    return Roll(count, sides, modifier, rolls, sum(rolls) + modifier)


def notation(r: Roll) -> str:
    """"2d6+1": what was rolled, as dice notation."""
    return f"{r.count}d{r.sides}" + (f"{r.modifier:+d}" if r.modifier else "")


def pick(options: str, random: Callable[[], float] = _random.random) -> str | None:
    """"pizza, tacos, sushi" or "pizza or tacos" → one of them."""
    items = [s.strip() for s in re.split(r",|\bor\b", options) if s.strip()]
    return items[int(random() * len(items))] if len(items) >= 2 else None


def roll_card(r: Roll) -> Card:
    """A roll as a card: the notation and total, every die in a field (up to 25 shown)."""
    shown = ", ".join(map(str, r.rolls[:25])) + (", …" if len(r.rolls) > 25 else "")
    color = 0x57F287 if all(x == r.sides for x in r.rolls) else 0xED4245 if all(x == 1 for x in r.rolls) else 0x695BFF
    fields = [{"name": "Die" if r.count == 1 else "Dice", "value": shown, "inline": True}]
    if r.modifier:
        fields.append({"name": "Modifier", "value": f"{r.modifier:+d}", "inline": True})
    return {"title": f"🎲 {notation(r)}", "description": f"**{r.total}**", "color": color, "fields": fields}  # type: ignore[typeddict-item]


def roll_again(r: Roll) -> list[ComponentRow]:
    """The "Roll again" button under a roll: its customId says what to roll ("roll:2d6")."""
    return [{"type": "row", "items": [{"type": "button", "customId": f"roll:{notation(r)}", "label": "Roll again", "style": "primary"}]}]
