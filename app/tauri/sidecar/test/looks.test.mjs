import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_VOICE } from '../fish.mjs';

// Tiro is the only look (Roamies' JARVIS and characters were removed in the split): it has JARVIS's Fish Audio voice,
// and the setup guide and Settings agree on its name and greeting.
const src = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const side = src('../sidekick.mjs'), guide = src('../../../onboarding/onboarding.js');
const looks = [...side.slice(side.indexOf('const LOOKS = ['), side.indexOf('];', side.indexOf('const LOOKS = ['))).matchAll(/\['(\w+)', '([^']+)', (DEFAULT_VOICE|'(\w+)')\]/g)];
assert.deepEqual(looks.map((m) => [m[1], m[2]]), [['classic', 'Tiro']]);
assert.equal(looks[0][4], 'e13fa398a7f445a685316a3de6089ce7', 'Tiro speaks with JARVIS\'s voice');
assert.equal(DEFAULT_VOICE, '2680da81de8348a68e1f4dbaa79272f1');
assert.ok(!/config\.fishVoice/.test(side), 'a saved fishVoice (the old JARVIS default) is never used');
assert.match(side, /if \(!LOOKS\.some\(\(\[id\]\) => id === config\.look\)\) config\.look = 'classic';/, 'a Roamies look saved in settings becomes Tiro');
assert.ok(guide.includes("const LOOKS = [['classic', 'Tiro']]"), 'the setup guide offers Tiro only');
{
  const obj = (text, name) => new Function(`return ${text.match(new RegExp(`const ${name} = (\\{[^}]*\\})`))[1]}`)();
  const said = obj(side, 'LOOK_GREETINGS');
  assert.deepEqual(said, { classic: 'Tiro, at your service.' });
  assert.deepEqual(obj(src('../../../panel/panel.js'), 'QUIPS'), said, 'Settings shows the spoken greeting');
  assert.deepEqual(obj(guide, 'LOOK_QUIPS'), said, 'the setup guide shows the spoken greeting');
}
for (const page of ['../../../desktop.html', '../../../panel/index.html', '../../../onboarding/index.html']) {
  assert.ok(!/overlay\/(people|jarvis|notch|sidebar)\.js/.test(src(page)), `${page} loads none of the removed looks`);
}
console.log('looks tests: passed');

// Regression: a selected stage canvas showed as a grey box around the Tiro (WebKit tints selected canvases).
assert.match(src('../../../desktop.html'), /canvas \{[^}]*-webkit-user-select: none; user-select: none;[^}]*\}/);

// Regression: after a drawing the Sidekick stopped following the cursor and hopped away from it instead.
{
  const agent = src('../../../overlay/agent.js'), rel = agent.slice(agent.indexOf('async release()'), agent.indexOf('place: (x, y) =>'));
  assert.match(agent, /pen\.follow = !!station\.byCursor/, 'take() remembers whether it was following the cursor');
  assert.match(rel, /if \(pen\.follow && presence\.ptr\) station\.byCursor = presence\.ptr\.slice\(\)/, 'release() goes back to following');
}

// The bubbles, tags and step list draw with glass.js, so the overlay loads it before them.
{
  const page = src('../../../desktop.html'), at = (f) => page.indexOf(`overlay/${f}`);
  assert.ok(at('glass.js') > 0 && at('glass.js') < at('agent.js') && at('glass.js') < at('agent-cards.js'), 'desktop.html loads glass.js before agent.js and agent-cards.js');
}

// Regression: the hands trailed behind the body when it moved fast (they sprang after screen points, not body ones).
{
  const kit = src('../../../overlay/10-dither.js');
  assert.match(kit, /spring\(h\.o, tg\[0\] \* R, tg\[1\] \* R/, 'hands spring in the body\'s own space');
  assert.match(kit, /h\.y = m\.y \+ oy \+ h\.o\.y/, 'and ride its hop once');
  assert.match(kit, /lerp\(sx, bx \+ h\.o\.x, arms\)/, 'hands are drawn from where the body is drawn');
}
