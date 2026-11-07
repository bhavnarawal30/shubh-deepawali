"""Turn the line-art stencils into data the page can "draw" with powder.

For each stencils/<name>.webp this writes:
  - stroke paths: the black lines thinned to 1px and split into whole curves
    (circles stay one loop), ordered from the centre outward, ring by ring
  - stencils/<name>-regions.png: every enclosed shape labelled with an id
    (id = R + 256*G, 0 = not filled), used for the coloured powder fill
and collects everything into stencils/stencils.js (window.STENCILS).
"""
import base64
import json
import math
from collections import deque
import numpy as np
from PIL import Image, ImageFilter

N = 1024            # canvas size the paths are expressed in
RN = 512            # region map size
NAMES = ['lotus', 'peacock', 'star']

PALETTE = ['#e0236f', '#ff8a00', '#ffc400', '#1fa34a', '#1f6fd6', '#d62828', '#8e3fbf', '#11a8a0']


def thin(img):
    """Zhang-Suen thinning on a boolean array."""
    img = img.copy().astype(np.uint8)
    while True:
        changed = False
        for step in (0, 1):
            p = np.pad(img, 1)
            P2, P3, P4 = p[:-2, 1:-1], p[:-2, 2:], p[1:-1, 2:]
            P5, P6, P7 = p[2:, 2:], p[2:, 1:-1], p[2:, :-2]
            P8, P9 = p[1:-1, :-2], p[:-2, :-2]
            nb = [P2, P3, P4, P5, P6, P7, P8, P9]
            B = sum(n.astype(int) for n in nb)
            A = sum(((nb[i] == 0) & (nb[(i + 1) % 8] == 1)).astype(int) for i in range(8))
            if step == 0:
                c = (P2 * P4 * P6 == 0) & (P4 * P6 * P8 == 0)
            else:
                c = (P2 * P4 * P8 == 0) & (P2 * P6 * P8 == 0)
            rm = (img == 1) & (B >= 2) & (B <= 6) & (A == 1) & c
            if rm.any():
                img[rm] = 0
                changed = True
        if not changed:
            return img.astype(bool)


NB4 = [(-1, 0), (1, 0), (0, -1), (0, 1)]


def rdp(pts, eps):
    if len(pts) < 3:
        return pts
    a, b = np.array(pts[0], float), np.array(pts[-1], float)
    P = np.array(pts, float)
    ab = b - a
    L = np.hypot(*ab)
    d = np.abs(ab[0] * (P[:, 1] - a[1]) - ab[1] * (P[:, 0] - a[0])) / L if L > 0 else np.hypot(*(P - a).T)
    i = int(np.argmax(d))
    if d[i] > eps:
        return rdp(pts[:i + 1], eps)[:-1] + rdp(pts[i:], eps)
    return [pts[0], pts[-1]]


RING = [(-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1)]   # N NE E SE S SW W NW


def skeleton_curves(sk):
    """Split the 1px skeleton into whole curves, the way a hand would draw them.

    The skeleton is cut into pieces at junctions; then at every junction the
    pieces that carry on most straight are joined back up. A circle that other
    lines touch therefore stays one closed loop instead of several arcs."""
    H, W = sk.shape
    pad = np.pad(sk, 1).astype(np.uint8)
    ring = [pad[1 + dy:1 + dy + H, 1 + dx:1 + dx + W] for dy, dx in RING]
    cross = sum(((ring[i] == 0) & (ring[(i + 1) % 8] == 1)).astype(int) for i in range(8))
    junc = sk & (cross >= 3)
    # group touching junction pixels into one node
    node = np.zeros((H, W), np.int32)
    nodes = []
    for y0, x0 in zip(*np.nonzero(junc)):
        if node[y0, x0]:
            continue
        nodes.append([]); q = [(y0, x0)]; node[y0, x0] = len(nodes)
        while q:
            y, x = q.pop(); nodes[-1].append((y, x))
            for dy, dx in RING:
                yy, xx = y + dy, x + dx
                if 0 <= yy < H and 0 <= xx < W and junc[yy, xx] and not node[yy, xx]:
                    node[yy, xx] = len(nodes); q.append((yy, xx))
    centre = [np.mean(n, axis=0) for n in nodes]

    seen = np.zeros((H, W), bool)
    def nbrs(y, x):
        for dy, dx in sorted(RING, key=lambda d: abs(d[0]) + abs(d[1])):      # straight steps first
            yy, xx = y + dy, x + dx
            if 0 <= yy < H and 0 <= xx < W and sk[yy, xx]:
                yield yy, xx

    edges = []                       # [pts, start node, end node] (0 = free end)
    def walk(pts, a):
        while True:
            y, x = pts[-1]
            hit = next((q for q in nbrs(y, x) if node[q] and (node[q] != a or len(pts) > 4)
                        and q not in pts[-3:]), None)
            if hit is not None:
                pts.append(hit); edges.append([pts, a, int(node[hit])]); return
            nxt = next((q for q in nbrs(y, x) if not node[q] and not seen[q]), None)
            if nxt is None:
                closed = len(pts) > 8 and max(abs(pts[0][0] - y), abs(pts[0][1] - x)) <= 1
                edges.append([pts + [pts[0]] if closed else pts, a, -1 if closed else 0]); return
            seen[nxt] = True; pts.append(nxt)

    for k, n in enumerate(nodes, 1):
        for p in n:
            for q in nbrs(*p):
                if not node[q] and not seen[q]:
                    seen[q] = True; walk([p, q], k)
    ys, xs = np.nonzero(sk & ~junc)
    free = sorted(zip(ys, xs), key=lambda p: sum(1 for _ in nbrs(*p)))   # line ends before loops
    for p in free:
        if not seen[p]:
            seen[p] = True; walk([p], 0)

    # drop little spurs the thinning leaves on corners
    edges = [e for e in edges if not ((e[1] == 0) != (e[2] == 0) and len(e[0]) < 8)]

    # at each junction, join the pairs of pieces that carry on most straight
    ends = {}
    for i, (pts, na, nb) in enumerate(edges):
        for end, nd in ((0, na), (1, nb)):
            if nd > 0:
                seq = pts if end == 0 else pts[::-1]
                far = np.array(seq[min(10, len(seq) - 1)], float)
                d = far - centre[nd - 1]
                ends.setdefault(nd, []).append((i, end, d / (np.hypot(*d) or 1)))
    partner = {}
    for nd, lst in ends.items():
        pairs = sorted(((float(np.dot(u[2], v[2])), u[:2], v[:2]) for k, u in enumerate(lst) for v in lst[k + 1:]),
                       key=lambda t: t[0])
        for dot, u, v in pairs:
            if dot < -0.3 and u not in partner and v not in partner:
                partner[u] = v; partner[v] = u

    used, curves = set(), []
    def follow(i, end):
        out = []
        while i not in used:
            used.add(i)
            pts = edges[i][0] if end == 0 else edges[i][0][::-1]
            out += pts if not out else pts[1:]
            nxt = partner.get((i, 1 - end))
            if nxt is None:
                break
            i, end = nxt
        return out
    for i in range(len(edges)):                      # open curves start at a loose end
        for end in (0, 1):
            if i not in used and (i, end) not in partner:
                curves.append(follow(i, end))
    for i in range(len(edges)):                      # whatever is left is closed loops
        if i not in used:
            curves.append(follow(i, 0))
    return [[(x, y) for y, x in c] for c in curves if len(c) >= 6]


def clock(x, y, cx, cy):
    """Angle clockwise from 12 o'clock around (cx, cy), in [0, 2pi)."""
    return math.atan2(x - cx, -(y - cy)) % (2 * math.pi)


def rings(items, radius, angle, gap, width):
    """Group items into rings by distance from the centre (inner first), and
    within each ring go round clockwise starting where the last ring ended."""
    items = sorted(items, key=radius)
    bands = []
    for it in items:
        if bands and radius(it) - radius(bands[-1][-1]) < gap and radius(it) - radius(bands[-1][0]) < width:
            bands[-1].append(it)
        else:
            bands.append([it])
    out, at = [], 0.0
    for band in bands:
        band.sort(key=angle)
        k = min(range(len(band)), key=lambda i: (angle(band[i]) - at) % (2 * math.pi))
        band = band[k:] + band[:k]
        out += band
        at = angle(band[-1])
    return out


def draw_order(curves, cx, cy):
    """Inside out: rings of curves from the centre outward. Closed shapes are
    drawn clockwise in one go, starting at the point nearest the hand."""
    info = []
    for c in curves:
        P = np.array(c, float)
        info.append(dict(c=c, r=float(np.hypot(P[:, 0] - cx, P[:, 1] - cy).mean()),
                         a=clock(P[:, 0].mean(), P[:, 1].mean(), cx, cy),
                         closed=math.dist(c[0], c[-1]) < 3))
    out, pos = [], (cx, cy)
    for it in rings(info, lambda i: i['r'], lambda i: i['a'], gap=14, width=70):
        c = it['c']
        if it['closed']:
            c = c[:-1]
            P = np.array(c, float)
            area = (P[:, 0] * np.roll(P[:, 1], -1) - np.roll(P[:, 0], -1) * P[:, 1]).sum()
            if area < 0:                     # y points down, so positive area = clockwise on screen
                c = c[::-1]
            k = min(range(len(c)), key=lambda i: math.dist(pos, c[i]))
            c = c[k:] + c[:k + 1]
        elif math.dist(pos, c[-1]) < math.dist(pos, c[0]):
            c = c[::-1]
        out.append(c)
        pos = c[-1]
    return out


def regions(lines):
    """Label enclosed shapes on a RN x RN grid."""
    small = np.asarray(Image.fromarray((lines * 255).astype(np.uint8)).resize((RN, RN), Image.BOX)) > 40
    small = np.asarray(Image.fromarray((small * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(3))) > 0
    lab = np.zeros((RN, RN), np.int32)
    info = []
    nid = 0
    for y0 in range(RN):
        for x0 in range(RN):
            if small[y0, x0] or lab[y0, x0]:
                continue
            nid += 1
            q = deque([(y0, x0)]); lab[y0, x0] = nid
            pts = []
            edge = False
            while q:
                y, x = q.popleft(); pts.append((y, x))
                if y in (0, RN - 1) or x in (0, RN - 1):
                    edge = True
                for dy, dx in NB4:
                    yy, xx = y + dy, x + dx
                    if 0 <= yy < RN and 0 <= xx < RN and not small[yy, xx] and not lab[yy, xx]:
                        lab[yy, xx] = nid; q.append((yy, xx))
            P = np.array(pts)
            cy, cx = P[:, 0].mean(), P[:, 1].mean()
            spread = np.sqrt(((P[:, 0] - cy) ** 2 + (P[:, 1] - cx) ** 2).mean())
            info.append(dict(id=nid, area=len(pts), cy=cy, cx=cx, spread=spread, edge=edge))
    return lab, info


stencils = {}
for name in NAMES:
    g = np.asarray(Image.open(f'stencils/{name}.webp').convert('L').resize((N, N), Image.LANCZOS))
    lines = g < 140
    sk = thin(lines)
    ly, lx = np.nonzero(lines)
    cx, cy = (lx.min() + lx.max()) / 2, (ly.min() + ly.max()) / 2          # true design centre
    curves = skeleton_curves(sk)
    paths = [rdp(p, 0.75) for p in draw_order(curves, cx, cy)]
    total = sum(np.hypot(*np.diff(np.array(p, float), axis=0).T).sum() for p in paths)

    lab, info = regions(lines)
    keep = [r for r in info if not r['edge'] and r['area'] >= 8]          # every enclosed shape can be filled
    # Shapes that map onto each other under the design's symmetry (quarter turns,
    # mirrors) get the same powder colour.
    gx, gy = cx * RN / N, cy * RN / N
    c0 = RN / 2
    def rot(a):
        ca, sa = np.cos(a), np.sin(a)
        return lambda x, y: (gx + (x - gx) * ca - (y - gy) * sa, gy + (x - gx) * sa + (y - gy) * ca)
    xforms = [rot(np.pi / 2 * k) for k in (1, 2, 3)] + [lambda x, y: (2 * gx - x, y), lambda x, y: (x, 2 * gy - y)]
    eighth = [rot(np.pi / 4 * k) for k in (1, 3, 5, 7)]          # 8-petal centre flower
    parent = list(range(len(keep)))
    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]; i = parent[i]
        return i
    for i, r in enumerate(keep):
        near_centre = np.hypot(r['cx'] - gx, r['cy'] - gy) < RN * 0.18
        for f in xforms + (eighth if near_centre else []):
            tx, ty = f(r['cx'], r['cy'])
            for j, o in enumerate(keep):
                if (j != i and abs(o['cx'] - tx) < 12 and abs(o['cy'] - ty) < 12
                        and 0.7 < o['area'] / r['area'] < 1.4 and 0.85 < o['spread'] / r['spread'] < 1.18):
                    parent[find(j)] = find(i)
    groups = {}
    for i, r in enumerate(keep):
        groups.setdefault(find(i), []).append(r)
    order = sorted(groups, key=lambda g: min(np.hypot(r['cx'] - c0, r['cy'] - c0) for r in groups[g]))
    for i, g in enumerate(order):
        for r in groups[g]:
            r['color'] = PALETTE[i % len(PALETTE)]
    # Colour in the same order as the outlines: inside out, clockwise round each ring.
    keep = rings(keep, lambda r: math.hypot(r['cx'] - gx, r['cy'] - gy),
                 lambda r: clock(r['cx'], r['cy'], gx, gy), gap=7, width=35)

    out = np.zeros((RN, RN, 3), np.uint8)
    remap = {}
    for k, r in enumerate(keep, 1):
        remap[r['id']] = k
    flat = lab.ravel()
    ids = np.zeros(flat.max() + 1, np.int32)
    for old, new in remap.items():
        ids[old] = new
    newlab = ids[flat].reshape(RN, RN)
    out[..., 0] = newlab % 256
    out[..., 1] = newlab // 256
    Image.fromarray(out).save(f'stencils/{name}-regions.png')

    stencils[name] = dict(
        size=N,
        paths=[[int(c) for xy in p for c in xy] for p in paths],
        regions=[dict(id=remap[r['id']], color=r['color'], area=int(r['area']),
                      cx=int(round(r['cx'] * N / RN)), cy=int(round(r['cy'] * N / RN))) for r in keep],
        # embedded as a data URL so the page can read its pixels even when opened as a file
        regionMap='data:image/png;base64,' + base64.b64encode(open(f'stencils/{name}-regions.png', 'rb').read()).decode(), regionSize=RN,
    )
    print(name, len(paths), 'paths', sum(math.dist(p[0], p[-1]) < 3 for p in curves), 'closed,', int(total), 'px of line,', len(keep), 'regions,', len(groups), 'colour groups')

with open('stencils/stencils.js', 'w') as f:
    f.write('// Generated by build_stencils.py\nwindow.STENCILS = ' + json.dumps(stencils, separators=(',', ':')) + ';\n')
