#!/usr/bin/env node
'use strict';
// Photo Cull — a tiny local server + Edge app window for culling photos fast.
// No dependencies: just Node.js.
// Jamie's Photo Cull (C:\Users\jamie\source\repos\photo-cull), shipped inside TiroDash: localapps.mjs runs it with
// --no-browser and TiroDash shows its page in a frame. Keep changes here small so it stays in step with that copy.

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const APP_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), 'PhotoCull');
const SETTINGS_FILE = path.join(APP_DIR, 'settings.json');
const LOG_FILE = path.join(APP_DIR, 'log.txt');
const TOKEN = crypto.randomBytes(16).toString('hex');
const BASE_PORT = 47615;
const NO_BROWSER = process.argv.includes('--no-browser');

const DEFAULT_PREFS = { keepDir: '_Keep', trashDir: '_Trash', burstGap: 1, showExif: true, slowWarn: true, sharpness: true };

const WEB_EXT = new Set(['.jpg', '.jpeg', '.jpe', '.png', '.webp', '.gif', '.bmp', '.avif', '.jfif']);
const JPEG_EXT = new Set(['.jpg', '.jpeg', '.jpe', '.jfif']);
const RAW_EXT = new Set(['.cr2', '.cr3', '.crw', '.nef', '.nrw', '.arw', '.srf', '.sr2', '.dng', '.raf', '.orf',
  '.rw2', '.pef', '.srw', '.x3f', '.3fr', '.iiq', '.erf', '.kdc', '.mrw', '.raw', '.rwl', '.mef', '.mos']);
const OTHER_EXT = new Set(['.heic', '.heif', '.tif', '.tiff']);
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.mts', '.m2ts', '.mpg', '.mpeg', '.wmv', '.3gp', '.insv']);
const SIDECAR_EXT = new Set(['.xmp', '.thm', '.aae', '.pp3', '.dop', '.lrf']);

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jpe': 'image/jpeg', '.jfif': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.heic': 'image/heic', '.heif': 'image/heif', '.tif': 'image/tiff', '.tiff': 'image/tiff',
  // Chromium plays H.264/HEVC .mov files fine when they're labelled as MP4.
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4', '.insv': 'video/mp4', '.3gp': 'video/3gpp',
  '.webm': 'video/webm', '.mkv': 'video/webm', '.avi': 'video/x-msvideo', '.mts': 'video/mp2t', '.m2ts': 'video/mp2t',
  '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg', '.wmv': 'video/x-ms-wmv',
};

// The folder being culled, and where keepers / rejects go.
let root = null, keepAbs = null, trashAbs = null;
// Every folder this session has worked in. File paths from the page must be inside one of these.
const allowedBases = new Set();

// ---------- utils ----------
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}\n`;
  process.stdout.write(line);
  try { fs.mkdirSync(APP_DIR, { recursive: true }); fs.appendFileSync(LOG_FILE, line); } catch {}
}
function loadSettings() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch {}
  return { recent: [], ...DEFAULT_PREFS, ...s };
}
function saveSettings(s) {
  try { fs.mkdirSync(APP_DIR, { recursive: true }); fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2)); } catch {}
}
function prefsOf(s) { const p = {}; for (const k of Object.keys(DEFAULT_PREFS)) p[k] = s[k]; return p; }
function rememberFolder(p) {
  const s = loadSettings();
  s.recent = [p, ...(s.recent || []).filter(x => x.toLowerCase() !== p.toLowerCase())].slice(0, 6);
  saveSettings(s);
}
const exists = p => fsp.access(p).then(() => true, () => false);
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const extOf = f => path.extname(f).toLowerCase();
function httpError(code, msg) { const e = new Error(msg); e.code = code; return e; }

function kindOf(ext) {
  if (WEB_EXT.has(ext)) return 'web';
  if (RAW_EXT.has(ext)) return 'raw';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (OTHER_EXT.has(ext)) return 'other';
  if (SIDECAR_EXT.has(ext)) return 'side';
  return null;
}

function resolveDir(spec, r) {
  const s = String(spec || '').trim().replace(/\{folder\}/gi, path.basename(r) || 'photos');
  return path.isAbsolute(s) ? path.resolve(s) : path.resolve(r, s);
}
function allow(dir) { allowedBases.add(path.resolve(dir).toLowerCase()); }
function setDirs() {
  const s = loadSettings();
  keepAbs = resolveDir(s.keepDir || DEFAULT_PREFS.keepDir, root);
  trashAbs = resolveDir(s.trashDir || DEFAULT_PREFS.trashDir, root);
  [root, keepAbs, trashAbs].forEach(allow);
}
function inside(abs, base) {
  const a = abs.toLowerCase(), b = base.toLowerCase();
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}
// Resolve a path from the page, refusing anything outside the folders we're working in.
function safeAbs(p) {
  const abs = path.resolve(String(p || ''));
  for (const b of allowedBases) if (inside(abs, b)) return abs;
  throw httpError(403, 'That path is outside the folders Photo Cull is working in');
}

// ---------- scanning ----------
// Groups files sharing a base name (IMG_0001.CR2 + IMG_0001.JPG + IMG_0001.xmp) into one item.
async function scanDir(dir) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const groups = new Map();
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith('.') || e.name.endsWith('.cull-tmp')) continue;
    const ext = extOf(e.name);
    const kind = kindOf(ext);
    if (!kind) continue;
    let base = e.name.slice(0, e.name.length - ext.length);
    if (kind === 'side') { // IMG_0001.CR2.xmp -> IMG_0001
      const inner = extOf(base);
      const ik = kindOf(inner);
      if (ik && ik !== 'side') base = base.slice(0, base.length - inner.length);
    }
    const key = base.toLowerCase();
    if (!groups.has(key)) groups.set(key, { name: base, files: [] });
    groups.get(key).files.push({ name: e.name, kind, ext });
  }
  const list = [...groups.values()].filter(g => g.files.some(f => f.kind !== 'side'));
  await Promise.all(list.map(async g => {
    const media = g.files.filter(f => f.kind !== 'side');
    const pick = media.find(f => f.kind === 'web') || media.find(f => f.kind === 'raw') ||
      media.find(f => f.kind === 'video') || media[0];
    g.size = 0; g.mtime = 0;
    await Promise.all(g.files.map(async f => {
      try {
        const st = await fsp.stat(path.join(dir, f.name));
        g.size += st.size;
        if (f === pick) g.mtime = st.mtimeMs;
      } catch {}
    }));
    g.display = pick.name;
    g.mode = pick.kind === 'raw' ? 'preview' : pick.kind === 'video' ? 'video' : 'direct';
    g.types = [...new Set(media.map(f => f.ext.slice(1).toUpperCase().replace('JPEG', 'JPG')))];
    g.files = g.files.map(f => f.name);
  }));
  list.sort((a, b) => collator.compare(a.name, b.name));
  return list;
}

async function readHead(abs, n) {
  const fh = await fsp.open(abs, 'r');
  try {
    const { size } = await fh.stat();
    const len = Math.min(n, size);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    return buf;
  } finally { await fh.close(); }
}

// ---------- EXIF ----------
function readTiff(buf, t, out) {
  if (t < 0 || t + 8 > buf.length) return;
  const bo = buf.toString('latin1', t, t + 2);
  const le = bo === 'II' ? true : bo === 'MM' ? false : null;
  if (le === null) return;
  const u16 = o => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = o => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const i32 = o => (le ? buf.readInt32LE(o) : buf.readInt32BE(o));
  const SZ = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8 };
  const val = e => {
    const type = u16(e + 2), n = u32(e + 4), size = (SZ[type] || 1) * n;
    const off = size <= 4 ? e + 8 : t + u32(e + 8);
    if (off < 0 || off + Math.min(size, 8) > buf.length) return undefined;
    if (type === 2) return buf.toString('latin1', off, Math.min(off + n, buf.length)).replace(/\0[\s\S]*$/, '').trim();
    if (type === 3) return u16(off);
    if (type === 4) return u32(off);
    if (type === 5) { const d = u32(off + 4); return d ? u32(off) / d : undefined; }
    if (type === 10) { const d = i32(off + 4); return d ? i32(off) / d : undefined; }
    return undefined;
  };
  const set = (k, v) => { if (v !== undefined && v !== '' && !Number.isNaN(v) && out[k] === undefined) out[k] = v; };
  const seen = new Set();
  const ifd = (off, kind) => {
    if (off <= t || off + 2 > buf.length || seen.has(off)) return 0;
    seen.add(off);
    const n = u16(off);
    if (n > 1000) return 0;
    let exifPtr = 0;
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > buf.length) break;
      switch (u16(e)) {
        case 0x010F: if (kind === 0) set('make', val(e)); break;
        case 0x0110: if (kind === 0) set('model', val(e)); break;
        case 0x0112: if (kind === 0) set('orientation', val(e)); break;
        case 0x0132: if (kind === 0) set('dt', val(e)); break;
        case 0x8769: { const v = val(e); if (v) exifPtr = t + v; break; }
        case 0x829A: set('exposure', val(e)); break;
        case 0x829D: set('fnum', val(e)); break;
        case 0x8827: set('iso', val(e)); break;
        case 0x9003: set('dto', val(e)); break;
        case 0x9291: set('subsec', val(e)); break;
        case 0x920A: set('focal', val(e)); break;
        case 0xA405: set('focal35', val(e)); break;
        case 0xA434: set('lens', val(e)); break;
        case 0x0201: if (kind === 1) { const v = val(e); if (v) set('thumbOff', t + v); } break;
        case 0x0202: if (kind === 1) set('thumbLen', val(e)); break;
      }
    }
    if (exifPtr) ifd(exifPtr, 2);
    const nextAt = off + 2 + n * 12;
    return nextAt + 4 <= buf.length ? u32(nextAt) : 0;
  };
  const next = ifd(t + u32(t + 4), 0);
  if (next) ifd(t + next, 1);
}

function parseExif(buf) {
  const out = {};
  const starts = [];
  const b0 = buf.toString('latin1', 0, 2);
  if (b0 === 'II' || b0 === 'MM') starts.push(0); // TIFF-based RAW files
  for (let p = 0, c = 0; c < 8; c++) { // JPEG APP1 Exif (also inside RAF / RW2 previews)
    p = buf.indexOf('Exif\0\0', p, 'latin1');
    if (p < 0) break;
    starts.push(p + 6); p += 6;
  }
  for (const tag of ['CMT1', 'CMT2']) { // Canon CR3
    const q = buf.indexOf(tag, 0, 'latin1');
    if (q >= 0) starts.push(q + 4);
  }
  for (const t of starts) { try { readTiff(buf, t, out); } catch {} }
  return out;
}

function exifTime(dt, subsec) {
  const m = /^(\d{4}):(\d\d):(\d\d)[ T](\d\d):(\d\d):(\d\d)/.exec(dt || '');
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  if (!Number.isFinite(d)) return null;
  const frac = subsec && /^\d+/.test(String(subsec)) ? Number('0.' + String(subsec).match(/^\d+/)[0]) * 1000 : 0;
  return d + frac;
}

async function exifFor(abs) {
  const kind = kindOf(extOf(abs));
  if (kind === 'video' || kind === 'side' || !kind) return null;
  const head = await readHead(abs, 512 * 1024);
  const e = parseExif(head);
  const out = {
    t: exifTime(e.dto || e.dt, e.subsec),
    make: e.make, model: e.model, lens: e.lens,
    exposure: e.exposure, fnum: e.fnum, iso: e.iso, focal: e.focal, focal35: e.focal35,
  };
  if (out.model && out.make && out.model.toLowerCase().startsWith(out.make.toLowerCase().split(' ')[0])) delete out.make;
  return out;
}

// ---------- embedded JPEGs (RAW previews, thumbnails) ----------
const SOI = Buffer.from([0xFF, 0xD8, 0xFF]);

// Walks JPEG markers from SOI at s. Returns {end, w, h, sof, hasOrient} or null.
function parseJpeg(buf, s) {
  const n = buf.length;
  let p = s + 2, w = 0, h = 0, sof = -1, hasOrient = false;
  while (p + 4 <= n) {
    if (buf[p] !== 0xFF) return null;
    const m = buf[p + 1];
    if (m === 0xFF) { p++; continue; }
    if (m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { p += 2; continue; }
    if (m === 0xD8 || m === 0xD9) return null;
    const len = buf.readUInt16BE(p + 2);
    if (len < 2 || p + 2 + len > n) return null;
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC && len >= 7) {
      sof = m; h = buf.readUInt16BE(p + 5); w = buf.readUInt16BE(p + 7);
    }
    if (m === 0xE1 && len > 8 && buf.toString('latin1', p + 4, p + 10) === 'Exif\0\0') {
      const o = {}; try { readTiff(buf, p + 10, o); } catch {}
      hasOrient = !!o.orientation;
    }
    if (m === 0xDA) { // start of scan: skip entropy-coded data
      let q = p + 2 + len;
      for (;;) {
        q = buf.indexOf(0xFF, q);
        if (q < 0 || q + 1 >= n) return null;
        const c = buf[q + 1];
        if (c === 0x00 || (c >= 0xD0 && c <= 0xD7)) { q += 2; continue; }
        if (c === 0xFF) { q += 1; continue; }
        if (c === 0xD9) return { end: q + 2, w, h, sof, hasOrient };
        p = q; break; // another marker (progressive JPEGs have several scans)
      }
      continue;
    }
    p += 2 + len;
  }
  return null;
}

// All decodable (baseline/progressive) JPEGs embedded in a buffer.
function findJpegs(buf) {
  const found = [];
  let p = 0;
  while ((p = buf.indexOf(SOI, p)) !== -1) {
    const j = parseJpeg(buf, p);
    if (j) {
      if ((j.sof === 0xC0 || j.sof === 0xC1 || j.sof === 0xC2) && j.w > 0 && j.h > 0) found.push({ ...j, start: p });
      p = j.end;
    } else p += 2;
  }
  return found;
}

function withOrientation(jpeg, o) {
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0, 'latin1'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x0112, 10); tiff.writeUInt16LE(3, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt16LE(o, 18);
  tiff.writeUInt32LE(0, 22);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const seg = Buffer.from([0xFF, 0xE1, 0, 0]); seg.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), seg, payload, jpeg.subarray(2)]);
}
function sliceJpeg(buf, j, orientation) {
  let out = Buffer.from(buf.subarray(j.start, j.end));
  if (!j.hasOrient && orientation >= 2 && orientation <= 8) out = withOrientation(out, orientation);
  return out;
}

class Lru {
  constructor(max) { this.max = max; this.map = new Map(); }
  get(k) { const v = this.map.get(k); if (v) { this.map.delete(k); this.map.set(k, v); } return v; }
  set(k, v) { this.map.set(k, v); while (this.map.size > this.max) this.map.delete(this.map.keys().next().value); }
  delete(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}
const previewCache = new Lru(40);
const thumbCache = new Lru(1500);

// Almost every RAW format embeds a full-size JPEG preview; serve the largest one.
async function extractPreview(abs) {
  const st = await fsp.stat(abs);
  const key = abs + '|' + st.mtimeMs;
  const hit = previewCache.get(key);
  if (hit) return hit;
  const buf = await fsp.readFile(abs);
  const all = findJpegs(buf);
  if (!all.length) return null;
  const best = all.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
  const out = sliceJpeg(buf, best, parseExif(buf.subarray(0, 1024 * 1024)).orientation);
  previewCache.set(key, out);
  return out;
}

// Small thumbnail for the grid: the camera's embedded thumbnail where there is one.
// Returns null when the full file should be served instead.
async function makeThumb(abs) {
  const ext = extOf(abs);
  const st = await fsp.stat(abs);
  const key = abs + '|' + st.mtimeMs;
  const hit = thumbCache.get(key);
  if (hit !== undefined) return hit;
  let out = null;
  if (JPEG_EXT.has(ext)) {
    const head = await readHead(abs, 256 * 1024);
    const ex = parseExif(head);
    if (ex.thumbOff && ex.thumbLen && ex.thumbOff + ex.thumbLen <= head.length) {
      const j = parseJpeg(head, ex.thumbOff);
      if (j && j.w >= 120 && head[ex.thumbOff] === 0xFF && head[ex.thumbOff + 1] === 0xD8) {
        out = sliceJpeg(head, { ...j, start: ex.thumbOff }, ex.orientation);
      }
    }
  } else if (RAW_EXT.has(ext)) {
    const head = await readHead(abs, 6 * 1024 * 1024);
    const ex = parseExif(head);
    const js = findJpegs(head).filter(j => j.w >= 160);
    const pick = js.filter(j => j.w >= 320).sort((a, b) => a.w - b.w)[0] || js.sort((a, b) => b.w - a.w)[0];
    out = pick ? sliceJpeg(head, pick, ex.orientation) : await extractPreview(abs).catch(() => null);
  }
  thumbCache.set(key, out);
  return out;
}

// ---------- star ratings (XMP) ----------
const XMP_HDR = 'http://ns.adobe.com/xap/1.0/\0';
function xmpPacket(r) {
  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Photo Cull">\n <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="${r}"/>\n </rdf:RDF>\n</x:xmpmeta>\n<?xpacket end="w"?>`;
}
function setXmpRating(xml, r) {
  if (/xmp:Rating\s*=\s*"[^"]*"/.test(xml)) return xml.replace(/xmp:Rating\s*=\s*"[^"]*"/, `xmp:Rating="${r}"`);
  if (/xmp:Rating\s*=\s*'[^']*'/.test(xml)) return xml.replace(/xmp:Rating\s*=\s*'[^']*'/, `xmp:Rating="${r}"`);
  if (/<xmp:Rating>[^<]*<\/xmp:Rating>/.test(xml)) return xml.replace(/<xmp:Rating>[^<]*<\/xmp:Rating>/, `<xmp:Rating>${r}</xmp:Rating>`);
  if (/<rdf:Description\b/.test(xml)) {
    const ns = /xmlns:xmp\s*=/.test(xml) ? '' : ' xmlns:xmp="http://ns.adobe.com/xap/1.0/"';
    return xml.replace(/<rdf:Description\b/, m => `${m}${ns} xmp:Rating="${r}"`);
  }
  return null;
}
async function replaceFile(abs, data) {
  const st = await fsp.stat(abs);
  const tmp = abs + '.cull-tmp';
  await fsp.writeFile(tmp, data);
  await moveFile(tmp, abs, true);
  await fsp.utimes(abs, st.atime, st.mtime).catch(() => {}); // keep the original date
}
// Embed xmp:Rating in a JPEG (where Lightroom, Bridge and Windows read it).
async function writeJpegRating(abs, r) {
  const buf = await fsp.readFile(abs);
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) throw new Error('not a JPEG');
  let p = 2, insertAt = 2, xmpSeg = null;
  while (p + 4 <= buf.length && buf[p] === 0xFF) {
    const m = buf[p + 1];
    if (m === 0xFF) { p++; continue; }
    if (m === 0xDA || m === 0xD9) break;
    const len = buf.readUInt16BE(p + 2);
    if (m === 0xE1 && buf.toString('latin1', p + 4, p + 4 + XMP_HDR.length) === XMP_HDR) xmpSeg = { start: p, end: p + 2 + len };
    if (m === 0xE0 || m === 0xE1) insertAt = p + 2 + len;
    p += 2 + len;
  }
  let xml, before, after;
  if (xmpSeg) {
    const old = buf.toString('utf8', xmpSeg.start + 4 + XMP_HDR.length, xmpSeg.end);
    xml = setXmpRating(old, r) || xmpPacket(r);
    before = buf.subarray(0, xmpSeg.start); after = buf.subarray(xmpSeg.end);
  } else {
    xml = xmpPacket(r);
    before = buf.subarray(0, insertAt); after = buf.subarray(insertAt);
  }
  const payload = Buffer.concat([Buffer.from(XMP_HDR, 'latin1'), Buffer.from(xml, 'utf8')]);
  if (payload.length + 2 > 0xFFFF) throw new Error('XMP block too large');
  const seg = Buffer.from([0xFF, 0xE1, 0, 0]); seg.writeUInt16BE(payload.length + 2, 2);
  await replaceFile(abs, Buffer.concat([before, seg, payload, after]));
}
// Rate a group: embed in JPEGs, write/update an .xmp sidecar for RAW/video/other files.
// Returns the group's (possibly extended) file list.
async function rateGroup(dir, files, r) {
  const out = [...files];
  const media = files.filter(f => { const k = kindOf(extOf(f)); return k && k !== 'side'; });
  for (const f of media) if (JPEG_EXT.has(extOf(f))) await writeJpegRating(path.join(dir, f), r);
  const primary = media.find(f => kindOf(extOf(f)) === 'raw') || media.find(f => !WEB_EXT.has(extOf(f)));
  if (primary) {
    const base = primary.slice(0, -extOf(primary).length);
    const existing = files.find(f => [base + '.xmp', primary + '.xmp'].some(x => x.toLowerCase() === f.toLowerCase()));
    if (existing) {
      const p = path.join(dir, existing);
      const old = await fsp.readFile(p, 'utf8');
      await replaceFile(p, setXmpRating(old, r) || xmpPacket(r));
    } else {
      await fsp.writeFile(path.join(dir, base + '.xmp'), xmpPacket(r), { flag: 'wx' });
      out.push(base + '.xmp');
    }
  }
  return out;
}

// ---------- moving ----------
async function uniqueDest(dir, name) {
  let dest = path.join(dir, name);
  if (!(await exists(dest))) return dest;
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; ; i++) {
    dest = path.join(dir, `${base} (${i})${ext}`);
    if (!(await exists(dest))) return dest;
  }
}
async function moveFile(from, to, overwrite) {
  for (let attempt = 0; ; attempt++) {
    try { return await fsp.rename(from, to); }
    catch (e) {
      if (e.code === 'EXDEV') { // different drive: copy then delete
        await fsp.copyFile(from, to, overwrite ? 0 : fs.constants.COPYFILE_EXCL);
        const st = await fsp.stat(from);
        await fsp.utimes(to, st.atime, st.mtime).catch(() => {});
        return fsp.unlink(from);
      }
      // A file may be briefly held open by the player or an antivirus scan.
      if ((e.code === 'EBUSY' || e.code === 'EPERM') && attempt < 8) {
        await new Promise(r => setTimeout(r, 200));
        continue;
      }
      throw e;
    }
  }
}
async function moveTo(paths, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  const moves = [];
  for (const p of paths) {
    const from = safeAbs(p);
    if (!(await exists(from))) continue;
    const to = await uniqueDest(destDir, path.basename(from));
    await moveFile(from, to);
    moves.push({ from, to });
  }
  return moves;
}

// ---------- memory cards ----------
// A tiny PowerShell loop reports removable drives every few seconds (cheap, and never
// blocks Node's file system threads on a sleeping network drive).
let driveWatcher = null, removableDrives = [], drivesReported = false, cardCache = { at: 0, cards: [] };
function startDriveWatcher() {
  if (driveWatcher) return;
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  if (-not (Get-Process -Id ${process.pid})) { exit }
  $d = [IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Removable' -and $_.IsReady } | ForEach-Object { $_.Name }
  [Console]::Out.WriteLine('DRIVES ' + ($d -join '|'))
  [Console]::Out.Flush()
  Start-Sleep -Seconds 2
}`;
  driveWatcher = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    Buffer.from(ps, 'utf16le').toString('base64')], { windowsHide: true });
  // No PowerShell (blocked, or not Windows): no memory-card list, but Photo Cull keeps running.
  driveWatcher.on('error', e => { log('drive watcher', e.message); drivesReported = true; });
  let buf = '';
  driveWatcher.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (line.startsWith('DRIVES')) {
        removableDrives = line.slice(7).split('|').map(s => s.trim()).filter(Boolean);
        if (!drivesReported) { drivesReported = true; cardCache.at = 0; }
      }
    }
  });
  driveWatcher.on('exit', () => { driveWatcher = null; });
  process.on('exit', () => { try { driveWatcher && driveWatcher.kill(); } catch {} });
}
async function findCards() {
  startDriveWatcher();
  if (Date.now() - cardCache.at < 1500) return cardCache.cards;
  const cards = [];
  for (const drive of removableDrives) {
    const dcim = path.join(drive, 'DCIM');
    let subs;
    try { subs = await fsp.readdir(dcim, { withFileTypes: true }); } catch { continue; }
    const folders = [];
    const count = async p => {
      let n = 0;
      try { for (const f of await fsp.readdir(p)) { const k = kindOf(extOf(f)); if (k && k !== 'side') n++; } } catch {}
      return n;
    };
    for (const s of subs) {
      if (!s.isDirectory()) continue;
      const p = path.join(dcim, s.name);
      const n = await count(p);
      if (n) folders.push({ path: p, name: s.name, count: n });
    }
    const direct = await count(dcim);
    if (direct) folders.unshift({ path: dcim, name: 'DCIM', count: direct });
    if (folders.length) cards.push({ drive: drive.replace(/\\$/, ''), folders });
  }
  cardCache = { at: Date.now(), cards };
  return cards;
}

// ---------- native folder picker (modern Windows dialog) ----------
const PICKER_PS = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class CullFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogCls {}
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr hwnd);
    void SetFileTypes(uint c, IntPtr spec);
    void SetFileTypeIndex(uint i);
    void GetFileTypeIndex(out uint i);
    void Advise(IntPtr sink, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint fos);
    void GetOptions(out uint fos);
    void SetDefaultFolder(IShellItem si);
    void SetFolder(IShellItem si);
    void GetFolder(out IShellItem si);
    void GetCurrentSelection(out IShellItem si);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out IShellItem si);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, [In] ref Guid bhid, [In] ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem si);
    void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [In] ref Guid riid, out IShellItem item);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  public static string Pick(string initial, string title, string ok) {
    IFileOpenDialog dlg = (IFileOpenDialog)new FileOpenDialogCls();
    dlg.SetOptions(0x20 | 0x40 | 0x800);
    dlg.SetTitle(title);
    dlg.SetOkButtonLabel(ok);
    if (!string.IsNullOrEmpty(initial)) {
      try { Guid g = typeof(IShellItem).GUID; IShellItem it; SHCreateItemFromParsingName(initial, IntPtr.Zero, ref g, out it); dlg.SetFolder(it); } catch {}
    }
    if (dlg.Show(GetForegroundWindow()) != 0) return null;
    IShellItem res; dlg.GetResult(out res);
    string p; res.GetDisplayName(0x80058000, out p);
    return p;
  }
}
"@
$r = [CullFolderPicker]::Pick($env:CULL_INIT, $env:CULL_TITLE, $env:CULL_OK)
if ($r) { [Console]::Out.Write($r) }
`;

function pickFolder(initial, title, ok) {
  return new Promise(resolve => {
    const enc = Buffer.from(PICKER_PS, 'utf16le').toString('base64');
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], {
      env: { ...process.env, CULL_INIT: initial || '', CULL_TITLE: title || 'Choose a folder of photos to cull', CULL_OK: ok || 'Cull this folder' },
      windowsHide: true,
    });
    let out = '';
    ps.stdout.on('data', d => (out += d));
    ps.on('close', () => resolve(out.trim() || null));
    ps.on('error', e => { log('picker error', e.message); resolve(null); });
  });
}

// ---------- HTTP ----------
let lastPing = Date.now();
let byeTimer = null;

function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 20e6) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { reject(httpError(400, 'Bad JSON')); } });
    req.on('error', reject);
  });
}
function requireRoot() { if (!root) throw httpError(400, 'No folder open'); }

async function openFolder(p) {
  const abs = path.resolve(String(p || '').trim().replace(/^"|"$/g, ''));
  let st;
  try { st = await fsp.stat(abs); } catch { throw httpError(404, 'That folder does not exist'); }
  if (!st.isDirectory()) throw httpError(400, 'That is not a folder');
  root = abs;
  setDirs();
  rememberFolder(abs);
  const [groups, kept, trashed] = await Promise.all([scanDir(abs), scanDir(keepAbs), scanDir(trashAbs)]);
  log('opened', abs, `(${groups.length} items)`);
  return { root: abs, dir: abs, name: path.basename(abs) || abs, groups, kept: kept.length, trashed: trashed.length, keepDir: keepAbs, trashDir: trashAbs };
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

const routes = {
  'POST /api/state': async () => {
    const s = loadSettings();
    return { root, recent: s.recent || [], prefs: prefsOf(s) };
  },
  'POST /api/pick': async b => ({ path: await pickFolder(b.initial || root, b.title, b.ok) }),
  'POST /api/open': async b => openFolder(b.path),
  'POST /api/settings': async b => {
    const s = loadSettings();
    const next = { ...s };
    for (const k of ['keepDir', 'trashDir']) if (typeof b[k] === 'string') next[k] = b[k].trim();
    if (b.burstGap !== undefined) next.burstGap = Math.max(0, Math.min(10, Number(b.burstGap) || 0));
    for (const k of ['showExif', 'slowWarn', 'sharpness']) if (b[k] !== undefined) next[k] = !!b[k];
    if (!next.keepDir || !next.trashDir) throw httpError(400, 'Folder names can’t be empty');
    if (next.keepDir.toLowerCase() === next.trashDir.toLowerCase()) throw httpError(400, 'Keep and trash need different folders');
    if (root) {
      const k = resolveDir(next.keepDir, root), t = resolveDir(next.trashDir, root);
      if ([k, t].some(d => d.toLowerCase() === root.toLowerCase())) throw httpError(400, 'Keep and trash can’t be the folder you’re culling');
    }
    saveSettings(next);
    const out = { prefs: prefsOf(next) };
    if (root) {
      setDirs();
      const [kept, trashed] = await Promise.all([scanDir(keepAbs), scanDir(trashAbs)]);
      Object.assign(out, { kept: kept.length, trashed: trashed.length, keepDir: keepAbs, trashDir: trashAbs });
    }
    return out;
  },
  'POST /api/exif': async b => ({
    results: await mapLimit(b.paths || [], 6, p => exifFor(safeAbs(p)).catch(() => null)),
  }),
  // items: [{dir, files, to: 'keep'|'trash', rating}]
  'POST /api/move': async b => {
    requireRoot();
    const results = [];
    for (const it of b.items || []) {
      const dest = { keep: keepAbs, trash: trashAbs }[it.to];
      try {
        if (!dest) throw new Error('Bad destination');
        const dir = safeAbs(it.dir);
        let files = (it.files || []).map(f => path.basename(String(f)));
        let warning;
        if (it.to === 'keep' && it.rating >= 1 && it.rating <= 5) {
          try { files = await rateGroup(dir, files, Math.round(it.rating)); }
          catch (e) { warning = `Couldn’t save the rating: ${e.message}`; log('rating failed', dir, e.message); }
        }
        const moves = await moveTo(files.map(f => path.join(dir, f)), dest);
        results.push({ moves, files, dir: dest, warning });
      } catch (e) { results.push({ error: e.message }); }
    }
    return { results };
  },
  'POST /api/restore': async b => {
    requireRoot();
    const dir = safeAbs(b.dir);
    return { moves: await moveTo((b.files || []).map(f => path.join(dir, path.basename(String(f)))), root), dir: root };
  },
  'POST /api/revert': async b => {
    const moves = [];
    for (const m of [...(b.moves || [])].reverse()) {
      const cur = safeAbs(m.to), orig = safeAbs(m.from);
      if (!(await exists(cur))) continue;
      const to = await uniqueDest(path.dirname(orig), path.basename(orig));
      await moveFile(cur, to);
      moves.push({ from: cur, to });
    }
    return { moves };
  },
  'POST /api/trash': async () => { requireRoot(); return { dir: trashAbs, groups: await scanDir(trashAbs) }; },
  'POST /api/empty-trash': async () => {
    requireRoot();
    let count = 0, bytes = 0, entries = [];
    try { entries = await fsp.readdir(trashAbs, { withFileTypes: true }); } catch {}
    for (const e of entries) {
      if (!e.isFile()) continue;
      const f = path.join(trashAbs, e.name);
      try { const st = await fsp.stat(f); await fsp.unlink(f); count++; bytes += st.size; }
      catch (err) { log('delete failed', f, err.message); }
    }
    try { await fsp.rmdir(trashAbs); } catch {}
    log('emptied trash', trashAbs, count, 'files');
    return { count, bytes };
  },
  'POST /api/reveal': async b => {
    requireRoot();
    const target = b.which === 'keep' ? keepAbs : b.which === 'trash' ? trashAbs : root;
    await fsp.mkdir(target, { recursive: true });
    spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  },
  // ready: false until the drive watcher has reported once, so cards already plugged in
  // at launch aren't mistaken for newly inserted ones.
  'POST /api/cards': async () => { const cards = await findCards(); return { cards, ready: drivesReported }; },
  'POST /api/ping': async () => { lastPing = Date.now(); clearTimeout(byeTimer); return { ok: true }; },
};

let PORT = BASE_PORT;
const INDEX = path.join(__dirname, 'index.html');

async function serveFile(req, res, abs, preview) {
  const ext = extOf(abs);
  if (preview || RAW_EXT.has(ext)) {
    const buf = await extractPreview(abs).catch(e => { log('preview failed', abs, e.message); return null; });
    if (!buf) return send(res, 415, { error: 'No preview' });
    return send(res, 200, buf, 'image/jpeg', { 'Cache-Control': 'private, max-age=300' });
  }
  const st = await fsp.stat(abs).catch(() => null);
  if (!st) return send(res, 404, { error: 'Not found' });
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=120' };
  // Range requests let videos stream and seek without loading the whole file.
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  let start = 0, end = st.size - 1, code = 200;
  if (m && (m[1] || m[2])) {
    if (m[1] === '') start = Math.max(0, st.size - Number(m[2]));
    else { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), st.size - 1); }
    if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    code = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  res.writeHead(code, { ...headers, 'Content-Length': end - start + 1 });
  if (st.size === 0) return res.end();
  const s = fs.createReadStream(abs, { start, end }).on('error', () => res.destroy());
  res.on('close', () => s.destroy());
  s.pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const host = (req.headers.host || '').toLowerCase();
    if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return send(res, 403, { error: 'Forbidden' });
    const url = new URL(req.url, `http://${host}`);
    lastPing = Date.now();

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = (await fsp.readFile(INDEX, 'utf8')).replace('__CULL_TOKEN__', TOKEN);
      return send(res, 200, html, 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/hello') return send(res, 200, { app: 'photo-cull' });

    if (req.method === 'POST' && url.pathname === '/api/bye') {
      if (url.searchParams.get('t') === TOKEN) {
        clearTimeout(byeTimer);
        byeTimer = setTimeout(() => { log('window closed, exiting'); process.exit(0); }, 4000);
      }
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && (url.pathname === '/file' || url.pathname === '/thumb')) {
      if (url.searchParams.get('t') !== TOKEN) return send(res, 403, { error: 'Forbidden' });
      const abs = safeAbs(url.searchParams.get('p'));
      if (url.pathname === '/thumb') {
        const buf = await makeThumb(abs).catch(e => { log('thumb failed', abs, e.message); return null; });
        if (buf) return send(res, 200, buf, 'image/jpeg', { 'Cache-Control': 'private, max-age=600' });
      }
      return serveFile(req, res, abs, url.searchParams.get('preview') === '1');
    }

    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return send(res, 404, { error: 'Not found' });
    if (req.headers['x-cull-token'] !== TOKEN) return send(res, 403, { error: 'Forbidden' });
    const body = req.method === 'POST' ? await readJson(req) : {};
    send(res, 200, await route(body));
  } catch (e) {
    if (typeof e.code !== 'number') log('error', req.method, req.url, e.stack || e.message);
    if (!res.headersSent) send(res, typeof e.code === 'number' ? e.code : 500, { error: e.message });
    else res.destroy();
  }
});

// ---------- window ----------
function findBrowser() {
  const c = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  ];
  return c.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
}

function openWindow(port, exitWithWindow) {
  const url = `http://127.0.0.1:${port}/`;
  if (NO_BROWSER) { log('serving at', url); return; }
  const browser = findBrowser();
  if (!browser) {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  const started = Date.now();
  const child = spawn(browser, [
    `--app=${url}`, `--user-data-dir=${path.join(APP_DIR, 'window')}`, '--window-size=1440,960',
    '--no-first-run', '--no-default-browser-check', '--disable-features=Translate',
  ], { stdio: 'ignore' });
  if (exitWithWindow) {
    child.on('exit', () => {
      // If the browser handed off to an already-running instance, rely on heartbeats instead.
      if (Date.now() - started > 5000) { log('window process exited'); process.exit(0); }
    });
  }
}

function tryListen(port, attempts = 0) {
  PORT = port;
  server.once('error', e => {
    if (e.code !== 'EADDRINUSE' || attempts > 10) { log('listen failed', e.message); process.exit(1); }
    // Another Photo Cull already running? Just open a window to it.
    http.get({ host: '127.0.0.1', port, path: '/hello', headers: { host: `127.0.0.1:${port}` }, timeout: 1500 }, r => {
      let d = ''; r.on('data', c => (d += c));
      r.on('end', () => {
        if (d.includes('photo-cull')) { openWindow(port, false); setTimeout(() => process.exit(0), 1500); }
        else tryListen(port + 1, attempts + 1);
      });
    }).on('error', () => tryListen(port + 1, attempts + 1));
  });
  server.listen(port, '127.0.0.1', () => {
    log('Photo Cull running on port', port);
    startDriveWatcher();
    openWindow(port, true);
  });
}

// Exit if the window has been gone for a while (safety net).
setInterval(() => {
  if (!NO_BROWSER && Date.now() - lastPing > 3 * 60 * 1000) { log('no heartbeat, exiting'); process.exit(0); }
}, 30 * 1000).unref();
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

tryListen(BASE_PORT);
