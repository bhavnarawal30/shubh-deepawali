// Top-right buttons.
//  - Download: rebuilds the courtyard with your rangoli and diyas as a picture
//    (photo, rangoli warped onto the floor, every diya's light) and saves it.
//  - Music: switches the festive track (<audio id="music">) on and off.
(() => {
  const SRC_W = 1672, SRC_H = 941;           // the photo's size; the stage is laid out in these units
  const SCALE = 2;                           // saved picture is twice that, so the powder stays crisp
  const N = 1024;                            // rangoli drawing resolution
  const stage = document.getElementById('stage');
  const plane = document.getElementById('rangoli');
  const photo = stage.querySelector('.photo');

  // ---------- CSS filters, by hand (canvas filters aren't supported everywhere) ----------
  function adjust(img, { brightness = 1, contrast = 1, saturate = 1, sepia = 0 }) {
    const d = img.data;
    const s = saturate, q = sepia;
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
      if (q) {
        const sr = .393 * r + .769 * g + .189 * b, sg = .349 * r + .686 * g + .168 * b, sb = .272 * r + .534 * g + .131 * b;
        r += (sr - r) * q; g += (sg - g) * q; b += (sb - b) * q;
      }
      if (s !== 1) {
        const nr = (.213 + .787 * s) * r + (.715 - .715 * s) * g + (.072 - .072 * s) * b;
        const ng = (.213 - .213 * s) * r + (.715 + .285 * s) * g + (.072 - .072 * s) * b;
        const nb = (.213 - .213 * s) * r + (.715 - .715 * s) * g + (.072 + .928 * s) * b;
        r = nr; g = ng; b = nb;
      }
      r = ((r * brightness) - .5) * contrast + .5;
      g = ((g * brightness) - .5) * contrast + .5;
      b = ((b * brightness) - .5) * contrast + .5;
      d[i] = r * 255; d[i + 1] = g * 255; d[i + 2] = b * 255;   // clamped by the typed array
    }
    return img;
  }

  // A "closest-side" radial gradient filling an ellipse, like the CSS glows.
  function glow(ctx, cx, cy, rx, ry, stops, op = 'screen') {
    ctx.save();
    ctx.globalCompositeOperation = op;
    ctx.translate(cx, cy); ctx.scale(rx, ry);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    for (const [o, c] of stops) g.addColorStop(o, c);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // ---------- Rangoli onto the floor ----------
  // The floor is a perspective quad, so the drawing is laid on in small
  // triangles, each an affine piece of the full perspective mapping.
  function tri(ctx, img, s, d) {
    const cx = (d[0][0] + d[1][0] + d[2][0]) / 3, cy = (d[0][1] + d[1][1] + d[2][1]) / 3;
    const grow = p => { const dx = p[0] - cx, dy = p[1] - cy, l = Math.hypot(dx, dy) || 1; return [p[0] + dx / l * .6, p[1] + dy / l * .6]; };
    const [x0, y0] = s[0], [x1, y1] = s[1], [x2, y2] = s[2];
    const [u0, v0] = d[0], [u1, v1] = d[1], [u2, v2] = d[2];
    const den = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    const a = ((u1 - u0) * (y2 - y0) - (u2 - u0) * (y1 - y0)) / den;
    const c = ((u2 - u0) * (x1 - x0) - (u1 - u0) * (x2 - x0)) / den;
    const b = ((v1 - v0) * (y2 - y0) - (v2 - v0) * (y1 - y0)) / den;
    const e = ((v2 - v0) * (x1 - x0) - (v1 - v0) * (x2 - x0)) / den;
    ctx.save();
    ctx.beginPath();
    d.map(grow).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath(); ctx.clip();
    ctx.transform(a, b, c, e, u0 - a * x0 - c * y0, v0 - b * x0 - e * y0);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
  }
  // img pixel (x, y) sits on the floor at (x, y0 + y)
  function warp(ctx, img, toSrc, y0 = 0, n = 32) {
    const ny = Math.max(4, Math.round(n * img.height / img.width));
    for (let j = 0; j < ny; j++) for (let i = 0; i < n; i++) {
      const p = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]].map(([a, b]) => [a / n * img.width, b / ny * img.height]);
      const q = p.map(([x, y]) => toSrc(x, y0 + y));
      tri(ctx, img, [p[0], p[1], p[2]], [q[0], q[1], q[2]]);
      tri(ctx, img, [p[0], p[2], p[3]], [q[0], q[2], q[3]]);
    }
  }
  function rangoliLayer() {
    // whatever is on show: the coloured stencil, or your freehand drawing (+ dots if they're on)
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const x = c.getContext('2d');
    const color = window.rangoli.floor === 'color';
    const layers = color ? [['.r-fill', .3], ['.r-line', .45]]
                         : [['.r-dots', .45, plane.classList.contains('dots')], ['.r-free', .45]];
    for (const [sel, shadow, on = true] of layers) {
      if (!on) continue;
      x.shadowColor = `rgba(0,0,0,${shadow})`; x.shadowOffsetY = 2; x.shadowBlur = 2;
      x.drawImage(plane.querySelector(sel), 0, 0);
    }
    x.putImageData(adjust(x.getImageData(0, 0, N, N), { brightness: .88, sepia: .1, saturate: 1.05 }), 0, 0);
    return c;
  }

  // ---------- Diyas and fairy lights ----------
  const num = (el, v, d = 0) => parseFloat(el.style.getPropertyValue(v)) || d;
  function flame(ctx, x, y, h) {
    glow(ctx, x, y - .5 * h, 1.1 * h, 1.3 * h, [[0, 'rgba(255,240,200,.9)'], [.45, 'rgba(255,190,90,.4)'], [1, 'rgba(255,190,90,0)']]);
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.shadowColor = 'rgba(255,190,90,.75)'; ctx.shadowBlur = h * .5 * SCALE;
    ctx.beginPath(); ctx.ellipse(x, y - .6 * h, .25 * h, .6 * h, 0, 0, Math.PI * 2); ctx.clip();
    glow(ctx, x, y - .336 * h, .225 * h, .72 * h, [[0, '#fff'], [.25, '#fff'], [.42, '#fff4c8'], [.62, '#ffcb5c'], [.8, 'rgba(255,120,20,.6)'], [1, 'rgba(255,120,20,0)']]);
    ctx.restore();
  }
  function diyaLight(ctx, x, y, h, placed) {
    const rw = placed ? h * 18 : 620, rh = placed ? h * 13 : 520;
    glow(ctx, x, y, rw / 2, rh / 2, [[0, 'rgba(255,150,50,.85)'], [.45, 'rgba(255,120,30,.35)'], [1, 'rgba(255,120,30,0)']], 'overlay');
    glow(ctx, x, y + .55 * h, 4.5 * h, 1.3 * h, [[0, 'rgba(255,170,80,.75)'], [.55, 'rgba(255,120,40,.25)'], [1, 'rgba(255,120,40,0)']], 'color-dodge');
    glow(ctx, x, y - .55 * h, 3 * h, 3 * h, [[0, 'rgba(255,220,160,.75)'], [.28, 'rgba(255,170,80,.35)'], [.62, 'rgba(255,130,40,.1)'], [1, 'rgba(255,130,40,0)']], 'color-dodge');
  }
  const bowl = new Image();
  bowl.src = 'diya-bowl.png';
  function placedDiya(ctx, el) {
    const x = num(el, '--x'), y = num(el, '--y'), h = num(el, '--h');
    diyaLight(ctx, x, y, h, true);
    // contact shadow, then the clay bowl, then the flame
    const sx = x + .21 * h, sy = y + .76 * h;
    glow(ctx, sx, sy, 2.1 * h, .75 * h, [[0, 'rgba(25,10,3,.75)'], [.55, 'rgba(25,10,3,.35)'], [1, 'rgba(25,10,3,0)']], 'multiply');
    glow(ctx, sx, sy, 2.1 * h, .75 * h, [[0, 'rgba(12,4,0,1)'], [.3, 'rgba(12,4,0,1)'], [.42, 'rgba(12,4,0,.6)'], [.56, 'rgba(12,4,0,0)']], 'multiply');
    const w = 3.36 * h, bh = 2.11 * h;
    ctx.drawImage(bowl, x - .404 * w, y - .508 * bh, w, bh);
    flame(ctx, x, y, h);
  }
  function bulb(ctx, el) {
    const x = num(el, '--x'), y = num(el, '--y'), s = num(el, '--s', 11);
    glow(ctx, x, y, 35, 35, [[0, 'rgba(255,190,100,.8)'], [.45, 'rgba(255,150,60,.25)'], [1, 'rgba(255,150,60,0)']], 'color-dodge');
    glow(ctx, x, y, s / 2 + 22, s / 2 + 22, [[0, 'rgba(255,170,70,.45)'], [1, 'rgba(255,170,70,0)']]);
    glow(ctx, x, y, s / 2 + 8, s / 2 + 8, [[0, 'rgba(255,225,160,.95)'], [1, 'rgba(255,225,160,0)']]);
    glow(ctx, x, y, s / 2, s / 2, [[0, '#fff'], [.35, '#fff'], [.6, '#ffeab0'], [1, 'rgba(255,200,110,0)']]);
  }

  // ---------- The picture ----------
  async function snapshot() {
    if (!bowl.complete) await new Promise(r => (bowl.onload = r));
    const cv = document.createElement('canvas');
    cv.width = SRC_W * SCALE; cv.height = SRC_H * SCALE;
    const ctx = cv.getContext('2d');

    // the photo, dimmed like on the page
    ctx.drawImage(photo, 0, 0, cv.width, cv.height);
    ctx.putImageData(adjust(ctx.getImageData(0, 0, cv.width, cv.height), { brightness: .68, contrast: 1.1, saturate: 1.15 }), 0, 0);
    ctx.scale(SCALE, SCALE);                  // from here on, source pixels

    // the rangoli, laid onto the floor exactly where it sits on screen
    const m = window.rangoli.map(), st = stage.getBoundingClientRect();
    const toSrc = (fx, fy) => { const [sx, sy] = m.toScreen(fx, fy); return [(sx - st.left) / st.width * SRC_W, (sy - st.top) / st.height * SRC_H]; };
    warp(ctx, rangoliLayer(), toSrc);
    const greet = plane.querySelector('.r-greet');            // शुभ दीपावली above it
    const gc = document.createElement('canvas');
    gc.width = greet.width; gc.height = greet.height;
    const gx = gc.getContext('2d');
    gx.shadowColor = 'rgba(0,0,0,.4)'; gx.shadowOffsetY = 2; gx.shadowBlur = 2;
    gx.drawImage(greet, 0, 0);
    gx.putImageData(adjust(gx.getImageData(0, 0, gc.width, gc.height), { brightness: .88, sepia: .1, saturate: 1.05 }), 0, 0);
    warp(ctx, gc, toSrc, +greet.dataset.y);

    // diyas you set (only the ones on show), then the photo's diyas and fairy lights
    for (const el of document.querySelectorAll('#placed-diyas .diya:not(.ghost)')) {
      if (el.style.display !== 'none') placedDiya(ctx, el);
    }
    for (const el of stage.querySelectorAll(':scope > .diya')) {
      const x = num(el, '--x'), y = num(el, '--y'), h = num(el, '--h');
      diyaLight(ctx, x, y, h, false);
      flame(ctx, x, y, h);
    }
    for (const el of document.querySelectorAll('#bulbs .bulb')) bulb(ctx, el);

    // the same soft vignette as the page
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.save();
    ctx.translate(cv.width / 2, cv.height * .4); ctx.scale(cv.width * .75, cv.height * .7);
    const v = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    v.addColorStop(0, 'rgba(15,6,0,0)'); v.addColorStop(.55, 'rgba(15,6,0,0)'); v.addColorStop(1, 'rgba(15,6,0,.55)');
    ctx.fillStyle = v; ctx.fillRect(-2, -2, 4, 4);
    ctx.restore();
    return cv;
  }

  const dl = document.getElementById('download-btn');
  dl.addEventListener('click', async () => {
    if (dl.classList.contains('busy')) return;
    dl.classList.add('busy');
    await new Promise(r => setTimeout(r, 30));          // let the spinner show before the heavy work
    try {
      const cv = await snapshot();
      const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', .92));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'my-rangoli.jpg';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      dl.classList.add('done');
      setTimeout(() => dl.classList.remove('done'), 1600);
    } finally {
      dl.classList.remove('busy');
    }
  });

  // ---------- Music ----------
  const music = document.getElementById('music');
  const mb = document.getElementById('music-btn');
  // The track is loud, so it plays at a fixed, gentle level: about 3% of the
  // file's own volume (what "70%" was on the old slider), whatever the device is set to.
  const VOLUME = .06 * .7 ** 2;
  let fade = 0;
  mb.addEventListener('click', () => {
    const on = mb.getAttribute('aria-pressed') !== 'true';
    mb.setAttribute('aria-pressed', String(on));
    mb.dataset.tip = on ? 'Music on. Tap to turn it off' : 'Play festive music';
    mb.setAttribute('aria-label', on ? 'Turn music off' : 'Play festive music');
    clearInterval(fade);
    if (on) { music.volume = 0; music.play().catch(() => {}); }
    const from = music.volume, to = on ? VOLUME : 0, t0 = performance.now();
    fade = setInterval(() => {                             // gentle fade in and out (a timer, so it finishes in a background tab too)
      const k = Math.min(1, (performance.now() - t0) / 800);
      music.volume = from + (to - from) * k;
      if (k < 1) return;
      clearInterval(fade);
      if (!on) music.pause();
    }, 30);
  });

  window.rangoliSnapshot = snapshot;                     // handy for testing from the console
})();
