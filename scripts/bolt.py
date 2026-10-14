"""The Iskra bolt, drawn from client/public/favicon.svg (its path and gradient): the one source of every app icon.

Used by mobile/scripts/icons.py (phone apps) and desktop/scripts/icons.py (desktop apps). Needs Pillow.
The web app's icons come from the same SVG (client/scripts/gen-icons.mjs).
"""
import math
import re
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SVG = ROOT / "client" / "public" / "favicon.svg"
BACKGROUND = (0x0B, 0x0B, 0x14)


def _svg() -> tuple[list[tuple[float, float]], tuple[float, float, float, float], list[tuple[int, int, int]]]:
    text = SVG.read_text(encoding="utf8")
    d = re.search(r'<path[^>]*\sd="([^"]+)"', text).group(1)
    tokens = re.findall(r"[MLHVZmlhvz]|-?\d*\.?\d+", d)
    points, x, y, cmd, i = [], 0.0, 0.0, "", 0
    while i < len(tokens):
        if tokens[i].isalpha():
            cmd = tokens[i]
            i += 1
            if cmd in "Zz":
                continue
        if cmd in "ML":
            x, y = float(tokens[i]), float(tokens[i + 1]); i += 2
        elif cmd in "ml":
            x, y = x + float(tokens[i]), y + float(tokens[i + 1]); i += 2
        elif cmd == "H":
            x = float(tokens[i]); i += 1
        elif cmd == "h":
            x += float(tokens[i]); i += 1
        elif cmd == "V":
            y = float(tokens[i]); i += 1
        elif cmd == "v":
            y += float(tokens[i]); i += 1
        else:
            raise ValueError(f"unsupported path command {cmd!r} in {SVG}")
        points.append((x, y))
    g = re.search(r'<linearGradient[^>]*x1="([\d.]+)"[^>]*y1="([\d.]+)"[^>]*x2="([\d.]+)"[^>]*y2="([\d.]+)"', text)
    stops = [tuple(int(h[k:k + 2], 16) for k in (0, 2, 4)) for h in re.findall(r'stop-color="#([0-9a-fA-F]{6})"', text)]
    return points, tuple(float(v) for v in g.groups()), stops


def render_bolt(height: int, color: tuple[int, int, int] | None = None) -> Image.Image:
    """The bolt alone, `height` pixels tall, cropped to its shape, on transparent. `color` = one flat colour."""
    points, (x1, y1, x2, y2), stops = _svg()
    min_x, max_x = min(p[0] for p in points), max(p[0] for p in points)
    min_y, max_y = min(p[1] for p in points), max(p[1] for p in points)
    scale = height / (max_y - min_y)
    width = max(1, round((max_x - min_x) * scale))
    ss = max(2, min(8, 2048 // height))  # supersampling, so small sizes stay crisp
    big = (width * ss, height * ss)
    mask = Image.new("L", big, 0)
    ImageDraw.Draw(mask).polygon([((px - min_x) * scale * ss, (py - min_y) * scale * ss) for px, py in points], fill=255)
    mask = mask.resize((width, height), Image.LANCZOS)
    if color is not None:
        fill = Image.new("RGB", (width, height), color)
    else:
        # The SVG's linear gradient (userSpaceOnUse), sampled per pixel.
        fill = Image.new("RGB", (width, height))
        px = fill.load()
        dx, dy = x2 - x1, y2 - y1
        length = dx * dx + dy * dy
        a, b = stops[0], stops[-1]
        for j in range(height):
            for i in range(width):
                sx, sy = min_x + (i + 0.5) / scale, min_y + (j + 0.5) / scale
                t = min(1.0, max(0.0, ((sx - x1) * dx + (sy - y1) * dy) / length))
                px[i, j] = tuple(round(a[k] + (b[k] - a[k]) * t) for k in range(3))
    out = fill.convert("RGBA")
    out.putalpha(mask)
    return out


GLOW = (38, 34, 76)


def background(size: int, glow: bool = True) -> Image.Image:
    """The app's dark background, with a soft purple glow a little above the middle (as in the phone app icon)."""
    canvas = Image.new("RGB", (size, size), BACKGROUND)
    if not glow:
        return canvas
    px = canvas.load()
    cx, cy, radius = size * 0.5, size * 0.4, size * 0.7
    for y in range(size):
        for x in range(size):
            t = max(0.0, 1 - math.hypot(x - cx, y - cy) / radius) ** 1.5
            px[x, y] = tuple(round(BACKGROUND[i] + (GLOW[i] - BACKGROUND[i]) * t) for i in range(3))
    return canvas
