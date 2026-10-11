"""App icon and launch image for the phone app, from the bolt in desktop/assets/icon.png.

Run from anywhere: python mobile/scripts/icons.py   (needs Pillow)
- iOS app icon: one opaque 1024x1024 image (Xcode makes the other sizes; App Store rejects icons with alpha).
  Same look as the web app's icons: the bolt on the dark background with a soft glow.
- Launch image: the bolt in the middle of the app's background colour, 2732x2732 (aspect-filled on every screen).
"""
import math
from pathlib import Path

from PIL import Image

BACKGROUND = (0x0B, 0x0B, 0x14)
GLOW = (38, 34, 76)
ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "desktop" / "assets" / "icon.png"
ASSETS = ROOT / "mobile" / "ios" / "App" / "App" / "Assets.xcassets"


def bolt_only(icon: Image.Image) -> Image.Image:
    """The desktop icon is the bolt on a white tile: keep the coloured pixels (saturation), drop the white."""
    out = Image.new("RGBA", icon.size)
    src, dst = icon.load(), out.load()
    for y in range(icon.height):
        for x in range(icon.width):
            r, g, b, a = src[x, y]
            saturation = (max(r, g, b) - min(r, g, b)) / 255
            dst[x, y] = (r, g, b, round(a * min(1.0, saturation / 0.55)))
    return out.crop(out.getbbox())


def glow_background(size: int, glow: bool) -> Image.Image:
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


def compose(bolt: Image.Image, size: int, height: int, glow: bool) -> Image.Image:
    canvas = glow_background(size, glow)
    width = round(bolt.width * height / bolt.height)
    mark = bolt.resize((width, height), Image.LANCZOS)
    canvas.paste(mark, ((size - width) // 2, (size - height) // 2), mark)
    return canvas


def main() -> None:
    bolt = bolt_only(Image.open(SOURCE).convert("RGBA"))
    compose(bolt, 1024, 580, glow=True).save(ASSETS / "AppIcon.appiconset" / "AppIcon-512@2x.png", optimize=True)
    splash = compose(bolt, 2732, 300, glow=False)
    for name in ("splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"):
        splash.save(ASSETS / "Splash.imageset" / name, optimize=True)
    print("Icons written to", ASSETS)


if __name__ == "__main__":
    main()
