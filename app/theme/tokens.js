// The same tokens as tokens.css, for code that paints on a canvas (the overlay). Loaded before the overlay's
// scripts; sidecar/test/theme.test.mjs checks both files agree. Colours as hex, and as [r, g, b] in .rgb.
(() => {
  const hex = {
    bg: '#0b0f19', panel: '#111827', raise: '#0f1522', line: '#1f2937', line2: '#273244',
    text: '#e5e7eb', muted: '#6b7280', dim: '#9ca3af',
    acc: '#22d3ee', accInk: '#04131a', ok: '#34d399', warn: '#fbbf24', bad: '#f87171',
  };
  const rgb = Object.fromEntries(Object.entries(hex).map(([k, h]) => [k, [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))]));
  const theme = {
    ...hex, rgb, wave: hex.ok, r: 10,
    mono: 'ui-monospace, "SF Mono", SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace',
    sans: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif',
    rgba: (name, a) => `rgba(${rgb[name].join(',')},${a})`,
  };
  // The Tiro figure's five levels, dark to bright: the background, then the accent over it at 25%, 50% and 80% (what
  // rgba(34, 211, 238, .5) looks like on --bg), then the accent itself. Cyan only: no white.
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  theme.sprite = [rgb.bg, mix(rgb.bg, rgb.acc, 0.25), mix(rgb.bg, rgb.acc, 0.5), mix(rgb.bg, rgb.acc, 0.8), rgb.acc];
  if (typeof window !== 'undefined') window.TiroTheme = theme;
  if (typeof module !== 'undefined') module.exports = theme;
})();
