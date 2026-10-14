"""The desktop app's icons, from the same bolt as the phone apps (scripts/bolt.py, from client/public/favicon.svg).

Run from anywhere: python desktop/scripts/icons.py   (needs Pillow)
- icon.ico (Windows: exe, window, taskbar, Alt+Tab; 16-256 px) and icon.png (Linux, 512 px): the phone app's icon,
  the bolt on the dark background with a glow, as a rounded square. Small sizes get a bigger bolt so it stays readable.
- icon.icns (macOS): the same picture on Apple's icon grid (an 824 px rounded square on a 1024 px canvas, with a shadow).
- Tray: the bolt alone, which reads better at 16 px than the tile: tray.ico (Windows), tray.png (Linux),
  trayTemplate.png and @2x (macOS menu bar: black on transparent, macOS tints it).
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from bolt import background, render_bolt  # noqa: E402

ASSETS = ROOT / "desktop" / "assets"
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
TRAY_SIZES = [16, 20, 24, 32, 40, 48, 64]  # 100% to 400% display scaling


def rounded_mask(size: int, box: tuple[int, int, int, int], radius: float) -> Image.Image:
    ss = 4
    mask = Image.new("L", (size * ss, size * ss), 0)
    ImageDraw.Draw(mask).rounded_rectangle([v * ss for v in box], radius=radius * ss, fill=255)
    return mask.resize((size, size), Image.LANCZOS)


def place(canvas: Image.Image, bolt: Image.Image, cx: float, cy: float) -> None:
    canvas.alpha_composite(bolt, (round(cx - bolt.width / 2), round(cy - bolt.height / 2)))


def tile(size: int) -> Image.Image:
    """Windows and Linux: the rounded square fills the icon (a hair of margin from 64 px up)."""
    margin = size // 64
    inner = size - 2 * margin
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(background(inner).convert("RGBA"), (margin, margin))
    canvas.putalpha(rounded_mask(size, (margin, margin, size - margin - 1, size - margin - 1), inner * 0.22))
    place(canvas, render_bolt(round(inner * (0.7 if size <= 32 else 0.58))), size / 2, size / 2)
    return canvas


def mac_icon() -> Image.Image:
    """Apple's grid: an 824 px squircle-ish tile, centred on 1024 px, with a soft drop shadow."""
    size, inner = 1024, 824
    start = (size - inner) // 2
    box = (start, start, start + inner - 1, start + inner - 1)
    radius = inner * 0.2237
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shadow.putalpha(rounded_mask(size, box, radius).point(lambda a: a * 0.3).filter(ImageFilter.GaussianBlur(14)))
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(shadow, (0, 10))
    face = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    face.paste(background(inner).convert("RGBA"), (start, start))
    face.putalpha(rounded_mask(size, box, radius))
    canvas.alpha_composite(face)
    place(canvas, render_bolt(round(inner * 0.566)), size / 2, size / 2)
    return canvas


def tray(size: int, color: tuple[int, int, int] | None = None) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    place(canvas, render_bolt(size, color), size / 2, size / 2)
    return canvas


def save_ico(path: Path, images: list[Image.Image]) -> None:
    images[-1].save(path, format="ICO", sizes=[im.size for im in images], append_images=images[:-1])


def main() -> None:
    save_ico(ASSETS / "icon.ico", [tile(s) for s in ICO_SIZES])
    tile(512).save(ASSETS / "icon.png", optimize=True)
    mac_icon().save(ASSETS / "icon.icns")
    save_ico(ASSETS / "tray.ico", [tray(s) for s in TRAY_SIZES])
    tray(32).save(ASSETS / "tray.png", optimize=True)
    tray(16, (0, 0, 0)).save(ASSETS / "trayTemplate.png", optimize=True)
    tray(32, (0, 0, 0)).save(ASSETS / "trayTemplate@2x.png", optimize=True)
    print("Icons written to", ASSETS)


if __name__ == "__main__":
    main()
