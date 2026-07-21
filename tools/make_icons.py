#!/usr/bin/env python3
"""Build the Bibbs Zone Audit icon set from the master logo PNG.

The master logo is a square white-background mark: the "B road" emblem on
top and the words ZONE AUDIT underneath. Launcher icons use the emblem only
(text is unreadable at 192px); the full lockup ships as logo-full.png for
in-app use.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

SOURCE = Path("/storage/emulated/0/Pictures/file_0000000061f481f595c28b012c1f049b.png")
OUT = Path(__file__).resolve().parent.parent / "site" / "icons"
WHITE_CUTOFF = 245  # a pixel with every channel above this counts as background


def row_has_ink(image: Image.Image, y: int) -> bool:
    width = image.width
    row = image.crop((0, y, width, y + 1)).convert("RGB")
    extrema = row.getextrema()
    return any(low <= WHITE_CUTOFF for low, _ in extrema)


def column_bounds(image: Image.Image, top: int, bottom: int) -> tuple[int, int]:
    region = image.crop((0, top, image.width, bottom)).convert("RGB")
    grey = region.convert("L")
    mask = grey.point(lambda value: 255 if value <= WHITE_CUTOFF else 0)
    box = mask.getbbox()
    if not box:
        raise SystemExit("no ink found while measuring emblem columns")
    return box[0], box[2]


def emblem_box(image: Image.Image) -> tuple[int, int, int, int]:
    """Locate the emblem: ink rows from the top until the first tall white gap."""
    height = image.height
    ink_rows = [y for y in range(height) if row_has_ink(image, y)]
    if not ink_rows:
        raise SystemExit("logo appears blank")
    top = ink_rows[0]
    gap_needed = max(8, height // 40)
    run_start = None
    emblem_bottom = None
    previous = top
    for y in ink_rows[1:]:
        if y - previous > gap_needed:
            emblem_bottom = previous
            break
        previous = y
    if emblem_bottom is None:
        emblem_bottom = ink_rows[-1]
    left, right = column_bounds(image, top, emblem_bottom + 1)
    return left, top, right, emblem_bottom + 1


def squared(image: Image.Image, margin_ratio: float) -> Image.Image:
    side = max(image.width, image.height)
    side = int(side * (1 + margin_ratio * 2))
    canvas = Image.new("RGB", (side, side), "white")
    canvas.paste(image, ((side - image.width) // 2, (side - image.height) // 2))
    return canvas


def save(image: Image.Image, size: int, name: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    image.resize((size, size), Image.LANCZOS).save(OUT / name, "PNG", optimize=True)
    print(f"wrote {name} ({size}x{size})")


def main() -> int:
    logo = Image.open(SOURCE).convert("RGB")
    box = emblem_box(logo)
    emblem = logo.crop(box)
    print(f"emblem box: {box} of {logo.size}")

    plain = squared(emblem, 0.06)
    maskable = squared(emblem, 0.18)

    save(plain, 512, "icon-512.png")
    save(plain, 192, "icon-192.png")
    save(maskable, 512, "icon-maskable-512.png")
    save(plain, 180, "apple-touch-icon.png")
    save(plain, 48, "favicon-48.png")

    full = squared(logo.crop(logo.convert("L").point(lambda v: 255 if v <= WHITE_CUTOFF else 0).getbbox()), 0.05)
    full.resize((640, 640), Image.LANCZOS).save(OUT / "logo-full.png", "PNG", optimize=True)
    print("wrote logo-full.png (640x640)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
