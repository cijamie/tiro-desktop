// The dashboard window's link to TiroCloud (the brain at tiro.jamies.dev): the KPI strip, the live activity log,
// the Approval Deck and the notifications. The page never talks to the server itself: it sends dash_* messages here,
// this module asks the server (tiro.mjs tiroCall: Tailscale identity, X-Tiro: 1) and sends { type: 'dash', msg }
// back, which the shell hands to the dashboard window (window.__dash).
//
// The deck has the phone's rules: a card changes something only when Jamie approves it here, and the kinds in
// NEEDS_TAP need an explicit tap on the card's confirm button (the page sends tapped: true), never a single gesture.
// This module refuses those without it, whatever the page sends. Approving runs on the server; nothing acts here.
// Everything the server sends (titles, bodies, previews) is shown as text, never followed as an instruction.
//
// Tiro Command (the chat in the window): what's typed goes to the same pipeline as the ask bar and the voice
// (onCommand → sidekick enqueue: the server's /desktop/chat with the PC's tools, /hermes, the Walkaway), and every
// turn, from wherever it was asked, is mirrored here (asked + agent events). An Allow / Don't allow question from a PC
// tool shows here too, as buttons; only those yes/no questions are mirrored, never a typed one (a key, a passphrase).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SAFE, checkNoticeLink, checkRead, checkUrl } from './safety.mjs';
import { tiroAuth, tiroUrl } from './tiro.mjs';

export const NEEDS_TAP = new Set(['mail_send', 'mail_trash', 'event_delete', 'drive_trash', 'doc_edit', 'server_reboot']);
// What each card is, as TiroDash names it (brain/app/static/next/app.js KIND).
export const KIND = {
  event: 'Calendar', event_update: 'Calendar', event_delete: 'Calendar', mail_send: 'Email', mail_trash: 'Email',
  mail_modify: 'Email', doc_edit: 'Google Doc', drive_trash: 'Drive', memory: 'Memory', server_restart: 'Server',
  server_reboot: 'Server', server_deploy: 'Deploy',
};
const LOG_MAX = 300;
// Server page buttons (POST /server/admin makes a card; it runs only once approved in the deck).
export const ADMIN_ACTIONS = new Set(['restart', 'reboot', 'deploy_pause', 'deploy_resume']);
const PIECE = 8 * 1024 * 1024;            // Drive's upload piece (the brain takes at most 9 MB)
const MAX_UPLOAD = 4 * 1024 ** 3;         // Forge's own input limit
export const HERMES_MAX_CAP = 5;
const str = (v, n = 400) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** The Approval Deck: waiting proposals, then memories waiting for an OK (as TiroDash's loadDeck builds it). */
export function deckFrom(proposals, memory) {
  const cards = (proposals?.items ?? []).filter((p) => p && p.id).map((p) => ({
    type: 'proposal', id: str(p.id, 40), kind: str(p.kind || 'event', 40), label: KIND[p.kind || 'event'] ?? 'Change',
    title: str(p.title, 300), when: str(p.when, 120), location: str(p.location, 200), preview: String(p.preview ?? '').slice(0, 4000),
    ok: str(p.ok_label || 'Approve', 40), done: str(p.done_label || 'Done', 40), from: from(p.source), tap: NEEDS_TAP.has(p.kind),
  }));
  const mems = (memory?.items ?? []).filter((m) => m && m.pending && m.id).map((m) => ({
    type: 'memory', id: str(m.id, 40), kind: 'memory', label: 'Memory', title: str(m.text, 600), when: 'Remember this?',
    location: '', preview: '', ok: 'Remember', done: 'Remembered', from: from(m.source), tap: false,
  }));
  return cards.concat(mems);
}
const from = (s) => (s === 'hermes' ? 'Hermes' : s === 'chat' ? 'Chat' : str(s, 30));

/** The KPI strip from what the server said; anything missing shows as unknown, never as a made-up number. */
export function kpiFrom({ ms = null, health = null, system = null, hermes = null, status = null, dash = null, error = '' } = {}) {
  const sys = system && !system.error ? system : null;
  const gib = (b) => (typeof b === 'number' ? Math.round((b / 2 ** 30) * 10) / 10 : null);
  const spend = dash?.spend?.ok ? dash.spend : null;
  const wx = dash?.weather?.ok ? dash.weather : null;
  return {
    cloud: { ok: !!health?.ok && !error, ms: typeof ms === 'number' ? Math.round(ms) : null, error: str(error, 200) },
    cpu: sys && typeof sys.cpu_pct === 'number' ? Math.round(sys.cpu_pct) : null,
    temp: sys?.temps && typeof sys.temps.cpu === 'number' ? Math.round(sys.temps.cpu) : null,
    ram: sys && sys.ram_total ? { used: gib(sys.ram_used), total: gib(sys.ram_total), pct: Math.round((sys.ram_used / sys.ram_total) * 100) } : null,
    stale: !!sys?.stale,
    deploy: sys?.deploy ? { result: str(sys.deploy.result, 20), commit: str(sys.deploy.commit, 12), at: str(sys.deploy.done || sys.deploy.time, 30) } : null,
    containers: Array.isArray(sys?.containers) ? sys.containers.map((c) => ({ name: str(c.name, 40), state: str(c.state, 20), cpu: str(c.cpu, 12), mem: str(c.mem, 40) })) : [],
    model: status ? { mode: status.ai_mode === 'claude' ? 'Claude only' : 'Local first', name: str(status.model, 60), local: !!status.local?.ok } : null,
    spend: spend ? { month: Number(spend.api_cost) || 0, limit: Number(spend.limit) || 0, today: Number(spend.today) || 0 } : null,
    hermes: hermes && !hermes.error ? {
      state: !hermes.configured ? 'off' : hermes.paused ? 'paused' : hermes.running ? 'running' : 'stopped',
      today: Number(hermes.today_usd) || 0, month: Number(hermes.month_usd) || 0, cap: Number(hermes.cap_usd) || 0,
    } : null,
    weather: wx ? { place: str(wx.place, 40), temp: wx.now?.temp ?? null, sky: str(wx.now?.sky, 40), low: wx.today?.low ?? null, high: wx.today?.high ?? null } : null,
  };
}

/** Server-sent events: complete events out of the text so far, and what's left for the next chunk. */
export function parseSse(text) {
  const events = [];
  const blocks = text.replace(/\r\n/g, '\n').split('\n\n');
  const rest = blocks.pop();
  for (const block of blocks) {
    let type = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) continue;
    let json = null;
    try { json = JSON.parse(data.join('\n')); } catch { /* not JSON: ignored */ }
    events.push({ type, data: json });
  }
  return { events, rest };
}

/** A notice as one activity-log line. Hermes's own notices are Hermes's; the rest are the server's. */
export const noticeLine = (n, t = Date.now()) => ({
  t: Date.parse(n?.t) || t, src: n?.kind === 'hermes' ? 'hermes' : 'server', kind: str(n?.kind, 30),
  text: [str(n?.title, 160), str(n?.body, 240)].filter(Boolean).join(': ') || 'Notification',
});

/**
 * call: tiroCall. send: the sidecar's send (to the shell). open: opens a link in the browser (only after
 * safety.mjs checkNoticeLink). fetchImpl / env: for the event stream.
 * Returns { handle(msg) → true when it was a dash_* message, pc(recent), stop() }.
 */
export function createDashboard({ owner = () => null, call, send, open: openUrl = () => {}, onCommand = () => {}, onAnswer = () => {}, onNew = () => {}, chatId = () => null, fetchImpl = fetch, env = process.env, now = () => Date.now(), log = () => {}, pollMs = 10_000, home = os.homedir() } = {}) {
  let open = false, poll = null, slow = null, sse = null, backoff = 5000, retry = null;
  // The conversation as the window shows it: { role: 'user'|'tiro', text, tools: [{ id, label, state }], state }.
  let chat = [], asks = new Map(), loadedChat = null;
  let deck = [], lines = [], seenPc = new Set(), kpiIn = {}, notes = { items: [], unread: 0 };
  const out = (msg) => send({ type: 'dash', msg });
  const addLines = (add) => {
    if (!add.length) return;
    lines = add.concat(lines).sort((a, b) => b.t - a.t).slice(0, LOG_MAX);
    if (open) out({ kind: 'log', lines });
  };
  const safe = (p) => p.catch((e) => ({ error: String(e?.message ?? e) }));

  async function kpi() {
    const t0 = now();
    const health = await safe(call('GET', '/health', undefined, { timeout: 8000 }));
    const ms = health.error ? null : now() - t0;
    // The server's stats and Hermes are the owner's only: someone else's TiroDash doesn't ask (owner() false: the signed-in
    // account isn't the owner; null: not known yet, so it asks and the server says no).
    const mine = owner() !== false;
    const [system, hermes] = mine ? await Promise.all([safe(call('GET', '/system', undefined, { timeout: 8000 })), safe(call('GET', '/hermes', undefined, { timeout: 8000 }))]) : [null, null];
    kpiIn = { ...kpiIn, ms, health: health.error ? null : health, system, hermes, error: health.error ?? '' };
    if (open) out({ kind: 'kpi', kpi: kpiFrom(kpiIn) });
  }
  async function slowKpi() {
    const [status, dash] = await Promise.all([safe(call('GET', '/status', undefined, { timeout: 20_000 })), safe(call('GET', '/dashboard', undefined, { timeout: 30_000 }))]);
    kpiIn = { ...kpiIn, status: status.error ? null : status, dash: dash.error ? null : dash };
    if (open) out({ kind: 'kpi', kpi: kpiFrom(kpiIn) });
  }
  async function loadDeck() {
    const [p, m] = await Promise.all([safe(call('GET', '/proposals')), safe(call('GET', '/memory'))]);
    if (p.error) { out({ kind: 'deck', items: deck, error: p.error }); return; }
    deck = deckFrom(p, m.error ? null : m);
    out({ kind: 'deck', items: deck });
  }
  async function loadNotes() {
    const r = await safe(call('GET', '/notifications'));
    if (r.error) return;
    notes = { items: (r.items ?? []).slice(0, 100).map((n) => ({ ...noticeLine(n), title: str(n.title, 160), body: str(n.body, 400), url: str(n.url, 500), new: !!n.new })), unread: Number(r.unread) || 0 };
    out({ kind: 'notes', ...notes });
    // The log starts with what happened before the window opened.
    addLines(notes.items.filter((n) => !lines.some((l) => l.t === n.t && l.text === n.text)).map(({ t, src, kind, text }) => ({ t, src, kind, text })));
  }

  // The live stream: one connection while the window is open, back again after a drop (5 s, doubling to a minute).
  async function connect() {
    if (!open || sse) return;
    const ctl = new AbortController();
    sse = ctl;
    const headers = { accept: 'text/event-stream' };
    if (tiroAuth(env)) headers.authorization = tiroAuth(env);
    try {
      const r = await fetchImpl(`${tiroUrl(env)}/events`, { headers, signal: ctl.signal });
      if (!r.ok || !r.body) throw new Error(`events ${r.status}`);
      out({ kind: 'conn', live: true });
      backoff = 5000;
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of r.body) {
        const { events, rest } = parseSse(buf + dec.decode(chunk, { stream: true }));
        buf = rest;
        for (const ev of events) onEvent(ev);
      }
    } catch (e) {
      if (ctl.signal.aborted) return;
      log({ events_error: String(e?.message ?? e).slice(0, 200) });
    } finally {
      if (sse === ctl) sse = null;
    }
    if (!open) return;
    out({ kind: 'conn', live: false });
    retry = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 60_000);
  }
  function onEvent({ type, data }) {
    if (type === 'notice' && data) {
      if (data.kind === 'forge') loadForge();
      out({ kind: 'toast', notice: { title: str(data.title, 160), body: str(data.body, 400), kind: str(data.kind, 30), url: str(data.url, 500) } });
      addLines([noticeLine(data, now())]);
      loadNotes();
    } else if (type === 'cards') loadDeck();
    else if (type === 'drive') addLines([{ t: now(), src: 'server', kind: 'drive', text: 'Files changed' }]);
  }

  async function act({ id, type, ok, tapped }) {
    const card = deck.find((c) => c.id === id && c.type === type);
    if (!card) { await loadDeck(); out({ kind: 'deck', items: deck, error: 'That card is gone (handled somewhere else).' }); return; }
    if (ok && card.tap && tapped !== true) { out({ kind: 'deck', items: deck, error: `${card.label} changes need a tap on "${card.ok}".` }); return; }
    const path = card.type === 'memory' ? `/memory/${encodeURIComponent(card.id)}${ok ? '/approve' : ''}` : `/proposals/${encodeURIComponent(card.id)}/${ok ? 'approve' : 'dismiss'}`;
    const r = await safe(call(card.type === 'memory' && !ok ? 'DELETE' : 'POST', path, card.type === 'memory' ? undefined : {}, { timeout: 60_000 }));
    if (r.error) { out({ kind: 'deck', items: deck, error: r.error }); return; }
    addLines([{ t: now(), src: 'pc', kind: 'card', text: `${ok ? card.done : 'Dismissed'}: ${card.label}, ${card.title}`.slice(0, 300) }]);
    out({ kind: 'acted', id, ok, done: ok ? card.done : 'Dismissed' });
    await loadDeck();
  }

  // ---- Server, Hermes, Forge ----
  let admin = null, forge = { jobs: [] }, uploads = [];
  async function loadAdmin() {
    if (owner() === false) return;
    const r = await safe(call('GET', '/server/admin', undefined, { timeout: 15_000 }));
    if (r.error) { out({ kind: 'admin', error: r.error }); return; }
    admin = {
      services: (r.services ?? []).map((x) => str(x, 40)).filter(Boolean),
      recent: (r.recent ?? []).slice(0, 10).map((j) => ({ action: str(j.action, 20), service: str(j.service, 40), ok: j.ok !== false && !j.error, text: str(j.message ?? j.error ?? j.result, 200), t: str(j.done ?? j.t ?? j.time, 30) })),
      waiting: Number(r.waiting) || 0, helper: !!r.helper, rebootOk: !!r.reboot_ok, deployPaused: !!r.deploy_paused,
      tail: String(r.deploy_tail ?? '').slice(-6000),
    };
    out({ kind: 'admin', ...admin });
  }
  async function adminCard({ action, service }) {
    if (!ADMIN_ACTIONS.has(action)) return;
    if (action === 'restart' && !(admin?.services ?? []).includes(service)) { out({ kind: 'note', text: 'Pick one of the services listed.', bad: true }); return; }
    const r = await safe(call('POST', '/server/admin', { action, service: action === 'restart' ? service : '', reason: 'from Tiro desktop' }));
    if (r.error) { out({ kind: 'note', text: r.error, bad: true }); return; }
    addLines([{ t: now(), src: 'pc', kind: 'card', text: `Asked for a card: ${action.replace('_', ' ')}${action === 'restart' ? ` ${service}` : ''}` }]);
    out({ kind: 'note', text: 'Card made. Approve it under Approvals (here or on your phone).' });
    await loadDeck();
  }
  async function hermesCap(usd) {
    const v = Math.round(Number(usd) * 100) / 100;
    if (!Number.isFinite(v) || v < 0 || v > HERMES_MAX_CAP) { out({ kind: 'note', text: `The daily cap is between $0 and $${HERMES_MAX_CAP}.`, bad: true }); return; }
    const r = await safe(call('POST', '/hermes/cap', { daily_usd: v }));
    if (r.error) { out({ kind: 'note', text: r.error, bad: true }); return; }
    out({ kind: 'note', text: `Hermes's daily cap is now $${v.toFixed(2)}.` });
    kpi();
  }
  async function loadForge() {
    const r = await safe(call('GET', '/forge'));
    if (r.error) { out({ kind: 'forge', jobs: forge.jobs, error: r.error }); return; }
    forge = { jobs: (r.jobs ?? []).slice(0, 20).map((j) => ({ id: str(j.id, 40), kind: str(j.kind, 20), title: str(j.title, 160), status: str(j.status, 20), progress: str(j.progress, 120), error: str(j.error, 300), made: Number(j.made) || 0 })) };
    out({ kind: 'forge', jobs: forge.jobs });
  }
  async function forgeJob(m) {
    let body;
    if (m.kind === 'download') {
      const v = checkUrl(m.url);
      if (v.level !== SAFE) { out({ kind: 'note', text: v.reason, bad: true }); return; }
      body = { kind: 'download', url: String(m.url).slice(0, 2000), audio: m.audio === true };
    } else if (m.kind === 'convert' || m.kind === 'ocr') {
      if (typeof m.file_id !== 'string' || !m.file_id) return;
      body = { kind: m.kind, file_id: m.file_id.slice(0, 600), ...(m.kind === 'convert' ? { to: String(m.to ?? '').slice(0, 10) } : {}) };
    } else return;
    const r = await safe(call('POST', '/forge', body, { timeout: 60_000 }));
    if (r.error) { out({ kind: 'note', text: r.error, bad: true }); return; }
    addLines([{ t: now(), src: 'pc', kind: 'forge', text: `Forge: ${body.kind === 'download' ? 'downloading a link' : body.kind === 'ocr' ? 'reading the text' : `converting to ${body.to.toUpperCase()}`}` }]);
    out({ kind: 'note', text: "Started in Tiro Forge. You'll get a notification when it's done." });
    await loadForge();
  }
  // Files dropped on the window (main.rs sends their paths): checked like any file read (safety.mjs checkRead),
  // uploaded to Tiro's Files in 8 MB pieces, then offered for conversion. One at a time.
  let upChain = Promise.resolve(), upSeq = 0;
  const upOut = () => out({ kind: 'uploads', items: uploads });
  function dropped(paths) {
    for (const p of (Array.isArray(paths) ? paths : []).slice(0, 20)) {
      if (typeof p !== 'string' || !p) continue;
      const u = { id: `u${++upSeq}`, name: str(path.basename(p), 200), pct: 0, state: 'waiting', error: '', file: null, to: [], ocr: false };
      uploads = [u, ...uploads].slice(0, 12);
      upOut();
      upChain = upChain.then(() => upload(p, u)).catch((e) => { u.state = 'failed'; u.error = str(e?.message ?? e, 300); upOut(); });
    }
    return upChain;
  }
  async function upload(p, u) {
    const v = checkRead(p, home);
    if (v.level !== SAFE) throw new Error(v.reason || 'That file is in a protected place, so it stays on this PC.');
    const st = await fs.stat(p);
    if (!st.isFile()) throw new Error('Drop files, not folders.');
    if (st.size > MAX_UPLOAD) throw new Error('Too big for Forge (4 GB at most).');
    u.state = 'uploading'; upOut();
    const up = await call('POST', '/drive/uploads', { name: u.name, size: st.size }, { timeout: 30_000 });
    let file = up.done ? up.file : null, at = 0;
    const fh = await fs.open(p, 'r');
    try {
      while (!file && at < st.size) {
        const n = Math.min(PIECE, st.size - at), buf = Buffer.alloc(n);
        await fh.read(buf, 0, n, at);
        const headers = { 'content-type': 'application/octet-stream', 'x-tiro': '1' };
        if (tiroAuth(env)) headers.authorization = tiroAuth(env);
        const r = await fetchImpl(`${tiroUrl(env)}/drive/uploads/${encodeURIComponent(up.id)}?offset=${at}`, { method: 'PUT', headers, body: buf, signal: AbortSignal.timeout(120_000) });
        const j = await r.json().catch(() => ({}));
        if (r.status === 409 && Number.isFinite(j.received)) { at = j.received; continue; }
        if (!r.ok) throw new Error(`Upload stopped (${r.status}${typeof j.detail === 'string' ? `: ${j.detail}` : ''}).`);
        at = Number(j.received) || at + n;
        if (j.done) file = j.file;
        u.pct = Math.min(100, Math.round((at / Math.max(1, st.size)) * 100)); upOut();
      }
    } finally { await fh.close(); }
    if (!file?.id) throw new Error("The upload finished but Tiro didn't say where the file went.");
    const t = await safe(call('GET', `/forge/targets?name=${encodeURIComponent(u.name)}`));
    Object.assign(u, { state: 'done', pct: 100, file: { id: str(file.id, 600), name: str(file.name ?? u.name, 200) }, to: (t.to ?? []).map((x) => str(x, 10)), ocr: !!t.ocr });
    addLines([{ t: now(), src: 'pc', kind: 'upload', text: `Uploaded ${u.name} to Tiro's Files` }]);
    upOut();
  }

  // ---- Tiro Command ----
  const CHAT_MAX = 120;
  const sendChat = () => { if (open) out({ kind: 'chat', items: chat, asks: [...asks.values()] }); };
  const lastTiro = () => { const m = chat.at(-1); return m?.role === 'tiro' && m.state === 'live' ? m : null; };
  const push = (m) => { chat.push(m); if (chat.length > CHAT_MAX) chat = chat.slice(-CHAT_MAX); };
  // The saved conversation on the server (shared with the phone), when the window opens on one already going.
  async function loadChat() {
    const id = chatId();
    if (!id || id === loadedChat || chat.length) return;
    const c = await safe(call('GET', `/chats/${encodeURIComponent(id)}`));
    if (c.error || !Array.isArray(c.messages)) return;
    loadedChat = id;
    chat = c.messages.filter((m) => typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant')).slice(-40)
      .map((m) => ({ role: m.role === 'user' ? 'user' : 'tiro', text: str(m.content.replace(/^\[[^\]]{6,40}\]\s*/, ''), 20000), tools: [], state: 'done', t: Date.parse(m.t) || 0 }));
    sendChat();
  }
  function asked(text) {
    push({ role: 'user', text: String(text ?? '').slice(0, 20000), tools: [], state: 'done', t: now() });
    sendChat();
  }
  function agent(e) {
    if (!e || typeof e.type !== 'string') return;
    let m = lastTiro();
    if (e.type === 'start') { if (!m) push({ role: 'tiro', text: '', tools: [], state: 'live', t: now() }); }
    else if (e.type === 'text') { if (!m) { m = { role: 'tiro', text: '', tools: [], state: 'live', t: now() }; push(m); } m.text = (m.text + String(e.text ?? '')).slice(-40000); }
    else if (e.type === 'tool' && e.anim) { if (m) m.tools.push({ id: str(e.id, 80), label: str([e.anim.label, e.anim.detail].filter(Boolean).join(' '), 80), state: 'run' }); }
    else if (e.type === 'tool_end') { const t = m?.tools.find((x) => x.id === e.id); if (t) t.state = e.isError ? 'bad' : 'ok'; }
    else if (e.type === 'done' || e.type === 'error') {
      if (!m) { m = { role: 'tiro', text: '', tools: [], state: 'live', t: now() }; push(m); }
      if (e.type === 'error') { m.error = str(e.message, 600); m.state = 'bad'; } else m.state = 'done';
      for (const t of m.tools) if (t.state === 'run') t.state = 'ok';
    } else return;
    sendChat();
  }
  // A yes/no from a PC tool (tools.mjs confirm): shown as buttons; answered here or in the overlay, whichever first.
  function ask({ id, question, choices }) {
    if (!Array.isArray(choices) || !choices.length) return;
    asks.set(id, { id: str(id, 40), question: str(question, 600), choices: choices.map((c) => str(c, 40)) });
    sendChat();
  }
  function askDone(id) { if (asks.delete(id)) sendChat(); }

  function start() {
    if (open) { kpi(); loadDeck(); loadNotes(); sendChat(); return; }
    open = true;
    out({ kind: 'log', lines });
    sendChat(); loadChat();
    kpi(); slowKpi(); loadDeck(); loadNotes(); loadAdmin(); loadForge(); connect();
    if (uploads.length) upOut();
    poll = setInterval(kpi, pollMs);
    slow = setInterval(slowKpi, 5 * 60_000);
  }
  function stop() {
    open = false;
    clearInterval(poll); clearInterval(slow); clearTimeout(retry);
    poll = slow = retry = null;
    sse?.abort(); sse = null;
  }

  return {
    get open() { return open; },
    get deck() { return deck; },
    get lines() { return lines; },
    /** A dash_* message from the page; false for anything else. */
    handle(m) {
      if (!m || typeof m.type !== 'string' || !m.type.startsWith('dash_')) return false;
      if (m.type === 'dash_open') start();
      else if (m.type === 'dash_closed') stop();
      else if (m.type === 'dash_refresh') { kpi(); slowKpi(); loadDeck(); loadNotes(); }
      else if (m.type === 'dash_act' && typeof m.id === 'string' && (m.card === 'proposal' || m.card === 'memory')) act({ id: m.id, type: m.card, ok: m.ok === true, tapped: m.tapped === true });
      else if (m.type === 'dash_seen') safe(call('POST', '/notifications/seen', {})).then(loadNotes);
      else if (m.type === 'dash_link') {
        // A notification's link: a Tiro page or Gmail only (safety.mjs), opened in the browser.
        const v = checkNoticeLink(m.url, tiroUrl(env));
        if (v.url) openUrl(v.url); else out({ kind: 'note', text: v.reason, bad: true });
      } else if (m.type === 'dash_panel') send({ type: 'panel_show' });
      else if (m.type === 'dash_cmd' && typeof m.text === 'string' && m.text.trim()) onCommand(m.text.trim().slice(0, 8000));
      else if (m.type === 'dash_answer' && typeof m.id === 'string') {
        // Only a question that's still open, and only one of its own choices.
        const q = asks.get(m.id);
        if (q && q.choices.includes(m.value)) { asks.delete(m.id); onAnswer(m.id, m.value); sendChat(); }
      } else if (m.type === 'dash_new') { chat = []; loadedChat = null; asks.clear(); onNew(); sendChat(); }
      else if (m.type === 'dash_admin') { if (m.refresh) loadAdmin(); else adminCard({ action: String(m.action ?? ''), service: String(m.service ?? '') }); }
      else if (m.type === 'dash_hermes_cap') hermesCap(m.usd);
      else if (m.type === 'dash_forge') { if (m.refresh) loadForge(); else forgeJob(m); }
      else if (m.type === 'dash_drop') dropped(m.paths);
      return true;
    },
    /** The PC's own actions (activity.mjs recent, newest first) into the log, each once. */
    pc(recent) {
      const add = [];
      for (const r of recent ?? []) {
        const key = `${r.at}|${r.text}`;
        if (seenPc.has(key)) continue;
        seenPc.add(key);
        add.push({ t: r.at, src: 'pc', kind: str(r.kind, 20), text: str(r.text, 300) });
      }
      if (seenPc.size > 2000) seenPc = new Set([...seenPc].slice(-1000));
      addLines(add);
    },
    stop,
    asked,
    agent,
    /** A notice from Tiro on the server for this PC (desktools notify): a toast and a log line. */
    notice({ title, body = '' }) {
      if (open) out({ kind: 'toast', notice: { title: str(title, 160), body: str(body, 400), kind: 'pc', url: '' } });
      addLines([{ t: now(), src: 'server', kind: 'notify', text: [str(title, 160), str(body, 240)].filter(Boolean).join(': ') }]);
    },
    ask,
    askDone,
    get chat() { return chat; },
    get uploads() { return uploads; },
    /** For tests: the upload queue as a promise. */
    drop: (paths) => dropped(paths),
  };
}
