// Rangoli on the floor, made of powder trickled from the fingers.
// "Draw a rangoli" offers two ways to make one, then "Color a rangoli" fills it:
//  - Your own: freehand white powder; whatever is drawn in one quarter is
//    mirrored into the other three as it goes.
//  - Templates: a stencil is outlined in white, inside out, by itself.
//    Data comes from stencils/stencils.js.
//  - Color a rangoli (unlocked once the rangoli is made): a tray of coloured
//    powders appears and you fill the shapes by tapping them, on either kind.
//  - Add diyas: once a rangoli is made, set small lit diyas on it.
// One rangoli is on the floor at a time; starting a new one replaces it.
(() => {
  const STENCILS = window.STENCILS;
  const N = 1024;                      // drawing resolution (matches the stencil data)
  const LINE_MS = 17000;               // time spent drawing all the white outlines
  const MAX_PAUSE_MS = 5000;           // total time the hand spends lifted between strokes

  const plane = document.getElementById('rangoli');
  const fillCv = plane.querySelector('.r-fill');
  const lineCv = plane.querySelector('.r-line');
  const freeCv = plane.querySelector('.r-free');
  const handEl = plane.querySelector('.r-hand');
  const corners = [...plane.querySelectorAll('.r-corner')];
  const layer = document.getElementById('draw-layer');
  const streamCv = document.getElementById('powder-stream');
  for (const c of [fillCv, lineCv, freeCv]) c.width = c.height = N;
  const fctx = fillCv.getContext('2d');      // coloured powder, under either kind of outline
  const lctx = lineCv.getContext('2d');      // a template's white outline
  const dctx = freeCv.getContext('2d');      // your own freehand lines
  const sctx = streamCv.getContext('2d');

  const gauss = () => (Math.random() + Math.random() + Math.random() + Math.random() - 2) * 1.73;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- Powder colours ----------
  const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  function shades([r, g, b], n = 6) {
    const out = [];
    for (let k = 0; k < n; k++) {
      const m = 0.82 + 0.32 * k / (n - 1);              // darker and lighter grains
      for (const a of [0.55, 0.75, 0.95]) {
        out.push(`rgba(${Math.min(255, r * m) | 0},${Math.min(255, g * m) | 0},${Math.min(255, b * m) | 0},${a})`);
      }
    }
    return out;
  }
  const WHITE = shades([255, 252, 246]);
  const WHITE_FAINT = [0.18, 0.28, 0.38].map(a => `rgba(245,240,230,${a})`);

  // ---------- Stencil preparation ----------
  const prepared = {};
  function prepare(name) {
    if (prepared[name]) return prepared[name];
    return (prepared[name] = new Promise(resolve => {
      const st = STENCILS[name];
      const img = new Image();
      img.onload = () => {
        const R = st.regionSize;
        const c = document.createElement('canvas');
        c.width = c.height = R;
        const x = c.getContext('2d');
        x.drawImage(img, 0, 0);
        const d = x.getImageData(0, 0, R, R).data;
        const lists = new Map(st.regions.map(r => [r.id, []]));
        for (let i = 0, p = 0; i < d.length; i += 4, p++) {
          const id = d[i] + 256 * d[i + 1];
          if (id) lists.get(id)?.push(p);
        }
        const regions = st.regions
          .map(r => ({ ...r, px: Int32Array.from(lists.get(r.id) || []) }))
          .filter(r => r.px.length);
        const at = new Int16Array(R * R).fill(-1);       // which shape each map pixel belongs to
        regions.forEach((r, i) => { for (const p of r.px) at[p] = i; });
        const strokes = st.paths.map(flat => {
          const pts = [];
          for (let i = 0; i < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
          return pts;
        });
        resolve({ R, regions, at, strokes });
      };
      img.src = st.regionMap;
    }));
  }

  // ---------- Drawing state ----------
  let job = null;                      // the template currently being drawn
  let kind = null;                     // what's on the floor: 'free' | 'template' | null
  let made = false;                    // the rangoli is finished: colouring and diyas unlock
  let shapes = null;                   // its fillable shapes, found when colouring starts
  let drewSomething = false;
  const tip = { x: N / 2, y: N / 2, on: false, color: WHITE };

  function strokeLength(pts) {
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return L;
  }

  async function start(name) {
    const data = await prepare(name);
    const total = data.strokes.reduce((s, p) => s + strokeLength(p), 0);
    // Gaps between strokes: longer jumps take a little longer, capped overall.
    // Strokes that carry straight on from the last one need no lift at all.
    const hops = data.strokes.map((p, i) => {
      if (i === 0) return 0;
      const a = data.strokes[i - 1].at(-1), b = p[0];
      return Math.hypot(a[0] - b[0], a[1] - b[1]);
    });
    const gaps = hops.map((d, i) => (i === 0 || d < 6 ? 0 : 90 + Math.min(260, d * 0.6)));
    const gapSum = gaps.reduce((a, b) => a + b, 0);
    const gapScale = Math.min(1, MAX_PAUSE_MS / gapSum);
    job = {
      name, data,
      speed: total / LINE_MS,                // px per ms
      gaps: gaps.map(g => g * gapScale),
      phase: 'line', si: 0, seg: 0, segPos: 0, walked: 0, pause: 0,   // 'line' -> 'ready' (yours to fill)
    };
    tip.x = data.strokes[0][0][0]; tip.y = data.strokes[0][0][1];
    if (reduce) { while (job && job.phase === 'line') step(1000); }
  }

  // Sweep the floor clean for a new rangoli.
  function clearAll() {
    job = null;
    tip.on = false;
    fills.length = 0;
    for (const c of [fctx, lctx, dctx]) c.clearRect(0, 0, N, N);
    particles.length = 0;
    drewSomething = false;
    undoStack.length = 0; undoBtn.disabled = true;
    dotsToggle.checked = false; plane.classList.remove('dots');
    setKind(null);
    unmake();
  }
  function setKind(k) {
    kind = k;
    plane.classList.toggle('kind-free', k === 'free');
    plane.classList.toggle('kind-template', k === 'template');
  }
  function unmake() {                        // the rangoli is no longer finished
    made = false;
    shapes = null;
    removeDiyas();
    updateButtons();
  }

  // White outline grains around one point of a stroke.
  function lineGrains(ctx, x, y, flow) {
    const n = (10 * flow) | 0;
    for (let k = 0; k < n; k++) {
      const stray = Math.random() < 0.12;
      const s = stray ? 6 : 2.7;
      const gx = x + gauss() * s, gy = y + gauss() * s;
      const r = 0.6 + Math.random() * 1.2;
      ctx.fillStyle = stray ? WHITE_FAINT[(Math.random() * 3) | 0] : WHITE[(Math.random() * WHITE.length) | 0];
      ctx.fillRect(gx - r / 2, gy - r / 2, r, r);
    }
  }

  function stepLine(dt) {
    const strokes = job.data.strokes;
    if (job.pause > 0) {                       // hand lifted, moving to the next stroke
      job.pause -= dt;
      tip.on = false;
      const nx = strokes[job.si][0];
      tip.x += (nx[0] - tip.x) * Math.min(1, dt / 90);
      tip.y += (nx[1] - tip.y) * Math.min(1, dt / 90);
      return;
    }
    tip.on = true;
    tip.color = WHITE;
    let budget = job.speed * dt;
    while (budget > 0) {
      const pts = strokes[job.si];
      if (job.seg >= pts.length - 1) {         // stroke finished
        job.si++; job.seg = 0; job.segPos = 0;
        if (job.si >= strokes.length) { job.phase = 'ready'; tip.on = false; templateDone(); return; }
        if (job.gaps[job.si] === 0) continue;   // carries straight on
        job.walked = 0;
        job.pause = job.gaps[job.si] - budget / job.speed;   // rest of this frame counts as lifted
        return;
      }
      const a = pts[job.seg], b = pts[job.seg + 1];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const t = job.segPos / L;
      const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
      // Uneven hand: flow wobbles along the line; a little extra where a stroke begins.
      const flow = (0.8 + 0.25 * Math.sin(job.walked * 0.05 + job.si) + 0.15 * Math.sin(job.walked * 0.21))
                 * (job.walked < 6 ? 1.6 : 1);
      lineGrains(lctx, x, y, flow);
      tip.x = x; tip.y = y;
      job.segPos += 1; job.walked += 1; budget -= 1;
      if (job.segPos >= L) { job.segPos -= L; job.seg++; }
    }
  }

  function step(dt) {
    if (job && job.phase === 'line') stepLine(dt);
    stepFills(dt);
  }

  // ---------- Filling shapes by hand (after the outline) ----------
  // Tapping a shape pours the chosen powder where you tapped; it spreads out
  // from there until the shape is full. Several shapes can fill at once.
  const fills = [];
  function pourInto(ri, x, y, colour) {
    const r = shapes.regions[ri], R = shapes.R, s = N / R;
    const keys = new Float32Array(r.px.length);
    for (let i = 0; i < r.px.length; i++) {
      const p = r.px[i];
      keys[i] = Math.hypot((p % R + 0.5) * s - x, (((p / R) | 0) + 0.5) * s - y) + Math.random() * 14;
    }
    const order = Int32Array.from(r.px.keys()).sort((i, k) => keys[i] - keys[k]);
    fills.push({ r, order, shades: colour.shades, t: 0, dur: Math.min(3500, 300 + 28 * Math.sqrt(r.px.length)),
                 total: r.px.length * 11, placed: 0, fx: x, fy: y, R });
  }

  function stepFills(dt) {
    for (let i = fills.length - 1; i >= 0; i--) {
      const f = fills[i], r = f.r, R = f.R, scale = N / R, n = f.order.length;
      f.t += dt;
      const k = Math.min(1, f.t / f.dur);
      const front = k * (n - 1);
      const win = Math.max(25, n * 0.18);
      const want = Math.floor(k * f.total) - f.placed;
      for (let g = 0; g < want; g++) {
        const rank = Math.max(0, Math.min(n - 1, Math.round(front - Math.abs(gauss()) * win * 0.5)));
        const p = r.px[f.order[rank]];
        const gx = (p % R) * scale + Math.random() * scale + gauss() * 0.7;
        const gy = ((p / R) | 0) * scale + Math.random() * scale + gauss() * 0.7;
        const sz = 0.8 + Math.random() * 1.3;
        fctx.fillStyle = f.shades[(Math.random() * f.shades.length) | 0];
        fctx.fillRect(gx - sz / 2, gy - sz / 2, sz, sz);
      }
      f.placed += Math.max(0, want);
      const p = r.px[f.order[Math.round(front)]];
      f.fx += ((p % R) * scale - f.fx) * 0.3;            // the hand follows the spreading powder
      f.fy += (((p / R) | 0) * scale - f.fy) * 0.3;
      if (k >= 1) fills.splice(i, 1);
    }
  }

  // ---------- Freehand drawing (Draw a rangoli) ----------
  // The floor is split into four quarters; every grain is mirrored across both
  // centre lines, so the other three quarters build themselves as you draw.
  const pen = { x: 0, y: 0, down: false, over: false, walked: 0, carry: 0, id: null };
  const mirrors = (x, y) => [[x, y], [N - x, y], [x, N - y], [N - x, N - y]];
  const onFloor = (x, y) => x >= 0 && y >= 0 && x <= N && y <= N;

  function sprinkle(x, y, flow) {
    if (!onFloor(x, y)) return;
    for (const [mx, my] of mirrors(x, y)) lineGrains(dctx, mx, my, flow);
  }

  function penTo(x, y) {                    // trickle powder along the way, 1px at a time
    // carry: how far the hand has moved since the last pinch of powder, so even
    // tiny, slow movements keep laying a line instead of skipping it
    const L = Math.hypot(x - pen.x, y - pen.y);
    let d = 1 - pen.carry;
    for (; d <= L; d += 1) {
      const t = d / L;
      const flow = (0.8 + 0.25 * Math.sin(pen.walked * 0.05) + 0.15 * Math.sin(pen.walked * 0.21))
                 * (pen.walked < 6 ? 1.6 : 1);
      sprinkle(pen.x + (x - pen.x) * t, pen.y + (y - pen.y) * t, flow);
      pen.walked++;
    }
    pen.carry = L - (d - 1);
    pen.x = x; pen.y = y;
  }

  function settle(dt) {                     // fingers held still: powder keeps piling up
    if (mode !== 'free' || !pen.down || !onFloor(pen.x, pen.y)) return;
    const n = Math.floor(dt * 0.15 + Math.random());
    for (const [mx, my] of mirrors(pen.x, pen.y)) {
      for (let k = 0; k < n; k++) {
        const r = 0.6 + Math.random() * 1.2;
        dctx.fillStyle = WHITE[(Math.random() * WHITE.length) | 0];
        dctx.fillRect(mx + gauss() * 3.4 - r / 2, my + gauss() * 3.4 - r / 2, r, r);
      }
    }
  }

  function floorPoint(e) { return map().toFloor(e.clientX, e.clientY); }

  // Colour mode, once the rangoli is made: tap (or drag across) shapes to fill them.
  const filling = () => mode === 'color' && !!shapes;
  let filledThisDrag = new Set();
  function shapeAt(x, y) {
    if (!onFloor(x, y)) return -1;
    const { R, at } = shapes;
    return at[Math.min(R - 1, (y / N * R) | 0) * R + Math.min(R - 1, (x / N * R) | 0)];
  }
  function fillAt(x, y) {
    const ri = shapeAt(x, y);
    if (ri < 0 || filledThisDrag.has(ri)) return;
    if (!colour) { nudge(); return; }
    filledThisDrag.add(ri);
    pourInto(ri, x, y, colour);
  }

  layer.addEventListener('pointerdown', e => {
    if (pen.down) return;
    try { layer.setPointerCapture(e.pointerId); } catch {}
    mapping = null;
    [pen.x, pen.y] = floorPoint(e);
    pen.down = true; pen.id = e.pointerId; pen.walked = 0; pen.carry = 0;
    if (mode === 'diya') { pen.down = false; placeOrLift(e); return; }
    if (filling()) { filledThisDrag = new Set(); fillAt(pen.x, pen.y); return; }
    if (mode !== 'free') return;
    saveUndo();
    drewSomething = true;
    shapes = null;                            // the drawing changed: find its shapes again when colouring
    sprinkle(pen.x, pen.y, 1.6);
  });
  layer.addEventListener('pointermove', e => {
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evs.length ? evs : [e]) {
      const [x, y] = floorPoint(ev);
      if (!pen.down || e.pointerId !== pen.id) { pen.x = x; pen.y = y; }
      else if (filling()) { pen.x = x; pen.y = y; fillAt(x, y); }
      else if (mode === 'free') penTo(x, y);
    }
    pen.over = onFloor(pen.x, pen.y);
    if (mode === 'diya') { moveGhost(e); return; }
    layer.style.cursor = filling() ? (shapeAt(pen.x, pen.y) >= 0 ? 'pointer' : '') : pen.over ? 'crosshair' : '';
  });
  const lift = e => { if (e.pointerId === pen.id) { pen.down = false; pen.id = null; } };
  layer.addEventListener('pointerup', lift);
  layer.addEventListener('pointercancel', lift);
  layer.addEventListener('pointerleave', () => { if (!pen.down) pen.over = false; });

  // ---------- Floor <-> screen mapping ----------
  // The floor is a 3D-tilted square; reading back where its corners land on
  // screen gives a perspective mapping both ways.
  function homography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    for (let c = 0; c < 8; c++) {           // Gauss-Jordan with partial pivoting
      let p = c;
      for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
      for (let r = 0; r < 8; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    const h = b.map((v, i) => v / A[i][i]);
    return (x, y) => {
      const w = h[6] * x + h[7] * y + 1;
      return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
    };
  }
  let mapping = null;
  function map() {
    if (!mapping) {
      const scr = corners.map(c => { const r = c.getBoundingClientRect(); return [r.left, r.top]; });
      const flr = [[0, 0], [N, 0], [N, N], [0, N]];
      const m = { toScreen: homography(flr, scr), toFloor: homography(scr, flr) };
      if (!Number.isFinite(m.toFloor(0, 0)[0])) return m;     // not laid out yet: don't keep it
      mapping = m;
    }
    return mapping;
  }
  addEventListener('resize', () => { mapping = null; });

  // ---------- Falling powder + hand shadow (screen space) ----------
  const particles = [];
  function sizeStream() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    streamCv.width = innerWidth * dpr; streamCv.height = innerHeight * dpr;
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  addEventListener('resize', sizeStream);
  sizeStream();

  function pour(x, y, colors, k) {          // a thin trickle falling onto floor point (x, y)
    const [tx, ty] = map().toScreen(x, y);
    for (let i = 0; i < 7; i++) {
      particles.push({
        x: tx + gauss() * 1.6 * k, y: ty - (26 + Math.random() * 8) * k,
        vx: gauss() * 0.01 * k, vy: (0.02 + Math.random() * 0.05) * k, ty: ty + gauss() * 1.5 * k,
        c: colors[(Math.random() * colors.length) | 0], s: (0.8 + Math.random() * 1.2) * k,
      });
    }
  }

  function drawStream(dt) {
    const drawing = mode === 'free';
    let hx = pen.x, hy = pen.y, ho = 0;          // hand shadow: where, and how strong
    if (drawing) ho = pen.down ? 1 : pen.over ? 0.55 : 0;
    else if (job && job.phase === 'line') { hx = tip.x; hy = tip.y; ho = tip.on ? 1 : 0.7; }
    else if (fills.length) { hx = fills.at(-1).fx; hy = fills.at(-1).fy; ho = 1; }
    else if (filling() && pen.over) ho = 0.55;
    handEl.style.left = (hx / N * 100) + '%';
    handEl.style.top = (hy / N * 100) + '%';
    handEl.style.opacity = ho;

    const k = plane.getBoundingClientRect().width / 700;    // scale with how big the rangoli is on screen
    if (job && tip.on) pour(tip.x, tip.y, tip.color, k);
    for (const f of fills) pour(f.fx, f.fy, f.shades, k);
    if (drawing && pen.down && onFloor(pen.x, pen.y)) {
      for (const [mx, my] of mirrors(pen.x, pen.y)) pour(mx, my, WHITE, k);
    }
    sctx.clearRect(0, 0, innerWidth, innerHeight);
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.vy += 0.0016 * k * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.y >= p.ty) { particles.splice(i, 1); continue; }
      sctx.fillStyle = p.c;
      sctx.fillRect(p.x - p.s / 2, p.y - p.s / 2, p.s, p.s);
    }
  }

  let last = performance.now();
  function loop(now) {
    const dt = Math.min(50, now - last);
    last = now;
    step(dt * speed);
    settle(dt);
    drawStream(dt);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // ---------- Panel ----------
  let mode = null;                           // 'free' | 'template' | 'color' | 'diya' | null
  let speed = 2;                             // how fast a template is drawn (Speed slider)
  const modeBtns = [...document.querySelectorAll('.mode-btn')];
  const drawBtn = document.querySelector('[data-mode="draw"]');
  const colorBtn = document.querySelector('[data-mode="color"]');
  const diyaBtn = document.querySelector('[data-mode="diya"]');
  const diyaTip = document.getElementById('diya-tip');
  const colorTip = document.getElementById('color-tip');
  const bars = {
    free: document.getElementById('draw-bar'), template: document.getElementById('template-bar'),
    color: document.getElementById('color-bar'), diya: document.getElementById('diya-bar'),
  };
  const menu = document.getElementById('draw-menu');
  const menuItems = [...menu.querySelectorAll('button')];
  const dotsToggle = document.getElementById('dots-toggle');
  const quarterHint = document.getElementById('quarter-hint');
  function placeQuarterHint() {              // centred under the bottom dotted line of the quarters
    const [x, y] = map().toScreen(N / 2, N - 32);
    quarterHint.style.left = x + 'px';
    quarterHint.style.top = y + 'px';
  }
  const diyaHint = document.getElementById('diya-hint');
  function placeDiyaHint() {                 // under the bottom of the ring where diyas can go, above the buttons
    const [fx, fy] = reach ? [reach.cx, reach.cy + reach.r[ANG / 4]] : [N / 2, N];
    const [x, y] = map().toScreen(fx, fy);
    const limit = document.querySelector('.modes').getBoundingClientRect().top - 18 - diyaHint.offsetHeight;
    diyaHint.style.left = x + 'px';
    diyaHint.style.top = Math.min(y, limit) + 'px';
  }
  addEventListener('resize', () => {
    mapping = null;
    if (!quarterHint.hidden) placeQuarterHint();
    if (!diyaHint.hidden) placeDiyaHint();
  });

  function flash(tipEl) {                    // say why a locked button can't be used yet (also for touch)
    tipEl.classList.add('show');
    clearTimeout(tipEl.hideT);
    tipEl.hideT = setTimeout(() => tipEl.classList.remove('show'), 2200);
  }

  function setMode(m) {
    if (m === 'diya' && !made) return flash(diyaTip);
    if (m === 'color' && !made) return flash(colorTip);
    mode = m;
    if (m === 'color' && !shapes) shapes = kind === 'template' ? job.data : freeShapes();
    const pressed = { draw: m === 'free' || m === 'template', color: m === 'color', diya: m === 'diya' };
    modeBtns.forEach(b => b.setAttribute('aria-pressed', String(!!pressed[b.dataset.mode])));
    for (const [name, el] of Object.entries(bars)) el.hidden = name !== m;
    plane.classList.toggle('drawing', m === 'free');
    if (m === 'diya') reach = measureReach();
    mapping = null;
    pen.down = pen.over = false;
    openMenu(false);
    layer.classList.toggle('on', m === 'free' || m === 'diya' || filling());
    layer.style.cursor = '';
    showTray(filling());
    if (filling()) trayHint.textContent = !shapes.regions.length ? 'Close your lines into shapes to colour them'
      : colour ? `${colour.name}. Now tap a shape to fill it` : 'Tap a colour, then fill the rangoli';
    quarterHint.hidden = m !== 'free';
    if (m === 'free') placeQuarterHint();
    diyaHint.hidden = m !== 'diya';
    if (m === 'diya') placeDiyaHint();
    ghost.style.display = 'none';
  }
  drawBtn.addEventListener('click', () => openMenu(menu.hidden));
  colorBtn.addEventListener('click', () => setMode(mode === 'color' ? null : 'color'));
  diyaBtn.addEventListener('click', () => setMode(mode === 'diya' ? null : 'diya'));

  // Locks: colouring and diyas wait until the rangoli is made.
  function updateButtons(celebrate) {
    for (const [btn, tipEl, readyText, waitText] of [
      [colorBtn, colorTip, 'Colour your rangoli', 'Make your rangoli first, then colour it'],
      [diyaBtn, diyaTip, 'Light diyas around your rangoli', 'Make your rangoli first, then light the diyas'],
    ]) {
      const was = btn.getAttribute('aria-disabled') === 'false';
      btn.setAttribute('aria-disabled', String(!made));
      tipEl.textContent = made ? readyText : waitText;
      if (made && !was && celebrate) { btn.classList.remove('ready'); void btn.offsetWidth; btn.classList.add('ready'); }
    }
    const dl = document.getElementById('download-btn');       // nothing to save until there's a rangoli
    dl.setAttribute('aria-disabled', String(!made));
    dl.dataset.tip = made ? 'Save your rangoli as a picture' : 'Make your rangoli first, then save it';
    if (!made && (mode === 'color' || mode === 'diya')) setMode(null);
  }
  function templateDone() {                  // the outline has finished drawing itself
    made = true;
    shapes = null;
    updateButtons(true);
  }

  // Your own: freehand drawing. Picking it after a template starts a fresh floor.
  function startFree() {
    if (kind !== 'free') { clearAll(); setKind('free'); }
    setMode('free');
  }
  // Templates: a fresh floor, then the outline draws itself.
  function startTemplate(name) {
    clearAll();
    setKind('template');
    setMode('template');
    start(name);
  }
  bars.free.querySelector('[data-act="done"]').addEventListener('click', () => {
    dotsToggle.checked = false;                // the guide dots were only for drawing: leave just the rangoli
    plane.classList.remove('dots');
    if (drewSomething) { made = true; updateButtons(true); }
    setMode(null);
  });
  bars.free.querySelector('[data-act="clear"]').addEventListener('click', () => { saveUndo(); clearDraw(); });
  bars.template.querySelector('[data-act="clear"]').addEventListener('click', () => { clearAll(); setMode(null); });
  bars.color.querySelector('[data-act="clear-colours"]').addEventListener('click', () => { fills.length = 0; fctx.clearRect(0, 0, N, N); });
  bars.color.querySelector('[data-act="done"]').addEventListener('click', () => setMode(null));

  // The "Draw a rangoli" menu: a small panel just above the button.
  function placeMenu() {
    const r = drawBtn.getBoundingClientRect();
    const left = Math.min(innerWidth - menu.offsetWidth - 8, Math.max(8, r.left + r.width / 2 - menu.offsetWidth / 2));
    menu.style.left = left + 'px';
    menu.style.top = (r.top - menu.offsetHeight - 10) + 'px';
  }
  function openMenu(on) {
    menu.hidden = !on;
    drawBtn.setAttribute('aria-expanded', String(on));
    if (on) { placeMenu(); menuItems[0].focus({ preventScroll: true }); }
  }
  addEventListener('resize', () => { if (!menu.hidden) placeMenu(); });
  for (const b of menuItems) {
    b.addEventListener('click', () => {
      openMenu(false);
      if (b.dataset.pick === 'free') startFree();
      else startTemplate(b.dataset.stencil);
    });
  }
  addEventListener('keydown', e => { if (e.key === 'Escape' && !menu.hidden) { openMenu(false); drawBtn.focus(); } });
  document.addEventListener('pointerdown', e => {
    if (!menu.hidden && !menu.contains(e.target) && !drawBtn.contains(e.target)) openMenu(false);
  });

  // Undo (your own drawing): the floor is saved before each stroke and before Clear.
  const UNDO_MAX = 15;
  const undoStack = [];
  const undoBtn = bars.free.querySelector('[data-act="undo"]');
  function saveUndo() {
    undoStack.push({ img: dctx.getImageData(0, 0, N, N), drew: drewSomething });
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    undoBtn.disabled = false;
  }
  function undo() {
    const last = undoStack.pop();
    if (!last) return;
    dctx.putImageData(last.img, 0, 0);
    drewSomething = last.drew;
    shapes = null;
    if (!drewSomething && made) unmake();
    undoBtn.disabled = !undoStack.length;
  }
  undoBtn.addEventListener('click', undo);
  addEventListener('keydown', e => {
    if (mode === 'free' && (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
  });
  function clearDraw() {                     // Clear in your own drawing: lines and any colour on them
    dctx.clearRect(0, 0, N, N);
    fctx.clearRect(0, 0, N, N);
    fills.length = 0;
    particles.length = 0;
    drewSomething = false;
    unmake();
  }

  // The closed shapes in your own drawing, so they can be filled like a template's.
  // 1. The lines, thickened a little so grainy powder closes up, are walls; every
  //    pocket of floor they fence in, not touching the edge, becomes a shape.
  // 2. The thickening shrank each shape away from its lines, so each one grows
  //    back out over the line until it meets its neighbour (or the outside) halfway,
  //    filling the wide spots where several lines cross, and swallowing any pocket
  //    too small to be a shape. The colour then tucks right under the white edge.
  function freeShapes() {
    const R = 512;
    const c = document.createElement('canvas');
    c.width = c.height = R;
    const x = c.getContext('2d');
    x.drawImage(freeCv, 0, 0, R, R);
    const a = x.getImageData(0, 0, R, R).data;
    let wall = new Uint8Array(R * R);
    for (let i = 0; i < R * R; i++) wall[i] = a[i * 4 + 3] > 40 ? 1 : 0;
    for (let pass = 0; pass < 2; pass++) {    // thicken by 2px
      const w2 = wall.slice();
      for (let y = 1; y < R - 1; y++) for (let xx = 1; xx < R - 1; xx++) {
        const i = y * R + xx;
        if (!wall[i] && (wall[i - 1] | wall[i + 1] | wall[i - R] | wall[i + R] | wall[i - R - 1] | wall[i - R + 1] | wall[i + R - 1] | wall[i + R + 1])) w2[i] = 1;
      }
      wall = w2;
    }
    // label the open floor: shapes get 0, 1, 2…; the outside gets -2; crumbs stay
    // unclaimed (-1), like the lines, for the shapes around them to take over
    const lab = new Int32Array(R * R).fill(-1), queue = new Int32Array(R * R);
    let count = 0;
    const nb = p => { const px = p % R, py = (p / R) | 0; return [px > 0 ? p - 1 : -1, px < R - 1 ? p + 1 : -1, py > 0 ? p - R : -1, py < R - 1 ? p + R : -1]; };
    for (let s = 0; s < R * R; s++) {
      if (wall[s] || lab[s] !== -1) continue;
      let head = 0, tail = 0, edge = false;
      queue[tail++] = s; lab[s] = -3;
      while (head < tail) {
        const p = queue[head++], px = p % R, py = (p / R) | 0;
        if (px === 0 || py === 0 || px === R - 1 || py === R - 1) edge = true;
        for (const q of nb(p)) if (q >= 0 && !wall[q] && lab[q] === -1) { lab[q] = -3; queue[tail++] = q; }
      }
      const id = edge ? -2 : tail < 12 ? -1 : count++;
      for (let k = 0; k < tail; k++) lab[queue[k]] = id;
    }
    // grow every labelled area out over the walls at once, one step at a time,
    // so each line is shared between the areas on either side of it
    let front = [];
    for (let p = 0; p < R * R; p++) if (lab[p] !== -1) front.push(p);
    while (front.length) {
      const next = [];
      for (const p of front) for (const q of nb(p)) if (q >= 0 && lab[q] === -1) { lab[q] = lab[p]; next.push(q); }
      front = next;
    }
    const at = new Int16Array(R * R).fill(-1), lists = Array.from({ length: count }, () => []);
    for (let p = 0; p < R * R; p++) if (lab[p] >= 0) { at[p] = lab[p]; lists[lab[p]].push(p); }
    return { R, regions: lists.map(l => ({ px: Int32Array.from(l) })), at };
  }

  // Speed: the slider snaps to these steps.
  const SPEEDS = [0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4];
  const speedIn = document.getElementById('speed');
  speedIn.addEventListener('input', () => {
    speed = SPEEDS[+speedIn.value];
    const label = speed + '×';
    document.getElementById('speed-val').textContent = label;
    speedIn.setAttribute('aria-valuetext', label);
  });

  // ---------- Diyas on the rangoli ----------
  // Small lit diyas set on the floor: the clay bowl cut from the photo's own diya,
  // with the same glow layers and flicker as the diyas there, sized by perspective.
  const placed = [];
  const diyaHost = document.getElementById('placed-diyas');
  const stage = document.getElementById('stage');
  const SRC_W = 1672, SRC_H = 941;           // source image size the stage is laid out in
  const DIYA_SIZE = 20;                      // flame height, in floor units (rangoli is 1024 across)
  function makeDiya(cls) {
    const el = document.createElement('div');
    el.className = 'light diya placed ' + cls;
    el.innerHTML = '<div class="room"></div><div class="pool"></div><div class="halo"></div><div class="shadow"></div><div class="bowl"></div><div class="core"></div><div class="flame"></div>';
    diyaHost.appendChild(el);
    return el;
  }
  const ghost = makeDiya('ghost');           // follows the pointer while placing
  ghost.style.display = 'none';
  function sitDiya(el, fx, fy) {
    const m = map(), st = stage.getBoundingClientRect();
    const [sx, sy] = m.toScreen(fx, fy);
    const a = m.toScreen(fx - 20, fy), b = m.toScreen(fx + 20, fy);
    const perUnit = (b[0] - a[0]) / 40 * SRC_W / st.width;   // source px per floor unit, here
    el.style.setProperty('--x', ((sx - st.left) / st.width * SRC_W).toFixed(1));
    el.style.setProperty('--y', ((sy - st.top) / st.height * SRC_H).toFixed(1));
    el.style.setProperty('--h', (DIYA_SIZE * perUnit).toFixed(2));
  }
  function moveGhost(e) {
    const [fx, fy] = floorPoint(e);
    const near = nearestDiya(e);
    const show = canPlace(fx, fy) && !near;
    ghost.style.display = show ? '' : 'none';
    layer.style.cursor = near ? 'pointer' : show ? 'none' : 'not-allowed';
    if (show) sitDiya(ghost, fx, fy);
  }
  function nearestDiya(e) {
    return placed.find(d => {
      const r = d.el.querySelector('.bowl').getBoundingClientRect();
      return e.clientX > r.left - 4 && e.clientX < r.right + 4 && e.clientY > r.top - 10 && e.clientY < r.bottom + 4;
    });
  }
  function placeOrLift(e) {
    const hit = nearestDiya(e);
    if (hit) { liftDiya(hit); return; }
    const [fx, fy] = floorPoint(e);
    if (!canPlace(fx, fy)) return;
    const el = makeDiya('');
    sitDiya(el, fx, fy);
    placed.push({ el, fx, fy });
    window.diyaFlicker?.add(el);
    ghost.style.display = 'none';
  }
  // Where diyas may go: anywhere inside the rangoli, or in a band around it that
  // reaches BAND floor units out from its outermost powder, the same all round.
  // Found with a distance field over the floor, then traced from the rangoli's
  // middle outward in every direction so the edge is one clean ring (not drawn).
  const BAND = 88, CELL = 8, PAD = 136;      // floor units; PAD leaves room for the band past the square
  const GN = (N + 2 * PAD) / CELL;           // grid cells across (162)
  const ANG = 360;
  let reach = null;                          // { cx, cy, r: radius of the ring at each degree }
  function measureReach() {
    const g = N / CELL, off = PAD / CELL;
    const c = document.createElement('canvas');
    c.width = c.height = g;
    const x = c.getContext('2d');
    x.drawImage(kind === 'template' ? lineCv : freeCv, 0, 0, g, g);
    const a = x.getImageData(0, 0, g, g).data;
    const D = new Float32Array(GN * GN).fill(1e9);
    let x0 = g, y0 = g, x1 = -1, y1 = -1;
    for (let j = 0; j < g; j++) for (let i = 0; i < g; i++) {
      if (a[(j * g + i) * 4 + 3] < 40) continue;
      D[(j + off) * GN + i + off] = 0;
      x0 = Math.min(x0, i); x1 = Math.max(x1, i); y0 = Math.min(y0, j); y1 = Math.max(y1, j);
    }
    if (x1 < 0) return null;
    const S2 = Math.SQRT2;                   // two-pass chamfer distance, in cells
    for (let j = 0; j < GN; j++) for (let i = 0; i < GN; i++) {
      const k = j * GN + i; let v = D[k];
      if (i > 0) v = Math.min(v, D[k - 1] + 1);
      if (j > 0) {
        v = Math.min(v, D[k - GN] + 1);
        if (i > 0) v = Math.min(v, D[k - GN - 1] + S2);
        if (i < GN - 1) v = Math.min(v, D[k - GN + 1] + S2);
      }
      D[k] = v;
    }
    for (let j = GN - 1; j >= 0; j--) for (let i = GN - 1; i >= 0; i--) {
      const k = j * GN + i; let v = D[k];
      if (i < GN - 1) v = Math.min(v, D[k + 1] + 1);
      if (j < GN - 1) {
        v = Math.min(v, D[k + GN] + 1);
        if (i < GN - 1) v = Math.min(v, D[k + GN + 1] + S2);
        if (i > 0) v = Math.min(v, D[k + GN - 1] + S2);
      }
      D[k] = v;
    }
    const dist = (fx, fy) => {
      const i = Math.round((fx + PAD) / CELL - 0.5), j = Math.round((fy + PAD) / CELL - 0.5);
      return i < 0 || j < 0 || i >= GN || j >= GN ? 1e9 : D[j * GN + i] * CELL;
    };
    const cx = (x0 + x1 + 1) / 2 * CELL, cy = (y0 + y1 + 1) / 2 * CELL;
    const raw = new Float32Array(ANG);
    for (let k = 0; k < ANG; k++) {
      const t = k / ANG * Math.PI * 2, dx = Math.cos(t), dy = Math.sin(t);
      let r = N * 0.72 + PAD;                // start outside everything and walk in
      while (r > 0 && dist(cx + dx * r, cy + dy * r) > BAND) r -= 2;
      raw[k] = r;
    }
    const r = raw.map((_, k) => {             // smooth out the grid's steps
      let s = 0;
      for (let d = -3; d <= 3; d++) s += raw[(k + d + ANG) % ANG];
      return s / 7;
    });
    return { cx, cy, r, dist };              // dist: floor units to the nearest powder
  }
  function canPlace(fx, fy) {
    if (!reach) return false;
    const dx = fx - reach.cx, dy = fy - reach.cy;
    const k = ((Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2) * ANG;
    const k0 = Math.floor(k) % ANG, f = k - Math.floor(k);
    return Math.hypot(dx, dy) <= reach.r[k0] * (1 - f) + reach.r[(k0 + 1) % ANG] * f;
  }
  function liftDiya(d) {
    placed.splice(placed.indexOf(d), 1);
    window.diyaFlicker?.remove(d.el);
    d.el.classList.add('lift');
    setTimeout(() => d.el.remove(), 300);
  }
  function removeDiyas() {
    for (const d of placed) { window.diyaFlicker?.remove(d.el); d.el.remove(); }
    placed.length = 0;
  }
  addEventListener('resize', () => {
    mapping = null;
    for (const d of placed) sitDiya(d.el, d.fx, d.fy);
  });
  bars.diya.querySelector('[data-act="clear-diyas"]').addEventListener('click', () => removeDiyas());
  bars.diya.querySelector('[data-act="diyas-done"]').addEventListener('click', () => setMode(null));

  // ---------- Dots (Draw a rangoli) ----------
  // A grid of little powder dots to draw around, like a kolam. They sit every
  // 40px, twice the spacing of the dotted quarter lines, centred on the middle.
  const DOT_GAP = 40;
  let dotsDrawn = false;
  function drawDots() {
    const cv = plane.querySelector('.r-dots');
    cv.width = cv.height = N;
    const c = cv.getContext('2d');
    for (let y = N / 2 - DOT_GAP * 12; y <= N / 2 + DOT_GAP * 12; y += DOT_GAP) {
      for (let x = N / 2 - DOT_GAP * 12; x <= N / 2 + DOT_GAP * 12; x += DOT_GAP) {
        for (let k = 0; k < 16; k++) {
          const r = 0.6 + Math.random() * 1.1;
          c.fillStyle = WHITE[(Math.random() * WHITE.length) | 0];
          c.fillRect(x + gauss() * 1.5 - r / 2, y + gauss() * 1.5 - r / 2, r, r);
        }
      }
    }
    dotsDrawn = true;
  }
  dotsToggle.addEventListener('change', () => {
    if (dotsToggle.checked && !dotsDrawn) drawDots();
    plane.classList.toggle('dots', dotsToggle.checked);
  });

  // ---------- Colour tray ----------
  // Set down on the floor beside the rangoli while you colour it. x, y:
  // middle of each powder heap as a fraction of tray.webp (from build_tray.py).
  const POWDERS = [
    { name: 'Pink',   color: '#e3176f', x: 0.247, y: 0.226 },
    { name: 'Purple', color: '#6a1fa0', x: 0.561, y: 0.135 },
    { name: 'Green',  color: '#3f9c1d', x: 0.813, y: 0.329 },
    { name: 'Yellow', color: '#f4b80a', x: 0.519, y: 0.368 },
    { name: 'Red',    color: '#cc1430', x: 0.195, y: 0.484 },
    { name: 'Orange', color: '#f26b10', x: 0.436, y: 0.665 },
    { name: 'Blue',   color: '#1a48c2', x: 0.76, y: 0.6 },
  ].map(p => ({ ...p, shades: shades(hexRgb(p.color)) }));
  const TRAY_SIZE = 0.28;                    // tray width as a share of the rangoli's width
  const trayEl = document.getElementById('tray');
  const trayHint = document.getElementById('tray-hint');
  const trayBody = trayEl.querySelector('.tray-body');
  let colour = null;
  const powderBtns = POWDERS.map(p => {
    const b = document.createElement('button');
    b.className = 'powder';
    b.style.left = p.x * 100 + '%'; b.style.top = p.y * 100 + '%';
    b.style.setProperty('--c', p.color);
    b.setAttribute('aria-label', p.name);
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => {
      colour = p;
      powderBtns.forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      trayHint.textContent = `${p.name}. Now tap a shape to fill it`;
    });
    trayBody.appendChild(b);
    return b;
  });
  function nudge() {
    trayHint.classList.remove('nudge');
    void trayHint.offsetWidth;
    trayHint.classList.add('nudge');
  }
  function showTray(on) {
    trayEl.hidden = trayHint.hidden = !on;
    if (on) placeTray();
  }
  function placeTray() {
    // Search the floor (floor units; 0..N is the rangoli square) for the open spot
    // nearest the rangoli's right side: clear of its powder, the greeting and every
    // control. The tray's base sits on that spot, sized by perspective.
    const m = map();
    const avoid = [...document.querySelectorAll('.modes, .diya-corner, .corner-tools, .floor-bar:not([hidden]), .r-greet')]
      .map(el => el.getBoundingClientRect());
    const shape = measureReach();
    const R = N * TRAY_SIZE / 2;
    const offPowder = (fx, fy) => !shape || [[0, 0], [-1, 0], [1, 0], [0, -.6], [0, .6], [-.7, -.45], [.7, -.45], [-.7, .45], [.7, .45]]
      .every(([a, b]) => shape.dist(fx + a * R, fy + b * R) > 28);
    // the tray's picture stands up off the floor, so also keep the whole picture off the powder
    const coversNoPowder = box => {
      for (let i = 0; i <= 6; i++) for (let k = 0; k <= 6; k++) {
        const [fx, fy] = m.toFloor(box.left + (box.right - box.left) * i / 6, box.top + (box.bottom - 26 - box.top) * k / 6);
        if (shape.dist(fx, fy) < 56) return false;     // a clear margin, so it never sits over a shape's middle either
      }
      return true;
    };
    let best = null, bestScore = Infinity;
    for (let fy = -0.7 * N; fy <= 1.4 * N; fy += N * 0.04) for (let fx = -0.5 * N; fx <= 1.5 * N; fx += N * 0.04) {
      const [cx, cy] = m.toScreen(fx, fy);
      const a = m.toScreen(fx - R, fy), b = m.toScreen(fx + R, fy);
      const w = b[0] - a[0], h = w * 519 / 640;
      const box = { left: cx - w / 2, top: cy - h * 0.8, right: cx + w / 2, bottom: cy + h * 0.2 + 26, w };   // + room for the hint
      if (w <= 0 || box.left < 8 || box.top < 8 || box.right > innerWidth - 8 || box.bottom > innerHeight - 8) continue;
      if (!avoid.every(r => box.right < r.left || box.left > r.right || box.bottom < r.top || box.top > r.bottom)) continue;
      if (!offPowder(fx, fy)) continue;
      if (shape && !coversNoPowder(box)) continue;
      const score = Math.hypot(fx - N * 1.12, fy - N * 0.55);
      if (score < bestScore) { bestScore = score; best = box; }
    }
    best ||= (() => { const [cx, cy] = m.toScreen(N * 1.17, N * 0.62); return { left: cx - 60, top: cy - 80, w: 120 }; })();
    trayEl.style.left = best.left + 'px'; trayEl.style.top = best.top + 'px'; trayEl.style.width = best.w + 'px';
    // the hint sits on one line right under the tray, kept on screen
    const hw = trayHint.offsetWidth;
    const cx = Math.min(innerWidth - 8 - hw / 2, Math.max(8 + hw / 2, best.left + best.w / 2));
    trayHint.style.left = cx + 'px';
    trayHint.style.top = (best.top + best.w * 519 / 640 + 8) + 'px';
  }
  addEventListener('resize', () => { if (!trayEl.hidden) placeTray(); });

  // ---------- शुभ दीपावली on the floor above the rangoli ----------
  // Always there and never touched by Clear or the modes: letters filled with
  // coloured powder and edged in white powder, laid on the floor like the rangoli.
  const GREET_Y = -400, GREET_H = 320;       // floor units: the band it sits in, above the square
  const STRETCH = 1.7;                       // drawn taller so it reads true once the floor's perspective flattens it
  (async function drawGreeting() {
    const cv = plane.querySelector('.r-greet');
    cv.width = N; cv.height = GREET_H;
    cv.dataset.y = GREET_Y;                  // for the downloaded picture
    const text = 'शुभ दीपावली', family = '"Yatra One", serif';
    try { await document.fonts.load(`100px ${family}`, text); } catch {}
    // the letters as two masks: their body, and a stroke round them for the white edge
    const mask = () => { const c = document.createElement('canvas'); c.width = N; c.height = GREET_H; return c.getContext('2d'); };
    const body = mask(), edge = mask();
    body.font = `100px ${family}`;
    const size = Math.min(100 * 860 / body.measureText(text).width, 150);
    for (const c of [body, edge]) {
      c.font = `${size}px ${family}`; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.setTransform(1, 0, 0, STRETCH, 0, GREET_H / 2 + 10);
    }
    body.fillText(text, N / 2, 0);
    edge.lineWidth = 6; edge.lineJoin = 'round';
    edge.strokeText(text, N / 2, 0);
    const B = body.getImageData(0, 0, N, GREET_H).data, E = edge.getImageData(0, 0, N, GREET_H).data;
    const g = cv.getContext('2d');
    const bands = ['#f4b80a', '#f26b10', '#e3176f', '#9b2fb0'].map(c => shades(hexRgb(c)));   // left to right
    for (let y = 0; y < GREET_H; y++) for (let x = 0; x < N; x++) {
      const k = (y * N + x) * 4 + 3;
      if (E[k] > 90) {                       // white powder edge
        if (Math.random() < .7) {
          const s = .6 + Math.random() * 1.2;
          g.fillStyle = WHITE[(Math.random() * WHITE.length) | 0];
          g.fillRect(x + gauss() * .8 - s / 2, y + gauss() * .8 - s / 2, s, s);
        }
      } else if (B[k] > 128) {               // coloured powder inside the letter
        const sh = bands[Math.max(0, Math.min(3, Math.floor((x / N + gauss() * .03) * 4)))];
        for (let n = 0; n < 3; n++) {
          const s = .8 + Math.random() * 1.3;
          g.fillStyle = sh[(Math.random() * sh.length) | 0];
          g.fillRect(x + Math.random() - s / 2, y + Math.random() - s / 2, s, s);
        }
      }
    }
  })();

  updateButtons();
  window.rangoli = { start, startFree, startTemplate, clearAll, step, setMode, map, pen, fills, placed,   // handy for testing from the console
                     get job() { return job; }, get kind() { return kind; }, get made() { return made; }, get shapes() { return shapes; } };   // handy for testing from the console
})();
