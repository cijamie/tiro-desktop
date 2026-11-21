// TiroDash's sign-in (account.mjs) against a fake Tiro: a code, the browser, the token collected once and kept only in
// the safe store; Continue as <name> over Tailscale; a turned-down code; signing out revokes it. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SECRET, createAccount } from '../account.mjs';
import { setTiroToken, tiroAuth } from '../tiro.mjs';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tiro-acct-'));
const store = new Map();
const secrets = { get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); } };
const jamie = { id: 'u1', name: 'Jamie', email: 'jamie@example.com', owner: true };
let token = '', polls = 0, status = 'pending', whoUser = null;
const calls = [];
const call = async (m, r, b) => {
  calls.push([m, r, b]);
  if (r === '/whoami') return { user: token || whoUser ? (whoUser ?? jamie) : null };
  if (r === '/link/start') return { link_id: 'L1', code: 'ABCD-EFGH', expires_in: 600 };
  if (r === '/link/L1') { polls++; return polls < 2 ? { status: 'pending' } : status === 'approved' ? { status, token: 'tiro_secret', user: jamie } : { status }; }
  if (r === '/tokens') return { token: 'tiro_ts' };
  if (r === '/link/signout') return { ok: true };
  throw new Error(`unexpected ${m} ${r}`);
};
const opened = [], states = [];
const timers = [];
const run = async () => { while (timers.length) { await timers.shift()(); await new Promise((r) => setImmediate(r)); } };
const make = () => createAccount({
  call, secrets, setToken: (t) => { token = t; setTiroToken(t); }, base: () => 'https://tiro.example', open: (u) => opened.push(u),
  onChange: (s) => states.push(s), dir, schedule: (fn) => { timers.push(fn); return 1; },
});

// Nobody signed in, and Tailscale doesn't know this PC either: the page offers only Sign in with Tiro.
let a = make();
await a.load(); await new Promise((r) => setImmediate(r));
assert.equal(states.at(-1).signedIn, false);
assert.equal(states.at(-1).tailscale, null);

// Sign in with Tiro: the code shows, the browser opens TiroWeb at it, the token arrives on the second poll.
status = 'approved';
a.handle({ type: 'acct_start' });
await new Promise((r) => setImmediate(r));
assert.equal(states.at(-1).pending.code, 'ABCD-EFGH');
assert.deepEqual(opened, ['https://tiro.example/?link=ABCD-EFGH']);
assert.equal(calls.find(([, r]) => r === '/link/start')[2].app, 'tirodash');
await run();
assert.equal(states.at(-1).signedIn, true);
assert.equal(states.at(-1).user.name, 'Jamie');
assert.equal(states.at(-1).pending, null);
assert.equal(store.get(SECRET), 'tiro_secret', 'the token is in the safe store');
assert.equal(tiroAuth({}), 'Bearer tiro_secret', 'every request to Tiro now sends it');
const onDisk = await fs.readFile(path.join(dir, 'account.json'), 'utf8');
assert.ok(onDisk.includes('Jamie') && !onDisk.includes('tiro_secret'), 'account.json says who, never the token');

// A restart: signed in again from the store, before any request.
token = ''; setTiroToken('');
a = make();
await a.load();
assert.equal(token, 'tiro_secret');
assert.equal(states.at(-1).signedIn, true);

// Sign out: revoked on the server, gone from the store and the file.
a.handle({ type: 'acct_signout' });
await new Promise((r) => setTimeout(r, 10));
assert.ok(calls.some(([m, r]) => m === 'POST' && r === '/link/signout'));
assert.equal(store.has(SECRET), false);
assert.equal(token, '');
await assert.rejects(fs.stat(path.join(dir, 'account.json')));
assert.equal(states.at(-1).signedIn, false);

// Turned down in TiroWeb: nothing is kept, and the page says why.
polls = 0; status = 'denied';
a.handle({ type: 'acct_start' });
await new Promise((r) => setImmediate(r)); await run();
assert.equal(states.at(-1).signedIn, false);
assert.match(states.at(-1).error, /Turned down/);
assert.equal(store.has(SECRET), false);

// Known by Tailscale: Continue as Jamie gets this PC its own token straight away.
whoUser = jamie;
await a.refresh();
assert.equal(states.at(-1).tailscale.name, 'Jamie');
a.handle({ type: 'acct_tailscale' });
await new Promise((r) => setTimeout(r, 10));
assert.equal(store.get(SECRET), 'tiro_ts');
assert.match(calls.find(([, r]) => r === '/tokens')[2].label, /^TiroDash · /);
assert.equal(states.at(-1).signedIn, true);

// The safe store refuses: the token is not kept anywhere, and it says so.
await a.signOut(); whoUser = null;
const broken = createAccount({ call, secrets: { ...secrets, set: async () => { throw new Error('DPAPI failed'); } }, setToken: (t) => { token = t; }, base: () => 'https://tiro.example', onChange: (s) => states.push(s), dir, schedule: (fn) => { timers.push(fn); return 1; } });
polls = 0; status = 'approved';
broken.handle({ type: 'acct_start' });
await new Promise((r) => setImmediate(r)); await run();
assert.equal(states.at(-1).signedIn, false);
assert.match(states.at(-1).error, /couldn't store the key safely/);
assert.equal(token, '');

setTiroToken('');
await fs.rm(dir, { recursive: true, force: true });
console.log('account ok');
