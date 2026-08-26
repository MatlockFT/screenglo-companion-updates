import fs from 'node:fs';
import path from 'node:path';

const LETTERBOXD_ORIGIN = 'https://letterboxd.com';
const CACHE_VERSION = 1;
const MAX_COLLECTION_PAGES = 50;
const COLLECTION_TTL = 12 * 60 * 60 * 1000;
const RATING_TTL = 7 * 24 * 60 * 60 * 1000;
const TMDB_TTL = 30 * 24 * 60 * 60 * 1000;
const politePause = (milliseconds = 220) => new Promise(resolve => setTimeout(resolve, milliseconds));

export function normalizeFilmKey(title, year = '') {
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

export function parseFilmGrid(html) {
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

export function parsePageCount(html) {
  let pages = 1;
  for (const match of String(html || '').matchAll(/\/page\/(\d+)\//g)) pages = Math.max(pages, Number(match[1]) || 1);
  return Math.min(MAX_COLLECTION_PAGES, pages);
}

function xmlText(block, name) {
  const match = block.match(new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${name}>`, 'i'));
  return match ? decodeHtml(match[1]).trim() : '';
}

export function parseRss(xml) {
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

export function parseCommunityRating(html) {
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

export class LetterboxdService {
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

  async discovery(filter = 'all') {
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
    const selected = candidates.slice(0, 24);
    const enriched = await Promise.all(selected.map(async item => ({ item, metadata: await this.tmdbMovie(item) })));
    this.persist();
    return {
      status: this.status(),
      items: enriched.map(({ item, metadata }) => ({
        title: item.title, year: metadata?.year || item.year, slug: item.slug, url: item.url,
        tmdbId: metadata?.tmdbId || '', posterUrl: metadata?.posterUrl || '', overview: metadata?.overview || '',
        savedBy: item.savedBy, curated: Boolean(item.curatedBy.length),
        communityRating: this.state.community[metadata?.tmdbId || item.slug]?.rating ?? null,
      })),
    };
  }
}

export function normalizeLetterboxdConfig(value = {}) {
  return {
    letterboxdTyler: safeUsername(value.letterboxdTyler, 'xMATLOCKx'),
    letterboxdGloria: safeUsername(value.letterboxdGloria, 'gloriaileana'),
    letterboxdLists: String(value.letterboxdLists || '').split(/[\n,]+/).map(publicListUrl).filter(Boolean).slice(0, 8),
  };
}
