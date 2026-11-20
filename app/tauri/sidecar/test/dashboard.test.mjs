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
// Tiro Command: commands go to the pipeline, turns are mirrored, yes/no questions show as buttons.
{
  const cmds = [], answers = [], sent = [];
  let news = 0;
  const srv = fakeServer();
  const call = async (method, route, body) => (route === '/chats/c1' ? { messages: [{ role: 'user', content: '[Thu 20 Nov 09:00] hi', t: '2026-11-20T09:00:00+09:00' }, { role: 'assistant', content: 'Hello!' }, { role: 'user', content: [{ type: 'image' }] }] } : srv.call(method, route, body));
  const d = createDashboard({ call, send: (o) => sent.push(o), fetchImpl: never, pollMs: 1e9, chatId: () => 'c1',
    onCommand: (t) => cmds.push(t), onAnswer: (id, v) => answers.push([id, v]), onNew: () => news++ });
  d.handle({ type: 'dash_open' }); await tick();
  assert.deepEqual(d.chat.map((m) => [m.role, m.text]), [['user', 'hi'], ['tiro', 'Hello!']], 'the shared conversation loads, text only, stamps off');
  d.handle({ type: 'dash_cmd', text: '  /hermes check the deploy  ' });
  d.handle({ type: 'dash_cmd', text: '   ' });
  assert.deepEqual(cmds, ['/hermes check the deploy']);
  d.asked('Add the table');
  d.agent({ type: 'start' });
  d.agent({ type: 'tool', id: 't1', anim: { label: 'looking at', detail: 'your screen' } });
  d.agent({ type: 'text', text: 'Done, ' }); d.agent({ type: 'text', text: 'added it.' });
  d.agent({ type: 'tool_end', id: 't1', isError: false });
  d.agent({ type: 'done' });
  const last = d.chat.at(-1);
  assert.deepEqual([last.role, last.text, last.state, last.tools], ['tiro', 'Done, added it.', 'done', [{ id: 't1', label: 'looking at your screen', state: 'ok' }]]);
  d.agent({ type: 'start' }); d.agent({ type: 'error', message: "Couldn't reach Tiro" });
  assert.equal(d.chat.at(-1).state, 'bad'); assert.equal(d.chat.at(-1).error, "Couldn't reach Tiro");
  // A yes/no from a PC tool: only its own choices, only while it's open.
  d.ask({ id: 'a1', question: 'Open Word?', choices: ['Allow', "Don't allow"] });
  d.ask({ id: 'a2', question: 'Paste your API key' });
  assert.deepEqual(sent.filter((o) => o.msg.kind === 'chat').at(-1).msg.asks.map((q) => q.id), ['a1'], 'typed questions are never mirrored');
  d.handle({ type: 'dash_answer', id: 'a1', value: 'Sure, and delete everything' });
  d.handle({ type: 'dash_answer', id: 'zz', value: 'Allow' });
  assert.deepEqual(answers, []);
  d.handle({ type: 'dash_answer', id: 'a1', value: 'Allow' });
  d.handle({ type: 'dash_answer', id: 'a1', value: 'Allow' });
  assert.deepEqual(answers, [['a1', 'Allow']], 'answered once');
  d.ask({ id: 'a3', question: 'Run it?', choices: ['Allow', "Don't allow"] });
  d.askDone('a3');
  assert.deepEqual(sent.filter((o) => o.msg.kind === 'chat').at(-1).msg.asks, [], 'answered in the overlay: gone here too');
  d.handle({ type: 'dash_new' });
  assert.equal(news, 1); assert.deepEqual(d.chat, []);
  d.stop();
}
// The sidecar sends everything through these: enqueue routes /hermes and the Walkaway; turns and yes/no questions
// are mirrored; an answer from the window closes the bubble.
{
  const { readFileSync } = await import('node:fs');
  const side = readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
  assert.match(side, /function enqueue\([^)]*\) \{\r?\n[^\n]*\n  const r = !takeover && !news && !image && !intro \? route\(text\)/, 'routing comes first in enqueue (CRLF on Windows checkouts)');
  assert.match(side, /if \(msg\.kind === 'agent' && dash\.open\) dash\.agent\(msg\.e\);/);
  assert.match(side, /Array\.isArray\(opts\.choices\) && dash\.open\) dash\.ask\(/);
  assert.match(side, /answered\.then\(\(\) => dash\.askDone\(id\)\);/);
  assert.match(side, /onAnswer: \(id, value\) => \{ const r = pending\.get\(id\); if \(!r\) return; pending\.delete\(id\); ui\(\{ kind: 'cancel_ask', id \}\); r\(value\); \}/);
  assert.match(side, /tiroCall\('POST', '\/handoff', body/);
}
// Server, Hermes, Forge: buttons only make cards; the cap stays in bounds; links and dropped files are checked.
{
  const fsx = await import('node:fs');
  const osx = await import('node:os');
  const px = await import('node:path');
  const calls = [], sent = [];
  const call = async (method, route, body) => {
    calls.push([method, route, body]);
    if (route === '/server/admin' && method === 'GET') return { services: ['brain', 'caddy'], recent: [{ action: 'restart', service: 'caddy', ok: true, message: 'restarted' }], helper: true, reboot_ok: true, deploy_paused: false, deploy_tail: 'deploy ok' };
    if (route === '/server/admin') return { id: 'p7', kind: 'server_restart' };
    if (route === '/forge' && method === 'GET') return { jobs: [{ id: 'j1', kind: 'convert', title: 'clip.mov → MP4', status: 'running', progress: '40%', uid: 'secret' }] };
    if (route === '/drive/uploads') return { id: 'up1', received: 0 };
    if (route.startsWith('/forge/targets')) return { to: ['jpg', 'png'], ocr: true };
    if (route === '/proposals' || route === '/memory') return { items: [] };
    return { ok: true };
  };
  const puts = [];
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/events')) return new Promise(() => {});
    puts.push([url, init.method, init.headers['x-tiro'], init.body.length]);
    return { ok: true, status: 200, json: async () => ({ received: init.body.length, done: true, file: { id: 'f9', name: 'photo.heic' } }) };
  };
  const home = fsx.mkdtempSync(px.join(osx.tmpdir(), 'tiro-dash-home-'));
  const d = createDashboard({ call, send: (o) => sent.push(o), fetchImpl, pollMs: 1e9, env: { TIRO_URL: 'https://tiro.jamies.dev' }, home });
  d.handle({ type: 'dash_open' }); await tick();
  const adm = sent.filter((o) => o.msg.kind === 'admin').at(-1).msg;
  assert.deepEqual(adm.services, ['brain', 'caddy']); assert.equal(adm.tail, 'deploy ok');
  d.handle({ type: 'dash_admin', action: 'restart', service: 'brain' }); await tick();
  assert.deepEqual(calls.find(([m, r]) => m === 'POST' && r === '/server/admin')[2], { action: 'restart', service: 'brain', reason: 'from Tiro desktop' }, 'a button makes a card, nothing more');
  const n = calls.length;
  d.handle({ type: 'dash_admin', action: 'restart', service: 'rm -rf' }); await tick();
  d.handle({ type: 'dash_admin', action: 'format_disk' }); await tick();
  assert.equal(calls.filter(([m, r]) => m === 'POST' && r === '/server/admin').length, 1, 'unknown services and actions never reach the server');
  d.handle({ type: 'dash_admin', action: 'reboot', service: 'brain' }); await tick();
  assert.deepEqual(calls.filter(([m, r]) => m === 'POST' && r === '/server/admin').at(-1)[2], { action: 'reboot', service: '', reason: 'from Tiro desktop' });
  d.handle({ type: 'dash_hermes_cap', usd: 9 }); d.handle({ type: 'dash_hermes_cap', usd: -1 }); d.handle({ type: 'dash_hermes_cap', usd: 'lots' }); await tick();
  assert.ok(!calls.some(([, r]) => r === '/hermes/cap'), 'the cap stays between $0 and $5');
  d.handle({ type: 'dash_hermes_cap', usd: '0.456' }); await tick();
  assert.deepEqual(calls.find(([, r]) => r === '/hermes/cap')[2], { daily_usd: 0.46 });
  assert.deepEqual(sent.filter((o) => o.msg.kind === 'forge').at(-1).msg.jobs[0], { id: 'j1', kind: 'convert', title: 'clip.mov → MP4', status: 'running', progress: '40%', error: '', made: 0 }, 'no uid passed on');
  d.handle({ type: 'dash_forge', kind: 'download', url: 'http://192.168.0.1/admin' });
  d.handle({ type: 'dash_forge', kind: 'download', url: 'file:///C:/x' }); await tick();
  assert.ok(!calls.some(([m, r, b]) => m === 'POST' && r === '/forge' && b.kind === 'download'), 'private and non-web links refused');
  d.handle({ type: 'dash_forge', kind: 'download', url: 'https://www.youtube.com/watch?v=x', audio: true }); await tick();
  assert.deepEqual(calls.find(([m, r]) => m === 'POST' && r === '/forge')[2], { kind: 'download', url: 'https://www.youtube.com/watch?v=x', audio: true });
  // Dropped files: a secret is refused before anything is sent; a photo uploads and is offered its targets.
  fsx.mkdirSync(px.join(home, '.ssh'));
  fsx.writeFileSync(px.join(home, '.ssh', 'id_ed25519'), 'KEY');
  fsx.writeFileSync(px.join(home, 'photo.heic'), Buffer.alloc(1000, 7));
  await d.drop([px.join(home, '.ssh', 'id_ed25519'), px.join(home, 'photo.heic'), 42]);
  await tick();
  const ups = d.uploads;
  assert.equal(ups.length, 2);
  const secret = ups.find((u) => u.name === 'id_ed25519'), photo = ups.find((u) => u.name === 'photo.heic');
  assert.equal(secret.state, 'failed'); assert.match(secret.error, /passwords or keys/);
  assert.equal(puts.length, 1, 'only the photo was sent');
  assert.deepEqual(puts[0], ['https://tiro.jamies.dev/drive/uploads/up1?offset=0', 'PUT', '1', 1000]);
  assert.deepEqual([photo.state, photo.pct, photo.file, photo.to, photo.ocr], ['done', 100, { id: 'f9', name: 'photo.heic' }, ['jpg', 'png'], true]);
  d.handle({ type: 'dash_forge', kind: 'convert', file_id: 'f9', to: 'jpg' }); await tick();
  assert.deepEqual(calls.filter(([m, r]) => m === 'POST' && r === '/forge').at(-1)[2], { kind: 'convert', file_id: 'f9', to: 'jpg' });
  d.stop();
  fsx.rmSync(home, { recursive: true, force: true });
}
console.log('dashboard tests passed');
process.exit(0);
