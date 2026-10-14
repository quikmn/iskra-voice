"""App icon and launch image for the phone app, from the bolt in client/public/favicon.svg (scripts/bolt.py).

Run from anywhere: python mobile/scripts/icons.py   (needs Pillow)
- iOS app icon: one opaque 1024x1024 image (Xcode makes the other sizes; App Store rejects icons with alpha).
  Same look as the web app's icons: the bolt on the dark background with a soft glow.
- Launch image: the bolt in the middle of the app's background colour, 2732x2732 (aspect-filled on every screen).
- Android: launcher icons (legacy square and round, and the adaptive icon's foreground on the dark background colour),
  the launch screen, and the white status bar icon for notifications.
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from bolt import BACKGROUND, background, render_bolt  # noqa: E402

ASSETS = ROOT / "mobile" / "ios" / "App" / "App" / "Assets.xcassets"
RES = ROOT / "mobile" / "android" / "app" / "src" / "main" / "res"
DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}


def compose(bolt: Image.Image, size: int, height: int, glow: bool) -> Image.Image:
    canvas = background(size, glow)
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
    bolt = render_bolt(2048)
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
