"""Errors the server answers with (PROTOCOL.md "Errors and close codes")."""
from __future__ import annotations

from typing import Any


class RequestError(Exception):
    """A request the server answered with an error, or that couldn't be sent.

    ``code`` is one of the protocol's codes (``forbidden``, ``not_found``, ``rate_limited``, ``bad_request``, ...) or
    ``disconnected`` / ``timeout``. ``key`` and ``args`` name the message when the server gives them.
    """

    def __init__(self, code: str, message: str, request_type: str | None = None, key: str | None = None,
                 args: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.request_type = request_type
        self.key = key
        self.args_ = args or {}

    def __repr__(self) -> str:
        return f"RequestError({self.code!r}, {self.message!r})"


class Rejected(Exception):
    """The server turned the bot away (no invite, banned, removed...). ``code`` is the protocol's code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
