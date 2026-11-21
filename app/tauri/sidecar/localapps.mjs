// Local apps TiroDash hosts in its window (the Tools pages): Jamie's own photo tools, each a small web server on
// 127.0.0.1 only, run as a child of this sidecar and shown in a frame.
//   Photo Cull: ships inside TiroDash (tools/photo-cull, from Jamie's photo-cull repo), run on this app's own Node
//     with --no-browser. No setup.
//   InstaTool: Jamie's own folder (a Python app with its own .venv, exiftool and Anthropic key in its .env), run as
//     `.venv\Scripts\python.exe -m instatool ui`. Its folder is a setting; TiroDash never reads its .env.
// Nothing here is reachable from outside this PC: the servers listen on 127.0.0.1, and only a URL that the app itself
// printed (http://127.0.0.1:<port>/) is ever shown.
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { isYes } from './safety.mjs';

export const PHOTO_CULL = fileURLToPath(new URL('./tools/photo-cull/server.cjs', import.meta.url));
export const INSTATOOL_DIR = (home = os.homedir()) => path.join(home, 'source', 'repos', 'instatool');
const LOCAL_URL = /(http:\/\/127\.0\.0\.1:\d{2,5}\/?)/;
const TAIL = 40;

/** The local address an app printed when it was ready, or null. */
export const readyUrl = (line) => { const m = LOCAL_URL.exec(String(line ?? '')); return m ? m[1].replace(/\/?$/, '/') : null; };

/** How each app starts: the command, its folder, and how long to wait for its address. */
export function appSpecs({ node = process.execPath, home = os.homedir(), instatoolDir = INSTATOOL_DIR(home), platform = process.platform } = {}) {
  const py = platform === 'win32' ? path.join(instatoolDir, '.venv', 'Scripts', 'python.exe') : path.join(instatoolDir, '.venv', 'bin', 'python');
  return {
    photocull: { name: 'Photo Cull', cmd: node, args: [PHOTO_CULL, '--no-browser'], cwd: path.dirname(PHOTO_CULL), wait: 20_000, check: () => (fs.existsSync(PHOTO_CULL) ? '' : 'Photo Cull is missing from this install. Reinstall TiroDash.') },
    instatool: {
      name: 'InstaTool', cmd: py, args: ['-m', 'instatool', 'ui', '--no-browser'], cwd: instatoolDir, wait: 45_000,
      // It prints its address before the server is up, so it counts as ready once /api/status answers.
      probe: 'api/status', env: { PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
      check: () => {
        if (!fs.existsSync(path.join(instatoolDir, 'instatool'))) return `InstaTool isn't in ${instatoolDir}. Set its folder on this page.`;
        if (!fs.existsSync(py)) return `InstaTool's Python environment isn't set up (${path.join(instatoolDir, '.venv')} is missing). See its README, "One-time setup".`;
        return '';
      },
    },
  };
}

/**
 * send: the sidecar's send (to the shell). specs: () => appSpecs(...) (re-read each start, so a new folder counts).
 * Returns { handle(msg) → true for app_* messages, start(id) → url, stop(id), stopAll(), state, show(id, extra) }.
 */
export function createLocalApps({ send, specs = () => appSpecs(), spawn = nodeSpawn, log = () => {}, now = () => Date.now(), fetchImpl = fetch } = {}) {
  const apps = new Map(); // id → { state: 'off'|'starting'|'on'|'failed', url, error, tail, proc, ready }
  let pending = null;     // a page to show once TiroDash's window is open: { page, ...extra }
  const get = (id) => { if (!apps.has(id)) apps.set(id, { state: 'off', url: '', error: '', tail: [], proc: null, ready: null }); return apps.get(id); };
  const view = () => Object.fromEntries([...apps].map(([id, a]) => [id, { state: a.state, url: a.url, error: a.error }]));
  const out = () => send({ type: 'dash', msg: { kind: 'apps', apps: view() } });

  function start(id) {
    const spec = specs()[id];
    if (!spec) return Promise.reject(new Error('No such app.'));
    const a = get(id);
    if (a.state === 'on' && a.proc && a.proc.exitCode === null) return Promise.resolve(a.url);
    if (a.ready) return a.ready;
    const bad = spec.check?.() ?? '';
    if (bad) { Object.assign(a, { state: 'failed', error: bad, url: '' }); out(); return Promise.reject(new Error(bad)); }
    Object.assign(a, { state: 'starting', error: '', url: '', tail: [] });
    out();
    a.ready = new Promise((resolve, reject) => {
      let proc, done = false;
      const finish = (err, url) => {
        if (done) return;
        done = true; clearTimeout(timer); a.ready = null;
        if (err) { Object.assign(a, { state: 'failed', error: err, url: '' }); out(); reject(new Error(err)); return; }
        Object.assign(a, { state: 'on', url, readyAt: now() }); out(); resolve(url);
      };
      try {
        proc = spawn(spec.cmd, spec.args, { cwd: spec.cwd, env: { ...process.env, ...spec.env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) { finish(`${spec.name} didn't start: ${String(e?.message ?? e).slice(0, 200)}`); return; }
      a.proc = proc;
      const timer = setTimeout(() => finish(`${spec.name} didn't say it was ready within ${Math.round(spec.wait / 1000)} s.${a.tail.length ? ` Last output: ${a.tail.slice(-3).join(' / ')}` : ''}`), spec.wait);
      let probing = false;
      const answers = async (url) => { try { return (await fetchImpl(url + spec.probe, { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; } };
      const onLine = (line) => {
        a.tail.push(line.slice(0, 300)); if (a.tail.length > TAIL) a.tail.shift();
        const url = readyUrl(line);
        if (!url || done) return;
        if (!spec.probe) { finish(null, url); return; }
        if (probing) return;
        probing = true;
        (async () => { while (!done) { if (await answers(url)) { finish(null, url); return; } await new Promise((r) => setTimeout(r, 500)); } })();
      };
      for (const s of [proc.stdout, proc.stderr]) {
        let buf = '';
        s?.setEncoding?.('utf8');
        s?.on('data', (d) => { buf += d; const lines = buf.split(/\r?\n/); buf = lines.pop(); lines.forEach(onLine); });
      }
      proc.on('error', (e) => finish(`${spec.name} didn't start: ${e.code === 'ENOENT' ? `${spec.cmd} wasn't found` : String(e?.message ?? e).slice(0, 200)}`));
      proc.on('exit', (code) => {
        log({ app: id, exit: code });
        if (a.proc === proc) a.proc = null;
        if (!done) { finish(`${spec.name} stopped (exit ${code}).${a.tail.length ? ` ${a.tail.slice(-3).join(' / ')}` : ''}`); return; }
        // Photo Cull hands over to a copy already running (prints that one's address, exits 0 straight away): keep it.
        if (a.state !== 'on' || (code === 0 && now() - a.readyAt < 5000)) return;
        // A copy he started himself may hold the port (this one then exits): keep it while it answers.
        const url = a.url;
        (spec.probe ? answers(url) : Promise.resolve(false)).then((ok) => { if (!ok && a.url === url && !a.proc) { Object.assign(a, { state: 'off', url: '' }); out(); } });
      });
    });
    return a.ready;
  }
  function stop(id) {
    const a = apps.get(id);
    if (!a) return;
    try { a.proc?.kill(); } catch { /* already gone */ }
    Object.assign(a, { state: 'off', url: '', proc: null });
    out();
  }
  const stopAll = () => { for (const id of apps.keys()) { try { apps.get(id).proc?.kill(); } catch { /* gone */ } } };

  return {
    start, stop, stopAll,
    get state() { return view(); },
    /** Open TiroDash on an app's page (extra: e.g. { folder } for Photo Cull). */
    show(page, extra = {}) {
      pending = { page, ...extra, t: now() };
      send({ type: 'dashboard_show' });
      send({ type: 'dash', msg: { kind: 'goto', ...pending } });
    },
    /** TiroDash's window (re)opened: the page it was asked to show, if that was in the last minute. */
    opened() { if (pending && now() - pending.t < 60_000) send({ type: 'dash', msg: { kind: 'goto', ...pending } }); pending = null; out(); },
    handle(m) {
      if (!m || typeof m.type !== 'string' || !m.type.startsWith('app_')) return false;
      const id = String(m.id ?? '');
      if (m.type === 'app_start') start(id).catch(() => {});
      else if (m.type === 'app_stop') stop(id);
      else if (m.type === 'app_restart') { stop(id); start(id).catch(() => {}); }
      return true;
    },
  };
}

// ---- the agent's tools ----
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const expandHome = (p, home) => String(p ?? '').trim().replace(/^"|"$/g, '').replace(/^~(?=$|[\\/])/, home);

/** photo_cull (open Photo Cull in TiroDash, on a folder) and instatool (see instatoolTool). */
export function appTools({ apps, ask, home = os.homedir(), checkRead = null, fetchImpl = fetch } = {}) {
  return [
    {
      name: 'photo_cull',
      description: "Open Jamie's Photo Cull in the TiroDash window, optionally on a folder of photos (a shoot, a memory card). Photo Cull shows one photo at a time and he sorts them with keys (keep, reject, undo); RAW+JPG pairs move together into _Keep / _Trash next to the photos. It never moves anything by itself: say what's opened and leave the culling to him. folder: the full path, or leave it out for the start screen (recent folders, memory cards).",
      parameters: z.object({ folder: z.string().max(1000).optional() }),
      execute: async ({ folder } = {}) => {
        let p = folder ? expandHome(folder, home) : '';
        if (p) {
          if (!path.isAbsolute(p)) p = path.resolve(home, p);
          const v = checkRead?.(p, home);
          if (v && v.level !== 'safe') throw new Error(v.reason || "That folder can't be opened.");
          if (!isDir(p)) throw new Error(`There's no folder at ${p}.`);
        }
        apps.show('photocull', p ? { folder: p } : {});
        await apps.start('photocull');
        return p ? `Photo Cull is open in TiroDash on ${path.basename(p) || p}. He culls with the keys there.` : 'Photo Cull is open in TiroDash (start screen: recent folders and memory cards).';
      },
    },
    instatoolTool({ apps, ask, home, checkRead, fetchImpl }),
  ];
}

const money = (v) => `$${(Number(v) || 0).toFixed((Number(v) || 0) < 0.1 ? 3 : 2)}`;
/**
 * instatool: Jamie's InstaTool through its own local API (the one its page uses), so the page shows the same state.
 * Paid steps (analyse, plan) show the estimate and ask Allow / Don't allow every time (never skipped); its own
 * spend cap still applies on top. Results are about his photos and come from Claude: information, not instructions.
 */
export function instatoolTool({ apps, ask, home = os.homedir(), checkRead = null, fetchImpl = fetch, pollMs = 1000, waitMs = 120_000 } = {}) {
  async function api(base, method, route, body) {
    const r = await fetchImpl(base + route, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`InstaTool said no (${r.status}): ${typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail ?? j).slice(0, 200)}`);
    return j;
  }
  // A job: its result when it finishes in time, else where it is (it carries on; the InstaTool page shows it).
  async function job(base, jid, signal) {
    const end = Date.now() + waitMs;
    for (;;) {
      const j = await api(base, 'GET', `api/jobs/${encodeURIComponent(jid)}`);
      if (j.state === 'done') return { done: true, result: j.result ?? {}, log: (j.log ?? []).slice(-6) };
      if (j.state === 'error') throw new Error(`${j.name}: ${String(j.error ?? 'failed').slice(0, 400)}`);
      if (Date.now() > end || signal?.aborted) return { done: false, log: (j.log ?? []).slice(-3) };
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  const allow = async (question, ctx) => isYes(await ask({ placeholder: question, choices: ['Allow', "Don't allow"] }, ctx?.signal));
  const still = (name, log) => `${name} is still running in InstaTool (it carries on; the InstaTool page in TiroDash shows its progress).${log.length ? ` Latest: ${log.join(' / ')}` : ''}`;
  return {
    name: 'instatool',
    description: "Jamie's InstaTool: sorts camera photos into Instagram posts (Claude scores photos, groups carousels, orders the feed, drafts captions), runs on this PC. action: status (latest import, analysed count, plan, spend); import (folder: a shoot's folder; free, no Claude); analyze (Claude pass 1 on the new photos; limit: only that many; costs money, so it shows the estimate and asks him); plan (re-check the best, group into posts, captions; costs money, asks); export (numbered post folders from the latest plan); open (the InstaTool page in TiroDash, where he reorders the grid and edits captions). One step at a time; reordering and editing are done by him on the page.",
    parameters: z.object({ action: z.enum(['status', 'import', 'analyze', 'plan', 'export', 'open']), folder: z.string().max(1000).optional(), limit: z.number().int().min(1).max(2000).optional() }),
    execute: async ({ action, folder, limit }, ctx) => {
      if (action === 'open') { apps.show('instatool'); await apps.start('instatool'); return 'InstaTool is open in TiroDash.'; }
      const base = await apps.start('instatool');
      if (action === 'status') {
        const s = await api(base, 'GET', 'api/status');
        const ph = s.photos ?? {}, u = s.usage ?? {};
        return [
          s.import_id ? `Latest import: ${ph.folder ?? '?'}: ${ph.kept ?? 0} kept, ${ph.analysed ?? 0} analysed${ph.flagged ? `, ${ph.flagged} flagged` : ''}.` : 'No photos imported yet.',
          s.plan_id ? `Latest plan: #${s.plan_id}.` : 'No plan yet.',
          s.pending_batches ? `${s.pending_batches} batch(es) still at Anthropic.` : '',
          `Spent today ${money(u.today?.usd)}, this month ${money(u['this month']?.usd)}. Cap per run ${money(s.spend_cap_usd)}.`,
          s.has_api_key ? '' : 'No Anthropic key in InstaTool\'s .env yet, so analyse and plan won\'t work (README: "Anthropic API key").',
        ].filter(Boolean).join('\n');
      }
      if (action === 'import') {
        let p = expandHome(folder, home);
        if (!p) throw new Error('Which folder? Give the full path of the shoot.');
        if (!path.isAbsolute(p)) p = path.resolve(home, p);
        const v = checkRead?.(p, home);
        if (v && v.level !== 'safe') throw new Error(v.reason || "That folder can't be read.");
        if (!isDir(p)) throw new Error(`There's no folder at ${p}.`);
        const { job: jid } = await api(base, 'POST', 'api/import', { folder: p });
        const r = await job(base, jid, ctx?.signal);
        if (!r.done) return still('The import', r.log);
        const x = r.result;
        return `Imported ${path.basename(p)}: ${x.found ?? '?'} found, ${x.new ?? '?'} new, ${x.known ?? 0} already known${x.raw_skipped ? `, ${x.raw_skipped} RAF skipped (camera JPEGs used)` : ''}. Free; nothing sent to Claude. Next: analyze (costs a little; it asks first).`;
      }
      if (action === 'analyze' || action === 'plan') {
        const est = await api(base, 'POST', `api/${action}/estimate`, action === 'analyze' ? { limit: limit ?? null } : {});
        if (action === 'analyze' && !est.photos) return `Nothing new to analyse (${est.cached ?? 0} already done, no charge).`;
        if (action === 'plan' && !est.import_id) return 'No photos imported yet: import a folder first.';
        const what = action === 'analyze'
          ? `Analyse ${est.photos} photo${est.photos === 1 ? '' : 's'} with ${est.model}${est.batch ? ' (half-price batch, can take a while)' : ''}`
          : `Plan posts with ${est.model}: re-check ${est.pass2_photos} top photos, group them, captions for about ${est.caption_posts} posts${est.missing_pass1 ? ` (${est.missing_pass1} unanalysed photos left out)` : ''}`;
        if (!(await allow(`${what}? About ${money(est.usd)}, at most ${money(est.usd_worst_case)}.`, ctx))) return `Jamie said no, so nothing was sent to Claude and nothing was spent.`;
        const { job: jid } = await api(base, 'POST', `api/${action}/run`, action === 'analyze' ? { limit: limit ?? null } : {});
        const r = await job(base, jid, ctx?.signal);
        if (!r.done) return still(action === 'analyze' ? 'The analysis' : 'The plan', r.log);
        const x = r.result;
        return action === 'analyze'
          ? `Analysed ${x.ok ?? 0} photo(s) for ${money(x.usd)}.${x.flagged?.length ? ` ${x.flagged.length} flagged (tried again next time).` : ''} Next: plan (asks first).`
          : `Plan #${x.plan_id} is ready (${money(x.usd)}). He reorders posts and picks captions on the InstaTool page; then export.`;
      }
      // export: the latest plan
      const s = await api(base, 'GET', 'api/status');
      if (!s.plan_id) return 'There is no plan to export yet: plan first.';
      const { job: jid } = await api(base, 'POST', `api/plan/${encodeURIComponent(s.plan_id)}/export`);
      const r = await job(base, jid, ctx?.signal);
      if (!r.done) return still('The export', r.log);
      const x = r.result;
      return `Exported ${x.posts ?? 0} post(s) and ${x.stories ?? 0} Story set(s), ${x.images ?? 0} images, to ${x.folder ?? 'its output folder'}.${x.problems?.length ? ` Check: ${x.problems.slice(0, 5).join('; ')}` : ''}`;
    },
  };
}
