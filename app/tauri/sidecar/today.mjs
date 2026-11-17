// The panel's Today page: Tiro's Today page in short (the briefing, what's next, to-dos, classes, mail, weather,
// spending, news), from the Tiro server (GET /dashboard, /briefing, /todos), so the website isn't needed on the PC.
// Everything here was written by others (emails, events, headlines): it's only shown, never sent to a model.
export const STALE_MS = 5 * 60_000;

const s = (v, n = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const https = (u) => (/^https:\/\//i.test(String(u ?? '')) ? String(u).slice(0, 2000) : '');

/** The server's answers, cut down to what the page shows. Any part can be missing (its card then says why). */
export function shapeToday(d = {}, brief = null, todos = null) {
  const ok = (c) => c && c.ok !== false && c.configured !== false;
  const w = d.weather, a = d.agenda, cv = d.canvas, m = d.mail, sp = d.spend, nw = d.news;
  return {
    briefing: s(brief?.text, 2000),
    weather: ok(w) && w.now ? {
      place: s(w.place, 60), temp: w.now.temp, feels: w.now.feels, sky: s(w.now.sky, 40),
      high: w.today?.high ?? null, low: w.today?.low ?? null, rain: w.today?.rain_mm ?? 0,
    } : null,
    agenda: ok(a) ? {
      today: (a.today ?? []).slice(0, 8).map((e) => ({ time: s(e.time, 12), end: s(e.end, 8), title: s(e.title, 120), where: s(e.location, 80) })),
      tomorrow: (a.tomorrow ?? []).slice(0, 4).map((e) => ({ time: s(e.time, 12), title: s(e.title, 120) })),
    } : null,
    todos: Array.isArray(todos?.items) ? todos.items.filter((t) => !t.done).slice(0, 12)
      .map((t) => ({ id: s(t.id, 20), text: s(t.text, 200), due: s(t.due, 20), overdue: !!t.overdue })) : null,
    canvas: ok(cv) ? (cv.items ?? []).slice(0, 6).map((i) => ({ title: s(i.title, 120), course: s(i.course, 60), due: s(i.due_text, 30), overdue: !!i.overdue, link: https(i.link) })) : null,
    mail: ok(m) ? (m.items ?? []).slice(0, 6).map((i) => ({ from: s(i.from, 60), subject: s(i.subject, 140), when: s(i.when, 20), link: https(i.link) })) : null,
    spend: ok(sp) && typeof sp.api_cost === 'number' ? { api: sp.api_cost, limit: sp.limit ?? null, projected: sp.projected_api ?? null } : null,
    news: ok(nw) && nw.categories ? Object.entries(nw.categories).slice(0, 4)
      .map(([cat, items]) => ({ cat: s(cat, 30), items: (items ?? []).slice(0, 3).map((i) => ({ title: s(i.title, 160), source: s(i.source, 40), link: https(i.link) })) }))
      .filter((c) => c.items.length) : null,
  };
}

/** Fetches Today. Parts that fail are left out; if every part fails, the first error is thrown. */
export async function fetchToday(call, { fresh = false } = {}) {
  const parts = await Promise.allSettled([
    call('GET', `/dashboard${fresh ? '?fresh=1' : ''}`, undefined, { timeout: 45_000 }),
    call('GET', '/briefing', undefined, { timeout: 60_000 }),
    call('GET', '/todos', undefined, { timeout: 15_000 }),
  ]);
  if (parts.every((p) => p.status === 'rejected')) throw parts[0].reason;
  const [d, b, t] = parts.map((p) => (p.status === 'fulfilled' ? p.value : null));
  return shapeToday(d ?? {}, b, t);
}

/** Keeps Today fresh for the panel: refresh() when it's opened (only if stale) or by the Refresh button (force). */
export function createToday({ call, onChange = () => {}, now = () => Date.now() }) {
  const st = { data: null, at: 0, loading: false, error: '' };
  let running = null;
  async function refresh({ force = false } = {}) {
    if (running) return running;
    if (!force && st.data && now() - st.at < STALE_MS) return null;
    st.loading = true; onChange();
    running = (async () => {
      try { st.data = await fetchToday(call, { fresh: force }); st.at = now(); st.error = ''; }
      catch (e) { st.error = s(e?.message ?? e, 200); }
      finally { st.loading = false; running = null; onChange(); }
    })();
    return running;
  }
  async function todo(id, done = true) {
    await call('POST', `/todos/${encodeURIComponent(id)}`, { done });
    if (st.data?.todos) { st.data.todos = st.data.todos.filter((t) => t.id !== id); onChange(); }
  }
  async function addTodo(text) {
    const t = await call('POST', '/todos', { text: s(text, 200) });
    if (st.data) { st.data.todos = [...(st.data.todos ?? []), { id: s(t.id, 20), text: s(t.text ?? text, 200), due: s(t.due, 20), overdue: false }]; onChange(); }
  }
  return { state: () => ({ ...st }), refresh, todo, addTodo };
}
