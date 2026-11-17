// The one-time move from the Roamies-era folders (paths.mjs). Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TIRO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tiro-paths-data-'));
const { migrateFromRoamies, MIGRATED, CONFIG_PATH, DATA_DIR } = await import('../paths.mjs');
assert.deepEqual(MIGRATED, [], 'a test data folder never migrates anything');
assert.equal(CONFIG_PATH, path.join(process.env.TIRO_DATA_DIR, 'sidekick.json'));
assert.equal(DATA_DIR, path.join(process.env.TIRO_DATA_DIR, 'sidekick'));

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tiro-paths-home-')), local = path.join(home, 'AppData', 'Local');
const put = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
put(path.join(home, '.gg', 'sidekick.json'), '{"look":"classic"}');
put(path.join(home, '.gg', 'sidekick', 'secrets.json'), 'secret');
put(path.join(home, '.gg', 'sidekick', 'sessions', 'a.json'), 'chat');
put(path.join(home, '.gg', 'auth.json'), 'sign-in');
put(path.join(home, 'Roamies', 'Agents', 'x', 'out.txt'), 'made');
put(path.join(local, 'Roamies', 'parakeet', 'model.onnx'), 'model');

const done = migrateFromRoamies({ home, local });
assert.deepEqual(done, ['settings', 'data', 'agents folder', 'speech model']);
const read = (...p) => fs.readFileSync(path.join(home, ...p), 'utf8');
assert.equal(read('.tiro', 'sidekick.json'), '{"look":"classic"}');
assert.equal(read('.tiro', 'sidekick', 'secrets.json'), 'secret', 'the saved voice keys come along');
assert.equal(read('.tiro', 'sidekick', 'sessions', 'a.json'), 'chat');
assert.equal(read('.gg', 'sidekick.json'), '{"look":"classic"}', 'the old copy stays for an older build');
assert.ok(fs.existsSync(path.join(home, '.gg', 'auth.json')) && !fs.existsSync(path.join(home, '.tiro', 'auth.json')), 'sign-in stays in ~/.gg');
assert.equal(read('Tiro', 'Agents', 'x', 'out.txt'), 'made');
assert.ok(!fs.existsSync(path.join(home, 'Roamies')), 'the agents folder moves');
assert.equal(read('AppData', 'Local', 'Tiro', 'parakeet', 'model.onnx'), 'model');

// Second start: nothing to do, and newer settings are never overwritten.
fs.writeFileSync(path.join(home, '.tiro', 'sidekick.json'), '{"look":"jarvis"}');
assert.deepEqual(migrateFromRoamies({ home, local }), []);
assert.equal(read('.tiro', 'sidekick.json'), '{"look":"jarvis"}');

// A fresh computer: nothing to move.
assert.deepEqual(migrateFromRoamies({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'tiro-paths-new-')), local: '' }), []);
console.log('paths tests: passed');
