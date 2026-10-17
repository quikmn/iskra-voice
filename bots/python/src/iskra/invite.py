"""Invite links: ``<appUrl>/#/join/<b64u(serverUrl)>.<serverKey>.<code>[.<p2p>]`` (PROTOCOL.md "Invite links")."""
from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import urlsplit

from .crypto import from_b64u

_B64U = re.compile(r"^[A-Za-z0-9_-]+$")
_KEY43 = re.compile(r"^[A-Za-z0-9_-]{43}$")


@dataclass(frozen=True)
class InviteLink:
    server_url: str
    server_key: str
    code: str
    #: The server's p2p secret (the desktop app's tunnel); bots don't use it.
    p2p: str | None = None


def normalize_server_url(raw: str) -> str | None:
    """Only http(s) servers, normalized without a trailing slash (like the app's ``new URL`` handling)."""
    try:
        url = urlsplit(raw.strip())
        if url.scheme.lower() not in ("http", "https") or not url.hostname:
            return None
        if url.username or url.password or url.query or url.fragment or "@" in url.netloc:
            return None
        scheme = url.scheme.lower()
        host = url.hostname.lower()
        if ":" in host:  # IPv6
            host = f"[{host}]"
        port = url.port
        default = 80 if scheme == "http" else 443
        origin = f"{scheme}://{host}" + (f":{port}" if port is not None and port != default else "")
        return origin + url.path.rstrip("/")
    except ValueError:
        return None


def parse_invite(text: str) -> InviteLink | None:
    """Accepts a full link, a ``#/join/...`` hash, or just the ``<a>.<b>.<c>[.<d>]`` token."""
    text = text.strip()
    token = text[text.rfind("/join/") + 6 :] if "/join/" in text else text
    parts = token.split(".")
    if len(parts) not in (3, 4) or not all(_B64U.match(p) for p in parts):
        return None
    url_part, server_key, code = parts[0], parts[1], parts[2]
    p2p = parts[3] if len(parts) == 4 else None
    if not _KEY43.match(server_key) or len(code) < 8 or len(code) > 64:
        return None
    if p2p is not None and not _KEY43.match(p2p):
        return None
    try:
        server_url = normalize_server_url(from_b64u(url_part).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    if not server_url:
        return None
    return InviteLink(server_url, server_key, code, p2p)


def socket_url(server_url: str) -> str:
    """ws(s)://host/ws for an http(s) server URL."""
    return re.sub(r"^http", "ws", server_url) + "/ws"
