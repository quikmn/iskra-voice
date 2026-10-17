"""Your bot's logic, kept apart from the connection (bot.py) so tests can check it without a server. Put the rules of
your bot here as plain functions: they take what people typed and return what to answer."""
from __future__ import annotations

from collections import Counter


def greeting(name: str, hour: int) -> str:
    """'Good morning, Ann!' by the hour of the day (0-23)."""
    part = "Good night" if hour < 5 else "Good morning" if hour < 12 else "Good afternoon" if hour < 18 else "Good evening"
    return f"{part}, {name}!"


def hello_card(name: str) -> dict:
    """A card with a button; clicks come back to @bot.on_component("starter:wave")."""
    return {
        "cards": [{"title": "👋 Hello", "description": f"{name} says hi to everyone.", "color": 0x695BFF}],
        "components": [{"type": "row", "items": [{"type": "button", "customId": "starter:wave", "label": "Wave back", "style": "primary"}]}],
    }


def tally(text: str) -> str | None:
    """'/count apples, pears, apples' -> 'apples ×2, pears ×1'."""
    words = [w.strip().lower() for w in text.split(",") if w.strip()]
    if not words:
        return None
    counts = sorted(Counter(words).items(), key=lambda kv: (-kv[1], kv[0]))
    return ", ".join(f"{w} ×{n}" for w, n in counts)
