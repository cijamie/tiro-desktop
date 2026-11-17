// The panel's Today page (today.mjs): the server's dashboard cut down to what's shown, and refreshing it. Run: npm test
import assert from 'node:assert/strict';
import { STALE_MS, createToday, fetchToday, shapeToday } from '../today.mjs';

const dash = {
  weather: { ok: true, place: 'Seongbuk', now: { temp: 7, feels: 4, sky: 'cloudy' }, today: { high: 10, low: 2, rain_mm: 0.4 } },
  agenda: { ok: true, today: [{ title: 'Korean class', time: '14:00', end: '15:30', location: 'Room 3' }], tomorrow: [{ title: 'Gym', time: '08:00' }] },
  canvas: { ok: true, configured: true, items: [{ title: 'Essay', course: 'ENGL 102', due_text: 'Wed 19 Nov, 23:59', overdue: false, link: 'https://canvas.uidaho.edu/x' }] },
  mail: { ok: true, configured: true, items: [{ from: 'Bank', subject: 'Statement', when: 'Tue 09:12', link: 'javascript:alert(1)' }] },
  spend: { ok: true, api_cost: 1.234, limit: 8, projected_api: 3.5 },
  news: { ok: true, categories: { World: [{ title: 'A', source: 'BBC', link: 'https://bbc.co.uk/a' }], Tech: [] } },
};
const todos = { items: [{ id: 't1', text: 'Buy rice', due: '2026-11-17', overdue: true }, { id: 't2', text: 'Old', done: true }] };
const d = shapeToday(dash, { text: 'Morning!  Cloudy.' }, todos);
assert.equal(d.briefing, 'Morning! Cloudy.');
assert.deepEqual(d.weather, { place: 'Seongbuk', temp: 7, feels: 4, sky: 'cloudy', high: 10, low: 2, rain: 0.4 });
assert.deepEqual(d.agenda.today[0], { time: '14:00', end: '15:30', title: 'Korean class', where: 'Room 3' });
assert.deepEqual(d.todos, [{ id: 't1', text: 'Buy rice', due: '2026-11-17', overdue: true }], 'done to-dos are left out');
assert.equal(d.canvas[0].link, 'https://canvas.uidaho.edu/x');
assert.equal(d.mail[0].link, '', 'only https links can be opened');
assert.deepEqual(d.news, [{ cat: 'World', items: [{ title: 'A', source: 'BBC', link: 'https://bbc.co.uk/a' }] }], 'empty categories are left out');
assert.equal(d.spend.api, 1.234);
// Cards Tiro can't build (not set up, or failing) are left out, not shown broken.
const none = shapeToday({ weather: { ok: false, error: 'x' }, mail: { ok: true, configured: false }, agenda: { configured: false } });
assert.equal(none.weather, null); assert.equal(none.mail, null); assert.equal(none.agenda, null); assert.equal(none.todos, null);

// Fetching: parts that fail are left out; all failing is an error.
{
  const routes = [];
  const call = async (m, r) => { routes.push(r); if (r === '/briefing') throw new Error('slow'); return r.startsWith('/dashboard') ? dash : todos; };
  const got = await fetchToday(call, { fresh: true });
  assert.deepEqual(routes, ['/dashboard?fresh=1', '/briefing', '/todos']);
  assert.equal(got.briefing, '');
  assert.equal(got.todos.length, 1);
  await assert.rejects(fetchToday(async () => { throw new Error("Couldn't reach Tiro"); }), /reach Tiro/);
}

// Refreshing: only when stale unless forced; to-dos tick off and get added.
{
  let t = 1_000_000, n = 0, changes = 0;
  const posts = [];
  const call = async (m, r, b) => { if (m === 'POST') { posts.push([r, b]); return { id: 't9', text: b.text }; } n++; return r.startsWith('/dashboard') ? dash : r === '/todos' ? todos : { text: 'Hi' }; };
  const today = createToday({ call, onChange: () => changes++, now: () => t });
  await today.refresh();
  assert.equal(n, 3); assert.equal(today.state().data.briefing, 'Hi'); assert.equal(today.state().loading, false);
  await today.refresh(); assert.equal(n, 3, 'fresh enough: no new fetch');
  t += STALE_MS + 1; await today.refresh(); assert.equal(n, 6);
  await today.refresh({ force: true }); assert.equal(n, 9);
  await today.todo('t1');
  assert.deepEqual(posts[0], ['/todos/t1', { done: true }]);
  assert.equal(today.state().data.todos.length, 0, 'ticked off at once');
  await today.addTodo('Call mum');
  assert.deepEqual(posts[1], ['/todos', { text: 'Call mum' }]);
  assert.equal(today.state().data.todos[0].text, 'Call mum');
  assert.ok(changes >= 6);
  const bad = createToday({ call: async () => { throw new Error('Tailscale is off'); } });
  await bad.refresh();
  assert.match(bad.state().error, /Tailscale/);
}
console.log('today tests: passed');
