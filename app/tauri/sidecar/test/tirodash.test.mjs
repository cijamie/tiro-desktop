// TiroDash is the one window: the tray icon opens it, and the old tray panel's pages live in its frame (panel.js in
// embed mode, its messages handed on by dashboard.js). A sign-in gate links the PC to one Tiro account. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const src = (p) => fs.readFileSync(path.join(app, p), 'utf8');

const rs = src('tauri/src-tauri/src/main.rs');
assert.ok(!rs.includes('"panel/index.html"'), 'no separate panel window any more');
assert.match(rs, /MouseButton::Left[^\n]*\n\s*show_dashboard\(tray\.app_handle\(\)\);/, 'the tray icon opens TiroDash');
assert.match(rs, /fn to_panel[\s\S]{0,200}DASHBOARD_LABEL[\s\S]{0,120}__pc&&__pc/, "the panel's messages go to TiroDash's frame");
assert.match(rs, /\.title\("TiroDash"\)/);
assert.ok(!/show_panel|hide_panel|PANEL_LABEL/.test(rs + src('tauri/src-tauri/src/voice.rs')), 'nothing left of the flyout');

const html = src('dashboard/index.html'), js = src('dashboard/dashboard.js'), pj = src('panel/panel.js');
assert.ok(html.includes('src="../panel/index.html?embed=1"'), 'the panel pages are framed in embed mode');
assert.ok(html.includes('id="gate"') && html.includes('id="page-account"'), 'a sign-in gate and an Account page');
for (const id of ['today', 'home', 'memory', 'model', 'appearance', 'speaking', 'listening', 'shortcuts', 'routines', 'general', 'about', 'whatsnew']) {
  assert.ok(js.includes(`['${id}', `), `the rail has the panel's ${id} page`);
  assert.ok(src('panel/index.html').includes(`data-page="${id}"`), `the panel still has ${id}`);
}
assert.match(js, /window\.__pc = /); assert.match(js, /window\.__pcShown = /);
assert.match(pj, /const EMBED = /); assert.match(pj, /window\.__embedShow = /);
assert.match(pj, /host\?\.__pcShown\?\.\(name\)/, 'the frame tells the rail which page it opened');
for (const t of ['acct_start', 'acct_tailscale', 'acct_signout', 'acct_cancel']) assert.ok(js.includes(`'${t}'`), t);
assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(js), 'server text only as text');
console.log('tirodash tests passed');
