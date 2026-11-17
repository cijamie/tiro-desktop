// The notch capsule (#86): off unless picked, only on a Mac with a notched screen (notch.mjs), and in the overlay
// (app/overlay/notch.js) it takes clicks only with something to act on and tells screen readers the whole reply
// once, not every streamed word. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { pickNotch } from '../notch.mjs';

assert.equal(pickNotch({ mac: true, notchScreen: true, pick: undefined }), 'off', 'off until picked');
assert.equal(pickNotch({ mac: true, notchScreen: true, pick: 'drop' }), 'drop');
assert.equal(pickNotch({ mac: true, notchScreen: true, pick: 'spread' }), 'spread');
assert.equal(pickNotch({ mac: true, notchScreen: false, pick: 'drop' }), 'off', 'no notched screen');
assert.equal(pickNotch({ mac: false, notchScreen: true, pick: 'drop' }), 'off', 'not a Mac');
assert.equal(pickNotch({ mac: true, notchScreen: true, pick: 'nonsense' }), 'off');

// A stand-in DOM: every element answers anything, and covers the box 0..500 x 0..60.
const noop = () => {};
const els = [];
function node(tag) {
  const attrs = {}, kids = [], found = {};
  const base = {
    tag, attrs, style: { set: [], setProperty(k, v) { this.set.push([k, v]); } }, dataset: {}, textContent: '', hidden: false, isConnected: true, width: 0, height: 0,
    classList: { set: new Set(), add(...c) { c.forEach((x) => this.set.add(x)); }, remove(...c) { c.forEach((x) => this.set.delete(x)); }, contains(c) { return this.set.has(c); }, toggle(c, on) { if (on ?? !this.set.has(c)) this.set.add(c); else this.set.delete(c); return this.set.has(c); } },
    setAttribute(k, v) { attrs[k] = String(v); }, getAttribute: (k) => attrs[k] ?? null,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 500, bottom: 60, width: 500, height: 60 }),
    querySelector: (q) => (found[q] ??= node('div')), querySelectorAll: () => [], appendChild: (c) => kids.push(c), append: (...c) => kids.push(...c),
    addEventListener: noop, animate: () => ({ cancel: noop }), getAnimations: () => [], getContext: () => new Proxy({}, { get: () => noop }),
    scrollHeight: 0, offsetHeight: 0, offsetWidth: 0,
  };
  els.push(base);
  return base;
}
const document = { head: node('head'), body: node('body'), createElement: node, addEventListener: noop, fonts: null };
const timers = [], rafs = [];
const frames = (n = 3) => { for (let i = 0; i < n; i++) rafs.splice(0).forEach((f) => f(0)); };
const ctx = {
  window: {}, document, Math, performance, innerWidth: 1512, innerHeight: 982, devicePixelRatio: 2,
  matchMedia: () => ({ matches: true, addEventListener: noop }), addEventListener: noop,
  requestAnimationFrame: (f) => { rafs.push(f); return rafs.length; }, cancelAnimationFrame: noop, setTimeout: (f) => { timers.push(f); return 0; }, clearTimeout: noop,
  getComputedStyle: () => ({}),
};
ctx.window.Tiro = { safe: { top: 38, notch: { x: 666, w: 180, h: 38 } }, wake: noop };
vm.runInNewContext(fs.readFileSync(new URL('../../../overlay/notch.js', import.meta.url), 'utf8'), ctx);
const R = ctx.window.Tiro;
const sr = els.find((e) => e.className === 'nc-sr');
const flush = () => { while (timers.length) timers.shift()(); };
const capsule = els.find((e) => e.className?.startsWith?.('nc '));
assert.ok(sr && capsule, 'capsule and its screen-reader line are made');
assert.equal(capsule.attrs['aria-live'], undefined, 'the capsule itself is not a live region');

R.notch.enabled = true;
R.notch.think();
assert.equal(R.notchHit(100, 20), false, 'thinking: clicks go to the app below');
assert.equal(R.notchHit(100, 20, false), false);
R.notch.text('Hello ');
R.notch.text('there.');
flush();
assert.equal(sr.textContent, '', 'streaming words are not read out');
assert.equal(R.notchHit(100, 20), true, 'a reply can be clicked (fold it, open it)');
R.notch.done();
flush();
assert.equal(sr.textContent, 'Hello there.', 'the whole reply is read once');
R.notch.close(); flush();
R.notch.prompt('Run npm test?', ['Allow', "Don't allow"], noop);
flush();
assert.equal(sr.textContent, 'Run npm test?');
assert.equal(R.notchHit(100, 20), true, 'Allow buttons take clicks');
assert.equal(R.notchHit(900, 20), false, 'outside it, never');
// A line said while it's closed ("I heard you…") is measured once it's open, so its card fits it (it kept the last
// reply's height, and lost its bottom padding).
R.notch.close(); flush(); frames();
const card = capsule.querySelector('.nc-body');
card.style.set.length = 0;
R.notch.say("I heard you, but didn't catch any words.");
frames();
assert.ok(card.style.set.some(([k]) => k === '--bh'), 'the card is sized for the line');
// Talking again while the last turn is still finishing: that turn's end (or error) arrives once the mic is on, and the
// capsule keeps listening instead of closing.
R.notch.close(); flush(); frames();
R.notch.listen();
R.notch.done();
assert.equal(R.notch.active, true, 'the cut-short turn ending leaves it listening');
R.notch.fail('stopped');
assert.equal(capsule.dataset.mode, 'listen', 'an error from it does too');
console.log('notch tests: passed');
