import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Tiro's one look: theme/tokens.css and tokens.js hold TiroDash's tokens (cijamie/tiro, brain/app/static/next.html),
// and the restyled pages use nothing else: no colour outside them, no gradients, no glow but the green status dot,
// no pixel fonts.
const app = (p) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const src = (p) => readFileSync(app(p), 'utf8');
const theme = createRequire(import.meta.url)(app('theme/tokens.js'));

// TiroDash's tokens, as next.html has them.
const DASH = {
  bg: '#0b0f19', panel: '#111827', raise: '#0f1522', line: '#1f2937', line2: '#273244',
  text: '#e5e7eb', muted: '#6b7280', dim: '#9ca3af',
  acc: '#22d3ee', 'acc-ink': '#04131a', ok: '#34d399', warn: '#fbbf24', bad: '#f87171',
};
const css = src('theme/tokens.css');
for (const [name, hex] of Object.entries(DASH)) {
  assert.match(css, new RegExp(`--${name}: ${hex};`), `tokens.css --${name} is TiroDash's ${hex}`);
  assert.equal(theme[name.replace(/-(\w)/g, (_, c) => c.toUpperCase())], hex, `tokens.js ${name} matches`);
}
assert.match(css, /--r: 10px;/);
assert.equal(theme.r, 10);
assert.match(css, /--mono: ui-monospace, "SF Mono", SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace;/);
assert.equal(theme.mono, 'ui-monospace, "SF Mono", SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace');
assert.match(css, /:focus-visible \{ outline: 1px solid var\(--acc\)/, 'keyboard focus: a thin cyan ring');

// The figure's levels: the background up to the accent, cyan only.
assert.equal(theme.sprite.length, 5);
assert.deepEqual(theme.sprite[0], theme.rgb.bg);
assert.deepEqual(theme.sprite[4], theme.rgb.acc);
for (let i = 1; i < 5; i++) assert.ok(theme.sprite[i][2] > theme.sprite[i - 1][2], 'each level is brighter cyan than the last');

// Every colour in a restyled page is a token, or a token at some opacity. (The cursor in the drawing demo is the
// system arrow: white with a black edge.)
const OK = new Set(Object.values(DASH).map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(',')));
const CURSOR = new Set(['#ffffff', '#000000']);
const PAGES = ['onboarding/onboarding.css', 'panel/panel.css', 'theme/tokens.css'];
for (const page of PAGES) {
  const text = src(page).replace(/\/\*[\s\S]*?\*\//g, '').replace(/url\("data:[^"]*"\)/g, '');
  for (const [hex] of text.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g)) {
    assert.ok(Object.values(DASH).includes(hex.toLowerCase()) || CURSOR.has(hex.toLowerCase()), `${page}: ${hex} is not a TiroDash token`);
  }
  for (const [, r, g, b] of text.matchAll(/rgba?\((\d+),\s*(\d+),\s*(\d+)/g)) {
    assert.ok(OK.has(`${r},${g},${b}`), `${page}: rgb(${r}, ${g}, ${b}) is not a TiroDash token`);
  }
  assert.ok(!/gradient\(/.test(text), `${page}: no gradients`);
  assert.ok(!/Martian Mono|Doto|text-shadow|drop-shadow|backdrop-filter/.test(text), `${page}: no pixel fonts, glow or glass`);
  // The only outward shadow is the status dot's green glow; inset ones mark the current tab or page.
  for (const [, v] of text.matchAll(/box-shadow:\s*([^;]+);/g)) {
    assert.ok(/^(none|inset\b.*|0 0 8px rgba\(52, 211, 153, \.5\))$/.test(v.trim()), `${page}: box-shadow ${v} is a glow`);
  }
}

// Labels: monospace caps in brackets that never wrap.
for (const [page, sel] of [['panel/panel.css', '.side-label'], ['panel/panel.css', '.sub'], ['onboarding/onboarding.css', '.waiting']]) {
  const text = src(page);
  assert.ok(text.includes(`${sel}::before { content: "[ "; }`), `${page} ${sel} is in brackets`);
  const rule = text.match(new RegExp(`\\n${sel.replace('.', '\\.')} \\{[^}]*\\}`))?.[0] ?? '';
  assert.match(rule, /var\(--mono\)/, `${sel} is monospace`);
  assert.match(rule, /text-transform: uppercase/, `${sel} is in caps`);
  assert.match(rule, /white-space: nowrap/, `${sel} never wraps`);
}

// Pages load the tokens before their own styles and scripts.
for (const page of ['onboarding/index.html', 'panel/index.html']) {
  const html = src(page);
  assert.ok(html.indexOf('theme/tokens.css') > -1 && html.indexOf('theme/tokens.css') < html.indexOf('onboarding.css'), `${page} loads tokens.css first`);
  assert.ok(html.indexOf('theme/tokens.js') > -1 && html.indexOf('theme/tokens.js') < html.indexOf('overlay/core.js'), `${page} loads tokens.js first`);
}
assert.ok(src('desktop.html').indexOf('theme/tokens.js') < src('desktop.html').indexOf('overlay/core.js'), 'the overlay loads tokens.js first');
assert.match(src('tauri/build.sh'), /cp -R \.\.\/theme /, 'build.sh ships the theme folder');

// The panel's open and close: panel.js waits for the animations panel.css really has.
const pcss = src('panel/panel.css'), pjs = src('panel/panel.js');
for (const name of ['open-in', 'open-in-up', 'shut-out']) assert.ok(pcss.includes(`@keyframes ${name} `), `panel.css has ${name}`);
assert.ok(pjs.includes("e.animationName.startsWith('open-in')") && pjs.includes("e.animationName === 'shut-out'"));
// The figures have no glow.
for (const page of ['panel/panel.js', 'onboarding/onboarding.js', 'overlay/12-sidekick.js']) {
  assert.ok(!/glow: 0\.\d/.test(src(page)), `${page}: the figure has no glow`);
  assert.ok(src(page).includes('TiroTheme.sprite'), `${page}: the figure uses the theme's colours`);
}
// The overlay paints with the tokens too: no colour literals (the one '#fff' is agent.js's glyph mask, never
// shown), no glow or blur, no pixel fonts, and the CRT entrance is gone.
const OVERLAY = ['glass.js', 'agent.js', 'agent-home.js', 'agent-panel.js', 'ask-bar.js', 'ink.js', 'pen.js', 'minis.js', 'agent-cards.js', '12-sidekick.js'];
for (const f of OVERLAY) {
  const text = src(`overlay/${f}`).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const hexes = [...text.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g)].map((m) => m[0]).filter((h) => !(f === 'agent.js' && h === '#fff'));
  assert.deepEqual(hexes, [], `overlay/${f}: colours come from the theme`);
  for (const [, r, g, b] of text.matchAll(/rgba?\((\d+),\s*(\d+),\s*(\d+)/g)) assert.ok(OK.has(`${r},${g},${b}`), `overlay/${f}: rgb(${r}, ${g}, ${b}) is not a token`);
  assert.ok(!/shadowBlur = [1-9a-z]|filter = `blur|drop-shadow|Martian Mono|"Doto"/.test(text), `overlay/${f}: no glow, blur or pixel fonts`);
}
assert.ok(!/'crt'/.test(src('overlay/agent.js').match(/const ORDER = \[[^\]]*\]/)[0]), 'no CRT entrance');
assert.match(src('overlay/12-sidekick.js'), /pattern: 'flat'/, 'the figure is shaded flat, not dithered');
const dhtml = src('desktop.html');
assert.ok(dhtml.includes('theme/tokens.css') && !/Martian|Doto|fonts\//.test(dhtml), 'the overlay page loads the tokens and no web fonts');
// The mic waveform is the phosphor green, in the bubble and in the setup guide.
assert.match(src('overlay/agent.js'), /ctx\.fillStyle = G\.WAVE;/);
assert.match(src('onboarding/onboarding.css'), /\.meter i \{ width: 3px; background: var\(--wave\); \}/);
// The voice helper draws the pen into captures in the same cyan.
assert.match(src('tauri/src-tauri/voice-win/src/ink.rs'), /pass\(r, \[0x22 as f64, 0xd3 as f64, 0xee as f64\]/);
console.log('theme tests passed');
