"""Text lengths as the server and the app count them: UTF-16 code units (JavaScript's ``string.length``)."""
from __future__ import annotations


def utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def cut(text: str, limit: int) -> str:
    """The longest start of ``text`` that is at most ``limit`` UTF-16 units, never splitting a character."""
    if utf16_len(text) <= limit:
        return text
    units = 0
    for i, ch in enumerate(text):
        units += 2 if ord(ch) > 0xFFFF else 1
        if units > limit:
            return text[:i]
    return text
