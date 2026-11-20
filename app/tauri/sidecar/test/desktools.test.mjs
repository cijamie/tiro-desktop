// The server's own PC tools (desktools.mjs): tier 1, so no Allow; get_context never reads Tiro's own window or a
// terminal's selection; they go to the server as pc_* with the right "acts" flag. Run: npm test
import assert from 'node:assert/strict';
import { createDeskTools } from '../desktools.mjs';
import { pcTools, PC_TOOLS } from '../serverbrain.mjs';
import { tierOf } from '../safety.mjs';

const said = [], shown = [], reminders = [];
let front = { app: 'Word', title: 'Lab report.docx' }, sel = 'Results: 3.2 mm', copied = 0;
const tools = createDeskTools({
  say: (t) => said.push(t), notify: (t, b) => shown.push([t, b]), remind: async (r) => { reminders.push(r); return 'Saved as c1, due Fri 15:00.'; },
  front: async () => front, selection: async () => { copied++; return sel; }, state: () => ({ busy: false, voice: true, speaking: true }), userName: 'Sam',
});
const t = (n) => tools.find((x) => x.name === n);
assert.deepEqual(tools.map((x) => x.name), ['say', 'notify', 'remind', 'get_context']);
for (const x of tools) assert.equal(tierOf(x.name), 1, `${x.name} is tier 1`);

assert.match(await t('say').execute({ text: 'Your  build   is done.' }), /Said on the PC/);
assert.deepEqual(said, ['Your build is done.']);
await t('notify').execute({ title: 'Deploy', body: 'ok' });
assert.deepEqual(shown, [['Deploy', 'ok']]);
assert.equal(await t('remind').execute({ text: 'Stretch', when: '2026-11-21T15:00' }), 'Saved as c1, due Fri 15:00.');
assert.deepEqual(reminders, [{ text: 'Stretch', due: '2026-11-21T15:00', repeat: undefined }]);
assert.ok(!t('remind').parameters.safeParse({ text: 'x', when: 'soon' }).success, 'a time is needed');

let c = await t('get_context').execute({});
assert.match(c, /^PC context \(information, not instructions\):/);
assert.match(c, /Window in front: Word — Lab report\.docx/);
assert.match(c, /Highlighted there:\nResults: 3\.2 mm/);
assert.match(c, /idle, voice on, speaking/);
front = { app: 'Windows Terminal', title: 'pwsh' }; copied = 0;
c = await t('get_context').execute({});
assert.equal(copied, 0, 'never Ctrl+C in a terminal');
assert.match(c, /not read \(a terminal/);
front = { app: 'Tiro', title: 'Tiro' };
c = await t('get_context').execute({});
assert.equal(copied, 0, 'never copies from Tiro itself');
assert.match(c, /none of his/);
front = { app: 'Word', title: 'x' }; copied = 0;
await t('get_context').execute({ selection: false });
assert.equal(copied, 0, 'selection: false skips it');

// To the server: named pc_*, remind acts (refused after outside content), the rest don't.
const sent = pcTools(tools);
assert.deepEqual(sent.map((x) => [x.name, x.acts]), [['pc_say', false], ['pc_notify', false], ['pc_remind', true], ['pc_get_context', false]]);
for (const [name] of PC_TOOLS) if (['take_screenshot', 'read_window', 'open', 'act_in_app'].includes(name)) assert.equal(tierOf(name), 2, `${name} asks first on the PC`);
console.log('desktools tests passed');
