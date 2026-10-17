"""Tests for commands.py: python -m pytest. Add one for each rule you write."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from commands import greeting, hello_card, tally  # noqa: E402


def test_greeting_fits_the_time_of_day() -> None:
    assert greeting("Ann", 8) == "Good morning, Ann!"
    assert greeting("Ann", 13) == "Good afternoon, Ann!"
    assert greeting("Ann", 21) == "Good evening, Ann!"
    assert greeting("Ann", 2) == "Good night, Ann!"


def test_card_has_a_button_the_bot_answers() -> None:
    assert hello_card("Ann")["components"][0]["items"][0]["customId"] == "starter:wave"


def test_tally_counts_words_most_first() -> None:
    assert tally("apples, Pears, apples") == "apples ×2, pears ×1"
    assert tally(" , ") is None
