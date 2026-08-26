import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = '0.9.13';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.SCREENGLO_PORT || 8090);
const DATA_DIR = process.env.SCREENGLO_DATA_DIR || path.join(
  process.platform === 'win32' ? (process.env.APPDATA || os.homedir()) : os.homedir(),
  'SCREENGLO Companion',
);
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const PID_FILE = path.join(DATA_DIR, 'companion.pid');
const SECRET_KEY_FILE = path.join(DATA_DIR, 'secret.key');
const UPDATE_STATUS_FILE = path.join(DATA_DIR, 'update-status.json');
const UPDATE_MANIFEST_URL = process.env.SCREENGLO_UPDATE_URL || 'https://raw.githubusercontent.com/MatlockFT/screenglo-companion-updates/main/update.json';
const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEATwg+UETCIufPIy2zuneR9IdJpRUg2Bwbx/6xQk1HNlI=
-----END PUBLIC KEY-----`;
const UPDATE_FILES = new Set([
  'server.js', 'package.json', 'start.ps1', 'apply-update.ps1',
  'public/app.js', 'public/index.html', 'public/styles.css', 'public/sw.js',
  'public/manifest.webmanifest', 'public/logo.png', 'public/icon-192.png', 'public/icon-512.png',
]);
const resultCache = new Map();
let tv = { callbackUrl: '', foreground: false, lastSeen: 0 };
let secretKey = null;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(PID_FILE, String(process.pid));
let config = loadConfig();

function protectSecret(value) {
  if (!value) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', localSecretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `aesgcm:${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${encrypted.toString('base64')}`;
}

function unprotectSecret(value) {
  if (!value) return '';
  if (value.startsWith('dev:')) return Buffer.from(value.slice(4), 'base64').toString('utf8');
  if (!value.startsWith('aesgcm:')) return '';
  try {
    const [iv, tag, encrypted] = value.slice(7).split('.').map(part => Buffer.from(part, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', localSecretKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {}
  return '';
}

function localSecretKey() {
  if (secretKey) return secretKey;
  try {
    const existing = Buffer.from(fs.readFileSync(SECRET_KEY_FILE, 'utf8').trim(), 'base64');
    if (existing.length === 32) { secretKey = existing; return secretKey; }
  } catch {}
  secretKey = crypto.randomBytes(32);
  fs.writeFileSync(SECRET_KEY_FILE, secretKey.toString('base64'), { mode: 0o600 });
  return secretKey;
}

function persistConfig(value) {
  const saved = { ...value, qbitApiKey: undefined, tmdbToken: undefined, qbitApiKeyProtected: protectSecret(value.qbitApiKey), tmdbTokenProtected: protectSecret(value.tmdbToken) };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(saved, null, 2));
}

function loadConfig() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  const next = {
    token: saved.token || crypto.randomBytes(16).toString('hex'),
    qbitHost: saved.qbitHost || '127.0.0.1',
    qbitPort: Number(saved.qbitPort || 8080),
    qbitHttps: Boolean(saved.qbitHttps),
    qbitApiKey: unprotectSecret(saved.qbitApiKeyProtected || '') || saved.qbitApiKey || '',
    tmdbToken: unprotectSecret(saved.tmdbTokenProtected || '') || saved.tmdbToken || '',
    category: saved.category || 'movies',
  };
  persistConfig(next);
  return next;
}

function saveConfig(update) {
  config = { ...config, ...update, token: config.token };
  persistConfig(config);
}

function localIp() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries || []) {
      if (item.family === 'IPv4' && !item.internal && !item.address.startsWith('169.254.')) return item.address;
    }
  }
  return '127.0.0.1';
}

function baseUrl() { return `http://${localIp()}:${PORT}/${config.token}/`; }
function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
  res.end(body);
}
function json(res, status, value) { send(res, status, JSON.stringify(value)); }
function safeAsset(name) { return /^[a-z0-9._-]+$/i.test(name) ? path.join(PUBLIC, name) : ''; }
function serveAsset(res, name) {
  const file = safeAsset(name);
  if (!file || !fs.existsSync(file)) return send(res, 404, 'Not found', 'text/plain');
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
  const refreshOnOpen = new Set(['index.html', 'app.js', 'styles.css', 'sw.js', 'manifest.webmanifest']);
  send(res, 200, fs.readFileSync(file), types[path.extname(file)] || 'application/octet-stream', { 'cache-control': refreshOnOpen.has(name) ? 'no-cache' : 'public, max-age=3600' });
}
async function body(req, maxBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Request too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function publicConfig() {
  return {
    qbitHost: config.qbitHost,
    qbitPort: config.qbitPort,
    qbitHttps: config.qbitHttps,
    category: config.category,
    hasQbitKey: Boolean(config.qbitApiKey),
    hasTmdbToken: Boolean(config.tmdbToken),
  };
}
function compareVersions(left, right) {
  const a = String(left).split('.').map(value => Number(value) || 0);
  const b = String(right).split('.').map(value => Number(value) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0) ? 1 : -1;
  }
  return 0;
}
function verifyUpdateDescriptor(descriptor) {
  const release = descriptor?.release;
  if (!release || !/^\d+\.\d+\.\d+$/.test(String(release.version || ''))) throw new Error('The update manifest is invalid.');
  if (!Array.isArray(release.files) || !release.files.length || release.files.length > UPDATE_FILES.size) throw new Error('The update file list is invalid.');
  if (!release.baseUrl || !String(release.baseUrl).startsWith('https://raw.githubusercontent.com/')) throw new Error('The update source is not trusted.');
  const seen = new Set();
  for (const file of release.files) {
    if (!UPDATE_FILES.has(file.path) || seen.has(file.path)) throw new Error('The update contains an unexpected file.');
    if (!/^[a-f0-9]{64}$/.test(String(file.sha256 || '')) || !Number.isInteger(file.size) || file.size < 1 || file.size > 3_000_000) throw new Error('The update file details are invalid.');
    seen.add(file.path);
  }
  const signature = Buffer.from(String(descriptor.signature || ''), 'base64');
  if (!crypto.verify(null, Buffer.from(JSON.stringify(release)), UPDATE_PUBLIC_KEY, signature)) throw new Error('The update signature is not valid.');
  return release;
}
async function updateDescriptor() {
  const descriptor = await fetchJson(UPDATE_MANIFEST_URL, { headers: { accept: 'application/json', 'user-agent': `SCREENGLO-Companion/${VERSION}` } });
  const release = verifyUpdateDescriptor(descriptor);
  return { descriptor, release, available: compareVersions(release.version, VERSION) > 0 };
}
async function fetchBytes(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'user-agent': `SCREENGLO-Companion/${VERSION}` } });
    if (!response.ok) throw new Error(`Update download failed (${response.status}).`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 3_000_000) throw new Error('An update file is too large.');
    return bytes;
  } finally { clearTimeout(timer); }
}
async function stageUpdate(descriptor) {
  const release = verifyUpdateDescriptor(descriptor);
  if (compareVersions(release.version, VERSION) <= 0) return { installed: false, current: true, version: VERSION };
  const staging = path.join(DATA_DIR, 'update-staging');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  let total = 0;
  for (const file of release.files) {
    total += file.size;
    if (total > 10_000_000) throw new Error('The update package is too large.');
    const remotePath = file.path.split('/').map(encodeURIComponent).join('/');
    const bytes = await fetchBytes(new URL(remotePath, release.baseUrl.endsWith('/') ? release.baseUrl : `${release.baseUrl}/`));
    if (bytes.length !== file.size || crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`Update verification failed for ${file.path}.`);
    const target = path.join(staging, ...file.path.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  fs.writeFileSync(path.join(staging, 'pending.json'), JSON.stringify({ version: release.version, stagedAt: new Date().toISOString() }));
  fs.writeFileSync(UPDATE_STATUS_FILE, JSON.stringify({ state: 'installing', version: release.version, message: 'Verified. Restarting SCREENGLO Companion…' }));
  return { installed: true, version: release.version, staging };
}
function scheduleUpdate(staging, version) {
  setTimeout(() => {
    const updater = path.join(ROOT, 'apply-update.ps1');
    const child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', updater, '-StagingPath', staging, '-Version', version], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    setTimeout(() => server.close(() => process.exit(0)), 250);
  }, 500);
}
function cleanTitle(title) {
  return title.replace(/\b(2160p|1080p|720p|bluray|brrip|webrip|web-dl|hevc|x26[45]|remux|hdr|dv|aac|dts|yts|bone)\b/ig, ' ')
    .replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}
function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'Unknown size';
  const units = ['B', 'KB', 'MB', 'GB', 'TB']; let value = bytes; let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 10 || unit < 2 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}
async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    return text ? JSON.parse(text) : {};
  } finally { clearTimeout(timer); }
}
async function searchCatalog(query, sort) {
  const order = sort === 'newest' ? 'date' : sort === 'size' ? 'bytes' : 'seeders';
  const payload = await fetchJson('https://api.knaben.org/v1', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query, search_type: '100%', search_field: 'title', order_by: order, order_direction: 'desc', categories: [2000000, 3000000], from: 0, size: 40, hide_unsafe: true, hide_xxx: true }),
  });
  const items = (payload.hits || []).filter(x => x.magnetUrl).map(x => {
    const item = { id: String(x.id || x.hash), title: String(x.title || 'Untitled'), bytes: x.bytes || 0, size: formatBytes(x.bytes), seeders: x.seeders || 0, date: x.date || '', magnetUrl: x.magnetUrl, categoryIds: x.categoryId || [] };
    resultCache.set(item.id, item); return item;
  });
  while (resultCache.size > 160) resultCache.delete(resultCache.keys().next().value);
  return { ok: true, total: payload.total?.value || items.length, items };
}
async function metadataFor(item) {
  if (!config.tmdbToken) return null;
  const query = encodeURIComponent(cleanTitle(item.title));
  const found = await fetchJson(`https://api.themoviedb.org/3/search/multi?query=${query}&include_adult=false&language=en-US&page=1`, { headers: { authorization: `Bearer ${config.tmdbToken}`, accept: 'application/json' } });
  const match = (found.results || []).find(x => x.media_type === 'movie' || x.media_type === 'tv');
  if (!match) return null;
  const type = match.media_type;
  const details = await fetchJson(`https://api.themoviedb.org/3/${type}/${match.id}?language=en-US`, { headers: { authorization: `Bearer ${config.tmdbToken}`, accept: 'application/json' } });
  return { title: details.title || details.name, year: String(details.release_date || details.first_air_date || '').slice(0, 4), mediaType: type === 'tv' ? 'TV' : 'Movie', runtime: details.runtime || details.episode_run_time?.[0] || null, genres: (details.genres || []).map(x => x.name), overview: details.overview || '', posterUrl: details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : '' };
}
function qbitUrl(endpoint) { return `${config.qbitHttps ? 'https' : 'http'}://${config.qbitHost}:${config.qbitPort}${endpoint}`; }
async function qbit(endpoint, options = {}) {
  if (!config.qbitApiKey) throw new Error('Finish qBittorrent setup in Phone Control settings.');
  const response = await fetch(qbitUrl(endpoint), { ...options, headers: { authorization: `Bearer ${config.qbitApiKey}`, ...(options.headers || {}) } });
  const text = await response.text();
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'qBittorrent rejected the API key.' : `qBittorrent returned ${response.status}.`);
  return text;
}
async function addDownload(id) {
  const item = resultCache.get(id); if (!item) throw new Error('That result expired. Search again.');
  const form = new FormData(); form.set('urls', item.magnetUrl); if (config.category) form.set('category', config.category);
  await qbit('/api/v2/torrents/add', { method: 'POST', body: form });
  return { ok: true, message: 'Added to qBittorrent ✓' };
}
async function downloads() {
  const items = JSON.parse(await qbit('/api/v2/torrents/info?filter=all') || '[]');
  return items.sort((a, b) => (b.added_on || 0) - (a.added_on || 0)).map(x => {
    const complete = (x.progress || 0) >= .999 || /UP$/.test(String(x.state || ''));
    const progress = complete ? 100 : Math.min(99, Math.round((x.progress || 0) * 100));
    const labels = { downloading: 'DOWNLOADING', stalledDL: 'STALLED', stoppedDL: 'PAUSED', queuedDL: 'QUEUED', checkingDL: 'CHECKING', metaDL: 'STARTING', forcedDL: 'DOWNLOADING', error: 'ERROR', missingFiles: 'MISSING FILES' };
    return { id: x.hash, title: x.name, progress, status: complete ? 'COMPLETE' : (labels[x.state] || String(x.state || 'UNKNOWN').toUpperCase()), speed: `${formatBytes(x.dlspeed || 0)}/s`, complete };
  });
}
function tvActive() { return Boolean(tv.callbackUrl && tv.foreground && Date.now() - tv.lastSeen < 12_000); }
async function tvPost(route, payload) {
  if (!tvActive()) return false;
  try {
    const response = await fetch(new URL(route, tv.callbackUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    return response.ok;
  } catch { return false; }
}
async function tvState() {
  if (!tvActive()) return { foreground: false, screen: 'phone-only' };
  try {
    const response = await fetch(new URL('state', tv.callbackUrl), { cache: 'no-store' });
    if (!response.ok) throw 0;
    return await response.json();
  } catch { return { foreground: false, screen: 'phone-only' }; }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/' || url.pathname === '/setup') return send(res, 302, '', 'text/plain', { location: `/${config.token}/${url.pathname === '/setup' ? '?setup=1' : ''}` });
    if (url.pathname === '/pair') return json(res, 200, { ok: true, url: baseUrl(), version: VERSION, signedUpdates: true });
    if (url.pathname === '/bridge/tv' && req.method === 'POST') {
      const data = await body(req); tv = { callbackUrl: String(data.callbackUrl || ''), foreground: Boolean(data.foreground), lastSeen: Date.now() };
      return json(res, 200, { ok: true, phoneUrl: baseUrl() });
    }
    const prefix = `/${config.token}/`;
    if (!url.pathname.startsWith(prefix)) return send(res, 404, 'Not found', 'text/plain');
    const route = url.pathname.slice(prefix.length);
    if (!route || route === 'index.html') return serveAsset(res, 'index.html');
    if (route === 'manifest.webmanifest') {
      const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8'));
      manifest.start_url = prefix; manifest.scope = prefix;
      return send(res, 200, JSON.stringify(manifest), 'application/manifest+json');
    }
    if (route === 'api/state') return json(res, 200, { ok: true, tv: await tvState(), configured: Boolean(config.qbitApiKey) });
    if (route === 'api/config' && req.method === 'GET') return json(res, 200, { ok: true, config: publicConfig(), phoneUrl: baseUrl(), version: VERSION });
    if (route === 'api/config' && req.method === 'POST') {
      const data = await body(req); const update = { qbitHost: String(data.qbitHost || '127.0.0.1').slice(0, 255), qbitPort: Number(data.qbitPort || 8080), qbitHttps: Boolean(data.qbitHttps), category: String(data.category || '').slice(0, 100) };
      if (String(data.qbitApiKey || '').trim()) update.qbitApiKey = String(data.qbitApiKey).trim();
      if (String(data.tmdbToken || '').trim()) update.tmdbToken = String(data.tmdbToken).trim();
      saveConfig(update); return json(res, 200, { ok: true, config: publicConfig() });
    }
    if (route === 'api/test' && req.method === 'POST') return json(res, 200, { ok: true, version: (await qbit('/api/v2/app/version')).trim() });
    if (route === 'api/search' && req.method === 'POST') {
      const data = await body(req); const query = String(data.query || '').trim().slice(0, 120); if (query.length < 2) return json(res, 400, { ok: false, message: 'Enter a title.' });
      const result = await searchCatalog(query, data.sort); if (tvActive()) await tvPost('search', { query }); return json(res, 200, result);
    }
    if (route === 'api/select' && req.method === 'POST') {
      const data = await body(req); const item = resultCache.get(String(data.id)); if (!item) return json(res, 404, { ok: false, message: 'Search again.' });
      if (tvActive()) await tvPost('select', { id: item.id });
      let metadata = null; try { metadata = await metadataFor(item); } catch {}
      return json(res, 200, { ok: true, item, metadata });
    }
    if (route === 'api/download' && req.method === 'POST') { const data = await body(req); return json(res, 200, await addDownload(String(data.id))); }
    if (route === 'api/downloads') return json(res, 200, { ok: true, items: await downloads() });
    if (route === 'api/update/check') {
      const update = await updateDescriptor();
      return json(res, 200, { ok: true, currentVersion: VERSION, latestVersion: update.release.version, available: update.available, notes: String(update.release.notes || '') });
    }
    if (route === 'api/update/install' && req.method === 'POST') {
      const update = await updateDescriptor();
      if (!update.available) return json(res, 200, { ok: true, current: true, version: VERSION, message: 'SCREENGLO Companion is up to date.' });
      const staged = await stageUpdate(update.descriptor);
      json(res, 202, { ok: true, restarting: true, version: staged.version, message: 'Update verified. SCREENGLO Companion is restarting…' });
      scheduleUpdate(staged.staging, staged.version);
      return;
    }
    if (route === 'api/command' && req.method === 'POST') { const data = await body(req); if (data.action === 'exit') await tvPost('exit', {}); else await tvPost('command', { action: data.action }); return json(res, 200, { ok: true, synced: tvActive() }); }
    return serveAsset(res, route);
  } catch (error) { json(res, 500, { ok: false, message: error?.message || 'Something went wrong.' }); }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SCREENGLO Companion ${VERSION}`);
  console.log(`Phone Control: ${baseUrl()}`);
  console.log(`Setup on this PC: http://localhost:${PORT}/setup`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { try { fs.unlinkSync(PID_FILE); } catch {} process.exit(0); }));
