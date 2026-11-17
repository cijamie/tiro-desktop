// The Tiro tools (tiro.mjs) against a fake server: chats carry on, long text is saved and shortened for the phone,
// terminals never get Ctrl+C, and failures say what to check. Run: npm test
import assert from 'node:assert/strict';
import { createTiroTools, tiroCall, tiroUrl, TERMINALS } from '../tiro.mjs';

const calls = [];
const call = async (m, r, b) => {
  calls.push([m, r, b]);
  if (r === '/chat') return { reply: 'ok', chat_id: 'c1', proposals: [{ title: 'Dentist', when: 'Fri 14:00' }] };
  if (r === '/todos') return { text: b.text, due: b.due };
  return { message: 'saved' };
};
const tools = (front, readSelection = async () => 'hello', platform = 'win32') =>
  Object.fromEntries(createTiroTools({ call, platform, front, readSelection }).map((x) => [x.name, x]));

const t = tools(async () => ({ app: 'Windows Terminal' }));
assert.match(await t.tiro_ask.execute({ message: 'add dentist friday 2pm' }), /Dentist, Fri 14:00 \(waiting for Jamie's OK in Tiro\)/);
await t.tiro_ask.execute({ message: 'and the week after' });
assert.equal(calls[1][2].chat_id, 'c1', 'a follow-up stays in the same Tiro chat');

assert.match(await t.tiro_send_to_phone.execute({ text: 'x'.repeat(250) }), /shortened in the notification\); saved in full/);
assert.equal(calls.at(-2)[1], '/inbox', 'long text is saved in full first');
assert.equal(calls.at(-1)[1], '/reminders');
assert.equal(calls.at(-1)[2].text.length, 200, 'the notification fits Tiro\'s limit');

assert.match(await t.tiro_add_todo.execute({ text: 'buy milk', due: '2026-11-20' }), /buy milk \(due 2026-11-20\)/);

await assert.rejects(t.read_selection.execute({}), /terminal/, 'never Ctrl+C in a terminal');
assert.ok(TERMINALS.test('Command Prompt') && TERMINALS.test('Windows PowerShell') && !TERMINALS.test('Google Chrome'));
assert.match(await tools(async () => ({ app: 'chrome' }), async () => '안녕').read_selection.execute({}), /안녕/, 'Korean comes through');
assert.match(await tools(async () => null, async () => '  ').read_selection.execute({}), /Nothing is highlighted/);
await assert.rejects(tools(async () => null, undefined, 'darwin').read_selection.execute({}), /only works on Windows/);

await assert.rejects(tiroCall('GET', '/x', undefined, { fetchImpl: async () => { throw Object.assign(new Error('x'), { cause: { code: 'ENOTFOUND' } }); } }), /Tailscale/);
await assert.rejects(tiroCall('GET', '/x', undefined, { fetchImpl: async () => new Response('{"detail":"not signed in"}', { status: 401 }) }), /recognise this computer/);
assert.equal(tiroUrl({}), 'https://tiro.jamies.dev');
assert.equal(tiroUrl({ TIRO_URL: 'https://example.test/' }), 'https://example.test');
console.log('tiro tests: passed');
