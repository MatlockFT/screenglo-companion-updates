import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
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

function episodeGroup(title) {
  const match = String(title || '').match(/^(.*?)[ ._-]+s(\d{1,2})e\d{1,3}/i);
  if (!match) return '';
  const show = match[1].replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return show ? `${show}:s${Number(match[2])}` : '';
}

function chapterSegments(chapters) {
  return (chapters || []).flatMap(chapter => {
    const title = String(chapter?.tags?.title || chapter?.tags?.TITLE || '').trim().toLowerCase();
    const startMs = Math.round(Number(chapter?.start_time || 0) * 1000);
    const endMs = Math.round(Number(chapter?.end_time || 0) * 1000);
    const duration = endMs - startMs;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || duration < 5_000) return [];
    const type = /previously|recap/.test(title) ? 'recap'
      : /opening|\bintro\b|theme song|^op$/.test(title) ? 'intro'
        : /credit|outro|ending|^ed$/.test(title) ? 'credits' : '';
    return type ? [{ type, startMs, endMs, source: 'chapter', confidence: 1 }] : [];
  });
}

function columnStats(bytes, x, width, height) {
  let mean = 0;
  for (let y = 0; y < height; y += 1) mean += bytes[y * width + x];
  mean /= height;
  let variance = 0;
  for (let y = 0; y < height; y += 1) {
    const centered = bytes[y * width + x] - mean;
    variance += centered * centered;
  }
  return { mean, variance };
}

function columnSimilarity(left, lx, right, rx, width, height) {
  const a = columnStats(left, lx, width, height);
  const b = columnStats(right, rx, width, height);
  if (a.mean < 4 || b.mean < 4 || a.variance < 80 || b.variance < 80) return 0;
  let covariance = 0;
  for (let y = 0; y < height; y += 1) covariance += (left[y * width + lx] - a.mean) * (right[y * width + rx] - b.mean);
  return covariance / Math.sqrt(a.variance * b.variance);
}

function recurringIntro(left, right, width = 720, height = 24) {
  if (!left || !right || left.length !== width * height || right.length !== width * height) return null;
  let best = null;
  for (let offset = -(width - 20); offset <= width - 20; offset += 1) {
    let runStart = -1, matches = 0, misses = 0, score = 0;
    const closeRun = end => {
      const length = end - runStart;
      const confidence = matches ? score / matches : 0;
      if (runStart >= 0 && length >= 20 && matches / length >= .88 && confidence >= .87 && (!best || length * confidence > best.length * best.confidence)) {
        best = { startA: runStart, endA: end, startB: runStart + offset, endB: end + offset, length, confidence };
      }
      runStart = -1; matches = 0; misses = 0; score = 0;
    };
    for (let x = Math.max(0, -offset); x < Math.min(width, width - offset); x += 1) {
      const similarity = columnSimilarity(left, x, right, x + offset, width, height);
      if (similarity >= .82) {
        if (runStart < 0) runStart = x;
        matches += 1; score += similarity; misses = 0;
      } else if (runStart >= 0 && misses < 2) {
        misses += 1;
      } else if (runStart >= 0) closeRun(x - misses);
    }
    if (runStart >= 0) closeRun(Math.min(width, width - offset) - misses);
  }
  if (!best || best.endA > 600 || best.endB > 600) return null;
  return {
    current: { type: 'intro', startMs: best.startA * 1000, endMs: Math.max((best.startA + 5) * 1000, best.endA * 1000 - 1500), source: 'audio-match', confidence: Number(best.confidence.toFixed(3)) },
    comparison: { type: 'intro', startMs: best.startB * 1000, endMs: Math.max((best.startB + 5) * 1000, best.endB * 1000 - 1500), source: 'audio-match', confidence: Number(best.confidence.toFixed(3)) },
  };
}


const VERSION = '0.10.4';
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
const MEDIA_SEGMENTS_FILE = path.join(DATA_DIR, 'media-segments.json');
const UPDATE_MANIFEST_URL = process.env.SCREENGLO_UPDATE_URL || 'https://raw.githubusercontent.com/MatlockFT/screenglo-companion-updates/main/update.json';
const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEATwg+UETCIufPIy2zuneR9IdJpRUg2Bwbx/6xQk1HNlI=
-----END PUBLIC KEY-----`;
const UPDATE_FILES = new Set([
  'server.js', 'letterboxd.js', 'package.json', 'start.ps1', 'apply-update.ps1',
  'public/app.js', 'public/index.html', 'public/styles.css', 'public/sw.js',
  'public/manifest.webmanifest', 'public/logo.png', 'public/icon-192.png', 'public/icon-512.png',
]);
const resultCache = new Map();
const playbackCache = new Map();
const segmentJobs = new Map();
const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.m4v', '.avi', '.webm', '.mov', '.ts', '.m2ts']);
const SUBTITLE_TYPES = new Map([['.srt', 'application/x-subrip'], ['.vtt', 'text/vtt'], ['.ass', 'text/x-ssa'], ['.ssa', 'text/x-ssa'], ['.ttml', 'application/ttml+xml']]);
let tv = { callbackUrl: '', foreground: false, lastSeen: 0, version: '' };
let secretKey = null;
let cachedDownloads = [];
let qbitHealth = { state: 'checking', consecutiveFailures: 0, lastSuccessAt: 0 };

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(PID_FILE, String(process.pid));
let segmentRecords = loadSegmentRecords();
let segmentQueue = Promise.resolve();
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
  const saved = {
    ...value,
    qbitApiKey: undefined,
    tmdbToken: undefined,
    openSubtitlesApiKey: undefined,
    qbitApiKeyProtected: protectSecret(value.qbitApiKey),
    tmdbTokenProtected: protectSecret(value.tmdbToken),
    openSubtitlesApiKeyProtected: protectSecret(value.openSubtitlesApiKey),
  };
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
    openSubtitlesApiKey: unprotectSecret(saved.openSubtitlesApiKeyProtected || '') || saved.openSubtitlesApiKey || '',
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
    hasOpenSubtitlesKey: Boolean(config.openSubtitlesApiKey),
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
  const manifestUrl = new URL(UPDATE_MANIFEST_URL);
  manifestUrl.searchParams.set('checked', String(Date.now()));
  const descriptor = await fetchJson(manifestUrl, { headers: { accept: 'application/json', 'cache-control': 'no-cache', 'user-agent': `SCREENGLO-Companion/${VERSION}` } });
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
    try {
      const updater = path.join(ROOT, 'apply-update.ps1');
      const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const updateLog = fs.openSync(path.join(DATA_DIR, 'update.log'), 'a');
      const child = spawn(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', updater, '-StagingPath', staging, '-Version', version], { detached: true, stdio: ['ignore', updateLog, updateLog], windowsHide: true });
      child.once('error', error => {
        fs.closeSync(updateLog);
        fs.writeFileSync(UPDATE_STATUS_FILE, JSON.stringify({ state: 'failed', version, message: `Could not start the updater: ${error.message}` }));
      });
      child.once('spawn', () => {
        fs.closeSync(updateLog);
        child.unref();
        // Give detached PowerShell time to open and lock onto the staged payload before this server exits.
        setTimeout(() => server.close(() => process.exit(0)), 1_500);
      });
    } catch (error) {
      fs.writeFileSync(UPDATE_STATUS_FILE, JSON.stringify({ state: 'failed', version, message: `Could not start the updater: ${error.message}` }));
    }
  // The tray normally applies a staged update on its next five-second tick. Waiting here prevents
  // the tray and server from racing; this remains a fallback when Companion was launched without its tray.
  }, 8_000);
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
function qbitError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}
async function qbit(endpoint, options = {}) {
  if (!config.qbitApiKey) throw qbitError('QBIT_SETUP', 'Finish qBittorrent setup in Phone Control settings.');
  let response;
  try {
    response = await fetchWithTimeout(qbitUrl(endpoint), { ...options, headers: { authorization: `Bearer ${config.qbitApiKey}`, ...(options.headers || {}) } }, 4_500);
  } catch (error) {
    throw qbitError('QBIT_UNREACHABLE', 'qBittorrent is not responding on this PC.', error);
  }
  const text = await response.text();
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw qbitError('QBIT_AUTH', 'qBittorrent rejected the API key.');
    throw qbitError('QBIT_SERVER', `qBittorrent returned ${response.status}.`);
  }
  return text;
}
async function addDownload(id) {
  const item = resultCache.get(id); if (!item) throw new Error('That result expired. Search again.');
  const form = new FormData(); form.set('urls', item.magnetUrl); if (config.category) form.set('category', config.category);
  await qbit('/api/v2/torrents/add', { method: 'POST', body: form });
  return { ok: true, message: 'Added to qBittorrent' };
}
async function downloads() {
  const items = JSON.parse(await qbit('/api/v2/torrents/info?filter=all') || '[]');
  return items.sort((a, b) => (b.added_on || 0) - (a.added_on || 0)).map(x => {
    const complete = (x.progress || 0) >= .999 || /UP$/.test(String(x.state || ''));
    const progress = complete ? 100 : Math.min(99, Math.round((x.progress || 0) * 100));
    const labels = { downloading: 'DOWNLOADING', stalledDL: 'STALLED', stoppedDL: 'PAUSED', queuedDL: 'QUEUED', checkingDL: 'CHECKING', metaDL: 'STARTING', forcedDL: 'DOWNLOADING', error: 'ERROR', missingFiles: 'MISSING FILES' };
    return {
      id: x.hash, title: x.name, progress,
      status: complete ? 'COMPLETE' : (labels[x.state] || String(x.state || 'UNKNOWN').toUpperCase()),
      state: String(x.state || ''), speed: `${formatBytes(x.dlspeed || 0)}/s`, complete,
      size: Number(x.size || 0), downloaded: Number(x.downloaded || 0), speedBytes: Number(x.dlspeed || 0),
      eta: Number(x.eta || 0), category: String(x.category || ''), addedOn: Number(x.added_on || 0),
    };
  });
}
async function downloadSnapshot() {
  try {
    cachedDownloads = await downloads();
    qbitHealth = { state: 'ready', consecutiveFailures: 0, lastSuccessAt: Date.now() };
  } catch (error) {
    if (error?.code === 'QBIT_UNREACHABLE') {
      const failures = qbitHealth.consecutiveFailures + 1;
      qbitHealth = { ...qbitHealth, state: failures >= 3 ? 'sleeping' : 'checking', consecutiveFailures: failures };
    } else {
      qbitHealth = {
        ...qbitHealth,
        state: error?.code === 'QBIT_AUTH' ? 'auth' : error?.code === 'QBIT_SETUP' ? 'setup' : 'problem',
        consecutiveFailures: 0,
      };
    }
  }
  return {
    ok: true,
    items: cachedDownloads,
    qbit: {
      state: qbitHealth.state,
      confirmed: qbitHealth.state === 'sleeping',
      lastSuccessAt: qbitHealth.lastSuccessAt || null,
    },
  };
}

function naturalCompare(left, right) {
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' });
}

function validHash(value) {
  const hash = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(hash)) throw new Error('That download could not be identified.');
  return hash;
}

function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function existingFile(candidates, roots) {
  for (const candidate of candidates) {
    if (!candidate || !roots.some(root => root && inside(root, candidate))) continue;
    try { if (fs.statSync(candidate).isFile()) return path.resolve(candidate); } catch {}
  }
  return '';
}

function mediaType(filePath) {
  const types = {
    '.mkv': 'video/x-matroska', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
    '.avi': 'video/x-msvideo', '.mov': 'video/quicktime', '.ts': 'video/mp2t', '.m2ts': 'video/mp2t',
  };
  return types[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function languageFromSubtitle(name) {
  const match = String(name).toLowerCase().match(/(?:^|[._ -])(en|eng|english|es|spa|spanish|fr|fre|french|de|ger|german)(?:[._ -]|$)/);
  if (!match) return '';
  return ({ eng: 'en', english: 'en', spa: 'es', spanish: 'es', fre: 'fr', french: 'fr', ger: 'de', german: 'de' })[match[1]] || match[1];
}

function subtitleLabel(filePath) {
  const language = languageFromSubtitle(path.basename(filePath));
  return language === 'en' ? 'English' : language ? language.toUpperCase() : path.basename(filePath, path.extname(filePath));
}

function loadSegmentRecords() {
  try {
    const parsed = JSON.parse(fs.readFileSync(MEDIA_SEGMENTS_FILE, 'utf8'));
    return parsed && typeof parsed.records === 'object' ? parsed.records : {};
  } catch { return {}; }
}

function saveSegmentRecords() {
  const entries = Object.entries(segmentRecords).sort((a, b) => Number(b[1].updatedAt || 0) - Number(a[1].updatedAt || 0)).slice(0, 300);
  segmentRecords = Object.fromEntries(entries);
  fs.writeFileSync(MEDIA_SEGMENTS_FILE, JSON.stringify({ version: 1, records: segmentRecords }));
}

function segmentKey(file) {
  const stat = fs.statSync(file.absolutePath);
  return crypto.createHash('sha256').update(`${file.absolutePath.toLowerCase()}\n${stat.size}\n${Math.round(stat.mtimeMs)}`).digest('hex').slice(0, 32);
}

function mediaTool(name) {
  const configured = process.env[`SCREENGLO_${name.toUpperCase()}`];
  const bundled = process.platform === 'win32' ? `C:\\ffmpeg\\bin\\${name}.exe` : '';
  return configured || (bundled && fs.existsSync(bundled) ? bundled : name);
}

function capture(command, args, timeoutMs, maxBytes) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let size = 0; let errorText = ''; let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(new Error(`${path.basename(command)} timed out.`)); }, timeoutMs);
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) { child.kill(); finish(new Error(`${path.basename(command)} returned too much data.`)); }
      else chunks.push(chunk);
    });
    child.stderr.on('data', chunk => { if (errorText.length < 2000) errorText += chunk.toString(); });
    child.once('error', error => finish(error));
    child.once('close', code => code === 0 ? finish(null, Buffer.concat(chunks)) : finish(new Error(errorText.trim() || `${path.basename(command)} failed.`)));
  });
}

async function embeddedSegments(filePath) {
  const output = await capture(mediaTool('ffprobe'), ['-v', 'error', '-show_chapters', '-print_format', 'json', filePath], 12_000, 1_000_000);
  return chapterSegments(JSON.parse(output.toString()).chapters || []);
}

async function audioSignature(filePath) {
  return capture(mediaTool('ffmpeg'), [
    '-hide_banner', '-loglevel', 'error', '-threads', '1', '-t', '720', '-i', filePath,
    '-filter_complex', '[0:a:0]showspectrumpic=s=720x24:legend=disabled:color=intensity:scale=log:start=20:stop=8000[v]',
    '-map', '[v]', '-frames:v', '1', '-c:v', 'rawvideo', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
  ], 90_000, 100_000);
}

function publicSegments(file) {
  const key = segmentKey(file);
  return { ok: true, analyzing: segmentJobs.has(key), items: segmentRecords[key]?.segments || [] };
}

function queueSegmentAnalysis(file) {
  const key = segmentKey(file);
  if (segmentRecords[key]?.complete || segmentJobs.has(key)) return;
  const job = segmentQueue.then(async () => {
    let segments = [];
    try { segments = await embeddedSegments(file.absolutePath); } catch {}
    const group = episodeGroup(file.title);
    let signature = null;
    if (group && !segments.some(item => item.type === 'intro')) {
      try { signature = await audioSignature(file.absolutePath); } catch {}
      if (signature?.length === 720 * 24) {
        let best = null;
        for (const [otherKey, other] of Object.entries(segmentRecords)) {
          if (otherKey === key || other.group !== group || !other.signature) continue;
          const match = recurringIntro(signature, Buffer.from(other.signature, 'base64'));
          if (match && (!best || match.current.confidence > best.match.current.confidence)) best = { otherKey, match };
        }
        if (best) {
          segments.push(best.match.current);
          const other = segmentRecords[best.otherKey];
          if (!other.segments?.some(item => item.type === 'intro')) other.segments = [...(other.segments || []), best.match.comparison];
        }
      }
    }
    segmentRecords[key] = {
      group, title: file.title, signature: signature?.toString('base64') || '', segments,
      complete: true, updatedAt: Date.now(),
    };
    saveSegmentRecords();
  }).catch(() => {
    segmentRecords[key] = { group: episodeGroup(file.title), title: file.title, signature: '', segments: [], complete: true, updatedAt: Date.now() };
    saveSegmentRecords();
  }).finally(() => segmentJobs.delete(key));
  segmentJobs.set(key, job);
  segmentQueue = job.catch(() => {});
}

async function playbackFiles(hash, refresh = false) {
  if (!refresh) {
    const cached = playbackCache.get(hash);
    if (cached && Date.now() - cached.cachedAt < 30_000) return cached;
  }
  const properties = JSON.parse(await qbit(`/api/v2/torrents/properties?hash=${hash}`) || '{}');
  const torrentFiles = JSON.parse(await qbit(`/api/v2/torrents/files?hash=${hash}`) || '[]');
  if (!properties.save_path && !properties.content_path) throw new Error('qBittorrent did not provide a safe playback path.');
  const savePath = path.resolve(String(properties.save_path || path.dirname(String(properties.content_path || ''))));
  const contentPath = path.resolve(String(properties.content_path || savePath));
  let contentIsFile = false;
  try { contentIsFile = fs.statSync(contentPath).isFile(); } catch {}
  const contentRoot = contentIsFile ? path.dirname(contentPath) : contentPath;
  const roots = [savePath, contentRoot];

  const resolved = torrentFiles.map((file, sourceIndex) => {
    const relative = String(file.name || '').replaceAll('/', path.sep);
    const withoutRoot = relative.split(path.sep).slice(1).join(path.sep);
    const absolutePath = existingFile([
      torrentFiles.length === 1 && contentIsFile ? contentPath : '',
      path.join(savePath, relative),
      path.join(contentRoot, relative),
      withoutRoot ? path.join(contentRoot, withoutRoot) : '',
    ], roots);
    return { sourceIndex, relative, absolutePath, size: Number(file.size || 0), progress: Number(file.progress || 0) };
  }).filter(file => file.absolutePath);

  if (contentIsFile && !resolved.some(file => file.absolutePath === contentPath)) {
    resolved.push({ sourceIndex: 0, relative: path.basename(contentPath), absolutePath: contentPath, size: fs.statSync(contentPath).size, progress: 1 });
  }

  const subtitleFiles = resolved.filter(file => SUBTITLE_TYPES.has(path.extname(file.absolutePath).toLowerCase()));
  const videos = resolved.filter(file => VIDEO_EXTENSIONS.has(path.extname(file.absolutePath).toLowerCase()) && file.progress >= .999)
    .sort((left, right) => naturalCompare(left.relative, right.relative))
    .map((file, index) => {
      const directory = path.dirname(file.absolutePath);
      const base = path.basename(file.absolutePath, path.extname(file.absolutePath)).toLowerCase();
      const bundled = subtitleFiles.filter(subtitle => path.dirname(subtitle.absolutePath) === directory && (
        path.basename(subtitle.absolutePath, path.extname(subtitle.absolutePath)).toLowerCase().startsWith(base) || subtitleFiles.length === 1
      ));
      const downloadedDir = path.join(DATA_DIR, 'subtitles', hash, String(index));
      let downloaded = [];
      try {
        downloaded = fs.readdirSync(downloadedDir).map(name => path.join(downloadedDir, name))
          .filter(candidate => SUBTITLE_TYPES.has(path.extname(candidate).toLowerCase()) && fs.statSync(candidate).isFile());
      } catch {}
      return {
        id: String(index), title: path.basename(file.absolutePath, path.extname(file.absolutePath)), size: file.size || fs.statSync(file.absolutePath).size,
        absolutePath: file.absolutePath,
        subtitles: [...bundled.map(subtitle => subtitle.absolutePath), ...downloaded]
          .filter((value, subtitleIndex, all) => all.indexOf(value) === subtitleIndex)
          .map((absolutePath, subtitleIndex) => ({ id: String(subtitleIndex), absolutePath, label: subtitleLabel(absolutePath), language: languageFromSubtitle(path.basename(absolutePath)), mimeType: SUBTITLE_TYPES.get(path.extname(absolutePath).toLowerCase()) })),
      };
    });
  if (!videos.length) throw new Error('No finished movie or episode was found in this download.');
  const rawTitle = String(properties.name || videos[0].title);
  let metadata = null;
  try { metadata = await metadataFor({ title: rawTitle }); } catch {}
  const result = { hash, title: metadata?.title || cleanTitle(rawTitle), metadata, files: videos, cachedAt: Date.now() };
  playbackCache.set(hash, result);
  videos.forEach(queueSegmentAnalysis);
  return result;
}

function publicPlayback(manifest) {
  return {
    ok: true, hash: manifest.hash, title: manifest.title, metadata: manifest.metadata,
    files: manifest.files.map(file => ({
      id: file.id, title: file.title, size: file.size,
      streamPath: `api/playback/stream?hash=${encodeURIComponent(manifest.hash)}&file=${encodeURIComponent(file.id)}`,
      segments: publicSegments(file).items,
      segmentAnalysis: publicSegments(file).analyzing ? 'analyzing' : 'ready',
      subtitles: file.subtitles.map(subtitle => ({
        id: subtitle.id, label: subtitle.label, language: subtitle.language, mimeType: subtitle.mimeType,
        path: `api/playback/subtitle?hash=${encodeURIComponent(manifest.hash)}&file=${encodeURIComponent(file.id)}&subtitle=${encodeURIComponent(subtitle.id)}`,
      })),
    })),
  };
}

async function playbackFile(hashValue, fileValue) {
  const hash = validHash(hashValue);
  const manifest = await playbackFiles(hash);
  const file = manifest.files.find(item => item.id === String(fileValue || '0'));
  if (!file) throw new Error('That movie or episode is no longer available.');
  return { hash, manifest, file };
}

function serveFile(req, res, filePath, contentType) {
  const stat = fs.statSync(filePath);
  const range = String(req.headers.range || '');
  const common = { 'accept-ranges': 'bytes', 'content-type': contentType, 'x-content-type-options': 'nosniff' };
  if (!range) {
    res.writeHead(200, { ...common, 'content-length': stat.size });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(filePath).pipe(res);
  }
  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) { res.writeHead(416, { 'content-range': `bytes */${stat.size}` }); return res.end(); }
  const start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2] || 0));
  const end = match[2] ? Math.min(stat.size - 1, Number(match[2])) : stat.size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= stat.size) {
    res.writeHead(416, { 'content-range': `bytes */${stat.size}` }); return res.end();
  }
  res.writeHead(206, { ...common, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${stat.size}` });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

function openSubtitlesHash(filePath) {
  const size = fs.statSync(filePath).size;
  if (size < 131_072) return '';
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const first = Buffer.alloc(65_536), last = Buffer.alloc(65_536);
    fs.readSync(descriptor, first, 0, first.length, 0);
    fs.readSync(descriptor, last, 0, last.length, size - last.length);
    let hash = BigInt(size);
    for (let offset = 0; offset < first.length; offset += 8) hash = BigInt.asUintN(64, hash + first.readBigUInt64LE(offset) + last.readBigUInt64LE(offset));
    return hash.toString(16).padStart(16, '0');
  } finally { fs.closeSync(descriptor); }
}

async function searchSubtitles(hashValue, fileValue, language = 'en') {
  if (!config.openSubtitlesApiKey) throw new Error('Add an OpenSubtitles API key in Phone Control Settings.');
  const { file } = await playbackFile(hashValue, fileValue);
  const query = new URLSearchParams({ languages: String(language || 'en').slice(0, 10), moviehash: openSubtitlesHash(file.absolutePath) });
  const response = await fetchJson(`https://api.opensubtitles.com/api/v1/subtitles?${query}`, { headers: { 'api-key': config.openSubtitlesApiKey, 'user-agent': `SCREENGLO v${VERSION}`, accept: 'application/json' } });
  const items = (response.data || []).flatMap(item => {
    const attributes = item.attributes || {};
    return (attributes.files || []).slice(0, 1).map(subtitle => ({
      id: Number(subtitle.file_id), language: String(attributes.language || language),
      label: attributes.moviehash_match ? 'Best match' : attributes.from_trusted ? 'Trusted' : 'English',
      release: String(attributes.release || subtitle.file_name || '').slice(0, 150),
      rating: Number(attributes.ratings || 0), downloads: Number(attributes.download_count || 0),
      hearingImpaired: Boolean(attributes.hearing_impaired), exact: Boolean(attributes.moviehash_match),
    }));
  }).filter(item => Number.isInteger(item.id))
    .sort((left, right) => Number(right.exact) - Number(left.exact) || right.rating - left.rating || right.downloads - left.downloads)
    .slice(0, 20);
  return { ok: true, items };
}

async function downloadSubtitle(hashValue, fileValue, subtitleId) {
  if (!config.openSubtitlesApiKey) throw new Error('Add an OpenSubtitles API key in Phone Control Settings.');
  const { hash, file } = await playbackFile(hashValue, fileValue);
  const response = await fetchJson('https://api.opensubtitles.com/api/v1/download', {
    method: 'POST',
    headers: { 'api-key': config.openSubtitlesApiKey, 'user-agent': `SCREENGLO v${VERSION}`, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ file_id: Number(subtitleId), sub_format: 'srt' }),
  });
  if (!response.link) throw new Error('OpenSubtitles did not return that subtitle.');
  const download = await fetch(response.link, { headers: { 'user-agent': `SCREENGLO v${VERSION}` } });
  if (!download.ok) throw new Error(`OpenSubtitles download failed (${download.status}).`);
  let bytes = Buffer.from(await download.arrayBuffer());
  if (download.headers.get('content-encoding') === 'gzip' || bytes.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))) bytes = zlib.gunzipSync(bytes);
  if (!bytes.length || bytes.length > 10_000_000) throw new Error('That subtitle file was invalid.');
  const directory = path.join(DATA_DIR, 'subtitles', hash, file.id);
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `opensubtitles-${Number(subtitleId)}.srt`);
  fs.writeFileSync(target, bytes);
  await playbackFiles(hash, true);
  return { ok: true };
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
      if (String(data.openSubtitlesApiKey || '').trim()) update.openSubtitlesApiKey = String(data.openSubtitlesApiKey).trim();
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
    if (route === 'api/downloads') return json(res, 200, await downloadSnapshot());
    if (route === 'api/downloads/action' && req.method === 'POST') { const data = await body(req); return json(res, 200, await downloadAction(data.id, data.action)); }
    if (route === 'api/playback') return json(res, 200, publicPlayback(await playbackFiles(validHash(url.searchParams.get('hash')))));
    if (route === 'api/playback/segments') {
      const { file } = await playbackFile(url.searchParams.get('hash'), url.searchParams.get('file'));
      queueSegmentAnalysis(file);
      return json(res, 200, publicSegments(file));
    }
    if (route === 'api/playback/stream' && (req.method === 'GET' || req.method === 'HEAD')) {
      const { file } = await playbackFile(url.searchParams.get('hash'), url.searchParams.get('file'));
      return serveFile(req, res, file.absolutePath, mediaType(file.absolutePath));
    }
    if (route === 'api/playback/subtitle' && (req.method === 'GET' || req.method === 'HEAD')) {
      const { file } = await playbackFile(url.searchParams.get('hash'), url.searchParams.get('file'));
      const subtitle = file.subtitles.find(item => item.id === String(url.searchParams.get('subtitle')));
      if (!subtitle) return json(res, 404, { ok: false, message: 'That subtitle is no longer available.' });
      return serveFile(req, res, subtitle.absolutePath, subtitle.mimeType);
    }
    if (route === 'api/subtitles/search') return json(res, 200, await searchSubtitles(url.searchParams.get('hash'), url.searchParams.get('file'), url.searchParams.get('language')));
    if (route === 'api/subtitles/download' && req.method === 'POST') {
      const data = await body(req); return json(res, 200, await downloadSubtitle(data.hash, data.file, data.subtitleId));
    }
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
