import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LETTERBOXD_ORIGIN = 'https://letterboxd.com';
const CACHE_VERSION = 1;
const MAX_COLLECTION_PAGES = 50;
const COLLECTION_TTL = 12 * 60 * 60 * 1000;
const RATING_TTL = 7 * 24 * 60 * 60 * 1000;
const TMDB_TTL = 30 * 24 * 60 * 60 * 1000;
const politePause = (milliseconds = 220) => new Promise(resolve => setTimeout(resolve, milliseconds));

function normalizeFilmKey(title, year = '') {
  const cleaned = String(title || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return `${cleaned}|${String(year || '').match(/\b(?:19|20)\d{2}\b/)?.[0] || ''}`;
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'")
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function titleAndYear(displayName) {
  const decoded = decodeHtml(displayName).trim();
  const match = decoded.match(/^(.*?)\s*\(((?:19|20)\d{2})\)$/);
  return { title: (match?.[1] || decoded).trim(), year: match?.[2] || '' };
}

function parseFilmGrid(html) {
  const matches = [...String(html || '').matchAll(/<div[^>]+data-item-name="([^"]+)"[^>]+data-item-slug="([^"]+)"[^>]*>/gi)];
  const items = [];
  const seen = new Set();
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    const end = matches[index + 1]?.index ?? Math.min(String(html).length, (match.index || 0) + 3000);
    const segment = String(html).slice(match.index || 0, end);
    const parsed = titleAndYear(match[1]);
    const slug = decodeHtml(match[2]).trim();
    const key = normalizeFilmKey(parsed.title, parsed.year);
    if (!parsed.title || !slug || seen.has(key)) continue;
    seen.add(key);
    const ratingClass = segment.match(/\brated-(\d+)\b/);
    items.push({
      key,
      title: parsed.title,
      year: parsed.year,
      slug,
      url: `${LETTERBOXD_ORIGIN}/film/${encodeURIComponent(slug)}/`,
      rating: ratingClass ? Number(ratingClass[1]) / 2 : null,
    });
  }
  return items;
}

function parsePageCount(html) {
  let pages = 1;
  for (const match of String(html || '').matchAll(/\/page\/(\d+)\//g)) pages = Math.max(pages, Number(match[1]) || 1);
  return Math.min(MAX_COLLECTION_PAGES, pages);
}

function xmlText(block, name) {
  const match = block.match(new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${name}>`, 'i'));
  return match ? decodeHtml(match[1]).trim() : '';
}

function parseRss(xml) {
  return [...String(xml || '').matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(match => {
    const block = match[1];
    const title = xmlText(block, 'letterboxd:filmTitle');
    const year = xmlText(block, 'letterboxd:filmYear');
    const link = xmlText(block, 'link');
    const slug = link.match(/\/film\/([^/]+)\/?/i)?.[1] || '';
    const tmdbId = xmlText(block, 'tmdb:movieId');
    const rating = Number(xmlText(block, 'letterboxd:memberRating'));
    return {
      key: normalizeFilmKey(title, year), title, year, slug, tmdbId,
      url: slug ? `${LETTERBOXD_ORIGIN}/film/${encodeURIComponent(slug)}/` : '',
      rating: Number.isFinite(rating) && rating > 0 ? rating : null,
    };
  }).filter(item => item.title);
}

function parseCommunityRating(html) {
  const jsonLd = [...String(html || '').matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const script of jsonLd) {
    try {
      const parsed = JSON.parse(script[1]);
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      for (const entry of entries) {
        const value = Number(entry?.aggregateRating?.ratingValue);
        if (Number.isFinite(value) && value >= 0 && value <= 5) return Math.round(value * 10) / 10;
      }
    } catch {}
  }
  const fallback = String(html || '').match(/"ratingValue"\s*:\s*"?(\d(?:\.\d+)?)"?/i);
  const value = Number(fallback?.[1]);
  return Number.isFinite(value) && value >= 0 && value <= 5 ? Math.round(value * 10) / 10 : null;
}

function safeUsername(value, fallback) {
  const username = String(value || '').trim();
  return /^[a-z0-9_]{2,30}$/i.test(username) ? username : fallback;
}

function publicListUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.hostname !== 'letterboxd.com') return '';
    return /^\/[a-z0-9_]+\/list\/[a-z0-9-]+\/?$/i.test(url.pathname) ? `${LETTERBOXD_ORIGIN}${url.pathname.replace(/\/?$/, '/')}` : '';
  } catch { return ''; }
}

function emptyState() {
  return { version: CACHE_VERSION, updatedAt: 0, users: {}, curated: [], community: {}, tmdb: {} };
}

class LetterboxdService {
  constructor({ dataDir, getConfig, fetchImpl = fetch }) {
    this.cacheFile = path.join(dataDir, 'letterboxd-cache.json');
    this.getConfig = getConfig;
    this.fetchImpl = fetchImpl;
    this.cookies = {};
    this.syncPromise = null;
    this.state = this.load();
  }

  load() {
    try {
      const value = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      return value?.version === CACHE_VERSION ? value : emptyState();
    } catch { return emptyState(); }
  }

  persist() {
    const temporary = `${this.cacheFile}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state));
    fs.renameSync(temporary, this.cacheFile);
  }

  status() {
    const config = this.getConfig();
    return {
      updatedAt: this.state.updatedAt || null,
      syncing: Boolean(this.syncPromise),
      users: {
        tyler: { username: safeUsername(config.letterboxdTyler, 'xMATLOCKx'), watched: Object.keys(this.state.users.tyler?.watched || {}).length, watchlist: Object.keys(this.state.users.tyler?.watchlist || {}).length },
        gloria: { username: safeUsername(config.letterboxdGloria, 'gloriaileana'), watched: Object.keys(this.state.users.gloria?.watched || {}).length, watchlist: Object.keys(this.state.users.gloria?.watchlist || {}).length },
      },
      curatedLists: (config.letterboxdLists || []).filter(publicListUrl).length,
    };
  }

  async text(url, timeout = 15_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const cookie = Object.entries(this.cookies).map(([name, value]) => `${name}=${value}`).join('; ');
      const response = await this.fetchImpl(url, { redirect: 'follow', signal: controller.signal, headers: { accept: 'text/html,application/xhtml+xml,application/rss+xml', 'accept-language': 'en-US,en;q=0.9', referer: `${LETTERBOXD_ORIGIN}/`, ...(cookie ? { cookie } : {}), 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36' } });
      const setCookies = response.headers.getSetCookie?.() || [response.headers.get('set-cookie') || ''];
      for (const header of setCookies) {
        for (const match of String(header).matchAll(/(?:^|,\s*)([a-z0-9_.-]+)=([^;,]*)/gi)) this.cookies[match[1]] = match[2];
      }
      if (!response.ok) throw new Error(`Letterboxd returned ${response.status}.`);
      const value = await response.text();
      if (value.length > 8_000_000) throw new Error('Letterboxd response was unexpectedly large.');
      return { value, finalUrl: response.url || url };
    } finally { clearTimeout(timer); }
  }

  async collection(baseUrl) {
    const first = await this.text(baseUrl);
    const items = [...parseFilmGrid(first.value)];
    const pages = parsePageCount(first.value);
    for (let page = 2; page <= pages; page++) {
      await politePause();
      const nextUrl = new URL(`page/${page}/`, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
      const response = await this.text(nextUrl);
      items.push(...parseFilmGrid(response.value));
    }
    return Object.fromEntries(items.map(item => [item.key, item]));
  }

  async member(label, username) {
    const watched = await this.collection(`${LETTERBOXD_ORIGIN}/${encodeURIComponent(username)}/films/`);
    const watchlist = await this.collection(`${LETTERBOXD_ORIGIN}/${encodeURIComponent(username)}/watchlist/`);
    const rssResponse = await this.text(`${LETTERBOXD_ORIGIN}/${encodeURIComponent(username)}/rss/`);
    const rss = parseRss(rssResponse.value);
    const byTmdb = {};
    for (const item of rss) {
      if (item.tmdbId) byTmdb[item.tmdbId] = item;
      watched[item.key] = { ...(watched[item.key] || item), rating: item.rating ?? watched[item.key]?.rating ?? null };
    }
    return { label, username, watched, watchlist, byTmdb };
  }

  async sync(force = false) {
    if (this.syncPromise) return this.syncPromise;
    if (!force && Date.now() - (this.state.updatedAt || 0) < COLLECTION_TTL) return this.status();
    this.syncPromise = (async () => {
      const config = this.getConfig();
      const tylerName = safeUsername(config.letterboxdTyler, 'xMATLOCKx');
      const gloriaName = safeUsername(config.letterboxdGloria, 'gloriaileana');
      const tyler = await this.member('Tyler', tylerName);
      await politePause(500);
      const gloria = await this.member('Gloria', gloriaName);
      const curated = [];
      for (const candidate of config.letterboxdLists || []) {
        const listUrl = publicListUrl(candidate);
        if (!listUrl) continue;
        try { curated.push({ url: listUrl, items: await this.collection(listUrl) }); } catch {}
      }
      this.state = { ...this.state, version: CACHE_VERSION, updatedAt: Date.now(), users: { tyler, gloria }, curated };
      this.persist();
      return this.status();
    })().finally(() => { this.syncPromise = null; });
    return this.syncPromise;
  }

  findMemberItem(member, tmdbId, title, year) {
    if (!member) return null;
    if (tmdbId && member.byTmdb?.[String(tmdbId)]) return member.byTmdb[String(tmdbId)];
    const exact = member.watched?.[normalizeFilmKey(title, year)] || member.watchlist?.[normalizeFilmKey(title, year)];
    if (exact) return exact;
    if (!year) {
      const prefix = `${normalizeFilmKey(title).split('|')[0]}|`;
      return Object.values(member.watched || {}).find(item => item.key.startsWith(prefix)) || Object.values(member.watchlist || {}).find(item => item.key.startsWith(prefix)) || null;
    }
    return null;
  }

  memberState(member, tmdbId, title, year) {
    const rssItem = tmdbId ? member?.byTmdb?.[String(tmdbId)] : null;
    const key = rssItem?.key || normalizeFilmKey(title, year);
    const watched = rssItem || member?.watched?.[key] || null;
    const watchlist = member?.watchlist?.[key] || null;
    return { watched: Boolean(watched), watchlist: Boolean(watchlist), rating: watched?.rating ?? null };
  }

  async communityRating(tmdbId, slug = '') {
    const cacheKey = String(tmdbId || slug || '');
    if (!cacheKey) return { rating: null, url: '' };
    const cached = this.state.community[cacheKey];
    if (cached && Date.now() - cached.checkedAt < RATING_TTL) return cached;
    let target = slug ? `${LETTERBOXD_ORIGIN}/film/${encodeURIComponent(slug)}/` : `${LETTERBOXD_ORIGIN}/tmdb/${encodeURIComponent(String(tmdbId))}/`;
    let result = { rating: null, url: slug ? target : '', checkedAt: Date.now() };
    try {
      const response = await this.text(target);
      const resolvedSlug = response.finalUrl.match(/\/film\/([^/]+)\/?/)?.[1] || slug;
      result = { rating: parseCommunityRating(response.value), url: resolvedSlug ? `${LETTERBOXD_ORIGIN}/film/${encodeURIComponent(resolvedSlug)}/` : response.finalUrl, checkedAt: Date.now() };
    } catch {}
    this.state.community[cacheKey] = result;
    this.persist();
    return result;
  }

  async match({ tmdbId = '', title = '', year = '' }) {
    if (Date.now() - (this.state.updatedAt || 0) >= COLLECTION_TTL) this.sync().catch(() => {});
    const tylerItem = this.findMemberItem(this.state.users.tyler, tmdbId, title, year);
    const gloriaItem = this.findMemberItem(this.state.users.gloria, tmdbId, title, year);
    const slug = tylerItem?.slug || gloriaItem?.slug || '';
    const community = await this.communityRating(tmdbId, slug);
    return {
      available: Boolean(this.state.updatedAt),
      communityRating: community.rating,
      url: community.url || tylerItem?.url || gloriaItem?.url || '',
      tyler: this.memberState(this.state.users.tyler, tmdbId, title, year),
      gloria: this.memberState(this.state.users.gloria, tmdbId, title, year),
      updatedAt: this.state.updatedAt || null,
    };
  }

  async tmdbMovie(item) {
    const token = this.getConfig().tmdbToken;
    if (!token) return null;
    const cached = this.state.tmdb[item.key];
    if (cached && Date.now() - cached.checkedAt < TMDB_TTL) return cached.value;
    let value = null;
    try {
      const query = new URLSearchParams({ query: item.title, include_adult: 'false', language: 'en-US', page: '1', ...(item.year ? { year: item.year } : {}) });
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10_000);
      const response = await this.fetchImpl(`https://api.themoviedb.org/3/search/movie?${query}`, { signal: controller.signal, headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
      clearTimeout(timer);
      if (response.ok) {
        const payload = await response.json();
        const match = (payload.results || []).find(candidate => !item.year || String(candidate.release_date || '').startsWith(item.year)) || payload.results?.[0];
        if (match) value = { tmdbId: String(match.id), posterUrl: match.poster_path ? `https://image.tmdb.org/t/p/w342${match.poster_path}` : '', overview: String(match.overview || ''), year: String(match.release_date || '').slice(0, 4) || item.year };
      }
    } catch {}
    this.state.tmdb[item.key] = { checkedAt: Date.now(), value };
    return value;
  }

  async discovery(filter = 'all', limit = 12) {
    if (!this.state.updatedAt) {
      this.sync().catch(() => {});
      return { items: [], status: this.status() };
    }
    if (Date.now() - this.state.updatedAt >= COLLECTION_TTL) this.sync().catch(() => {});
    const combined = new Map();
    const add = (item, owner, source = '') => {
      const existing = combined.get(item.key) || { ...item, savedBy: [], curatedBy: [] };
      if (owner && !existing.savedBy.includes(owner)) existing.savedBy.push(owner);
      if (source && !existing.curatedBy.includes(source)) existing.curatedBy.push(source);
      combined.set(item.key, existing);
    };
    Object.values(this.state.users.tyler?.watchlist || {}).forEach(item => add(item, 'tyler'));
    Object.values(this.state.users.gloria?.watchlist || {}).forEach(item => add(item, 'gloria'));
    this.state.curated.forEach(list => Object.values(list.items || {}).forEach(item => add(item, '', list.url)));
    let candidates = [...combined.values()].filter(item => !this.state.users.tyler?.watched?.[item.key] && !this.state.users.gloria?.watched?.[item.key]);
    if (filter === 'both') candidates = candidates.filter(item => item.savedBy.length === 2);
    if (filter === 'tyler') candidates = candidates.filter(item => item.savedBy.includes('tyler'));
    if (filter === 'gloria') candidates = candidates.filter(item => item.savedBy.includes('gloria'));
    if (filter === 'curated') candidates = candidates.filter(item => item.curatedBy.length);
    candidates.sort((a, b) => b.savedBy.length - a.savedBy.length || b.curatedBy.length - a.curatedBy.length || a.title.localeCompare(b.title));
    const selected = candidates.slice(0, Math.max(1, Math.min(24, Number(limit) || 12)));
    const enriched = await Promise.all(selected.map(async item => ({ item, metadata: await this.tmdbMovie(item) })));
    const detailed = await Promise.all(enriched.map(async entry => ({
      ...entry,
      community: await this.communityRating(entry.metadata?.tmdbId || '', entry.item.slug),
    })));
    this.persist();
    return {
      status: this.status(),
      items: detailed.map(({ item, metadata, community }) => ({
        title: item.title, year: metadata?.year || item.year, slug: item.slug, url: community.url || item.url,
        tmdbId: metadata?.tmdbId || '', posterUrl: metadata?.posterUrl || '', overview: metadata?.overview || '',
        savedBy: item.savedBy, curated: Boolean(item.curatedBy.length),
        communityRating: community.rating,
      })),
    };
  }
}

function normalizeLetterboxdConfig(value = {}) {
  return {
    letterboxdTyler: safeUsername(value.letterboxdTyler, 'xMATLOCKx'),
    letterboxdGloria: safeUsername(value.letterboxdGloria, 'gloriaileana'),
    letterboxdLists: String(value.letterboxdLists || '').split(/[\n,]+/).map(publicListUrl).filter(Boolean).slice(0, 8),
  };
}


const VERSION = '0.9.19';
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
let tv = { callbackUrl: '', foreground: false, lastSeen: 0, version: '' };
let secretKey = null;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(PID_FILE, String(process.pid));
let config = loadConfig();
const letterboxd = new LetterboxdService({ dataDir: DATA_DIR, getConfig: () => config });

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
    letterboxdTyler: saved.letterboxdTyler || 'xMATLOCKx',
    letterboxdGloria: saved.letterboxdGloria || 'gloriaileana',
    letterboxdLists: Array.isArray(saved.letterboxdLists) ? saved.letterboxdLists : [],
  };
  persistConfig(next);
  return next;
}

function saveConfig(update) {
  config = { ...config, ...update, token: config.token };
  persistConfig(config);
}

function localIp() {
  const candidates = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const item of entries || []) {
      if (item.family !== 'IPv4' || item.internal || item.address.startsWith('169.254.')) continue;
      const privateLan = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address);
      const preferredName = /ethernet|wi-?fi|wireless|wlan|lan/i.test(name);
      const virtualName = /virtual|vethernet|hyper-v|docker|vmware|tailscale|vpn|tunnel|loopback/i.test(name);
      candidates.push({ address: item.address, score: (privateLan ? 8 : 0) + (preferredName ? 4 : 0) - (virtualName ? 12 : 0) });
    }
  }
  return candidates.sort((left, right) => right.score - left.score)[0]?.address || '127.0.0.1';
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
    letterboxdTyler: config.letterboxdTyler,
    letterboxdGloria: config.letterboxdGloria,
    letterboxdLists: config.letterboxdLists.join('\n'),
    letterboxd: letterboxd.status(),
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
async function fetchWithTimeout(url, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  catch (error) {
    if (error?.name === 'AbortError') throw new Error('The connection timed out.');
    throw error;
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
  return { tmdbId: String(details.id || match.id), title: details.title || details.name, year: String(details.release_date || details.first_air_date || '').slice(0, 4), mediaType: type === 'tv' ? 'TV' : 'Movie', runtime: details.runtime || details.episode_run_time?.[0] || null, genres: (details.genres || []).map(x => x.name), overview: details.overview || '', posterUrl: details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : '' };
}
function qbitUrl(endpoint) { return `${config.qbitHttps ? 'https' : 'http'}://${config.qbitHost}:${config.qbitPort}${endpoint}`; }
async function qbit(endpoint, options = {}) {
  if (!config.qbitApiKey) throw new Error('Finish qBittorrent setup in Phone Control settings.');
  const response = await fetchWithTimeout(qbitUrl(endpoint), { ...options, headers: { authorization: `Bearer ${config.qbitApiKey}`, ...(options.headers || {}) } }, 10_000);
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
    return { id: x.hash, title: x.name, progress, status: complete ? 'COMPLETE' : (labels[x.state] || String(x.state || 'UNKNOWN').toUpperCase()), state: String(x.state || ''), speed: `${formatBytes(x.dlspeed || 0)}/s`, complete, addedOn: Number(x.added_on || 0) };
  });
}
async function downloadAction(id, action) {
  const hash = String(id || '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(hash)) throw new Error('That download could not be identified.');
  const form = new FormData(); form.set('hashes', hash);
  const endpoints = { pause: 'stop', resume: 'start', retry: 'recheck' };
  if (endpoints[action]) {
    await qbit(`/api/v2/torrents/${endpoints[action]}`, { method: 'POST', body: form });
    if (action === 'retry') await qbit('/api/v2/torrents/start', { method: 'POST', body: form });
    return { ok: true };
  }
  if (action === 'remove' || action === 'delete') {
    form.set('deleteFiles', action === 'delete' ? 'true' : 'false');
    await qbit('/api/v2/torrents/delete', { method: 'POST', body: form });
    return { ok: true };
  }
  throw new Error('That download action is unavailable.');
}
function tvActive() { return Boolean(tv.callbackUrl && tv.foreground && Date.now() - tv.lastSeen < 30_000); }
async function tvPost(route, payload) {
  if (!tvActive()) return false;
  try {
    const response = await fetchWithTimeout(new URL(route, tv.callbackUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }, 3_000);
    return response.ok;
  } catch { return false; }
}
async function tvState() {
  if (!tvActive()) return { foreground: false, screen: 'phone-only' };
  try {
    const response = await fetchWithTimeout(new URL('state', tv.callbackUrl), { cache: 'no-store' }, 3_000);
    if (!response.ok) throw 0;
    return await response.json();
  } catch { return { foreground: false, screen: 'phone-only' }; }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/' || url.pathname === '/setup') return send(res, 302, '', 'text/plain', { location: `/${config.token}/${url.pathname === '/setup' ? '?setup=1' : ''}` });
    if (url.pathname === '/pair' || url.pathname === '/health') return json(res, 200, { ok: true, url: baseUrl(), version: VERSION, products: { windowsCompanion: VERSION, phoneControl: VERSION, tvApp: tv.version || null, tvConnected: tvActive() }, signedUpdates: true, configured: Boolean(config.qbitApiKey) });
    if (url.pathname === '/bridge/tv' && req.method === 'POST') {
      const data = await body(req); tv = { callbackUrl: String(data.callbackUrl || ''), foreground: Boolean(data.foreground), lastSeen: Date.now(), version: String(data.tvVersion || '').slice(0, 24) };
      return json(res, 200, { ok: true, phoneUrl: baseUrl(), version: VERSION, receivedAt: Date.now() });
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
    if (route === 'api/state') return json(res, 200, { ok: true, tv: await tvState(), configured: Boolean(config.qbitApiKey), companion: { version: VERSION, ready: true, tvLastSeenAt: tv.lastSeen || null }, products: { windowsCompanion: VERSION, phoneControl: VERSION, tvApp: tv.version || null, tvConnected: tvActive() } });
    if (route === 'api/config' && req.method === 'GET') return json(res, 200, { ok: true, config: publicConfig(), phoneUrl: baseUrl(), version: VERSION, products: { windowsCompanion: VERSION, phoneControl: VERSION, tvApp: tv.version || null, tvConnected: tvActive() } });
    if (route === 'api/config' && req.method === 'POST') {
      const data = await body(req); const update = { qbitHost: String(data.qbitHost || '127.0.0.1').slice(0, 255), qbitPort: Number(data.qbitPort || 8080), qbitHttps: Boolean(data.qbitHttps), category: String(data.category || '').slice(0, 100), ...normalizeLetterboxdConfig(data) };
      if (String(data.qbitApiKey || '').trim()) update.qbitApiKey = String(data.qbitApiKey).trim();
      if (String(data.tmdbToken || '').trim()) update.tmdbToken = String(data.tmdbToken).trim();
      saveConfig(update); return json(res, 200, { ok: true, config: publicConfig() });
    }
    if (route === 'api/test' && req.method === 'POST') return json(res, 200, { ok: true, version: (await qbit('/api/v2/app/version')).trim() });
    if (route === 'api/search' && req.method === 'POST') {
      const data = await body(req); const query = String(data.query || '').trim().slice(0, 120); if (query.length < 2) return json(res, 400, { ok: false, message: 'Enter a title.' });
      const resolvedSort = ['seeders', 'newest', 'size'].includes(data.sort) ? data.sort : 'seeders';
      const result = await searchCatalog(query, resolvedSort); if (tvActive()) await tvPost('search', { query, sort: resolvedSort }); return json(res, 200, result);
    }
    if (route === 'api/select' && req.method === 'POST') {
      const data = await body(req); const item = resultCache.get(String(data.id)); if (!item) return json(res, 404, { ok: false, message: 'Search again.' });
      if (tvActive()) await tvPost('select', { id: item.id });
      let metadata = null; try { metadata = await metadataFor(item); } catch {}
      let letterboxdData = null;
      if (metadata?.mediaType === 'Movie') {
        try { letterboxdData = await letterboxd.match({ tmdbId: metadata.tmdbId, title: metadata.title, year: metadata.year }); } catch {}
      }
      return json(res, 200, { ok: true, item, metadata, letterboxd: letterboxdData });
    }
    if (route === 'api/letterboxd/status') return json(res, 200, { ok: true, ...letterboxd.status() });
    if (route === 'api/letterboxd/sync' && req.method === 'POST') return json(res, 200, { ok: true, ...(await letterboxd.sync(true)) });
    if (route === 'api/letterboxd/discover') {
      const filter = ['all', 'both', 'tyler', 'gloria', 'curated'].includes(url.searchParams.get('filter')) ? url.searchParams.get('filter') : 'all';
      const limit = Math.max(1, Math.min(24, Number(url.searchParams.get('limit')) || 12));
      return json(res, 200, { ok: true, ...(await letterboxd.discovery(filter, limit)) });
    }
    if (route === 'api/letterboxd/match') {
      const result = await letterboxd.match({ tmdbId: url.searchParams.get('tmdbId') || '', title: url.searchParams.get('title') || '', year: url.searchParams.get('year') || '' });
      return json(res, 200, { ok: true, ...result });
    }
    if (route === 'api/download' && req.method === 'POST') { const data = await body(req); return json(res, 200, await addDownload(String(data.id))); }
    if (route === 'api/downloads') return json(res, 200, { ok: true, items: await downloads() });
    if (route === 'api/downloads/action' && req.method === 'POST') { const data = await body(req); return json(res, 200, await downloadAction(data.id, data.action)); }
    if (route === 'api/text' && req.method === 'POST') { const data = await body(req); const synced = await tvPost('text', { value: String(data.value || '').slice(0, 512) }); return json(res, 200, { ok: true, synced }); }
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
setTimeout(() => letterboxd.sync().catch(error => console.warn(`Letterboxd sync deferred: ${error.message}`)), 1_500);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { try { fs.unlinkSync(PID_FILE); } catch {} process.exit(0); }));
