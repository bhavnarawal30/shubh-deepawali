"""Cut the clay diya by the right-hand step out of courtyard-16x9.webp into
diya-bowl.png (with alpha), so diyas set on the rangoli look like the ones in
the photo. The photo's own flame is painted out: the page draws a live one."""
import json
import numpy as np
from PIL import Image, ImageFilter

BOX = (1312, 205, 1406, 264)          # crop around the bowl, source pixels
WICK = (1350, 235)                    # where the flame meets the wick
RIM = dict(cx=1358.5, cy=226, rx=39, ry=12.5)
BASE = dict(cx=1358, cy=252, rx=23, ry=5.5)
FLAME = dict(cx=1350, cy=222, rx=8.5, ry=15)

im = Image.open('courtyard-16x9.webp').convert('RGB')
x0, y0, x1, y1 = BOX
S = 4                                  # build the mask at 4x for smooth edges
yy, xx = np.mgrid[y0:y1:1 / S, x0:x1:1 / S]
ell = lambda e: ((xx - e['cx']) / e['rx']) ** 2 + ((yy - e['cy']) / e['ry']) ** 2 <= 1
# body: from the rim's full width down to the base, curving in
t = np.clip((yy - RIM['cy']) / (BASE['cy'] - RIM['cy']), 0, 1)
hw = RIM['rx'] - (RIM['rx'] - BASE['rx']) * t ** 1.7
cx = RIM['cx'] + (BASE['cx'] - RIM['cx']) * t
body = (yy >= RIM['cy']) & (yy <= BASE['cy']) & (np.abs(xx - cx) <= hw)
mask = ell(RIM) | body | ell(BASE)
m = Image.fromarray((mask * 255).astype(np.uint8)).resize((x1 - x0, y1 - y0), Image.LANCZOS)
m = m.filter(ImageFilter.GaussianBlur(0.4))

px = np.asarray(im.crop(BOX)).astype(np.float32)
# paint out the photo's flame: bright pixels in the flame zone take the oil colour around them
gy, gx = np.mgrid[y0:y1, x0:x1]
zone = ((gx - FLAME['cx']) / FLAME['rx']) ** 2 + ((gy - FLAME['cy']) / FLAME['ry']) ** 2 <= 1
ring = (((gx - FLAME['cx']) / (FLAME['rx'] + 5)) ** 2 + ((gy - FLAME['cy']) / (FLAME['ry'] + 3)) ** 2 <= 1) & ~zone \
       & (np.asarray(m) > 200) & (gy > 218)
oil = np.median(px[ring], axis=0)
hot = zone & (px.mean(-1) > 125) & (gy < 233)
w = np.asarray(Image.fromarray((hot * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2))).astype(np.float32)[..., None] / 255
px = px * (1 - w) + oil * w

out = Image.fromarray(px.clip(0, 255).astype(np.uint8)); out.putalpha(m)
out = out.resize(((x1 - x0) * 2, (y1 - y0) * 2), Image.LANCZOS)    # a little headroom for sharp screens
out.save('diya-bowl.png', optimize=True)
print(json.dumps(dict(size=out.size, wick=[round((WICK[0] - x0) / (x1 - x0), 3), round((WICK[1] - y0) / (y1 - y0), 3)],
                      aspect=round((y1 - y0) / (x1 - x0), 3), width_over_h=round((x1 - x0) / 28, 2))))
