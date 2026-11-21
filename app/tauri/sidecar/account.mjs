// The Tiro account this computer is signed in as: TiroDash's sign-in page. One person across every Tiro app
// (TiroWeb, TiroDash, the glasses, Hermes): the server makes a personal token for this PC once that person
// approves it, and every request to Tiro sends it (tiro.mjs setTiroToken).
//
// Two ways in (the server side is brain/app/devlink.py):
// - Sign in with Tiro: POST /link/start gives an 8-character code; the browser opens TiroWeb at /?link=CODE, where
//   the person (signed in there with Google or Tailscale) checks the code and taps Sign in; this polls
//   GET /link/{id} and collects the token once.
// - Continue as <name>: this PC is already known to Tiro by its Tailscale identity (GET /whoami), so it asks for
//   its own token directly (POST /tokens), as TiroWeb's Settings → Apps & tokens would.
//
// The token is kept with secrets.mjs (DPAPI on Windows, never in plain text); who it belongs to (name, email) is in
// ~/.tiro/sidekick/account.json, which holds nothing secret. Sign out revokes the token on the server too.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const SECRET = 'tiro-account';
const POLL_MS = 2000;
const WAIT_MS = 10 * 60_000; // the server's code lifetime
const str = (v, n = 120) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const person = (u) => (u && u.id ? { id: str(u.id, 40), name: str(u.name, 80), email: str(u.email, 120), owner: !!u.owner } : null);
export const deviceName = () => str(process.env.COMPUTERNAME || os.hostname() || 'this PC', 40);

/**
 * call: tiroCall. secrets: { get, set, delete }. setToken: tiro.mjs setTiroToken. base(): the server's address.
 * open(url): the browser. onChange(state): the sign-in changed (TiroDash's page and the rest of the app).
 */
export function createAccount({ call, secrets, setToken, base, open = () => {}, onChange = () => {}, dir, now = () => Date.now(), schedule = setTimeout, pollMs = POLL_MS, log = () => {} } = {}) {
  const file = path.join(dir, 'account.json');
  let user = null, signed = false, tailscale = null, pending = null, error = '', busy = false, timer = null, loaded = false;
  const state = () => ({
    signedIn: signed, user, device: deviceName(), busy, error,
    pending: pending ? { code: pending.code, url: pending.url, until: pending.until } : null,
    // Known by Tailscale but not signed in: offered as "Continue as <name>".
    tailscale: !signed && tailscale ? { name: tailscale.name || tailscale.email, email: tailscale.email } : null,
  });
  const changed = () => onChange(state());
  const fail = (e) => { error = str(e?.message ?? e, 300); busy = false; changed(); };

  async function save(token, u) {
    await secrets.set(SECRET, token); // throws when the safe store can't take it: then it isn't kept at all
    setToken(token);
    signed = true; user = person(u); error = ''; tailscale = null;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, JSON.stringify({ user, device: deviceName(), at: new Date(now()).toISOString() }, null, 1));
    log({ event: 'signed_in', user: user?.email ?? '' });
  }

  /** At start: the saved sign-in, if any. Then who the server says this is (a revoked token shows as signed out). */
  async function load() {
    try {
      const token = await secrets.get(SECRET);
      if (token) { setToken(token); signed = true; }
      try { user = person(JSON.parse(await fs.readFile(file, 'utf8')).user); } catch { user = null; }
    } catch (e) { log({ event: 'load_failed', error: str(e?.message ?? e) }); }
    loaded = true;
    changed();
    refresh().catch(() => {}); // not waited for: offline, start-up mustn't hang on it
    return state();
  }

  /** Asks the server who this is. Signed in: the person (name changes come through). Not: whether Tailscale knows. */
  async function refresh() {
    let w;
    try { w = await call('GET', '/whoami', undefined, { timeout: 8000 }); } catch { return state(); } // offline: keep what we have
    if (signed && w?.user) { user = person(w.user); }
    else if (signed && !w?.user) { await forget(); error = 'Tiro signed this computer out. Sign in again.'; }
    else tailscale = person(w?.user);
    changed();
    return state();
  }

  async function forget() {
    setToken(''); signed = false; user = null;
    await secrets.delete(SECRET).catch(() => {});
    await fs.rm(file, { force: true }).catch(() => {});
  }

  function stopPolling() { if (timer) { clearTimeout(timer); timer = null; } pending = null; }

  /** Sign in with Tiro: a code, the browser, then wait for the person to approve it. */
  async function start() {
    if (busy) return;
    stopPolling(); busy = true; error = ''; changed();
    let r;
    try { r = await call('POST', '/link/start', { app: 'tirodash', device: deviceName() }, { timeout: 15_000 }); } catch (e) { return fail(e); }
    const code = str(r.code, 12), id = str(r.link_id, 40);
    if (!code || !id) return fail('Tiro sent back no code. Try again.');
    pending = { id, code, url: `${base()}/?link=${encodeURIComponent(code)}`, until: now() + Math.min(WAIT_MS, (Number(r.expires_in) || 600) * 1000) };
    busy = false; changed();
    open(pending.url);
    const tick = async () => {
      timer = null;
      if (!pending || pending.id !== id) return;
      if (now() > pending.until) { stopPolling(); return fail('The code ran out. Start again.'); }
      let c;
      try { c = await call('GET', `/link/${encodeURIComponent(id)}`, undefined, { timeout: 10_000 }); } catch { c = { status: 'pending' }; } // a blip: keep waiting
      if (!pending || pending.id !== id) return;
      if (c.status === 'approved' && c.token) {
        stopPolling();
        try { await save(String(c.token), c.user); } catch (e) { return fail(`Signed in, but Windows couldn't store the key safely (${str(e?.message ?? e, 120)}). Try again.`); }
        busy = false; changed(); return;
      }
      if (c.status === 'denied') { stopPolling(); return fail('Turned down in TiroWeb. Nothing was signed in.'); }
      if (c.status === 'expired') { stopPolling(); return fail('The code ran out. Start again.'); }
      timer = schedule(tick, pollMs);
    };
    timer = schedule(tick, pollMs);
  }

  /** Continue as the person Tailscale says this PC belongs to: its own token, straight away. */
  async function viaTailscale() {
    if (busy || signed || !tailscale) return;
    busy = true; error = ''; changed();
    try {
      const r = await call('POST', '/tokens', { label: `TiroDash · ${deviceName()}` }, { timeout: 15_000 });
      if (!r?.token) throw new Error('Tiro sent back no key.');
      await save(String(r.token), tailscale);
      busy = false;
      await refresh();
    } catch (e) { fail(e); }
  }

  async function signOut() {
    stopPolling();
    if (signed) await call('POST', '/link/signout', {}, { timeout: 10_000 }).catch(() => {}); // revoked there too, when it can be reached
    await forget();
    error = ''; busy = false;
    log({ event: 'signed_out' });
    return refresh();
  }

  /** acct_* messages from TiroDash. True when it was one. */
  function handle(m) {
    switch (m?.type) {
      case 'acct_open': changed(); if (loaded) refresh(); return true;
      case 'acct_start': start(); return true;
      case 'acct_tailscale': viaTailscale(); return true;
      case 'acct_cancel': stopPolling(); error = ''; changed(); return true;
      case 'acct_reopen': if (pending) open(pending.url); return true;
      case 'acct_signout': signOut(); return true;
      default: return false;
    }
  }

  return { load, refresh, handle, state, signOut, get signedIn() { return signed; }, get user() { return user; } };
}
