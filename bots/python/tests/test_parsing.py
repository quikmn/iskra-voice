"""Commands, options, invite links and the state file."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from iskra.commands import may_use, parse_command, parse_options
from iskra.crypto import b64u
from iskra.invite import parse_invite, socket_url
from iskra.state import default_state_file, identity_of, load_state, new_state, save_state
from iskra.text import cut, utf16_len

KEY = "A" * 43


def test_commands_follow_the_convention() -> None:
    c = parse_command("  /Roll@Dice   2d6 + 1  ")
    assert c is not None and (c.name, c.target, c.args) == ("roll", "Dice", "2d6 + 1")
    c = parse_command("/echo hello\nthere")
    assert c is not None and c.args == "hello\nthere"
    assert parse_command("/coin") is not None and parse_command("/coin").args == ""  # type: ignore[union-attr]
    assert parse_command("hello /roll") is None
    assert parse_command("/") is None
    assert parse_command("/" + "a" * 33) is None


def test_options_are_read_like_the_app_reads_them() -> None:
    cmd = {"name": "x", "description": "d", "options": [
        {"name": "n", "description": "d", "type": "integer", "required": True},
        {"name": "f", "description": "d", "type": "number"},
        {"name": "b", "description": "d", "type": "boolean"},
        {"name": "who", "description": "d", "type": "user"},
        {"name": "rest", "description": "d", "type": "string"},
    ]}
    members = [{"accountKey": KEY, "name": "Viktor"}]
    assert parse_options(cmd, "3 2,5 ja @viktor hello there", members) == (
        {"n": 3, "f": 2.5, "b": True, "who": KEY, "rest": "hello there"}, None, None)
    assert parse_options(cmd, "", members) == ({}, "n", "missing")
    assert parse_options(cmd, "three", members) == ({}, "n", "invalid")
    assert parse_options(cmd, "1 1 maybe", members) == ({}, "b", "invalid")
    choices = {"name": "c", "description": "d", "options": [
        {"name": "size", "description": "d", "type": "string", "choices": [{"name": "Big", "value": "L"}]}]}
    assert parse_options(choices, "big")[0] == {"size": "L"}
    assert parse_options(choices, "huge")[1:] == ("size", "invalid")


def test_who_may_use_a_command() -> None:
    assert may_use({"name": "a"}, {"role": "guest"})
    assert not may_use({"name": "a", "role": "trusted"}, {"role": "member"})
    assert may_use({"name": "a", "role": "trusted"}, {"role": "admin"})
    assert not may_use({"name": "a", "permission": "kickMembers"}, {"role": "trusted"})
    assert not may_use({"name": "a"}, None)


def test_invite_links() -> None:
    url = b64u(b"https://chat.example.com/")
    link = parse_invite(f"https://app.iskra.foo/#/join/{url}.{KEY}.abcdefgh")
    assert link is not None and link.server_url == "https://chat.example.com" and link.server_key == KEY and link.code == "abcdefgh"
    assert parse_invite(f"{url}.{KEY}.abcdefgh.{KEY}").p2p == KEY  # type: ignore[union-attr]
    assert parse_invite(f"{b64u(b'http://localhost:47070')}.{KEY}.abcdefgh").server_url == "http://localhost:47070"  # type: ignore[union-attr]
    assert parse_invite(f"{b64u(b'https://x.example:443/')}.{KEY}.abcdefgh").server_url == "https://x.example"  # type: ignore[union-attr]
    for bad in (f"{b64u(b'ftp://x')}.{KEY}.abcdefgh", f"{url}.{KEY}.short", f"{url}.short.abcdefgh",
                f"{b64u(b'https://u:p@x')}.{KEY}.abcdefgh", f"{b64u(b'https://x/?q=1')}.{KEY}.abcdefgh", "nonsense"):
        assert parse_invite(bad) is None, bad
    assert socket_url("https://chat.example.com") == "wss://chat.example.com/ws"
    assert socket_url("http://localhost:5203") == "ws://localhost:5203/ws"


def test_state_file_matches_the_node_sdk(tmp_path: Path) -> None:
    assert default_state_file("My Dice!").name == "my-dice-.bot.json"
    # The Node SDK's file (bots/sdk/src/state.ts): the same seeds give the same account, so a bot can switch languages.
    node_file = tmp_path / "dice.bot.json"
    node_file.write_text(json.dumps({
        "v": 1, "accountSeed": "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE", "deviceSeed": "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI",
        "created": 1760000000000, "server": {"url": "http://localhost:5203", "key": KEY}, "extra": "kept",
    }, indent=2) + "\n")
    state = load_state(node_file)
    assert state is not None
    vectors = json.loads((Path(__file__).resolve().parents[3] / "protocol" / "vectors.json").read_text(encoding="utf-8"))["v1"]
    assert identity_of(state).cert == vectors["cert"]
    save_state(node_file, state)
    again = json.loads(node_file.read_text())
    assert again["extra"] == "kept" and again["server"]["key"] == KEY
    fresh = new_state()
    assert set(fresh) == {"v", "accountSeed", "deviceSeed", "created"} and len(fresh["accountSeed"]) == 43
    (tmp_path / "bad.json").write_text('{"v": 2}')
    with pytest.raises(ValueError):
        load_state(tmp_path / "bad.json")
    assert load_state(tmp_path / "missing.json") is None


def test_text_is_counted_like_the_app_counts_it() -> None:
    assert utf16_len("a😀") == 3
    assert cut("a😀b", 2) == "a"
    assert cut("abc", 5) == "abc"
