// The dashboard's link to TiroCloud (dashboard.mjs): the deck as the phone builds it, the KPI strip, the event stream,
// and the rule that kinds needing a tap never change anything on a single gesture. Run: npm test
import assert from 'node:assert/strict';
import { createDashboard, deckFrom, kpiFrom, NEEDS_TAP, noticeLine, parseSse } from '../dashboard.mjs';

const tick = () => new Promise((r) => setTimeout(r, 5));

// The deck: proposals first, then memories waiting for an OK; the tap kinds are marked.
{
  const d = deckFrom(
    { items: [{ id: 'p1', kind: 'mail_send', title: 'Reply to Dana', when: 'now', ok_label: 'Send', done_label: 'Sent', source: 'hermes', preview: 'Hi Dana' }, { id: 'p2', title: 'Dentist', when: 'Fri 3pm' }, { title: 'no id' }] },
    { items: [{ id: 'm1', text: 'Likes oat milk', pending: true, source: 'chat' }, { id: 'm2', text: 'old', pending: false }] },
  );
  assert.deepEqual(d.map((c) => [c.type, c.id, c.kind, c.label, c.tap]), [['proposal', 'p1', 'mail_send', 'Email', true], ['proposal', 'p2', 'event', 'Calendar', false], ['memory', 'm1', 'memory', 'Memory', false]]);
  assert.equal(d[0].from, 'Hermes'); assert.equal(d[0].ok, 'Send'); assert.equal(d[0].preview, 'Hi Dana');
  assert.equal(d[2].ok, 'Remember'); assert.equal(d[2].from, 'Chat');
  for (const k of ['mail_send', 'mail_trash', 'event_delete', 'drive_trash', 'doc_edit', 'server_reboot']) assert.ok(NEEDS_TAP.has(k), `${k} needs a tap`);
  assert.equal(NEEDS_TAP.size, 6);
}

// The KPI strip: real numbers only, unknown stays unknown.
{
  const k = kpiFrom({
    ms: 41.6, health: { ok: true },
    system: { cpu_pct: 12.4, temps: { cpu: 34.6 }, ram_total: 12 * 2 ** 30, ram_used: 6 * 2 ** 30, deploy: { result: 'ok', commit: '0971252', done: '2026-11-20 00:08:26' }, containers: [{ name: 'brain', state: 'running', cpu: '0.3%', mem: '100MB / 768MB' }] },
    hermes: { configured: true, running: true, paused: false, today_usd: 0.04, month_usd: 1.2, cap_usd: 0.3 },
    status: { ai_mode: 'local', model: 'claude-sonnet-5-5', local: { ok: true } },
    dash: { spend: { ok: true, api_cost: 3.2, limit: 20, today: 0.1 }, weather: { ok: true, place: 'Seoul', now: { temp: 4, sky: 'Clear' }, today: { low: -1, high: 7 } } },
  });
  assert.deepEqual(k.cloud, { ok: true, ms: 42, error: '' });
  assert.equal(k.cpu, 12); assert.equal(k.temp, 35);
  assert.deepEqual(k.ram, { used: 6, total: 12, pct: 50 });
  assert.equal(k.model.mode, 'Local first'); assert.equal(k.hermes.state, 'running');
  assert.deepEqual(k.spend, { month: 3.2, limit: 20, today: 0.1 });
  assert.equal(k.weather.place, 'Seoul'); assert.equal(k.containers[0].name, 'brain');
  const none = kpiFrom({ error: "Couldn't reach Tiro", system: { error: 'x' }, hermes: { error: 'owner only' } });
  assert.deepEqual(none.cloud, { ok: false, ms: null, error: "Couldn't reach Tiro" });
  for (const f of ['cpu', 'temp', 'ram', 'model', 'spend', 'hermes', 'weather', 'deploy']) assert.equal(none[f], null, `${f} unknown`);
  assert.equal(kpiFrom({ hermes: { configured: true, paused: true } }).hermes.state, 'paused');
  assert.equal(kpiFrom({ hermes: { configured: false } }).hermes.state, 'off');
}

// Server-sent events, split anywhere.
{
  const a = parseSse('retry: 5000\n\nevent: hello\ndata: {}\n\n: ping\n\nevent: notice\ndata: {"title":"Hi"');
  assert.deepEqual(a.events, [{ type: 'hello', data: {} }]);
  const b = parseSse(`${a.rest}}\n\nevent: cards\ndata: {"n":1}\n\n`);
  assert.deepEqual(b.events, [{ type: 'notice', data: { title: 'Hi' } }, { type: 'cards', data: { n: 1 } }]);
  assert.equal(b.rest, '');
  assert.deepEqual(noticeLine({ t: '2026-11-20T09:00:00+09:00', kind: 'hermes', title: 'Handoff done', body: 'Summary saved' }), { t: Date.parse('2026-11-20T09:00:00+09:00'), src: 'hermes', kind: 'hermes', text: 'Handoff done: Summary saved' });
  assert.equal(noticeLine({ kind: 'mail', title: 'New mail' }, 5).src, 'server');
}

// A fake server for the rest.
function fakeServer({ proposals = [], memory = [] } = {}) {
  const calls = [];
  const state = { proposals: [...proposals], memory: [...memory] };
  const call = async (method, route, body) => {
    calls.push([method, route, body]);
    if (route === '/proposals') return { items: state.proposals };
    if (route === '/memory') return { items: state.memory };
    if (route === '/notifications') return { items: [{ t: '2026-11-20T09:00:00+09:00', kind: 'forge', title: 'Converted', body: 'clip.mp4', url: '/?tab=files', new: true }], unread: 1 };
    if (route === '/health') return { ok: true };
    const pm = /^\/proposals\/(\w+)\/(approve|dismiss)$/.exec(route);
    if (pm) { state.proposals = state.proposals.filter((p) => p.id !== pm[1]); return { ok: true }; }
    const mm = /^\/memory\/(\w+)(\/approve)?$/.exec(route);
    if (mm) { state.memory = state.memory.filter((m) => m.id !== mm[1]); return { ok: true }; }
    return {};
  };
  return { call, calls, state };
}
const never = () => new Promise(() => {}); // the event stream: stays open, sends nothing

// The tap rule: a mail_send approve without tapped: true changes nothing; with it, it's approved on the server.
{
  const srv = fakeServer({ proposals: [{ id: 'p1', kind: 'mail_send', title: 'Reply' }, { id: 'p2', kind: 'event', title: 'Dentist' }], memory: [{ id: 'm1', text: 'x', pending: true }] });
  const sent = [];
  const d = createDashboard({ call: srv.call, send: (o) => sent.push(o), fetchImpl: never, pollMs: 1e9 });
  assert.equal(d.handle({ type: 'panel_open' }), false, 'other messages pass through');
  d.handle({ type: 'dash_open' });
  await tick();
  assert.equal(d.deck.length, 3);
  d.handle({ type: 'dash_act', id: 'p1', card: 'proposal', ok: true });
  await tick();
  assert.ok(!srv.calls.some(([, r]) => r.startsWith('/proposals/p1/')), 'no approve without the tap');
  assert.match(sent.filter((o) => o.msg.kind === 'deck').at(-1).msg.error, /need a tap on "Approve"/);
  d.handle({ type: 'dash_act', id: 'p1', card: 'proposal', ok: false });
  await tick();
  assert.ok(srv.calls.some(([m, r]) => m === 'POST' && r === '/proposals/p1/dismiss'), 'dismissing needs no tap');
  d.handle({ type: 'dash_act', id: 'p2', card: 'proposal', ok: true });
  await tick();
  assert.ok(srv.calls.some(([m, r]) => m === 'POST' && r === '/proposals/p2/approve'), 'a calendar card approves on one press');
  d.handle({ type: 'dash_act', id: 'm1', card: 'memory', ok: false });
  await tick();
  assert.ok(srv.calls.some(([m, r]) => m === 'DELETE' && r === '/memory/m1'), 'forgetting a memory');
  assert.equal(d.deck.length, 0);
  assert.ok(d.lines.some((l) => l.src === 'pc' && /^Dismissed: Email, Reply/.test(l.text)), 'what I did goes in the log');
  d.handle({ type: 'dash_act', id: 'gone', card: 'proposal', ok: true });
  await tick();
  assert.match(sent.filter((o) => o.msg.kind === 'deck').at(-1).msg.error, /That card is gone/);
  d.stop();
}
{
  const srv = fakeServer({ proposals: [{ id: 'p9', kind: 'server_reboot', title: 'Reboot' }] });
  const d = createDashboard({ call: srv.call, send: () => {}, fetchImpl: never, pollMs: 1e9 });
  d.handle({ type: 'dash_open' }); await tick();
  d.handle({ type: 'dash_act', id: 'p9', card: 'proposal', ok: true, tapped: 'yes' }); await tick();
  assert.ok(!srv.calls.some(([, r]) => r === '/proposals/p9/approve'), 'tapped must be exactly true');
  d.handle({ type: 'dash_act', id: 'p9', card: 'proposal', ok: true, tapped: true }); await tick();
  assert.ok(srv.calls.some(([, r]) => r === '/proposals/p9/approve'), 'the tap approves');
  d.stop();
}

// Links on notifications open only through safety.mjs: Tiro pages and Gmail.
{
  const opened = [], sent = [];
  const d = createDashboard({ call: fakeServer().call, send: (o) => sent.push(o), open: (u) => opened.push(u), fetchImpl: never, pollMs: 1e9, env: { TIRO_URL: 'https://tiro.jamies.dev' } });
  d.handle({ type: 'dash_link', url: '/?tab=today&deck=1' });
  d.handle({ type: 'dash_link', url: 'https://mail.google.com/mail/u/0/#inbox/1' });
  d.handle({ type: 'dash_link', url: 'file:///C:/Windows/System32/calc.exe' });
  d.handle({ type: 'dash_link', url: 'https://evil.example/' });
  assert.deepEqual(opened, ['https://tiro.jamies.dev/?tab=today&deck=1', 'https://mail.google.com/mail/u/0/#inbox/1']);
  assert.equal(sent.filter((o) => o.msg.kind === 'note' && o.msg.bad).length, 2);
}

// The live stream: a notice becomes a toast and a log line, cards reload the deck; the PC's actions go in once each.
{
  const srv = fakeServer();
  const sent = [];
  const body = (async function* () {
    const enc = new TextEncoder();
    yield enc.encode('event: hello\ndata: {}\n\nevent: notice\ndata: {"t":"2026-11-20T10:00:00+09:00","kind":"hermes","title":"Handoff done","body":"Saved to chats","url":"/?chat=1"}\n\n');
    yield enc.encode('event: cards\ndata: {}\n\n');
    await never();
  })();
  let asked = null;
  const fetchImpl = async (url, init) => { asked = { url, init }; return { ok: true, status: 200, body }; };
  const d = createDashboard({ call: srv.call, send: (o) => sent.push(o), fetchImpl, pollMs: 1e9, env: { TIRO_URL: 'https://tiro.jamies.dev' } });
  d.handle({ type: 'dash_open' });
  await tick(); await tick();
  assert.equal(asked.url, 'https://tiro.jamies.dev/events');
  assert.ok(sent.some((o) => o.msg.kind === 'conn' && o.msg.live));
  const toast = sent.find((o) => o.msg.kind === 'toast');
  assert.deepEqual(toast.msg.notice, { title: 'Handoff done', body: 'Saved to chats', kind: 'hermes', url: '/?chat=1' });
  assert.ok(d.lines.some((l) => l.src === 'hermes' && l.text === 'Handoff done: Saved to chats'));
  assert.ok(srv.calls.filter(([, r]) => r === '/proposals').length >= 2, 'cards reloaded the deck');
  d.pc([{ at: 1, kind: 'did', text: 'Read notes.md' }]);
  d.pc([{ at: 2, kind: 'did', text: 'Looked at your screen' }, { at: 1, kind: 'did', text: 'Read notes.md' }]);
  assert.equal(d.lines.filter((l) => l.src === 'pc').length, 2, 'each PC action once');
  d.stop();
  assert.equal(d.open, false);
}
console.log('dashboard tests passed');
process.exit(0);
