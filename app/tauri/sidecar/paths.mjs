// Where Tiro desktop keeps its files: ~/.tiro (settings in sidekick.json, everything else in sidekick/), the
// background agents' work in ~/Tiro, and the speech model in %LOCALAPPDATA%\Tiro. TIRO_DATA_DIR (tests) puts the
// first two in that folder instead. Sign-in (Claude subscription, API keys) stays where the gg framework keeps it,
// ~/.gg/auth.json.
//
// Builds before the split from Roamies kept these in ~/.gg/sidekick*, ~/Roamies and %LOCALAPPDATA%\Roamies. The
// first start of this build copies the settings and data across (the old copy stays, so an older build still finds
// it) and moves the agents' folder and the speech model (too big to keep twice). Nothing is overwritten.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const TEST = process.env.TIRO_DATA_DIR || '';

export const DATA_ROOT = TEST || path.join(HOME, '.tiro');
export const CONFIG_PATH = path.join(DATA_ROOT, 'sidekick.json');
export const DATA_DIR = path.join(DATA_ROOT, 'sidekick');
// The same, read when asked: a test that sets TIRO_DATA_DIR and re-imports store.mjs gets its own folder.
export const dataDir = () => (process.env.TIRO_DATA_DIR ? path.join(process.env.TIRO_DATA_DIR, 'sidekick') : path.join(os.homedir(), '.tiro', 'sidekick'));
// Read when asked (tests set TIRO_DATA_DIR after importing).
export const agentsRoot = () => (process.env.TIRO_DATA_DIR ? path.join(process.env.TIRO_DATA_DIR, 'Tiro') : path.join(os.homedir(), 'Tiro'));
export const voiceRoot = (env = process.env) => (env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Tiro') : DATA_DIR);

/** One-time move from the Roamies-era places. `home` and `local` are for tests; every step is skipped when its
 *  new place already exists. Returns what was done, for the log. */
export function migrateFromRoamies({ home = HOME, local = process.env.LOCALAPPDATA || '', data = path.join(home, '.tiro') } = {}) {
  const done = [];
  const step = (what, fn) => { try { if (fn()) done.push(what); } catch (e) { done.push(`${what} failed: ${e?.code ?? e?.message ?? e}`); } };
  const gg = path.join(home, '.gg');
  step('settings', () => {
    const from = path.join(gg, 'sidekick.json'), to = path.join(data, 'sidekick.json');
    if (fs.existsSync(to) || !fs.existsSync(from)) return false;
    fs.mkdirSync(data, { recursive: true, mode: 0o700 });
    fs.copyFileSync(from, to);
    return true;
  });
  step('data', () => {
    const from = path.join(gg, 'sidekick'), to = path.join(data, 'sidekick');
    if (fs.existsSync(to) || !fs.existsSync(from)) return false;
    fs.mkdirSync(data, { recursive: true, mode: 0o700 });
    fs.cpSync(from, to, { recursive: true, errorOnExist: false, force: false });
    return true;
  });
  step('agents folder', () => {
    const from = path.join(home, 'Roamies'), to = path.join(home, 'Tiro');
    if (fs.existsSync(to) || !fs.existsSync(from)) return false;
    fs.renameSync(from, to);
    return true;
  });
  // Only the models folder moves: %LOCALAPPDATA%\Tiro is also where the installer puts tiro.exe (and
  // %LOCALAPPDATA%\Roamies held roamies.exe), so the folder itself always exists by the time this runs. Checking
  // for it (as 0.2.8 did) meant the model never moved and voice, and with it hold-to-talk, stayed off.
  // A model counts as there once ready.json is (voicemodel.mjs); a half-finished download in the new place gives
  // way to a finished one in the old.
  step('speech model', () => {
    if (!local) return false;
    const from = path.join(local, 'Roamies', 'models'), to = path.join(local, 'Tiro', 'models');
    if (!fs.existsSync(from)) return false;
    let moved = false;
    for (const id of fs.readdirSync(from)) {
      const src = path.join(from, id), dst = path.join(to, id);
      if (!fs.existsSync(path.join(src, 'ready.json')) || fs.existsSync(path.join(dst, 'ready.json'))) continue;
      fs.rmSync(dst, { recursive: true, force: true });
      fs.mkdirSync(to, { recursive: true });
      fs.renameSync(src, dst);
      moved = true;
    }
    return moved;
  });
  return done;
}

// Runs on the first import, before anything reads the settings (store.mjs and sidekick.mjs import this first).
export const MIGRATED = TEST ? [] : migrateFromRoamies();
