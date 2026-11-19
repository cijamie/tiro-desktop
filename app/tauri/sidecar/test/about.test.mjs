import assert from 'node:assert/strict';
import { aboutTiro } from '../about.mjs';

// The app's manual for about_tiro (Windows only): only the features this copy has.
const base = { name: 'Tiro', looks: ['Tiro'], snap: false, pointer: false, voice: false, hotkeys: false };
const full = aboutTiro({ ...base, snap: true, pointer: true, voice: true, hotkeys: true });
const win = aboutTiro(base);
const noKeys = aboutTiro({ ...base, voice: true });
assert.match(win, /bottom right of the taskbar/);
assert.match(full, /Show Tiro, Ask Tiro…, Ask About an Area…, Stop, Quit Tiro/);
assert.match(full, /Look: Tiro, each with its own voice/);
assert.match(full, /Voice Provider: Fish Audio, Gemini or VoiceStudio/);
assert.ok(!/Ask About an Area|Voice Control|Cursor, a little arrow/.test(win), 'features this copy lacks are left out');
for (const t of [full, win, noKeys]) assert.ok(!/menu bar|Mac|Linux|AppImage|AppIndicator|Wake word/.test(t), 'no Mac or Linux wording');
// The settings pages as the panel names them (Speaking, Listening, Shortcuts, Routines, General since the split).
assert.match(full, /Speaking \(Replies:.*Listening \(Voice Control.*Shortcuts \(.*Routines \(Morning Briefing.*General \(Sound Effects/);
assert.match(noKeys, /Shortcuts \(the commands to bind/, 'no global keys: the commands to bind');
for (const t of [full, win, noKeys]) assert.ok(!/Behavior \(|, Voice \(/.test(t), 'no old page names');
// The Model page's local servers (#63, #66): Ollama, LM Studio and any other server, as the panel names them.
assert.match(win, /Model \(.*Ollama and LM Studio, each with Connect or Disconnect.*Another server with Add server.*Its models can see images/);
for (const t of [full, win, noKeys]) {
  assert.match(t, /Save Diagnostics/);
  assert.match(t, /github\.com\/cijamie\/tiro-desktop/);
  assert.ok(!/\$\{|undefined/.test(t), 'every part is filled in');
}
console.log('about tests: passed');
