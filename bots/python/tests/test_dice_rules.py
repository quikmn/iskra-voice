from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "examples"))

from dice_rules import notation, pick, roll, roll_again, roll_card  # noqa: E402


def test_rolls_dice_notation_within_limits() -> None:
    r = roll("2d6", lambda: 0.99)
    assert r is not None and (r.count, r.sides, r.rolls, r.total) == (2, 6, [6, 6], 12)
    r = roll("d20+3", lambda: 0)
    assert r is not None and (r.total, r.modifier) == (4, 3)
    assert roll("", lambda: 0).sides == 6  # type: ignore[union-attr]
    assert roll("101d6") is None and roll("2d1") is None and roll("hello") is None
    assert notation(roll("3d8-2", lambda: 0)) == "3d8-2"  # type: ignore[arg-type]


def test_cards_and_buttons() -> None:
    r = roll("2d6", lambda: 0.99)
    assert r is not None
    assert roll_card(r)["color"] == 0x57F287 and roll_card(r)["title"] == "🎲 2d6"
    assert roll_again(r)[0]["items"][0]["customId"] == "roll:2d6"  # type: ignore[typeddict-item]


def test_picks_one_of_several() -> None:
    assert pick("pizza, tacos, sushi", lambda: 0.5) == "tacos"
    assert pick("this or that", lambda: 0) == "this"
    assert pick("only one") is None
