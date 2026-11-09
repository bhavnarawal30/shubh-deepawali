"""Make the site icons from the rangoli icon artwork (icons/source.webp):
the purple disc, cropped close around the flower and its dots, on a transparent
background, in the sizes browsers and phones ask for."""
import numpy as np
from PIL import Image, ImageDraw

src = Image.open('icons/source.webp').convert('RGB')
a = np.asarray(src).astype(int)
dark = a.min(-1) < 200                      # the purple disc (the art sits on white)
ys, xs = np.nonzero(dark)
cx, cy = (xs.min() + xs.max()) / 2, (ys.min() + ys.max()) / 2
R = 440                                     # crop radius: just outside the outer dots
purple = tuple(int(v) for v in np.median(a[dark & (np.hypot(*np.mgrid[0:a.shape[0], 0:a.shape[1]][::-1] - np.array([cx, cy])[:, None, None]) > 470)], axis=0))

def disc(size, square_bg=None):
    """The circle at `size` px: transparent outside, or on a solid square for iOS."""
    S = 4
    crop = src.crop((int(cx - R), int(cy - R), int(cx + R), int(cy + R))).resize((size * S, size * S), Image.LANCZOS)
    mask = Image.new('L', (size * S, size * S), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size * S - 1, size * S - 1), fill=255)
    if square_bg:
        out = Image.new('RGB', (size * S, size * S), square_bg)
        out.paste(crop, (0, 0), mask)
    else:
        out = crop.convert('RGBA'); out.putalpha(mask)
    return out.resize((size, size), Image.LANCZOS)

for n in (512, 192, 32, 16):
    disc(n).save(f'icons/icon-{n}.png', optimize=True)
disc(180, square_bg=purple).save('icons/apple-touch-icon.png', optimize=True)   # iOS rounds the corners itself
disc(48).save('favicon.ico', sizes=[(16, 16), (32, 32), (48, 48)])
print('purple', purple)
