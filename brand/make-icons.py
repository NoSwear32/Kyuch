#!/usr/bin/env python3
"""Builds renderer/icons.png, the sprite sheet of every entry/folder icon, from the two source sheets (10 x 7 icons, 64 px cells).
Icon id = row * 10 + column. Ids 0-68 are the standard KeePass icons (same order, so other KeePass apps agree); 69 and up are Kyuch's own.
Run: python3 brand/make-icons.py   (needs Pillow)"""
from pathlib import Path
from PIL import Image

SRC = Path(__file__).resolve().parent / 'source'
OUT = Path(__file__).resolve().parent.parent / 'renderer' / 'icons.png'
CELL, KEEP = 64, 48            # the artwork sits in the middle 48 px of each 64 px cell

sheet = Image.new('RGBA', (10 * KEEP, 14 * KEEP), (0, 0, 0, 0))
for part, name in enumerate(['icons-keepass.png', 'icons-extra.png']):
    src = Image.open(SRC / name).convert('RGBA')
    assert src.size == (10 * CELL, 7 * CELL), src.size
    for r in range(7):
        for c in range(10):
            pad = (CELL - KEEP) // 2
            cell = src.crop((c * CELL + pad, r * CELL + pad, c * CELL + pad + KEEP, r * CELL + pad + KEEP))
            assert cell.getbbox(), f'empty icon at {name} {r},{c}'
            sheet.paste(cell, (c * KEEP, (part * 7 + r) * KEEP))
sheet.save(OUT, optimize=True)
print('icons.png', sheet.size, '140 icons')
