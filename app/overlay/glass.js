// The card look shared by the Sidekick's own UI (bubbles, the thinking tag, task tags, the step list) and the
// drawings' cards (ink.js): TiroDash's panel (theme/tokens.js): an opaque slate fill, a 1px edge, 10px corners,
// monospace type. No glass, glow or glint.
(() => {
  const R = window.Tiro;
  if (!R || typeof document === 'undefined') return;
  const T = window.TiroTheme;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  // The names the overlay has always used, on TiroDash's tokens: ACC the accent, HOT the brightest ink, MID and DEEP
  // quieter marks, CORAL trouble, NOTE and DIM secondary text.
  const ACC = T.acc, HOT = T.text, MID = T.muted, DEEP = T.line2, EDGE = T.rgba('bg', 0.6);
  const GLASS = T.panel, TEXT = T.text, DIM = T.dim, CORAL = T.bad, NOTE = T.dim, LINE = T.line2;
  const MONO = T.mono, SANS = T.sans;
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const rgba = (h, a) => `rgba(${hex(h).join(',')},${a})`;

  // A rounded box (corner r), with an optional tail: { side: 'top'|'right'|'bottom'|'left', at, to: [x, y], w } is a
  // small triangle on that side, centred at `at` along it and pointing at `to`.
  function cardPath(x, y, w, h, r = T.r, tail = null) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    const p = new Path2D(), b = y + h, rt = x + w;
    let t = null;
    if (tail) {
      const across = tail.side === 'top' || tail.side === 'bottom';
      const len = across ? w : h, w0 = Math.min(tail.w ?? 12, len - 2 * r - 4);
      if (w0 > 1) {
        const at = clamp(tail.at - (across ? x : y), r + w0 / 2 + 2, len - r - w0 / 2 - 2) + (across ? x : y);
        const n = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] }[tail.side];
        const base = across ? [at, tail.side === 'top' ? y : b] : [tail.side === 'left' ? x : rt, at];
        const to = tail.to ?? [base[0] + n[0] * 12, base[1] + n[1] * 12];
        const depth = clamp((to[0] - base[0]) * n[0] + (to[1] - base[1]) * n[1], 6, tail.max ?? 14);
        const shift = clamp(across ? to[0] - base[0] : to[1] - base[1], -w0, w0) * 0.5;
        const tipP = across ? [at + shift, base[1] + n[1] * depth] : [base[0] + n[0] * depth, at + shift];
        t = { side: tail.side, a: at - w0 / 2, b: at + w0 / 2, tip: tipP };
      }
    }
    // Clockwise from the top-left corner; the tail is drawn where its side is walked.
    p.moveTo(x + r, y);
    if (t?.side === 'top') { p.lineTo(t.a, y); p.lineTo(t.tip[0], t.tip[1]); p.lineTo(t.b, y); }
    p.lineTo(rt - r, y); p.arcTo(rt, y, rt, y + r, r);
    if (t?.side === 'right') { p.lineTo(rt, t.a); p.lineTo(t.tip[0], t.tip[1]); p.lineTo(rt, t.b); }
    p.lineTo(rt, b - r); p.arcTo(rt, b, rt - r, b, r);
    if (t?.side === 'bottom') { p.lineTo(t.b, b); p.lineTo(t.tip[0], t.tip[1]); p.lineTo(t.a, b); }
    p.lineTo(x + r, b); p.arcTo(x, b, x, b - r, r);
    if (t?.side === 'left') { p.lineTo(x, t.b); p.lineTo(t.tip[0], t.tip[1]); p.lineTo(x, t.a); }
    p.lineTo(x, y + r); p.arcTo(x, y, x + r, y, r);
    p.closePath();
    return p;
  }

  // The panel: slate fill and a 1px edge (the accent by default, as the bubbles point at Tiro). corner: radius.
  function chrome(c, x, y, w, h, o = {}) {
    const path = o.path || cardPath(x, y, w, h, o.corner ?? T.r, o.tail);
    c.save();
    c.fillStyle = GLASS; c.fill(path);
    c.strokeStyle = o.edge || ACC; c.lineWidth = 1; c.stroke(path);
    c.restore();
  }

  const meas = document.createElement('canvas').getContext('2d');
  const textW = (s, font) => { meas.font = font; return meas.measureText(String(s ?? '')).width; };
  // Words typing themselves in. Returns the full width.
  function typed(c, str, x, y, font, color, u = 1, o = {}) {
    str = String(str ?? '');
    c.save(); c.font = font; c.textBaseline = o.baseline || 'middle'; c.textAlign = 'left';
    const full = c.measureText(str).width, x0 = o.anchor === 'middle' ? x - full / 2 : o.anchor === 'end' ? x - full : x;
    const n = Math.floor(str.length * clamp(u, 0, 1));
    if (n > 0) { c.fillStyle = color; c.fillText(n >= str.length ? str : str.slice(0, n), x0, y); }
    c.restore();
    return full;
  }
  // Lines of at most w px (a word wider than a line is broken); past max rows the last one ends in an ellipsis.
  function wrapRows(str, w, font, max = Infinity) {
    meas.font = font;
    const fits = (t) => meas.measureText(t).width <= w, rows = [];
    for (const para of String(str ?? '').split('\n')) {
      let row = '';
      for (let wd of para.split(/\s+/).filter(Boolean)) {
        const tr = row ? `${row} ${wd}` : wd;
        if (fits(tr)) { row = tr; continue; }
        if (row) { rows.push(row); row = ''; }
        while (!fits(wd)) { let k = wd.length - 1; while (k > 1 && !fits(wd.slice(0, k))) k--; rows.push(wd.slice(0, k)); wd = wd.slice(k); }
        row = wd;
      }
      rows.push(row);
    }
    if (rows.length > max) {
      const rest = rows.splice(max), full = `${rows[max - 1]} ${rest.join(' ')}`;
      let last = full;
      while (last && !fits(`${last}…`)) last = last.slice(0, -1);
      // End on a whole word when one is close, rather than mid-word.
      const sp = last.lastIndexOf(' ');
      if (full[last.length] !== ' ' && sp > last.length * 0.6) last = last.slice(0, sp);
      rows[max - 1] = `${last.trimEnd()}…`;
    }
    return rows;
  }
  // A hand-drawn ring: a slightly wobbly circle that overshoots where it closes, the same each time for one seed.
  const ringPts = (cx, cy, r, seed = 0) => Array.from({ length: 34 }, (_, i) => {
    const a = -2.2 + (i / 30) * Math.PI * 2, k = 1 + 0.06 * Math.sin(i * 1.7 + seed) + (i > 28 ? 0.08 : 0);
    return [cx + Math.cos(a) * r * k, cy + Math.sin(a) * r * k];
  });
  // The pen's stroke (a dark edge so it reads on white, then the colour), drawn up to u of its length.
  function pen(c, pts, color, w = 2.2, u = 1) {
    const n = Math.max(2, Math.ceil(pts.length * clamp(u, 0, 1)));
    if (u <= 0) return;
    const path = new Path2D(); pts.slice(0, n).forEach((q, i) => (i ? path.lineTo(q[0], q[1]) : path.moveTo(q[0], q[1])));
    c.save(); c.lineCap = 'round'; c.lineJoin = 'round';
    c.strokeStyle = EDGE; c.lineWidth = w + 2; c.stroke(path);
    c.strokeStyle = color; c.lineWidth = w; c.stroke(path);
    c.restore();
  }

  // A button as TiroDash draws one: filled is the accent with dark ink, otherwise a ghost with a 1px edge. focus adds
  // the thin cyan ring (the keyboard's choice); down presses it a pixel.
  const CHIP_F = `600 12px ${SANS}`, INK_DARK = T.accInk;
  const chipW = (label) => Math.round(textW(label, CHIP_F) + 24);
  function chip(c, x, y, w, h, label, o = {}) {
    c.save();
    if (o.focus) { c.strokeStyle = ACC; c.lineWidth = 1; c.stroke(cardPath(x - 3, y - 3, w + 6, h + 6, 10)); }
    if (o.down) c.translate(0, 1);
    const face = cardPath(x, y, w, h, 8);
    if (o.filled) { c.globalAlpha *= o.hover ? 0.9 : 1; c.fillStyle = ACC; c.fill(face); c.globalAlpha = 1; }
    else { c.fillStyle = GLASS; c.fill(face); c.strokeStyle = o.hover ? ACC : LINE; c.lineWidth = 1; c.stroke(face); }
    c.font = CHIP_F; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = o.filled ? INK_DARK : TEXT;
    c.fillText(String(label ?? ''), x + w / 2, y + h / 2 + 0.5);
    c.restore();
  }

  R.glass = { ACC, HOT, MID, DEEP, EDGE, GLASS, TEXT, DIM, CORAL, NOTE, LINE, MONO, SANS, OK: T.ok, WAVE: T.wave, rgba, cardPath, chrome, textW, typed, wrapRows, ringPts, pen, chip, chipW, CHIP_H: 24 };
})();
