"""App icon and launch image for the phone app, from the bolt in desktop/assets/icon.png.

Run from anywhere: python mobile/scripts/icons.py   (needs Pillow)
- iOS app icon: one opaque 1024x1024 image (Xcode makes the other sizes; App Store rejects icons with alpha).
  Same look as the web app's icons: the bolt on the dark background with a soft glow.
- Launch image: the bolt in the middle of the app's background colour, 2732x2732 (aspect-filled on every screen).
- Android: launcher icons (legacy square and round, and the adaptive icon's foreground on the dark background colour),
  the launch screen, and the white status bar icon for notifications.
"""
import math
from pathlib import Path

from PIL import Image, ImageDraw

BACKGROUND = (0x0B, 0x0B, 0x14)
GLOW = (38, 34, 76)
ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "desktop" / "assets" / "icon.png"
ASSETS = ROOT / "mobile" / "ios" / "App" / "App" / "Assets.xcassets"
RES = ROOT / "mobile" / "android" / "app" / "src" / "main" / "res"
DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}


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


def round_mask(image: Image.Image) -> Image.Image:
    size = image.width
    mask = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
    out = image.convert("RGBA")
    out.putalpha(mask.resize((size, size), Image.LANCZOS))
    return out


def white_silhouette(bolt: Image.Image, size: int, height: int) -> Image.Image:
    """Notification icons are white shapes on transparent; Android tints them."""
    width = round(bolt.width * height / bolt.height)
    mark = bolt.resize((width, height), Image.LANCZOS)
    alpha = mark.getchannel("A")
    shape = Image.new("RGBA", mark.size, (255, 255, 255, 0))
    shape.putalpha(alpha)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(shape, ((size - width) // 2, (size - height) // 2), shape)
    return canvas


def android(bolt: Image.Image) -> None:
    for name, scale in DENSITIES.items():
        folder = RES / f"mipmap-{name}"
        legacy = compose(bolt, round(48 * scale), round(27 * scale), glow=True)
        legacy.save(folder / "ic_launcher.png", optimize=True)
        round_mask(legacy).save(folder / "ic_launcher_round.png", optimize=True)
        # Adaptive icon: 108 dp layers, the launcher shows the middle 72 dp (bolt kept inside the 66 dp safe zone).
        size = round(108 * scale)
        width = round(bolt.width * 44 * scale / bolt.height)
        foreground = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        mark = bolt.resize((width, round(44 * scale)), Image.LANCZOS)
        foreground.paste(mark, ((size - width) // 2, (size - mark.height) // 2), mark)
        foreground.save(folder / "ic_launcher_foreground.png", optimize=True)
        white_silhouette(bolt, round(24 * scale), round(20 * scale)).save(RES / f"drawable-{name}" / "ic_notification.png", optimize=True)
    # Launch screen (drawable/splash.png and Capacitor's per-orientation copies).
    for folder in RES.glob("drawable*"):
        target = folder / "splash.png"
        if target.exists():
            w, h = Image.open(target).size
            canvas = Image.new("RGB", (w, h), BACKGROUND)
            height = round(min(w, h) * 0.18)
            width = round(bolt.width * height / bolt.height)
            mark = bolt.resize((width, height), Image.LANCZOS)
            canvas.paste(mark, ((w - width) // 2, (h - height) // 2), mark)
            canvas.save(target, optimize=True)
    print("Icons written to", RES)


def main() -> None:
    bolt = bolt_only(Image.open(SOURCE).convert("RGBA"))
    compose(bolt, 1024, 580, glow=True).save(ASSETS / "AppIcon.appiconset" / "AppIcon-512@2x.png", optimize=True)
    splash = compose(bolt, 2732, 300, glow=False)
    for name in ("splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"):
        splash.save(ASSETS / "Splash.imageset" / name, optimize=True)
    print("Icons written to", ASSETS)
    if RES.exists():
        for name in DENSITIES:
            (RES / f"drawable-{name}").mkdir(exist_ok=True)
        android(bolt)


if __name__ == "__main__":
    main()
