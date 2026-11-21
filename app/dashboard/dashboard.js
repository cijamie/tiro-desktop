// TiroDash, the desktop app's one window. TiroCloud's pages: everything they show comes from the sidecar
// (dashboard.mjs) as window.__dash(msg); everything they do is a dash_* message back. The sign-in (account.mjs) is
// acct_* messages and a { kind: 'account' } state. This PC and Settings are the old tray panel's pages
// (panel/index.html?embed=1) in one frame: its messages come in as window.__pc(msg) and are handed to it, and the
// rail tells it which page to show. Server text is only ever set with textContent. In a plain browser (no Tauri)
// it runs on sample data, for checking the layout.
(() => {
  const TAURI = window.__TAURI__?.core?.invoke;
  const send = TAURI ? (msg) => TAURI('sidecar_send', { msg }).catch(() => {}) : (msg) => preview(msg);
  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v != null && v !== false) n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) n.append(c);
    return n;
  };
  // replaceChildren with the empty parts (null, false) left out.
  const fill = (node, ...kids) => node.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
  const hhmm = (t) => { const d = new Date(t); return Number.isNaN(+d) ? '' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); };
  const money = (v) => `$${(Number(v) || 0).toFixed(2)}`;

  const S = { account: null, skipped: false, kpi: null, deck: [], deckErr: '', lines: [], notes: { items: [], unread: 0 }, live: null, page: 'overview', filter: 'all', armed: null, busy: false, chat: [], asks: [], admin: null, jobs: [], uploads: [] };

  // ---------------------------------------------------------------- rail
  // [id, name, group]. 'pc' pages are the panel's, shown in the frame.
  const PAGES = [
    ['overview', 'Overview', 'TiroCloud'], ['chat', 'Chat', 'TiroCloud'], ['approvals', 'Approvals', 'TiroCloud'],
    ['server', 'Server', 'TiroCloud'], ['hermes', 'Hermes', 'TiroCloud'], ['forge', 'Forge', 'TiroCloud'], ['logs', 'Logs', 'TiroCloud'],
    ['today', 'Today', 'This PC'], ['home', 'Home', 'This PC'], ['memory', 'Memory', 'This PC'],
    ['account', 'Account', 'Settings'], ['model', 'Model', 'Settings'], ['appearance', 'Appearance', 'Settings'],
    ['speaking', 'Speaking', 'Settings'], ['listening', 'Listening', 'Settings'], ['shortcuts', 'Shortcuts', 'Settings'],
    ['routines', 'Routines', 'Settings'], ['general', 'General', 'Settings'], ['about', 'About', 'Settings'], ['whatsnew', "What's new", 'Settings'],
  ];
  const PC = new Set(['today', 'home', 'memory', 'model', 'appearance', 'speaking', 'listening', 'shortcuts', 'routines', 'general', 'about', 'whatsnew']);
  const SOON = {};
  function rail() {
    const kids = [];
    let grp = '';
    for (const [id, name, g] of PAGES) {
      if (g !== grp) { grp = g; kids.push(el('p', { class: 'grp', text: g, 'aria-hidden': 'true' })); }
      kids.push(el('button', {
        type: 'button', role: 'tab', 'aria-selected': String(S.page === id), id: `tab-${id}`, onclick: () => go(id),
      }, name, id === 'approvals' && S.deck.length ? el('span', { class: 'n num', text: String(S.deck.length) }) : null));
    }
    $('rail').replaceChildren(...kids);
  }
  // The frame with the panel's pages: what it should show, handed over once it has loaded.
  const pcWin = () => { try { return $('pc').contentWindow; } catch { return null; } };
  function pcShow(id) { const w = pcWin(); if (w?.__embedShow) w.__embedShow(id); else S.pcWant = id; }
  $('pc').addEventListener('load', () => { if (S.pcWant) { pcShow(S.pcWant); S.pcWant = null; } });
  function go(id, { fromPc = false } = {}) {
    if (!PAGES.some(([p]) => p === id)) id = 'overview';
    S.page = id;
    const page = PC.has(id) ? 'pc' : SOON[id] ? 'soon' : id;
    for (const s of document.querySelectorAll('.page')) s.hidden = s.id !== `page-${page}`;
    if (SOON[id]) { $('soonName').textContent = SOON[id][0]; $('soonText').textContent = SOON[id][1]; }
    if (PC.has(id) && !fromPc) pcShow(id);
    if (id === 'notes') { send({ type: 'dash_seen' }); }
    if (id === 'account') send({ type: 'acct_open' });
    rail(); render();
    $('main').scrollTop = 0;
  }
  // The panel's messages (main.rs to_panel) go on to the frame; the panel says which page it opened itself
  // (asked with nothing signed in: Model), so the rail follows.
  window.__pc = (m) => { const w = pcWin(); if (w?.__panel) w.__panel(m); else if (m?.kind === 'state') S.pcState = m; };
  window.__pcReady = () => { if (S.pcState) { pcWin()?.__panel?.(S.pcState); S.pcState = null; } };
  window.__pcShown = (id) => { if (PC.has(id) && S.page !== id) go(id, { fromPc: true }); };

  // ---------------------------------------------------------------- account and the sign-in gate
  function account() {
    const a = S.account, key = JSON.stringify([a, S.skipped, S.page]);
    if (key === S.acctKey) return; // unchanged: leave the buttons (and the focus) alone
    S.acctKey = key;
    $('who').hidden = !a?.signedIn;
    if (a?.signedIn) $('whoName').textContent = a.user?.name || a.user?.email || 'you';
    const gateOn = !!a && !a.signedIn && !S.skipped;
    $('gate').hidden = !gateOn;
    document.body.classList.toggle('gated', gateOn);
    if (gateOn) fill($('gateBody'), signInParts(a, true));
    $('gateErr').hidden = !a?.error || !gateOn; $('gateErr').textContent = a?.error ?? '';
    $('gateDev').textContent = a?.device ?? '';
    if (S.page !== 'account') return;
    $('acctDev').textContent = a?.device ?? '';
    if (!a) return fill($('acctBox'), el('p', { class: 'note', text: '…' }));
    if (a.signedIn) {
      return fill($('acctBox'),
        el('div', { class: 'acct' }, el('span', { class: 'nm', text: a.user?.name || 'Signed in' }), el('span', { class: 'em', text: a.user?.email ?? '' })),
        el('p', { class: 'note', text: `This PC (${a.device}) talks to Tiro as this account, on or off Tailscale.` }),
        el('div', { class: 'btnrow' }, el('button', { class: 'btn ghost', type: 'button', onclick: () => send({ type: 'acct_signout' }), disabled: a.busy }, 'Sign out')),
        a.error ? el('p', { class: 'err', text: a.error }) : null);
    }
    fill($('acctBox'), el('p', { class: 'note', text: 'Not signed in. Tiro goes by this PC\'s Tailscale identity meanwhile, if it has one.' }), signInParts(a, false),
      a.error ? el('p', { class: 'err', text: a.error }) : null);
  }
  function signInParts(a, big) {
    if (a.pending) {
      return [
        el('p', { class: 'code num', text: a.pending.code, 'aria-label': `Code ${a.pending.code.split('').join(' ')}` }),
        el('p', { class: 'wait', text: 'Waiting for you to approve it in TiroWeb…' }),
        el('div', { class: 'btnrow' },
          el('button', { class: `btn${big ? '' : ' ghost'}`, type: 'button', onclick: () => send({ type: 'acct_reopen' }) }, 'Open TiroWeb again'),
          el('button', { class: 'btn ghost', type: 'button', onclick: () => send({ type: 'acct_cancel' }) }, 'Cancel')),
      ];
    }
    return [
      el('button', { class: 'btn', type: 'button', disabled: a.busy, onclick: () => send({ type: 'acct_start' }) }, a.busy ? 'Starting…' : 'Sign in with Tiro'),
      a.tailscale ? el('button', { class: 'btn ghost', type: 'button', disabled: a.busy, onclick: () => send({ type: 'acct_tailscale' }) }, `Continue as ${a.tailscale.name}`) : null,
      a.tailscale ? el('p', { class: 'note', text: 'Tailscale already knows this PC is yours, so no code is needed.' }) : null,
    ];
  }
  $('who').addEventListener('click', () => go('account'));
  $('gateSkip').addEventListener('click', () => { S.skipped = true; account(); });

  // ---------------------------------------------------------------- KPI strip
  function strip() {
    const k = S.kpi, c = [];
    const chip = (label, value, { cls = '', title = '', dot = '' } = {}) => el('span', { class: `chip ${cls}`, title }, dot ? el('span', { class: `sdot ${dot}` }) : null, el('span', { class: 'tlbl', text: label }), value != null ? el('b', { class: 'num', text: value }) : null);
    if (!k) c.push(chip('TiroCloud', '…'));
    else {
      c.push(chip('TiroCloud', k.cloud.ok ? (k.cloud.ms != null ? `${k.cloud.ms} ms` : 'up') : 'offline', { dot: k.cloud.ok ? 'ok' : 'bad', cls: k.cloud.ok ? '' : 'bad', title: k.cloud.error || 'TiroCloud health and how long it took to answer' }));
      if (k.cpu != null) c.push(chip('CPU', `${k.cpu}%${k.temp != null ? ` · ${k.temp}°` : ''}`, { cls: k.temp >= 85 ? 'bad' : k.temp >= 75 ? 'warn' : '' }));
      if (k.ram) c.push(chip('RAM', `${k.ram.used}/${k.ram.total} G`, { cls: k.ram.pct >= 90 ? 'warn' : '' }));
      if (k.model) c.push(chip('Model', k.model.mode, { title: k.model.name }));
      if (k.spend) c.push(chip('AI', `${money(k.spend.month)} / $${Math.round(k.spend.limit)}`, { title: 'Claude spend this month', cls: k.spend.limit && k.spend.month >= k.spend.limit ? 'bad' : '' }));
      if (k.hermes) c.push(chip('Hermes', `${k.hermes.state} · ${money(k.hermes.today)}`, { dot: k.hermes.state === 'running' ? 'ok' : k.hermes.state === 'paused' ? 'warn' : '', title: `Today ${money(k.hermes.today)} of ${money(k.hermes.cap)} · month ${money(k.hermes.month)}` }));
      if (k.stale) c.push(chip('Stats', 'stale', { cls: 'warn', title: 'The server stats are over a minute old' }));
    }
    $('strip').replaceChildren(...c);
    const n = S.notes.unread;
    $('bellN').textContent = String(n);
    $('bell').classList.toggle('hot', n > 0);
    const w = k?.weather;
    $('wx').textContent = w ? `${w.place || 'Weather'} ${w.temp ?? '?'}° ${w.sky || ''}${w.low != null ? ` · ${w.low}–${w.high}°` : ''}` : '';
  }

  // ---------------------------------------------------------------- activity log
  const SRC = { all: 'All', server: 'Server', hermes: 'Hermes', pc: 'PC' };
  function filters(id) {
    $(id).replaceChildren(...Object.entries(SRC).map(([k, name]) => el('button', { type: 'button', 'aria-pressed': String(S.filter === k), onclick: () => { S.filter = k; render(); } }, name)));
  }
  function log(id, max) {
    const lines = S.lines.filter((l) => S.filter === 'all' || l.src === S.filter).slice(0, max);
    $(id).replaceChildren(...(lines.length ? lines.map((l) => el('li', {}, el('span', { class: 't', text: hhmm(l.t) }), el('span', { class: `s ${l.src}`, text: SRC[l.src] ?? l.src }), el('span', { class: 'x', text: l.text })))
      : [el('li', { class: 'empty', text: S.filter === 'all' ? 'Nothing yet. Tiro\'s notifications, Hermes and what this PC does show up here.' : 'Nothing from here yet.' })]));
  }

  // ---------------------------------------------------------------- approval deck
  function deck(box) {
    const n = S.deck.length;
    if (!n) {
      fill(box, el('div', { class: 'lbl' }, '[ ', el('b', { text: 'Waiting for you' }), ' ]'), el('p', { class: 'note', text: S.deckNote || 'All clear. New cards show up here and on your phone.' }),
        S.deckErr ? el('p', { class: 'err', text: S.deckErr }) : null);
      return;
    }
    const p = S.deck[0], armed = S.armed === p.id;
    const act = (ok, tapped = false) => {
      if (S.busy) return;
      if (ok && p.tap && !tapped) { S.armed = p.id; render(); box.querySelector('.dconfirm .btn')?.focus(); return; }
      S.busy = true; S.deckErr = '';
      box.querySelector('.dcard')?.classList.add(ok ? 'out-r' : 'out-l');
      send({ type: 'dash_act', id: p.id, card: p.type, ok, tapped });
    };
    const card = el('div', { class: 'dcard', tabindex: '0', 'aria-label': `${p.label}: ${p.title}`,
      onkeydown: (e) => { if (e.key === 'ArrowRight') act(true); else if (e.key === 'ArrowLeft') act(false); } },
    el('span', { class: 'dtag k', text: p.label }), p.from ? el('span', { class: 'dtag', text: `from ${p.from}` }) : null,
    el('span', { class: 'dtitle', text: p.title }), el('span', { class: 'dsub', text: [p.when, p.location].filter(Boolean).join(' · ') }),
    p.preview ? el('pre', { class: 'dprev', text: p.preview }) : null,
    armed ? el('div', { class: 'dconfirm' }, el('button', { class: 'btn', type: 'button', onclick: () => act(true, true) }, `Tap to ${p.ok.toLowerCase()}`),
      el('button', { class: 'link', type: 'button', onclick: () => { S.armed = null; render(); } }, 'Not yet')) : null);
    fill(box, 
      el('div', { class: 'lbl' }, '[ ', el('b', { text: 'Waiting for you' }), ' ]', el('span', { class: 'r num', text: `${n} left` })),
      el('div', { class: 'stackd' }, n > 2 ? el('div', { class: 'dshadow two' }) : null, n > 1 ? el('div', { class: 'dshadow' }) : null, card),
      el('div', { class: 'dbtns' }, el('button', { class: 'btn ghost', type: 'button', disabled: S.busy, onclick: () => act(false) }, 'Dismiss'),
        el('button', { class: 'btn', type: 'button', disabled: S.busy || armed, onclick: () => act(true) }, p.ok)),
      el('p', { class: 'dhint', text: `→ ${p.ok} · ← Dismiss${p.tap ? ' · needs a tap' : ''}` }),
      S.deckErr ? el('p', { class: 'err', text: S.deckErr }) : null,
    );
  }

  // ---------------------------------------------------------------- notifications
  function notes(id, max) {
    const items = S.notes.items.slice(0, max);
    $(id).replaceChildren(...(items.length ? items.map((n) => el('li', {}, el('span', { class: `t ${n.new ? '' : 'old'}`, text: hhmm(n.t) }),
      el('span', { class: 'x' }, n.title, n.body ? el('span', { text: n.body }) : null),
      n.url ? el('button', { class: 'link go', type: 'button', onclick: () => send({ type: 'dash_link', url: n.url }) }, 'open') : null))
      : [el('li', {}, el('span', { class: 'x note', text: 'No notifications yet.' }))]));
  }

  // ---------------------------------------------------------------- server / hermes
  function kv(id, rows) {
    $(id).replaceChildren(...rows.filter(Boolean).flatMap(([k, v, cls]) => [el('dt', { text: k }), el('dd', { class: cls || '', text: v ?? '—' })]));
  }
  function server() {
    const k = S.kpi;
    if (!k) return;
    kv('sys', [
      ['Health', k.cloud.ok ? `up · ${k.cloud.ms ?? '?'} ms` : `offline${k.cloud.error ? ` · ${k.cloud.error}` : ''}`, k.cloud.ok ? 'ok' : 'bad'],
      ['CPU', k.cpu != null ? `${k.cpu}%` : null], ['Temp', k.temp != null ? `${k.temp}°C` : null, k.temp >= 85 ? 'bad' : k.temp >= 75 ? 'warn' : ''],
      ['RAM', k.ram ? `${k.ram.used} of ${k.ram.total} GiB (${k.ram.pct}%)` : null],
      ['Model', k.model ? `${k.model.mode} · ${k.model.name}${k.model.local ? '' : ' · local model down'}` : null],
      ['Deploy', k.deploy ? `${k.deploy.result} · ${k.deploy.commit} · ${k.deploy.at}` : null, k.deploy && k.deploy.result !== 'ok' ? 'bad' : ''],
    ]);
    $('sysAge').textContent = k.stale ? 'stale' : '';
    const rows = k.containers.map((c) => el('tr', {}, el('td', { text: c.name }), el('td', { class: c.state === 'running' ? 'ok' : 'bad', text: c.state }), el('td', { text: c.cpu }), el('td', { text: c.mem })));
    $('ctr').replaceChildren(el('tr', {}, ...['Service', 'State', 'CPU', 'Memory'].map((h) => el('th', { text: h }))), ...rows);
  }
  // The admin buttons only ask the server for a card (dashboard.mjs); the deck is where it's approved.
  function admin() {
    const a = S.admin;
    if (!a) return;
    if (a.error) { fill($('adminBtns'), el('p', { class: 'err', text: a.error })); fill($('svc')); fill($('adminJobs')); return; }
    const card = (action, service = '') => send({ type: 'dash_admin', action, service });
    fill($('adminBtns'),
      el('button', { class: 'btn ghost', type: 'button', onclick: () => card(a.deployPaused ? 'deploy_resume' : 'deploy_pause') }, a.deployPaused ? 'Resume auto-deploy' : 'Pause auto-deploy'),
      el('button', { class: 'btn warn', type: 'button', disabled: !a.rebootOk, title: a.rebootOk ? '' : 'The server can\'t reboot itself (no permission, or it just started)', onclick: () => card('reboot') }, 'Reboot server…'));
    fill($('svc'), el('span', { class: 'tlbl lbl', text: 'Restart' }), a.services.map((s) => el('button', { type: 'button', onclick: () => card('restart', s) }, s)));
    fill($('adminJobs'), a.recent.length ? a.recent.map((j) => el('li', {}, el('span', { class: `st ${j.ok ? 'done' : 'failed'}`, text: j.ok ? 'ok' : 'failed' }),
      el('span', { class: 'x' }, `${j.action}${j.service ? ` ${j.service}` : ''}`, j.text ? el('span', { text: j.text }) : null)))
      : [el('li', {}, el('span', { class: 'x note', text: a.helper ? 'No admin jobs yet.' : 'The server\'s admin helper isn\'t running, so approved cards wait.' }))]);
    $('tail').textContent = a.tail || '(empty)';
    $('tail').scrollTop = $('tail').scrollHeight;
  }
  function forge() {
    const ups = S.uploads;
    $('upPanel').hidden = !ups.length;
    fill($('ups'), ups.map((u) => el('li', {}, el('span', { class: `st ${u.state}`, text: u.state === 'uploading' ? `${u.pct}%` : u.state }),
      el('div', { class: 'x' }, u.name,
        u.state === 'uploading' ? el('div', { class: 'bar' }, el('i', { style: `width:${u.pct}%` })) : null,
        u.error ? el('span', { class: 'err', text: u.error }) : null,
        u.state === 'done' ? el('div', { class: 'chips' },
          u.to.map((t) => el('button', { type: 'button', onclick: () => send({ type: 'dash_forge', kind: 'convert', file_id: u.file.id, to: t }) }, `→ ${t}`)),
          u.ocr ? el('button', { type: 'button', onclick: () => send({ type: 'dash_forge', kind: 'ocr', file_id: u.file.id }) }, 'Read text') : null,
          !u.to.length && !u.ocr ? el('span', { class: 'note', text: 'Saved to Files. Forge can\'t convert this kind of file.' }) : null) : null))));
    fill($('jobs'), S.jobs.length ? S.jobs.map((j) => el('li', {}, el('span', { class: `st ${j.status}`, text: j.status }),
      el('span', { class: 'x' }, j.title, j.progress && j.status === 'running' ? el('span', { text: j.progress }) : null, j.error ? el('span', { class: 'err', text: j.error }) : null)))
      : [el('li', {}, el('span', { class: 'x note', text: 'No Forge jobs yet.' }))]);
  }
  $('adminRefresh').addEventListener('click', () => send({ type: 'dash_admin', refresh: true }));
  $('forgeRefresh').addEventListener('click', () => send({ type: 'dash_forge', refresh: true }));
  $('capForm').addEventListener('submit', (e) => { e.preventDefault(); const v = $('capIn').value; if (v !== '') send({ type: 'dash_hermes_cap', usd: Number(v) }); });
  $('dlForm').addEventListener('submit', (e) => { e.preventDefault(); const u = $('dlIn').value.trim(); if (!u) return; send({ type: 'dash_forge', kind: 'download', url: u, audio: $('dlAudio').checked }); $('dlIn').value = ''; });

  function hermes() {
    const h = S.kpi?.hermes;
    kv('herm', h ? [['State', h.state, h.state === 'running' ? 'ok' : h.state === 'paused' ? 'warn' : ''], ['Today', `${money(h.today)} of ${money(h.cap)}`, h.cap && h.today >= h.cap ? 'bad' : ''], ['This month', money(h.month)]]
      : [['State', S.kpi ? 'unknown (owner only, or the server is offline)' : '…']]);
  }

  // ---------------------------------------------------------------- Tiro Command
  const who = (role) => el('span', { class: 'who tlbl lbl', text: role === 'user' ? 'You' : 'Tiro' });
  function msgEl(m) {
    return el('li', { class: `msg ${m.role} ${m.state === 'live' ? 'live' : ''}` }, who(m.role), m.text || (m.state === 'live' ? '' : m.error ? '' : '(no reply)'),
      m.tools?.length ? el('div', { class: 'tools' }, m.tools.map((t) => el('span', { class: `tool ${t.state}`, text: t.label }))) : null,
      m.error ? el('p', { class: 'err', text: m.error }) : null);
  }
  function asksEl(box) {
    fill(box, S.asks.map((q) => el('div', { class: 'askq' }, el('span', { class: 'tlbl lbl', text: 'Needs your OK' }), el('p', { text: q.question }),
      q.choices.map((c, i) => el('button', { class: `btn ${i ? 'ghost' : ''}`, type: 'button', onclick: () => send({ type: 'dash_answer', id: q.id, value: c }) }, c)))));
  }
  function chatPage() {
    const box = $('chat'), atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    fill(box, S.chat.length ? S.chat.map(msgEl) : [el('li', { class: 'empty', text: 'Ask anything. "/hermes …" asks Hermes; "Tiro, I\'m heading out …" hands what you\'re doing to Hermes, with this PC\'s context.' })]);
    asksEl($('asks-c'));
    if (atEnd) box.scrollTop = box.scrollHeight;
  }
  // The Overview shows the latest exchange (and any question waiting for an OK) under the box.
  function lastExchange() {
    const box = $('last-o'), t = [...S.chat].reverse().find((m) => m.role === 'tiro'), u = [...S.chat].reverse().find((m) => m.role === 'user');
    box.hidden = !t && !S.asks.length;
    if (box.hidden) return;
    const asks = el('div', { class: 'asks' }); asksEl(asks);
    fill(box, t ? [who('tiro'), t.text || (t.state === 'live' ? `Working on "${(u?.text ?? '').slice(0, 80)}"…` : ''), t.error ? el('p', { class: 'err', text: t.error }) : null] : [], S.asks.length ? asks : null);
  }
  function command(input) {
    const text = input.value.trim();
    if (!text) return;
    send({ type: 'dash_cmd', text });
    input.value = '';
    fitBox(input);
  }
  const fitBox = (ta) => { if (ta.tagName !== 'TEXTAREA') return; ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`; };
  for (const k of ['o', 'c']) {
    const form = $(`cmd-${k}`), input = $(`cmdIn-${k}`);
    form.addEventListener('submit', (e) => { e.preventDefault(); command(input); if (k === 'o' && S.page !== 'chat') lastExchange(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && input.tagName === 'TEXTAREA') { e.preventDefault(); command(input); } });
    input.addEventListener('input', () => fitBox(input));
  }
  $('newChat').addEventListener('click', () => send({ type: 'dash_new' }));

  // ---------------------------------------------------------------- render
  function render() {
    account();
    strip(); rail();
    if (S.page === 'overview') { filters('filters-o'); log('log-o', 80); deck($('deck-o')); notes('notes-o', 6); lastExchange(); }
    else if (S.page === 'chat') chatPage();
    else if (S.page === 'approvals') deck($('deck-a'));
    else if (S.page === 'logs') { filters('filters-l'); log('log-l', 300); $('logCount').textContent = `${S.lines.length} lines`; }
    else if (S.page === 'notes') { notes('notes-n', 100); $('noteCount').textContent = `${S.notes.items.length}`; }
    else if (S.page === 'server') { server(); admin(); }
    else if (S.page === 'hermes') { hermes(); const c = S.kpi?.hermes?.cap; if (c != null && document.activeElement !== $('capIn')) $('capIn').value = String(c); }
    else if (S.page === 'forge') forge();
    $('live').textContent = S.live == null ? '…' : S.live ? 'live' : 'reconnecting…';
  }
  function toast(n) {
    const t = el('div', { class: 'toast', role: 'status' }, el('span', { class: 'tlbl lbl', text: n.kind || 'Tiro' }), el('b', { text: n.title || 'Tiro' }), n.body ? el('p', { text: n.body }) : null);
    if (n.url) { t.style.cursor = 'pointer'; t.addEventListener('click', () => send({ type: 'dash_link', url: n.url })); }
    $('toasts').prepend(t);
    while ($('toasts').children.length > 4) $('toasts').lastChild.remove();
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 220); }, 6000);
  }
  function snack(text, bad) {
    const s = $('snack');
    s.textContent = text; s.classList.toggle('bad', !!bad); s.hidden = false;
    clearTimeout(snack.t); snack.t = setTimeout(() => { s.hidden = true; }, 4000);
  }

  window.__dash = (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.kind === 'kpi') S.kpi = m.kpi;
    else if (m.kind === 'deck') { S.deck = m.items ?? []; S.deckErr = m.error ?? ''; S.busy = false; if (!S.deck.some((c) => c.id === S.armed)) S.armed = null; if (S.deck.length) S.deckNote = ''; }
    else if (m.kind === 'acted') { S.deckNote = `${m.done} · all clear`; S.armed = null; }
    else if (m.kind === 'log') S.lines = m.lines ?? [];
    else if (m.kind === 'notes') S.notes = { items: m.items ?? [], unread: m.unread ?? 0 };
    else if (m.kind === 'conn') S.live = !!m.live;
    else if (m.kind === 'toast') toast(m.notice ?? {});
    else if (m.kind === 'note') snack(m.text, m.bad);
    else if (m.kind === 'chat') { S.chat = m.items ?? []; S.asks = m.asks ?? []; }
    else if (m.kind === 'admin') S.admin = m;
    else if (m.kind === 'forge') S.jobs = m.jobs ?? [];
    else if (m.kind === 'uploads') { S.uploads = m.items ?? []; if (S.uploads.length && S.page !== 'forge' && S.uploads.some((u) => u.state === 'waiting')) go('forge'); }
    else if (m.kind === 'drag') document.body.classList.toggle('dragging', !!m.on);
    else if (m.kind === 'account') { const was = S.account?.signedIn; S.account = m.account ?? null; if (S.account?.signedIn && was === false) snack(`Signed in as ${S.account.user?.name || S.account.user?.email || 'you'}.`); }
    render();
  };

  $('bell').addEventListener('click', () => go('notes'));
  $('seeAll').addEventListener('click', () => go('notes'));
  $('openWeb').addEventListener('click', () => send({ type: 'dash_link', url: '/' }));
  addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r') { e.preventDefault(); send({ type: 'dash_refresh' }); } });
  go('overview');
  send({ type: 'dash_open' });
  send({ type: 'acct_open' });

  // ---------------------------------------------------------------- browser preview (sample data)
  function preview(msg) {
    if (msg.type?.startsWith('acct_')) {
      const q = new URLSearchParams(location.search), me = { id: 'u1', name: 'Jamie', email: 'jamie@example.com', owner: true };
      preview.acct ??= q.has('signedout') ? { signedIn: false, user: null, device: 'AEROBOOK', busy: false, error: '', pending: null, tailscale: q.has('ts') ? { name: 'Jamie', email: me.email } : null }
        : { signedIn: true, user: me, device: 'AEROBOOK', busy: false, error: '', pending: null, tailscale: null };
      const a = preview.acct;
      if (msg.type === 'acct_start') { a.pending = { code: 'K7PQ-M2XD', url: '', until: Date.now() + 6e5 }; setTimeout(() => { a.pending = null; a.signedIn = true; a.user = me; window.__dash({ kind: 'account', account: { ...a } }); }, q.has('wait') ? 6e8 : 2500); }
      if (msg.type === 'acct_tailscale') { a.signedIn = true; a.user = me; a.tailscale = null; }
      if (msg.type === 'acct_cancel') a.pending = null;
      if (msg.type === 'acct_signout') { a.signedIn = false; a.user = null; }
      setTimeout(() => window.__dash({ kind: 'account', account: { ...a } }), 60);
      return;
    }
    if (msg.type === 'dash_cmd') {
      preview.chat = (preview.chat ?? []).concat({ role: 'user', text: msg.text, tools: [], state: 'done' }, { role: 'tiro', text: '', tools: [{ id: 't1', label: 'looking at your screen', state: 'run' }], state: 'live' });
      window.__dash({ kind: 'chat', items: preview.chat, asks: [{ id: 'a1', question: 'Open Word to edit "Lab report.docx"?', choices: ['Allow', "Don't allow"] }] });
      return;
    }
    if (msg.type === 'dash_answer') {
      const m = preview.chat.at(-1); m.tools[0].state = 'ok'; m.text = 'Done. I opened the report and added the results table.'; m.state = 'done';
      window.__dash({ kind: 'chat', items: preview.chat, asks: [] });
      return;
    }
    if (msg.type !== 'dash_open' && msg.type !== 'dash_act') return;
    const now = Date.now(), at = (m) => now - m * 60_000;
    if (msg.type === 'dash_act') {
      const i = preview.deck.findIndex((c) => c.id === msg.id);
      setTimeout(() => { if (i >= 0) preview.deck.splice(i, 1); window.__dash({ kind: 'acted', id: msg.id, ok: msg.ok, done: msg.ok ? 'Done' : 'Dismissed' }); window.__dash({ kind: 'deck', items: preview.deck }); }, 250);
      return;
    }
    document.title = 'Tiro dashboard (preview with sample data)';
    preview.deck = [
      { type: 'proposal', id: 'p1', kind: 'mail_send', label: 'Email', title: 'Reply to Dana: Thursday works', when: 'Sends now', preview: 'Hi Dana,\n\nThursday at 3 works for me. See you then.\n\nJamie', ok: 'Send', done: 'Sent', from: 'Hermes', tap: true },
      { type: 'proposal', id: 'p2', kind: 'event', label: 'Calendar', title: 'Dentist', when: 'Fri 21 Nov, 15:00–16:00', location: 'Gangnam', ok: 'Add', done: 'Added', from: 'Chat', tap: false },
      { type: 'memory', id: 'm1', kind: 'memory', label: 'Memory', title: 'Prefers morning meetings', when: 'Remember this?', ok: 'Remember', done: 'Remembered', from: 'Chat', tap: false },
    ];
    setTimeout(() => {
      window.__dash({ kind: 'kpi', kpi: { cloud: { ok: true, ms: 38, error: '' }, cpu: 7, temp: 41, ram: { used: 5.8, total: 11.9, pct: 49 }, stale: false,
        deploy: { result: 'ok', commit: '0971252', at: '2026-11-20 00:08:26' }, containers: [{ name: 'brain', state: 'running', cpu: '0.31%', mem: '102.7MB / 768MB' }, { name: 'caddy', state: 'running', cpu: '0.02%', mem: '21MB / 128MB' }, { name: 'ollama', state: 'running', cpu: '0.00%', mem: '1.2GB / 6GB' }],
        model: { mode: 'Local first', name: 'claude-sonnet-5-5', local: true }, spend: { month: 3.21, limit: 20, today: 0.12 },
        hermes: { state: 'running', today: 0.04, month: 1.18, cap: 0.3 }, weather: { place: 'Seoul', temp: 4, sky: 'Clear', low: -1, high: 7 } } });
      window.__dash({ kind: 'deck', items: preview.deck });
      window.__dash({ kind: 'conn', live: true });
      window.__dash({ kind: 'notes', unread: 2, items: [
        { t: at(3), title: 'Handoff done', body: 'Summary of the lab report saved to chats', url: '/?chat=1', new: true },
        { t: at(25), title: 'Converted clip.mp4', body: 'In Files → Tiro Forge', url: '/?tab=files', new: true },
        { t: at(90), title: 'New mail from Canvas', body: 'Assignment 4 graded', url: 'https://mail.google.com/mail/u/0/#inbox/1', new: false }] });
      window.__dash({ kind: 'log', lines: [
        { t: at(1), src: 'pc', text: 'Looked at your screen' }, { t: at(3), src: 'hermes', text: 'Handoff done: Summary of the lab report saved to chats' },
        { t: at(12), src: 'pc', text: 'Read notes.md' }, { t: at(25), src: 'server', text: 'Converted clip.mp4: In Files → Tiro Forge' },
        { t: at(40), src: 'server', text: 'Server OK: all 9 services running' }, { t: at(90), src: 'server', text: 'New mail from Canvas: Assignment 4 graded' }] });
      window.__dash({ kind: 'admin', services: ['brain', 'caddy', 'dns', 'forge', 'jellyfin', 'n8n', 'nextcloud', 'ollama', 'tunnel'], recent: [{ action: 'restart', service: 'caddy', ok: true, text: 'restarted in 3 s' }], waiting: 0, helper: true, rebootOk: true, deployPaused: false, tail: '[09:12] origin/main moved: 0971252\n[09:12] rebuilding brain\n[09:13] health ok' });
      window.__dash({ kind: 'forge', jobs: [{ id: 'j1', kind: 'convert', title: 'clip.mov → MP4', status: 'running', progress: '40%' }, { id: 'j2', kind: 'download', title: 'youtube.com/watch?v=…', status: 'done' }] });
      window.__dash({ kind: 'uploads', items: [{ id: 'u1', name: 'IMG_2041.HEIC', pct: 100, state: 'done', file: { id: 'f1', name: 'IMG_2041.HEIC' }, to: ['jpg', 'png', 'webp', 'pdf'], ocr: true }, { id: 'u2', name: 'lecture.mp4', pct: 46, state: 'uploading', to: [] }] });
      if (new URLSearchParams(location.search).has('toast')) window.__dash({ kind: 'toast', notice: { kind: 'hermes', title: 'Handoff done', body: 'Summary of the lab report saved to chats', url: '/?chat=1' } });
    }, 0);
  }
})();
