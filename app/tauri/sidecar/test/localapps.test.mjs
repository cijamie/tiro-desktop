// The Tools pages' apps (localapps.mjs): Photo Cull really starts on this Node and answers on 127.0.0.1, a missing
// InstaTool says what's wrong, the photo_cull tool only opens real, readable folders, and the instatool tool asks
// before anything that costs money. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appSpecs, appTools, createLocalApps, instatoolTool, PHOTO_CULL, readyUrl } from '../localapps.mjs';
import { checkRead } from '../safety.mjs';

assert.equal(readyUrl('[2026-11-21T08:00:00.000Z] serving at http://127.0.0.1:47615/'), 'http://127.0.0.1:47615/');
assert.equal(readyUrl('INFO:     Uvicorn running on http://127.0.0.1:8765 (Press CTRL+C to quit)'), 'http://127.0.0.1:8765/');
assert.equal(readyUrl('listening on http://0.0.0.0:8765'), null, 'only this PC\'s own address');
assert.equal(readyUrl('see http://example.com:80/'), null);
assert.ok(fs.existsSync(PHOTO_CULL), 'Photo Cull ships with the sidecar');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tiro-apps-'));
const sent = [];
const apps = createLocalApps({ send: (o) => sent.push(o), specs: () => appSpecs({ home, instatoolDir: path.join(home, 'nope') }) });

// InstaTool not there: a plain reason, nothing started.
await assert.rejects(apps.start('instatool'), /isn't in/);
assert.equal(apps.state.instatool.state, 'failed');

// Photo Cull: starts, prints its address, answers /hello there (Host must be that address: its own guard).
const url = await apps.start('photocull');
assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
assert.equal(await apps.start('photocull'), url, 'a second start reuses it');
const hello = await fetch(`${url}hello`).then((r) => r.json());
assert.deepEqual(hello, { app: 'photo-cull' });
const page = await fetch(url).then((r) => r.text());
assert.ok(!page.includes('__CULL_TOKEN__'), 'its page gets its token');
assert.match(page, /tiro_open/, 'and TiroDash can hand it a folder');
assert.deepEqual(sent.filter((o) => o.msg?.kind === 'apps').at(-1).msg.apps.photocull, { state: 'on', url, error: '' });

// The tool: a real folder opens TiroDash on Photo Cull with it; a secret place or a missing folder doesn't.
const shoot = path.join(home, 'shoot');
fs.mkdirSync(shoot);
const [cull] = appTools({ apps, home, checkRead });
sent.length = 0;
assert.match(await cull.execute({ folder: shoot }), /open in TiroDash on shoot/);
assert.deepEqual(sent.slice(0, 2).map((o) => o.type), ['dashboard_show', 'dash']);
assert.deepEqual([sent[1].msg.kind, sent[1].msg.page, sent[1].msg.folder], ['goto', 'photocull', shoot]);
await assert.rejects(cull.execute({ folder: path.join(home, 'missing') }), /no folder/);
fs.mkdirSync(path.join(home, '.ssh'));
await assert.rejects(cull.execute({ folder: path.join(home, '.ssh') }), /passwords or keys/);
// The window opening later still lands on that page (once).
sent.length = 0;
apps.show('photocull', { folder: shoot }); sent.length = 0;
apps.opened();
assert.equal(sent.filter((o) => o.msg?.kind === 'goto').length, 1);
sent.length = 0; apps.opened();
assert.equal(sent.filter((o) => o.msg?.kind === 'goto').length, 0);


// InstaTool (a stand-in with its API): ready only once it answers; free steps just run; paid ones show the estimate
// and run only after Allow; Don't allow sends nothing.
{
  const port = 18000 + Math.floor(Math.random() * 2000);
  const fake = createLocalApps({ send: () => {}, specs: () => ({ instatool: { name: 'InstaTool', cmd: process.execPath, args: [fileURLToPath(new URL('./fixtures/fake-instatool.cjs', import.meta.url)), String(port)], cwd: os.tmpdir(), wait: 10_000, probe: 'api/status' } }) });
  const asked = [];
  let answer = "Don't allow";
  const tool = instatoolTool({ apps: { start: (id) => fake.start(id), show: () => {} }, ask: async (o) => { asked.push(o.placeholder); return answer; }, home, checkRead, pollMs: 20 });
  const base = await fake.start('instatool');
  assert.equal(base, `http://127.0.0.1:${port}/`);
  const ran = async () => fetch(`${base}ran`).then((r) => r.json());
  assert.match(await tool.execute({ action: 'status' }), /12 kept, 3 analysed[\s\S]*Spent today \$0\.012/);
  await assert.rejects(tool.execute({ action: 'import', folder: path.join(home, '.ssh') }), /passwords or keys/);
  assert.match(await tool.execute({ action: 'import', folder: shoot }), /14 found, 12 new, 0 already known, 2 RAF skipped/);
  assert.match(await tool.execute({ action: 'analyze', limit: 5 }), /said no, so nothing was sent/);
  assert.match(asked.at(-1), /^Analyse 5 photos with claude-haiku-5-5\? About \$0\.021, at most \$0\.040\.$/);
  assert.deepEqual(await ran(), ['Import photos'], 'no means nothing ran');
  answer = 'Allow';
  assert.match(await tool.execute({ action: 'analyze', limit: 5 }), /Analysed 5 photo\(s\) for \$0\.019/);
  assert.match(await tool.execute({ action: 'export' }), /no plan to export yet/);
  assert.match(await tool.execute({ action: 'plan' }), /Plan #7 is ready \(\$0\.28\)/);
  assert.match(asked.at(-1), /re-check 3 top photos.*captions for about 4 posts\? About \$0\.31, at most \$0\.60\./);
  assert.match(await tool.execute({ action: 'export' }), /4 post\(s\) and 1 Story set\(s\), 15 images, to C:\\out\\plan7/);
  assert.deepEqual(await ran(), ['Import photos', 'Analyse photos', 'Plan posts', 'Export']);
  assert.equal(asked.length, 3, 'only the paid steps asked');
  fake.stopAll();
}
apps.stop('photocull');
assert.equal(apps.state.photocull.state, 'off');
// Windows keeps a folder busy for a moment after the processes in it are killed.
try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* the OS cleans its temp folder */ }
console.log('localapps tests passed');
process.exit(0);
