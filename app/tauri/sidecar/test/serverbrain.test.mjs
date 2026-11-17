// Where Tiro thinks (serverbrain.mjs): the PC tools offered to the Tiro server, and one server turn played as the
// same events the PC's own agent gives. The server is faked. Run: npm test
import assert from 'node:assert/strict';
import { z } from 'zod';
import { brainOf, noteTurn, pcTools, serverEvents, takeoverTool, tiroMemory, toServer } from '../serverbrain.mjs';

assert.equal(brainOf({}), 'server', 'the server by default');
assert.equal(brainOf({ brain: 'pc' }), 'pc');
assert.equal(brainOf({ brain: 'cloud' }), 'server');

const tool = (name, execute = async () => 'ok') => ({ name, description: `${name} tool`, parameters: z.object({ app: z.string().optional() }), execute });
const local = [tool('read_window', async ({ app }) => `Window of ${app}: Hello`), tool('act_in_app'), tool('run_command'), tool('remember_commitment'), tool('tiro_ask')];
let job = null;
const all = [...local, takeoverTool((t) => { job = t; })];

{
  const sent = pcTools(all, { allowActions: false });
  assert.deepEqual(sent.map((t) => [t.name, t.acts]), [['pc_read_window', false], ['pc_act_in_app', true], ['pc_takeover', true]],
    'only PC tools go to the server; Tiro\'s own and the memory tools stay here; commands only with actions on');
  assert.equal(sent[0].input_schema.type, 'object');
  assert.ok(pcTools(all, { allowActions: true }).some((t) => t.name === 'pc_run_command'));
}

assert.equal(toServer('text'), 'text');
assert.deepEqual(toServer({ content: [{ type: 'text', text: 'Shot' }, { type: 'image', mediaType: 'image/jpeg', data: 'AAA' }] }),
  [{ type: 'text', text: 'Shot' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAA' } }]);

// A turn: one PC call, a wait, then the reply.
{
  const calls = [];
  const replies = [
    { turn: 't1', call: { id: 'c1', name: 'pc_read_window', input: { app: 'Notepad' } } },
    { turn: 't1', wait: true },
    { turn: 't1', done: { reply: 'It says Hello.', chat_id: 'chat9', model: 'claude-haiku', usage: { input: 10, output: 3 } } },
  ];
  const call = async (method, route, body) => { calls.push([method, route, body]); return replies.shift(); };
  const chat = { id: null };
  const events = [];
  for await (const e of serverEvents({ message: 'what does Notepad say?', chat, tools: all, call, allowActions: false })) events.push(e);
  assert.deepEqual(events.map((e) => e.type), ['tool_call_start', 'tool_call_end', 'ping', 'text_delta', 'turn_end']);
  assert.equal(events[0].name, 'read_window', 'shown as the PC tool it is');
  assert.equal(events[1].isError, false);
  assert.equal(events[3].text, 'It says Hello.');
  assert.equal(chat.id, 'chat9', 'the next turn continues the same Tiro chat');
  assert.equal(calls[0][1], '/desktop/chat');
  assert.equal(calls[0][2].local_ok, true);
  assert.deepEqual(calls[1], ['POST', '/desktop/turn/t1', { id: 'c1', content: 'Window of Notepad: Hello', is_error: false }]);
  assert.deepEqual(calls[2].slice(0, 2), ['GET', '/desktop/turn/t1']);
}

// A tool this app doesn't have, a failing tool, and the takeover.
{
  const replies = [
    { turn: 't2', call: { id: 'a', name: 'pc_format_disk', input: {} } },
    { turn: 't2', call: { id: 'b', name: 'pc_takeover', input: { task: 'Fill in the visa form' } } },
    { turn: 't2', done: { reply: 'Started.', chat_id: 'c2' } },
  ];
  const posted = [];
  const call = async (m, r, b) => { if (b?.id) posted.push(b); return replies.shift(); };
  for await (const _ of serverEvents({ message: 'do it', chat: { id: 'c2' }, tools: all, call })) { /* drain */ }
  assert.equal(posted[0].is_error, true);
  assert.match(posted[0].content, /no tool called pc_format_disk/);
  assert.equal(job, 'Fill in the visa form', 'the job waits for the PC\'s agent');
}

// The server's error ends the turn with it.
await assert.rejects(async () => { for await (const _ of serverEvents({ message: 'x', chat: {}, tools: all, call: async () => ({ error: 'Your Claude API key was refused.' }) })) { /* drain */ } }, /API key was refused/);

// Turns the PC answered, saved in Tiro's chats; Tiro's memory for the PC's prompt.
{
  const got = [];
  const chat = { id: null };
  await noteTurn({ call: async (m, r, b) => { got.push([r, b]); return { chat_id: 'n1' }; }, chat, user: 'hi', reply: 'Hello!', model: 'claude-sonnet' });
  assert.deepEqual(got[0], ['/desktop/note', { reply: 'Hello!', user: 'hi', model: 'claude-sonnet', source: 'pc' }]);
  assert.equal(chat.id, 'n1');
  await noteTurn({ call: async () => { throw new Error('never'); }, chat, user: 'x', reply: '  ' });
  assert.equal(await tiroMemory(async () => ({ items: [{ text: 'Lives in Seoul' }, { text: 'From an email', pending: true }] })), '- Lives in Seoul');
}
console.log('serverbrain tests: passed');
