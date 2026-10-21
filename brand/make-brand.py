#!/usr/bin/env python3
"""Builds every logo/icon file. The key (mark) comes from brand/source/kyuch-key.png; the "kyuch" wordmark from brand/source/kyuch-logo.webp.
Needs Pillow (python3-pil). Run: python3 brand/make-brand.py

Outputs
  renderer/logo-mark.png, renderer/logo-text.png   the two parts, tightly cropped. The app draws them as CSS masks so they
                                                   take the colour of the current theme (only the alpha channel matters).
  brand/png/logo-*.png                              the same parts in the brand orange, plus the full lockup
  brand/png/icon-<n>.png, icon.png                  app/package icons: the key on a dark rounded square
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'brand' / 'source' / 'kyuch-logo.webp'
ORANGE = (248, 88, 0)
PAD = 6

im = Image.open(SRC).convert('RGBA')
alpha = im.getchannel('A')

# The artwork's "solid" pixels sit at alpha ~250, not 255: stretch so the interior is fully opaque.
hist = alpha.histogram()
solid = next(i for i in range(255, 0, -1) if sum(hist[i:]) > 20000)
# The export also carries a faint haze of near-zero alpha; drop it, or it inflates every bounding box.
alpha = alpha.point(lambda a: 0 if a < 24 else min(255, round(a * 255 / solid)))

# Split between the key and the lettering at the widest empty gap in the middle of the image.
w, h = im.size
cols = [alpha.crop((x, 0, x + 1, h)).getbbox() is None for x in range(w)]
gaps, start = [], None
for x, empty in enumerate(cols):
    if empty and start is None: start = x
    if not empty and start is not None: gaps.append((start, x)); start = None
gap = max((g for g in gaps if g[0] > w * 0.15 and g[1] < w * 0.85), key=lambda g: g[1] - g[0])
split = (gap[0] + gap[1]) // 2

def part(x0, x1):
    a = alpha.crop((x0, 0, x1, h))
    box = a.getbbox()
    a = a.crop((box[0] - PAD, box[1] - PAD, box[2] + PAD, box[3] + PAD)) if box else a
    return a

def coloured(a, rgb=ORANGE):
    out = Image.new('RGBA', a.size, rgb + (0,)); out.putalpha(a); return out

text_a = part(split, w)
# The mark is the newer "K key" artwork (transparent PNG); trim the haze, tighten the box, and shrink it: it is shown at <= 100 px.
k = Image.open(ROOT / 'brand' / 'source' / 'kyuch-key.png').convert('RGBA').getchannel('A').point(lambda a: 0 if a < 24 else min(255, round(a * 255 / 250)))
box = k.getbbox(); k = k.crop((box[0] - PAD, box[1] - PAD, box[2] + PAD, box[3] + PAD))
mark_a = k.resize((640, round(640 * k.height / k.width)), Image.LANCZOS)
# Full lockup: key, then the wordmark at half the key's height, centred vertically.
tw = text_a.resize((round(text_a.width * (mark_a.height * 0.5) / text_a.height), round(mark_a.height * 0.5)), Image.LANCZOS)
full_a = Image.new('L', (mark_a.width + 60 + tw.width, mark_a.height), 0)
full_a.paste(mark_a, (0, 0)); full_a.paste(tw, (mark_a.width + 60, (mark_a.height - tw.height) // 2))
(ROOT / 'renderer').mkdir(exist_ok=True); (ROOT / 'brand' / 'png').mkdir(exist_ok=True, parents=True)
coloured(mark_a).save(ROOT / 'renderer' / 'logo-mark.png', optimize=True)
coloured(text_a).save(ROOT / 'renderer' / 'logo-text.png', optimize=True)
coloured(mark_a).save(ROOT / 'brand' / 'png' / 'logo-mark.png', optimize=True)
coloured(text_a).save(ROOT / 'brand' / 'png' / 'logo-text.png', optimize=True)
coloured(full_a).save(ROOT / 'brand' / 'png' / 'logo-full.png', optimize=True)
print('mark', mark_a.size, 'aspect %.4f' % (mark_a.width / mark_a.height), '| text', text_a.size, 'aspect %.4f' % (text_a.width / text_a.height), '| split at x=%d' % split)

# App icon: the key on a dark rounded square. Drawn at 1024 and downsampled for crisp small sizes.
def icon(size):
    S = 1024
    base = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(base).rounded_rectangle((0, 0, S - 1, S - 1), radius=int(S * 0.22), fill=(21, 23, 28, 255))
    box = int(S * 0.66)
    k = coloured(mark_a)
    scale = min(box / k.width, box / k.height)
    k = k.resize((round(k.width * scale), round(k.height * scale)), Image.LANCZOS)
    base.alpha_composite(k, ((S - k.width) // 2, (S - k.height) // 2))
    return base.resize((size, size), Image.LANCZOS)

for n in (16, 32, 48, 64, 128, 256, 512):
    icon(n).save(ROOT / 'brand' / 'png' / f'icon-{n}.png', optimize=True)
icon(512).save(ROOT / 'icon.png', optimize=True)
print('icons written')
