// What Tiro just read on screen, marked for a moment: a thin green box round the window it looked at (a screenshot,
// reading a window), or a green underline under the window's title bar when it only read the context (the window's
// name, the highlighted text). Drawn after the read, so it's never in the picture it took. The sidecar sends
// { kind: 'readmark', bounds: [x, y, w, h] in screen points, style: 'box' | 'line' }; host.js hands it here.
// The phosphor green is theme/tokens.js ok; no glow (the status dot is the only one).
(() => {
  const R = window.Tiro;
  if (!R || typeof document === 'undefined') return;
  const T = window.TiroTheme;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const css = `
.rm { position: fixed; z-index: 2147482000; pointer-events: none; box-sizing: border-box; border: 2px solid ${T.ok}; border-radius: 8px;
  animation: rm-box 1.4s cubic-bezier(.2, .8, .2, 1) both; }
.rm::after { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 2px; background: ${T.ok}; opacity: .55; animation: rm-scan 1s ease-in-out both; }
.rm.line { border: 0; border-radius: 1px; height: 2px !important; background: ${T.ok}; animation: rm-line 1.4s cubic-bezier(.2, .8, .2, 1) both; transform-origin: left center; }
.rm.line::after { display: none; }
@keyframes rm-box { 0% { opacity: 0; transform: scale(1.015); } 15% { opacity: 1; transform: none; } 70% { opacity: 1; } 100% { opacity: 0; } }
@keyframes rm-scan { from { top: 0; } to { top: calc(100% - 2px); opacity: 0; } }
@keyframes rm-line { 0% { opacity: 1; transform: scaleX(0); } 35% { transform: scaleX(1); } 75% { opacity: 1; } 100% { opacity: 0; transform: scaleX(1); } }
@media (prefers-reduced-motion: reduce) { .rm, .rm.line { animation: rm-fade 1.2s linear both; } .rm::after { display: none; } @keyframes rm-fade { 0%, 70% { opacity: 1; } 100% { opacity: 0; } } }
`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // Screen points → this overlay's CSS px (each overlay covers one screen; R.origin is its corner).
  const local = ([x, y, w, h]) => [x - (R.origin?.x ?? 0), y - (R.origin?.y ?? 0), w, h];
  const ok = (b) => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[2] > 4 && b[3] > 4;

  R.readMark = (m) => {
    if (!ok(m?.bounds)) return;
    const [x, y, w, h] = local(m.bounds);
    // Not on this screen: another overlay draws it.
    if (x + w < 0 || y + h < 0 || x > innerWidth || y > innerHeight) return;
    const line = m.style === 'line';
    const el = document.createElement('div');
    el.className = `rm${line ? ' line' : ''}`;
    el.setAttribute('aria-hidden', 'true');
    // The underline sits just under the title bar (about 32 px down), the box hugs the window.
    Object.assign(el.style, line
      ? { left: `${x + 8}px`, top: `${y + Math.min(34, h - 2)}px`, width: `${Math.max(0, w - 16)}px` }
      : { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), reduced.matches ? 1300 : 1500);
  };
})();
