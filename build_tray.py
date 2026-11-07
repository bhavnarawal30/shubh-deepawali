"""Cut the brass colour tray out of tray-photo.webp into tray.webp (with alpha)
and print where each powder sits, for the colour picker in rangoli.js.

The hand-traced outline is only a rough guide: near it, each pixel is kept or
dropped by how far its colour is from the floor around the tray, so the cut
follows the tray's real edge."""
import json
from collections import deque
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

# Tray outline traced by hand, in photo pixels (clockwise from the top lobe).
OUTLINE = [(548, 185), (570, 160), (620, 143), (700, 135), (780, 145), (860, 172), (900, 195), (942, 220),
           (1000, 234), (1060, 240), (1100, 268), (1130, 310), (1136, 360), (1134, 420), (1124, 458),
           (1122, 485), (1128, 530), (1128, 600), (1122, 670), (1105, 735), (1068, 780), (1025, 815),
           (960, 835), (890, 832), (845, 822), (825, 842), (800, 862), (740, 885), (650, 893), (560, 885),
           (480, 862), (420, 830), (398, 800), (360, 790), (300, 770), (255, 740), (225, 690), (212, 620),
           (207, 550), (210, 480), (225, 420), (250, 380), (262, 360), (268, 320), (285, 270), (320, 225),
           (370, 200), (430, 190), (490, 192), (530, 195)]
# Middle of each powder heap, and the name shown to the user.
POWDERS = [('pink', (430, 300)), ('purple', (730, 230)), ('green', (970, 380)), ('yellow', (690, 410)),
           ('red', (380, 500)), ('orange', (610, 640)), ('blue', (920, 590))]
OUT_W = 640

im = Image.open('tray-photo.webp').convert('RGB')
W, H = im.size
px = np.asarray(im).astype(np.float32)
poly = Image.new('L', (W, H), 0)
ImageDraw.Draw(poly).polygon(OUTLINE, fill=255)
inside = np.asarray(poly) > 0
near_out = np.asarray(poly.filter(ImageFilter.MaxFilter(41))) > 0     # 20px either side of the outline
near_in = np.asarray(poly.filter(ImageFilter.MinFilter(41))) > 0

# What the floor would look like under the tray: fill it in from the floor around it.
def smooth(x, f):
    return np.asarray(Image.fromarray(x).resize((max(1, W // f), max(1, H // f)), Image.BOX).resize((W, H), Image.BILINEAR))
w = (~near_out).astype(np.float32)
floor = np.zeros_like(px); done = np.zeros((H, W), bool)
for f in (8, 16, 32, 64, 128):
    wb = smooth(w, f)
    est = np.stack([smooth(px[..., c] * w, f) for c in range(3)], -1) / np.maximum(wb, 1e-6)[..., None]
    fill = ~done & (wb > 0.05)
    floor[fill] = est[fill]; done |= fill
# Compare colour with brightness divided out, so shadows on the floor still count as floor.
chroma = lambda x: x / (x.sum(-1, keepdims=True) + 1e-6)
diff = np.abs(chroma(px) - chroma(floor)).sum(-1)
rows = np.arange(H)[:, None]
grow = near_out & ~inside & (diff > 0.08) & (rows < 720)   # reach the true edge on top and sides
keep = inside & ~(~near_in & (diff < 0.03))                 # drop floor the rough outline took in
m = np.asarray(Image.fromarray(((grow | keep) * 255).astype(np.uint8)).filter(ImageFilter.MedianFilter(7))) > 127

def flood(m, seed):
    out = np.zeros_like(m); q = deque([seed]); out[seed] = True
    while q:
        y, x = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            Y, X = y + dy, x + dx
            if 0 <= Y < H and 0 <= X < W and m[Y, X] and not out[Y, X]:
                out[Y, X] = True; q.append((Y, X))
    return out
m = flood(m, (420, 690))                 # the tray itself (seed in the yellow powder)
m = ~flood(~m, (0, 0))                   # fill any holes
mask = Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.0))
rgba = im.copy(); rgba.putalpha(mask)
x0, y0, x1, y1 = mask.getbbox()
pad = 4
box = (x0 - pad, y0 - pad, x1 + pad, y1 + pad)
cut = rgba.crop(box)
s = OUT_W / cut.width
cut = cut.resize((OUT_W, round(cut.height * s)), Image.LANCZOS)
cut.save('tray.webp', quality=88)

a = np.asarray(im).astype(float)
out = []
for name, (x, y) in POWDERS:
    patch = a[y - 30:y + 30, x - 30:x + 30].reshape(-1, 3)
    sat = patch.max(1) - patch.min(1)
    rgb = np.median(patch[sat >= np.percentile(sat, 50)], axis=0)
    out.append(dict(name=name, color='#%02x%02x%02x' % tuple(int(v) for v in rgb),
                    x=round((x - box[0]) / (box[2] - box[0]), 3), y=round((y - box[1]) / (box[3] - box[1]), 3)))
print('size', cut.size)
print(json.dumps(out))
