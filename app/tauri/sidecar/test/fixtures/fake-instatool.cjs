// A stand-in for InstaTool's `ui` (localapps.test.mjs): prints its address first, answers a moment later, and has
// the API the instatool tool uses (status, import, estimates, runs, jobs, export). Records what was run.
const http = require('http');
const port = Number(process.argv[2]);
const ran = [];
let n = 0;
const jobs = {};
const job = (name, result) => { const id = `j${++n}`; jobs[id] = { id, name, state: 'done', log: [`${name} done`], result, error: null }; ran.push(name); return { job: id }; };
const routes = {
  'GET /api/status': () => ({ import_id: 1, photos: { kept: 12, analysed: 3, flagged: 0, folder: 'C:\\shoot' }, plan_id: ran.includes('Plan posts') ? 7 : null, usage: { today: { usd: 0.012 }, 'this month': { usd: 0.4 } }, spend_cap_usd: 5, has_api_key: true, pending_batches: 0 }),
  'POST /api/import': (b) => job('Import photos', { found: 14, new: 12, known: 0, raw_skipped: 2, folder: b.folder }),
  'POST /api/analyze/estimate': (b) => ({ photos: b.limit ?? 9, cached: 3, batch: false, model: 'claude-haiku-5-5', usd: 0.021, usd_worst_case: 0.04 }),
  'POST /api/analyze/run': (b) => job('Analyse photos', { ok: b.limit ?? 9, flagged: [], usd: 0.019 }),
  'POST /api/plan/estimate': () => ({ import_id: 1, missing_pass1: 0, pass2_photos: 3, caption_posts: 4, model: 'claude-sonnet-5-5', usd: 0.31, usd_worst_case: 0.6 }),
  'POST /api/plan/run': () => job('Plan posts', { plan_id: 7, usd: 0.28 }),
  'POST /api/plan/7/export': () => job('Export', { posts: 4, stories: 1, images: 15, folder: 'C:\\out\\plan7', problems: [] }),
  'GET /ran': () => ran,
};
setTimeout(() => http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const jm = /^\/api\/jobs\/(\w+)$/.exec(req.url);
    const f = jm ? () => jobs[jm[1]] : routes[`${req.method} ${req.url}`];
    const out = f ? f(body ? JSON.parse(body) : {}) : null;
    res.writeHead(out ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out ?? { detail: 'Not Found' }));
  });
}).listen(port, '127.0.0.1'), 400);
console.log(`InstaTool is running at http://127.0.0.1:${port}  (only this PC can reach it). Press Ctrl+C to stop.`);
