const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
let sort = 'seeders', quality = 'any', selected = null, deferredInstall = null, activeView = 'control';
let downloadsLoading = false, downloadsTimer = null, downloadFailures = 0, downloadEvents = null;
let letterboxdLoading = false, letterboxdFilter = 'both', letterboxdItems = [];
let publicListUrl = '', libraryFilter = 'ready', libraryItems = [];
const libraryArt = new Map();
let libraryRenderKey = '';
const downloadActionsInFlight = new Set();
let letterboxdHasMore = false, letterboxdTotal = 0;
let connectionMisses = 0, lastConnectedAt = 0;
let detailReturn = 'results', edgeSwipeStart = null;
let trailerDialog = null, movieDetailRequest = 0;
let navigationStack = [{ view: 'control', mode: 'home', query: '', selectedId: null }], navigationIndex = 0, applyingNavigation = false;
const stateBox = $('#connection'), stateTitle = $('#state-title'), stateCopy = $('#state-copy');
const results = $('#results'), detail = $('#detail'), recommendations = $('#recommendations'), searchStatus = $('#search-status');

async function api(route, options = {}) {
  const response = await fetch(`api/${route}`, { headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.message || 'Request failed');
  return data;
}
function buzz(strong = false) { try { navigator.vibrate?.(strong ? 16 : 7); } catch {} }
function escape(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}
function resetDiscoverHome(clearResults = true) {
  closeTrailer(); movieDetailRequest += 1;
  selected = null;
  detail.classList.add('hidden'); detail.replaceChildren();
  results.classList.add('hidden');
  if (clearResults) results.replaceChildren();
  recommendations.classList.remove('hidden'); searchStatus.textContent = '';
  $('#search-input').value = '';
}
function navigationState(overrides = {}) {
  const mode = !detail.classList.contains('hidden') ? 'detail' : !results.classList.contains('hidden') ? 'results' : 'home';
  return { view: activeView, mode, query: $('#search-input').value, selectedId: selected?.item?.id || null, ...overrides };
}
function rememberNavigation(state = navigationState()) {
  if (applyingNavigation) return;
  const current = navigationStack[navigationIndex];
  if (current && JSON.stringify(current) === JSON.stringify(state)) return;
  navigationStack = navigationStack.slice(0, navigationIndex + 1);
  navigationStack.push(state); navigationIndex = navigationStack.length - 1;
}
async function applyNavigation(state, direction = '') {
  applyingNavigation = true;
  try {
    showView(state.view, false, false, direction);
    if (state.view !== 'discover') return;
    if (state.mode === 'detail' && state.selectedId) {
      if (state.selectedId.startsWith('recommendation:')) {
        if (!letterboxdItems.length) await loadForUs();
        openRecommendation(state.selectedId.slice('recommendation:'.length), false);
      }
      else await openDetail(state.selectedId, false);
    } else if (state.mode === 'results' && results.children.length) {
      selected = null; detail.classList.add('hidden'); detail.replaceChildren();
      recommendations.classList.add('hidden'); results.classList.remove('hidden');
      $('#search-input').value = state.query || ''; searchStatus.textContent = '';
    } else {
      resetDiscoverHome(false);
    }
  } finally { applyingNavigation = false; }
}
function navigateBack() {
  if (cameraDialog) { closeCamera(); return; }
  if (trailerDialog) { closeTrailer(); return; }
  if (navigationIndex <= 0) return;
  navigationIndex -= 1; buzz(); applyNavigation(navigationStack[navigationIndex], 'back');
}
function navigateForward() {
  if (navigationIndex >= navigationStack.length - 1) return;
  navigationIndex += 1; buzz(); applyNavigation(navigationStack[navigationIndex], 'forward');
}
function showView(id, reset = false, record = true, direction = '') {
  if (id !== 'live') stopLiveChannel();
  if (id !== 'live') closeCamera();
  closeTrailer(); movieDetailRequest += 1;
  document.documentElement.classList.remove('nav-back', 'nav-forward');
  if (direction) document.documentElement.classList.add(`nav-${direction}`);
  activeView = id;
  syncCameras();
  $$('.view').forEach(view => view.classList.toggle('active', view.id === id));
  $$('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.view === id));
  if (id === 'discover') { if (reset) resetDiscoverHome(); loadForUs(); loadHistory(); }
  if (id === 'downloads') { loadDownloads(); connectDownloadEvents(); } else clearTimeout(downloadsTimer);
  if (id === 'settings') loadSettings();
  scrollTo({ top: 0, behavior: 'smooth' });
  if (record) rememberNavigation(navigationState({ view: id, mode: reset ? 'home' : navigationState().mode }));
  if (direction) setTimeout(() => document.documentElement.classList.remove(`nav-${direction}`), 340);
}
function stopLiveChannel() {
  livePlayRequest++;
  $('#guide-placeholder').classList.remove('hidden');
  const video = $('#live-video');
  if (!video?.getAttribute('src')) return;
  video.pause(); video.removeAttribute('src'); video.load(); video.classList.add('hidden');
  $('#live-status').textContent = 'Choose a channel';
}
const liveChannels = {
  austin: { name: 'FOX 7 Austin', url: 'https://cdn-uw2-prod.tsv2.amagi.tv/linear/amg00488-foxdigital-ktbc-lgus/playlist.m3u8' },
  sports: { name: 'beIN SPORTS XTRA', url: 'https://bein-xtra-bein.amagi.tv/playlist.m3u8' },
  golazo: { name: 'CBS Sports Golazo', url: 'https://dai.google.com/linear/hls/event/7f3Wv6f7QEKfQna22jHqLQ/master.m3u8' },
  hq: { name: 'CBS Sports HQ', url: 'https://jmp2.uk/plu-5e9f2c05172a0f0007db4786.m3u8' },
  shout: { name: 'Shout! TV', url: 'https://d1s1wrpgemt9re.cloudfront.net/Shout_TV.m3u8' },
};
const austinCameras = [
  { id: 202, name: 'Burleson / McKinney Falls' },
  { id: 181, name: 'US 183 / Burleson' },
  { id: 183, name: 'Burleson / Smith School' },
  { id: 51, name: 'Congress / 2nd · Southwest' },
];
let cameraTimer = null, cameraDialog = null, cameraOpener = null, liveSection = 'channels';
function closeCamera() {
  if (!cameraDialog) return;
  cameraDialog.close(); cameraDialog.remove(); cameraDialog = null;
  cameraOpener?.focus({ preventScroll: true }); cameraOpener = null;
}
function refreshCameras() {
  const images = cameraDialog ? [...cameraDialog.querySelectorAll('[data-camera-image]')] : $$('[data-camera-image]');
  images.forEach(image => {
    image.src = 'https://cctv.austinmobility.io/image/' + image.dataset.cameraImage + '.jpg?t=' + Date.now();
  });
}
function syncCameras() {
  clearInterval(cameraTimer); cameraTimer = null;
  if (activeView !== 'live' || document.hidden || liveSection !== 'austin') return;
  refreshCameras(); cameraTimer = setInterval(refreshCameras, 15000);
}
function cameraImage(camera) {
  const image = document.createElement('img');
  image.alt = camera.name; image.dataset.cameraImage = camera.id;
  image.onload = () => { image.dataset.loading = 'false'; image.nextElementSibling.textContent = camera.name; };
  image.onerror = () => { image.dataset.loading = 'false'; image.nextElementSibling.textContent = camera.name + ' · Unavailable · retrying'; };
  return image;
}
austinCameras.forEach(camera => {
  const button = document.createElement('button'), caption = document.createElement('span');
  button.type = 'button'; button.className = 'camera-card'; caption.textContent = camera.name;
  button.append(cameraImage(camera), caption);
  button.addEventListener('click', () => {
    closeCamera(); cameraOpener = button;
    cameraDialog = document.createElement('dialog'); cameraDialog.className = 'camera-fullscreen';
    cameraDialog.setAttribute('aria-label', camera.name);
    const close = document.createElement('button'), label = document.createElement('span');
    close.textContent = 'Back'; close.className = 'camera-close'; close.addEventListener('click', closeCamera);
    label.textContent = camera.name;
    cameraDialog.append(cameraImage(camera), label, close);
    cameraDialog.addEventListener('cancel', event => { event.preventDefault(); closeCamera(); });
    document.body.append(cameraDialog); cameraDialog.showModal(); refreshCameras();
  });
  $('#austin-grid').append(button);
});
$$('[data-live-section]').forEach(button => button.addEventListener('click', () => {
  liveSection = button.dataset.liveSection;
  stopLiveChannel();
  currentLiveChannel = null;
  $('#guide-channel').textContent = 'Find your channel';
  $('#guide-preview').classList.toggle('hidden', liveSection === 'austin');
  $('#guide-columns').classList.toggle('hidden', liveSection === 'austin');
  $('#live-status').classList.toggle('hidden', liveSection === 'austin');
  $('#live-channels-panel').classList.toggle('hidden', liveSection !== 'channels');
  $('#austin-panel').classList.toggle('hidden', liveSection !== 'austin');
  $('#japan-panel').classList.toggle('hidden', liveSection !== 'japan');
  if (liveSection === 'japan') loadJapanChannels();
  $$('[data-live-section]').forEach(tab => tab.setAttribute('aria-pressed', String(tab === button)));
  syncCameras();
}));
let japanLoadedAt = 0, japanLoading = false, livePlayRequest = 0, currentLiveChannel = null;
function updateGuideClock() { $('#guide-clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
updateGuideClock(); setInterval(updateGuideClock, 30000);
$('#live-refresh').addEventListener('click', async () => {
  const button = $('#live-refresh');
  if (button.getAttribute('aria-busy') === 'true') return;
  button.setAttribute('aria-busy', 'true'); button.querySelector('span').textContent = 'Refreshing…';
  try {
    if (liveSection === 'austin') refreshCameras();
    if (liveSection === 'japan') await loadJapanChannels(true);
    if (currentLiveChannel && activeView === 'live' && liveSection !== 'austin') await playLiveChannel(currentLiveChannel);
    await new Promise(resolve => setTimeout(resolve, 500));
  } finally { button.setAttribute('aria-busy', 'false'); button.querySelector('span').textContent = 'Refresh'; }
});
async function loadJapanChannels(force = false) {
  if (japanLoading || (!force && japanLoadedAt && Date.now() - japanLoadedAt < 3600000)) return;
  japanLoading = true; $('#japan-status').textContent = 'Loading channels…';
  try {
    const response = await fetch('https://iptv-org.github.io/iptv/countries/jp.m3u', { signal: AbortSignal.timeout(12000), cache: force ? 'reload' : 'default' });
    if (!response.ok) throw new Error('Playlist unavailable');
    const text = await response.text();
    if (text.length > 2000000 || !text.trimStart().startsWith('#EXTM3U')) throw new Error('Invalid playlist');
    const channels = [], seen = new Set(); let name = '', category = 'Japan';
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('#EXTINF:')) {
        let quoted = false, separator = -1;
        for (let i = 0; i < line.length; i++) {
          if (line[i] === '"') quoted = !quoted;
          if (line[i] === ',' && !quoted) { separator = i; break; }
        }
        name = separator >= 0 ? line.slice(separator + 1).trim() : '';
        category = line.match(/group-title="([^"]*)"/)?.[1] || 'Japan';
      } else if (line && !line.startsWith('#')) {
        if (name && /^https?:\/\//.test(line) && !seen.has(line)) { channels.push({ name, category, url: line }); seen.add(line); }
        name = '';
      }
    }
    if (!channels.length) throw new Error('Empty playlist');
    const fragment = document.createDocumentFragment();
    channels.slice(0, 500).forEach(channel => {
      const button = document.createElement('button'), small = document.createElement('small'), title = document.createElement('span');
      button.type = 'button'; button.dataset.streamUrl = channel.url; title.textContent = channel.name; button.append(title); small.textContent = channel.category; button.append(small);
      button.addEventListener('click', () => playLiveChannel(channel)); fragment.append(button);
    });
    $('#japan-channels').replaceChildren(fragment); japanLoadedAt = Date.now();
    if (currentLiveChannel && liveSection === 'japan') currentLiveChannel = channels.find(c => c.name === currentLiveChannel.name) || null;
    $('#japan-status').textContent = '';
  } catch { $('#japan-status').textContent = 'Unable to refresh channels. Tap Japan to retry.'; }
  finally { japanLoading = false; }
}
async function playLiveChannel(channel) {
  const video = $('#live-video');
  stopLiveChannel();
  currentLiveChannel = channel;
  $('#guide-channel').textContent = channel.name;
  $$('.live-channels button').forEach(button => button.setAttribute('aria-current', String(button.dataset.streamUrl === channel.url)));
  const request = ++livePlayRequest;
  if (new URL(channel.url).pathname.endsWith('.mpd')) {
    $('#live-status').textContent = 'This channel uses a video format available in the TV app.'; return;
  }
  if (!video.canPlayType('application/vnd.apple.mpegurl')) {
    $('#live-status').textContent = 'This browser needs native HLS playback. Try this page on your iPhone or use Live TV on the television.'; return;
  }
  $('#live-status').textContent = 'Connecting to ' + channel.name + '…';
  video.src = channel.url; video.classList.remove('hidden');
  $('#guide-placeholder').classList.add('hidden');
  $('#guide-preview').scrollIntoView({ behavior: 'smooth', block: 'start' });
  let playTimeout;
  try {
    await Promise.race([video.play(), new Promise((_, reject) => { playTimeout = setTimeout(() => reject(new Error('Timed out')), 12000); })]);
    if (request === livePlayRequest) $('#live-status').textContent = channel.name + ' · LIVE';
  } catch { if (request === livePlayRequest) $('#live-status').textContent = 'Unable to start · tap Play or Refresh'; }
  finally { clearTimeout(playTimeout); }
}
$$('[data-live-channel]').forEach(button => {
  button.dataset.streamUrl = liveChannels[button.dataset.liveChannel].url;
  const title = document.createElement('span'); title.textContent = button.firstChild.textContent;
  button.replaceChild(title, button.firstChild);
  button.addEventListener('click', () => playLiveChannel(liveChannels[button.dataset.liveChannel]));
});
$('#live-video').addEventListener('error', () => { $('#live-status').textContent = 'Channel unavailable. Choose the channel again to retry.'; });
document.addEventListener('visibilitychange', () => { if (document.hidden) $('#live-video').pause(); syncCameras(); });
$$('[data-view]').forEach(button => button.addEventListener('click', () => {
  buzz();
  const target = button.dataset.view;
  showView(target, target === 'discover');
}));

function renderTvContext(tv, requestKeyboard = false) {
  const context = $('#tv-context'), form = $('#tv-input-form'), input = $('#tv-input');
  if (!tv?.foreground) {
    context.classList.remove('hidden');
    $('#tv-context-label').textContent = 'PHONE-ONLY MODE';
    $('#tv-context-title').textContent = 'TV app inactive';
    $('#tv-context-copy').textContent = 'Search and downloads remain available.';
    form.classList.add('hidden');
  } else if (tv.editing) {
    context.classList.remove('hidden');
    const field = tv.field || 'TV field';
    $('#tv-context-label').textContent = 'TV KEYBOARD';
    $('#tv-context-title').textContent = field;
    $('#tv-context-copy').textContent = 'Type or paste below.';
    form.classList.remove('hidden');
    input.placeholder = `Type for ${field}`;
    if (requestKeyboard) { input.focus({ preventScroll: true }); input.setSelectionRange(input.value.length, input.value.length); }
  } else {
    context.classList.add('hidden');
    $('#tv-context-label').textContent = String(tv.screen || 'SCREENGLO').toUpperCase();
    $('#tv-context-title').textContent = 'TV connected';
    $('#tv-context-copy').textContent = 'Select a TV text field to type from this phone.';
    form.classList.add('hidden');
  }
}
async function poll(requestKeyboard = false) {
  try {
    const data = await api('state');
    connectionMisses = 0; lastConnectedAt = Date.now();
    const synced = Boolean(data.tv?.foreground);
    stateBox.classList.toggle('synced', synced);
    stateBox.classList.remove('offline', 'delayed');
    stateTitle.textContent = synced ? 'TV SYNCED' : 'PHONE READY';
    stateCopy.textContent = synced ? `${String(data.tv.screen || 'SCREENGLO').replace('-', ' ')} on TV` : 'TV app inactive';
    renderTvContext(data.tv, requestKeyboard);
    if (data.tv?.selectedId && selected?.item?.id !== data.tv.selectedId) {
      const card = document.querySelector(`[data-id="${CSS.escape(data.tv.selectedId)}"]`);
      if (card) card.click();
    }
  } catch {
    connectionMisses += 1;
    const seconds = lastConnectedAt ? Math.round((Date.now() - lastConnectedAt) / 1000) : null;
    if (connectionMisses < 3) {
      stateBox.classList.add('delayed');
      stateCopy.textContent = seconds === null ? 'Connecting…' : `Last seen ${seconds}s ago`;
      return;
    }
    stateBox.classList.add('offline'); stateBox.classList.remove('synced', 'delayed');
    stateTitle.textContent = 'PC UNAVAILABLE'; stateCopy.textContent = 'Check PC power and home Wi-Fi';
    renderTvContext(null);
  }
}
setInterval(() => poll(), 4000); poll(); connectDownloadEvents();

async function command(action) {
  buzz(action === 'select');
  try {
    const data = await api('command', { method: 'POST', body: JSON.stringify({ action }) });
    if (action === 'select' && data.synced) setTimeout(() => poll(true), 180);
  } catch { stateCopy.textContent = 'Command delayed — trying again'; }
}
$$('[data-command]').forEach(button => {
  let holdDelay, repeatTimer;
  const stop = () => { clearTimeout(holdDelay); clearInterval(repeatTimer); button.classList.remove('pressed'); };
  button.addEventListener('pointerdown', event => {
    event.preventDefault(); button.classList.add('pressed'); command(button.dataset.command);
    if (['up', 'down', 'left', 'right'].includes(button.dataset.command)) {
      holdDelay = setTimeout(() => { repeatTimer = setInterval(() => command(button.dataset.command), 170); }, 380);
    }
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(name => button.addEventListener(name, stop));
});
$('#tv-input-form').addEventListener('submit', async event => {
  event.preventDefault(); const input = $('#tv-input');
  try {
    const data = await api('text', { method: 'POST', body: JSON.stringify({ value: input.value }) });
    if (!data.synced) throw new Error('Select a TV text field first.');
    input.blur(); input.value = ''; $('#tv-context-copy').textContent = 'Sent to TV';
  } catch (error) { $('#tv-context-copy').textContent = error.message; }
});

$$('.sort').forEach(button => button.addEventListener('click', () => {
  sort = button.dataset.sort; $$('.sort').forEach(item => item.classList.toggle('active', item === button));
  if ($('#search-input').value.trim().length >= 2) $('#search-form').requestSubmit();
}));
$$('.quality').forEach(button => button.addEventListener('click', () => {
  quality = button.dataset.quality; $$('.quality').forEach(item => item.classList.toggle('active', item === button));
  if ($('#search-input').value.trim().length >= 2) $('#search-form').requestSubmit();
}));
$('#search-form').addEventListener('submit', async event => {
  event.preventDefault(); const query = $('#search-input').value.trim(); if (query.length < 2) return;
  $('#search-input').blur(); detail.classList.add('hidden'); results.classList.remove('hidden'); results.replaceChildren();
  recommendations.classList.add('hidden'); searchStatus.textContent = 'Searching…';
  try {
    const data = await api('search', { method: 'POST', body: JSON.stringify({ query, sort, quality }) });
    searchStatus.textContent = `${data.total} results · ${sort === 'newest' ? 'newest first' : sort === 'size' ? 'largest first' : 'most seeders first'}`;
    renderResults(data.items);
    rememberNavigation(navigationState({ view: 'discover', mode: 'results', query, selectedId: null }));
  } catch (error) { searchStatus.textContent = error.message; recommendations.classList.remove('hidden'); }
});
$('#search-input').addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  $('#search-form').requestSubmit();
});
function renderResults(items) {
  results.innerHTML = items.map(item => `
    <button class="result" data-id="${escape(item.id)}">
      <h2>${escape(item.title)}</h2>
      <div class="meta"><span>${escape(item.size)}</span><span>${item.seeders} seeders</span><span>${escape(item.date ? new Date(item.date).toLocaleDateString() : 'Date unavailable')}</span></div>
    </button>`).join('');
  $$('.result').forEach(card => card.addEventListener('click', () => openDetail(card.dataset.id)));
}
function memberBadge(name, state) {
  if (!state) return '';
  const icon = state.watched ? 'check' : state.watchlist ? 'bookmark' : 'circle';
  const label = `${name}${state.rating ? ` · ${state.rating}` : state.watchlist ? ' · saved' : ''}`;
  return `<span class="member-badge ${state.watched ? 'watched' : state.watchlist ? 'saved' : 'unwatched'}"><svg class="inline-icon"><use href="#i-${icon}"/></svg>${escape(label)}</span>`;
}
function letterboxdStrip(data) {
  if (!data?.available) return '';
  return `<div class="letterboxd-strip">${data.communityRating ? `<a class="letterboxd-score" href="${escape(data.url || '#')}" target="_blank" rel="noopener"><i></i><i></i><i></i><svg class="inline-icon"><use href="#i-star"/></svg>${escape(data.communityRating)}</a>` : ''}${memberBadge('Tyler', data.tyler)}${memberBadge('Gloria', data.gloria)}</div>`;
}
async function openDetail(id, record = true) {
  const request = ++movieDetailRequest;
  buzz(true); searchStatus.textContent = 'Opening release…';
  try {
    const response = await api('select', { method: 'POST', body: JSON.stringify({ id }) });
    if (request !== movieDetailRequest) return;
    selected = response;
    const item = selected.item, meta = selected.metadata;
    detailReturn = results.children.length ? 'results' : 'home';
    detail.innerHTML = `
      <div class="detail-head"><button class="close" aria-label="Back to ${detailReturn === 'results' ? 'results' : 'Discover'}">← BACK TO ${detailReturn === 'results' ? 'RESULTS' : 'DISCOVER'}</button><small>SWIPE RIGHT TO GO BACK</small></div>
      <div class="detail-grid">
        ${meta?.posterUrl ? `<img class="poster" src="${escape(meta.posterUrl)}" alt="">` : '<div class="poster poster-placeholder">GLO</div>'}
        <div class="detail-copy"><p class="eyebrow">${escape([meta?.year, meta?.mediaType, meta?.runtime ? meta.runtime + ' min' : ''].filter(Boolean).join(' · '))}</p>
          <h1>${escape(meta?.title || item.title)}</h1>${letterboxdStrip(selected.letterboxd)}
          <p class="overview">${escape(meta?.overview || 'Movie information is unavailable, but this release is ready to download.')}</p>
        </div>
      </div>
      <div class="release-facts"><span>${escape(item.size)}</span><span>${item.seeders} seeders</span><span>${escape(item.date ? new Date(item.date).toLocaleDateString() : 'Date unavailable')}</span></div>
      <div class="movie-media"></div><button class="download-now">DOWNLOAD</button>`;
    detail.classList.remove('hidden'); results.classList.add('hidden');
    detail.querySelector('.close').addEventListener('click', closeDetail);
    detail.querySelector('.download-now').addEventListener('click', downloadSelected);
    renderMovieMedia(meta);
    searchStatus.textContent = ''; detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (record) rememberNavigation(navigationState({ view: 'discover', mode: 'detail', selectedId: id }));
  } catch (error) { if (request === movieDetailRequest) searchStatus.textContent = error.message; }
}
function renderMovieMedia(meta, failed = false) {
  const host = detail.querySelector('.movie-media');
  if (!host) return;
  failed = failed || !meta;
  const trailers = (meta?.trailers || []).filter(x => /^[a-zA-Z0-9_-]{11}$/.test(x.youtubeId));
  host.innerHTML = `${meta?.backdropUrl ? `<img class="movie-backdrop" src="${escape(meta.backdropUrl)}" alt="" loading="lazy">` : ''}${trailers.length ? '<button class="watch-trailer"><svg class="inline-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7Z"/></svg>Watch trailer</button>' : `<span class="media-status">${failed ? 'Movie extras unavailable' : 'No trailer available'}</span>`}`;
  if (failed && selected?.recommendation) {
    const retry = document.createElement('button'); retry.className = 'media-retry'; retry.textContent = 'Retry';
    retry.onclick = () => { if (selected?.recommendation) openRecommendation(recommendationId(selected.recommendation), false); };
    host.append(retry);
  }
  host.querySelector('.watch-trailer')?.addEventListener('click', () => openTrailer(trailers, meta.title));
}
function closeTrailer() {
  if (!trailerDialog) return;
  const modal = trailerDialog; trailerDialog = null;
  modal.querySelector('iframe')?.remove(); // Destroy playback before returning to the movie.
  modal.close(); modal.remove(); document.body.classList.remove('trailer-open');
}
function openTrailer(trailers, title) {
  closeTrailer();
  const modal = document.createElement('dialog'); modal.className = 'trailer-dialog'; modal.setAttribute('aria-label', `${title || 'Movie'} trailer`);
  modal.innerHTML = `<div class="trailer-toolbar"><select aria-label="Choose trailer">${trailers.map((item, index) => `<option value="${index}">${escape(item.name || 'Trailer')}</option>`).join('')}</select><button class="trailer-close" aria-label="Close trailer"><svg class="icon"><use href="#i-close"/></svg></button></div><div class="trailer-frame"></div>`;
  const play = index => {
    const trailer = trailers[index]; if (!trailer) return;
    const frame = document.createElement('iframe'); frame.title = trailer.name || `${title} trailer`;
    frame.src = `https://www.youtube.com/embed/${trailer.youtubeId}?autoplay=1&playsinline=1&rel=0`;
    frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen'; frame.allowFullscreen = true;
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    modal.querySelector('.trailer-frame').replaceChildren(frame);
  };
  modal.querySelector('select').addEventListener('change', event => play(Number(event.target.value)));
  modal.querySelector('.trailer-close').addEventListener('click', closeTrailer);
  modal.addEventListener('cancel', event => { event.preventDefault(); closeTrailer(); });
  modal.addEventListener('click', event => { if (event.target === modal) closeTrailer(); });
  document.body.append(modal); trailerDialog = modal; document.body.classList.add('trailer-open'); modal.showModal(); play(0);
  modal.querySelector('.trailer-close').focus();
}
// Don't leave a trailer sounding in the background when the phone is locked or switched away.
document.addEventListener('visibilitychange', () => { if (document.hidden) closeTrailer(); });

function closeDetail() {
  closeTrailer(); movieDetailRequest += 1;
  if (detail.classList.contains('hidden')) return;
  if (!applyingNavigation && navigationIndex > 0) { navigateBack(); return; }
  selected = null; detail.classList.add('hidden'); detail.replaceChildren(); searchStatus.textContent = '';
  if (detailReturn === 'results' && results.children.length) {
    results.classList.remove('hidden'); recommendations.classList.add('hidden');
    results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    results.classList.add('hidden'); recommendations.classList.remove('hidden');
    recommendations.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
document.addEventListener('pointerdown', event => {
  if (!event.isPrimary) return;
  const edge = event.clientX <= 34 ? 'back' : event.clientX >= window.innerWidth - 34 ? 'forward' : null;
  edgeSwipeStart = edge ? { edge, x: event.clientX, y: event.clientY } : null;
});
document.addEventListener('pointerup', event => {
  if (!edgeSwipeStart || !event.isPrimary) return;
  const gesture = edgeSwipeStart;
  const dx = event.clientX - gesture.x, dy = Math.abs(event.clientY - gesture.y);
  edgeSwipeStart = null;
  if (dy > 72) return;
  if (gesture.edge === 'back' && dx >= 72) navigateBack();
  if (gesture.edge === 'forward' && dx <= -72) navigateForward();
});
async function downloadSelected() {
  const button = detail.querySelector('.download-now'); button.disabled = true; button.textContent = 'SENDING…';
  try {
    const data = await api('download', { method: 'POST', body: JSON.stringify({ id: selected.item.id }) });
    button.textContent = 'ADDED'; searchStatus.textContent = data.message; setTimeout(() => showView('downloads'), 600);
  } catch (error) { button.disabled = false; button.textContent = 'TRY AGAIN'; searchStatus.textContent = error.message; }
}

function downloadPrimary(item) {
  if (item.complete) return null;
  if (['stoppedDL', 'pausedDL', 'stoppedUP'].includes(item.state)) return ['resume', 'RESUME'];
  if (['error', 'missingFiles'].includes(item.state)) return ['retry', 'RETRY'];
  if (!item.complete) return ['pause', 'PAUSE'];
  return null;
}
function renderDownloads(items) {
  libraryItems = items;
  items = items.filter(item => Boolean(item.complete) === (libraryFilter === 'ready'));
  const renderKey = libraryFilter + JSON.stringify(items);
  if (renderKey === libraryRenderKey) return;
  libraryRenderKey = renderKey;
  const focused = document.activeElement;
  const focusedId = focused?.closest?.('[data-download-id]')?.dataset.downloadId;
  const focusedAction = focused?.dataset?.downloadAction;
  const openCards = new Set($$('#download-list details[open]').map(details => details.closest('[data-download-id]').dataset.downloadId));
  $('#download-list').innerHTML = items.map(item => {
    const primary = downloadPrimary(item);
    return `<article class="download ${item.complete ? 'complete' : ''}" data-download-id="${escape(item.id)}">
      <div class="download-head">${item.complete ? '<img class="library-art" alt="" hidden>' : ''}<div><h2>${escape(item.title)}</h2><div class="meta"><strong>${escape(item.complete ? 'READY TO WATCH' : item.status)}</strong>${item.complete ? '' : ' · ' + item.progress + '% · ' + escape(item.speed)}</div></div></div>
      <div class="track"><div class="fill" style="width:${item.progress}%"></div></div>
      <div class="download-actions">${primary ? `<button data-download-action="${primary[0]}">${primary[1]}</button>` : ''}
        <details><summary>MORE</summary><div><button data-download-action="remove">REMOVE · KEEP FILES</button><button class="danger" data-download-action="delete">DELETE FILES</button></div></details>
      </div></article>`;
  }).join('');
  if (!items.length) $('#download-list').textContent = libraryFilter === 'ready' ? 'Nothing ready yet.' : 'No active downloads.';
  $$('.library-art').forEach(image => {
    const item = items.find(item => item.id === image.closest('[data-download-id]').dataset.downloadId);
    if (!item) return;
    if (!libraryArt.has(item.title)) {
      if (libraryArt.size >= 100) libraryArt.delete(libraryArt.keys().next().value);
      libraryArt.set(item.title, api(`metadata?${new URLSearchParams({ title: item.title })}`).then(data => data.metadata?.posterUrl || '').catch(() => ''));
    }
    libraryArt.get(item.title).then(url => { if (url && image.isConnected) { image.src = url; image.hidden = false; } });
  });
  $$('[data-download-action]').forEach(button => button.addEventListener('click', () => {
    const card = button.closest('[data-download-id]'); runDownloadAction(card.dataset.downloadId, button.dataset.downloadAction, button);
  }));
  $$('#download-list [data-download-id]').forEach(card => {
    if (openCards.has(card.dataset.downloadId)) card.querySelector('details').open = true;
    card.querySelectorAll('[data-download-action]').forEach(button => {
      button.disabled = downloadActionsInFlight.has(card.dataset.downloadId);
      if (card.dataset.downloadId === focusedId && button.dataset.downloadAction === focusedAction) button.focus({ preventScroll: true });
    });
  });
}
$$('.library-filter').forEach(button => button.addEventListener('click', () => {
  libraryFilter = button.dataset.library;
  $$('.library-filter').forEach(item => item.classList.toggle('active', item === button));
  renderDownloads(libraryItems);
}));
async function runDownloadAction(id, action, button) {
  if (downloadActionsInFlight.has(id)) return;
  if (action === 'remove' || action === 'delete') {
    const message = action === 'delete' ? 'Delete this torrent and its downloaded movie files? This cannot be undone.' : 'Remove this torrent from qBittorrent but keep its movie files?';
    if (!confirm(message)) return;
  }
  downloadActionsInFlight.add(id);
  const original = button.textContent; button.disabled = true; button.textContent = 'WORKING…';
  try {
    await api('downloads/action', { method: 'POST', body: JSON.stringify({ id, action }) }); await loadDownloads(true);
  } catch (error) { button.disabled = false; button.textContent = original; $('#download-status').textContent = error.message; }
  finally { downloadActionsInFlight.delete(id); libraryRenderKey = ''; renderDownloads(libraryItems); }
}
async function loadDownloads(silent = false) {
  if (downloadsLoading) return; downloadsLoading = true;
  const list = $('#download-list'), status = $('#download-status');
  if (!silent && !list.children.length) status.textContent = 'Loading your downloads…';
  try {
    renderDownloadSnapshot(await api('downloads'));
  } catch (error) {
    downloadFailures += 1;
    if (downloadFailures >= 3 || !list.children.length) status.textContent = `Updates delayed · ${error.message}`;
    if (activeView === 'downloads') scheduleDownloads(Math.min(30000, 4000 * downloadFailures));
  } finally { downloadsLoading = false; }
}
function renderDownloadSnapshot(data) {
  downloadFailures = 0;
  const status = $('#download-status'), qbitState = data.qbit?.state || 'ready';
  if (qbitState === 'sleeping') status.textContent = 'qBit is napping · open it on the PC when you’re ready';
  else if (qbitState === 'auth') status.textContent = 'qBit needs its key · check Settings';
  else if (qbitState === 'setup') status.textContent = 'Finish qBit setup in Settings';
  else if (qbitState === 'problem') status.textContent = 'qBit needs a moment · check the PC';
  else if (qbitState === 'checking' && !data.items.length) status.textContent = 'Checking qBit…';
  else status.textContent = data.items.length ? `LIVE · ${data.items.length} download${data.items.length === 1 ? '' : 's'} · newest first` : 'No downloads yet';
  renderDownloads(data.items);
}
function connectDownloadEvents() {
  if (downloadEvents || !window.EventSource) return;
  downloadEvents = new EventSource('api/events');
  downloadEvents.addEventListener('downloads', event => {
    if (activeView !== 'downloads') return;
    try { renderDownloadSnapshot(JSON.parse(event.data)); } catch {}
  });
  downloadEvents.addEventListener('playback', event => {
    try { renderNowPlaying(JSON.parse(event.data).playback); } catch {}
  });
  downloadEvents.addEventListener('history', event => {
    if (activeView === 'discover') try { renderHistory(JSON.parse(event.data).items || []); } catch {}
  });
  downloadEvents.onerror = () => {
    if (activeView === 'downloads') scheduleDownloads(12_000);
  };
}
function formatClock(milliseconds) {
  const seconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
function renderNowPlaying(playback) {
  const card = $('#now-playing');
  if (!playback?.active) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  $('#now-playing-title').textContent = playback.episode || playback.title;
  $('#now-playing-time').textContent = `${playback.playing ? 'PLAYING' : 'PAUSED'} · ${formatClock(playback.position)} / ${formatClock(playback.duration)}`;
  $('#now-playing-progress').style.width = `${playback.duration ? Math.min(100, playback.position / playback.duration * 100) : 0}%`;
  const poster = $('#now-playing-poster');
  poster.classList.toggle('hidden', !playback.posterUrl); if (playback.posterUrl) poster.src = playback.posterUrl;
}
function renderHistory(items) {
  $('#history-status').textContent = items.length ? `${items.length} watched in SCREENGLO` : 'Nothing watched internally yet';
  $('#history-list').innerHTML = items.slice(0, 20).map(item => `<article class="history-item" data-history-key="${escape(item.key)}">
    ${item.posterUrl ? `<img src="${escape(item.posterUrl)}" alt="">` : '<div class="history-poster"></div>'}
    <div><strong>${escape(item.title)}</strong><small>${escape(item.seriesTitle && item.seriesTitle !== item.title ? item.seriesTitle + ' · ' : '')}${new Date(item.watchedAt).toLocaleDateString()}${item.playCount > 1 ? ` · ${item.playCount} plays` : ''}</small></div>
    <button data-history-remove aria-label="Remove from history"><svg class="icon"><use href="#i-close"/></svg></button></article>`).join('');
  $$('[data-history-remove]').forEach(button => button.addEventListener('click', async () => {
    const card = button.closest('[data-history-key]');
    await api('history/action', { method: 'POST', body: JSON.stringify({ action: 'remove', key: card.dataset.historyKey }) });
    card.remove();
  }));
}
async function loadHistory() {
  try { renderHistory((await api('history')).items || []); }
  catch (error) { $('#history-status').textContent = error.message; }
}
function scheduleDownloads(delay) {
  clearTimeout(downloadsTimer);
  downloadsTimer = setTimeout(() => { if (activeView === 'downloads' && !document.hidden) loadDownloads(true); }, delay);
}
$('#refresh').addEventListener('click', () => loadDownloads());
document.addEventListener('visibilitychange', () => { if (activeView === 'downloads' && !document.hidden) loadDownloads(true); });

let remoteSwipeStart = null;
const remoteSurface = document.querySelector('.remote-card');
remoteSurface.addEventListener('pointerdown', event => {
  if (event.target.closest('button')) return;
  remoteSwipeStart = { x: event.clientX, y: event.clientY };
});
remoteSurface.addEventListener('pointerup', event => {
  if (!remoteSwipeStart) return;
  const dx = event.clientX - remoteSwipeStart.x, dy = event.clientY - remoteSwipeStart.y;
  remoteSwipeStart = null;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 26) return command('select');
  command(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
});

function savedByText(item) {
  if (item.savedBy?.length === 2) return 'BOTH SAVED';
  if (item.savedBy?.includes('tyler')) return 'TYLER SAVED';
  if (item.savedBy?.includes('gloria')) return 'GLORIA SAVED';
  return 'CURATED LIST';
}
function findRelease(title) { $('#search-input').value = title; recommendations.classList.add('hidden'); $('#search-form').requestSubmit(); }
function recommendationId(item) { return item.slug || `${item.title}-${item.year || ''}`.toLowerCase().replace(/[^a-z0-9]+/g, '-'); }
function openRecommendation(id, record = true) {
  const item = letterboxdItems.find(candidate => recommendationId(candidate) === id);
  if (!item) return;
  const request = ++movieDetailRequest;
  buzz(true);
  selected = { item: { id: `recommendation:${id}`, title: item.title }, recommendation: item };
  detailReturn = 'home';
  const source = savedByText(item);
  const lists = item.sources?.length ? ` · ${item.sources.join(' · ')}` : '';
  detail.innerHTML = `
    <div class="detail-head"><button class="close" aria-label="Back to What to Watch">← BACK TO PICKS</button><small>SWIPE RIGHT TO GO BACK</small></div>
    <div class="detail-grid">
      ${item.posterUrl ? `<img class="poster" src="${escape(item.posterUrl)}" alt="">` : '<div class="poster poster-placeholder">GLO</div>'}
      <div class="detail-copy"><p class="eyebrow">${escape([item.year, item.communityRating ? `LETTERBOXD ${item.communityRating}` : ''].filter(Boolean).join(' · '))}</p>
        <h1>${escape(item.title)}</h1><p class="recommendation-source">${escape(source + lists)}</p>
        <p class="overview">${escape(item.overview || 'Movie details are still being gathered.')}</p>
      </div>
    </div>
    <div class="movie-media" aria-live="polite"><span class="media-status">Loading movie extras…</span></div>
    <button class="download-now recommendation-download">CHOOSE DOWNLOAD</button>`;
  detail.classList.remove('hidden'); results.classList.add('hidden'); recommendations.classList.add('hidden');
  detail.querySelector('.close').addEventListener('click', closeDetail);
  detail.querySelector('.recommendation-download').addEventListener('click', () => findRelease([item.title, item.year].filter(Boolean).join(' ')));
  api(`metadata?${new URLSearchParams({ tmdbId: item.tmdbId || '', title: item.title, year: item.year || '', type: 'movie' })}`).then(data => {
    if (request !== movieDetailRequest || selected?.item?.id !== `recommendation:${id}`) return;
    const meta = data.metadata;
    if (meta?.overview) detail.querySelector('.overview').textContent = meta.overview;
    if (meta?.posterUrl) {
      const poster = document.createElement('img'); poster.className = 'poster'; poster.alt = ''; poster.src = meta.posterUrl;
      detail.querySelector('.poster')?.replaceWith(poster);
    }
    renderMovieMedia(meta);
  }).catch(() => {
    if (request === movieDetailRequest) renderMovieMedia(null, true);
  });
  detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (record) rememberNavigation(navigationState({ view: 'discover', mode: 'detail', selectedId: `recommendation:${id}` }));
}
async function loadForUs(force = false, append = false) {
  if (letterboxdFilter === 'curated' && !publicListUrl) return showPublicLists();
  if (letterboxdLoading) return; letterboxdLoading = true;
  const status = $('#letterboxd-status'), list = $('#letterboxd-list'), more = $('#letterboxd-more');
  if (!list.children.length) status.textContent = 'Mixing your watchlists…';
  else if (append) status.textContent = 'Finding more movies…';
  more.disabled = true;
  try {
    if (force) await api('letterboxd/sync', { method: 'POST', body: '{}' });
    const offset = append ? letterboxdItems.length : 0;
    const data = await api(`letterboxd/discover?filter=${encodeURIComponent(letterboxdFilter)}&limit=24&offset=${offset}${publicListUrl ? '&list=' + encodeURIComponent(publicListUrl) : ''}`);
    letterboxdItems = append ? [...letterboxdItems, ...data.items].filter((item, index, values) => values.findIndex(other => recommendationId(other) === recommendationId(item)) === index) : data.items;
    letterboxdHasMore = Boolean(data.hasMore); letterboxdTotal = Number(data.total || letterboxdItems.length);
    status.textContent = letterboxdItems.length ? `${letterboxdItems.length} of ${letterboxdTotal} ${publicListUrl ? 'films in this list' : 'unwatched picks'}${data.status?.degraded ? ' · using saved data for one list' : ''}` : data.status?.syncing ? 'First sync is still running…' : 'No films found in this category.';
    list.innerHTML = letterboxdItems.map(item => `<article class="letterboxd-film" data-recommendation="${escape(recommendationId(item))}">
      ${item.posterUrl ? `<img src="${escape(item.posterUrl)}" alt="">` : '<div class="letterboxd-placeholder">GLO</div>'}
      <div class="letterboxd-copy"><small>${savedByText(item)}</small><h2>${escape(item.title)}${item.year ? ` <span>${escape(item.year)}</span>` : ''}</h2>
      <p>${item.communityRating ? `Letterboxd ${escape(item.communityRating)} · ` : ''}${escape(item.overview || 'Open for details.')}</p><button class="open-recommendation" data-recommendation="${escape(recommendationId(item))}">MORE</button></div></article>`).join('');
    $$('.open-recommendation').forEach(button => button.addEventListener('click', () => openRecommendation(button.dataset.recommendation)));
    more.classList.toggle('hidden', !letterboxdHasMore);
    more.textContent = letterboxdHasMore ? `MORE MOVIES · ${Math.max(0, letterboxdTotal - letterboxdItems.length)} LEFT` : 'ALL PICKS LOADED';
  } catch (error) { status.textContent = error.message; }
  finally { letterboxdLoading = false; more.disabled = false; }
}
$$('.letterboxd-filter').forEach(button => button.addEventListener('click', () => {
  if (letterboxdLoading) return;
  publicListUrl = '';
  $('#public-lists').classList.toggle('hidden', button.dataset.letterboxdFilter !== 'curated');
  letterboxdFilter = button.dataset.letterboxdFilter; letterboxdItems = []; $('#letterboxd-list').replaceChildren(); $$('.letterboxd-filter').forEach(item => item.classList.toggle('active', item === button)); loadForUs();
}));
async function showPublicLists() {
  $('#letterboxd-more').classList.add('hidden'); $('#letterboxd-list').replaceChildren();
  $('#back-to-lists').classList.add('hidden'); $('#public-list-catalog').classList.remove('hidden');
  $('#letterboxd-status').textContent = 'Loading public lists…';
  try {
    const data = await api('letterboxd/lists');
    $('#letterboxd-status').textContent = 'Public Letterboxd lists';
    $('#public-list-catalog').innerHTML = data.items.map(item => `<button type="button" data-public-list="${escape(item.url)}">${escape(item.title)} · ${escape(item.owner)}</button>`).join('');
    $$('[data-public-list]').forEach(button => button.addEventListener('click', () => openPublicList(button.dataset.publicList)));
  } catch (error) { $('#letterboxd-status').textContent = error.message; }
}
function openPublicList(url) {
  if (letterboxdLoading) return;
  publicListUrl = url; letterboxdItems = [];
  $('#public-list-catalog').classList.add('hidden'); $('#back-to-lists').classList.remove('hidden');
  loadForUs();
}
$('#back-to-lists').addEventListener('click', () => { if (letterboxdLoading) return; publicListUrl = ''; showPublicLists(); });
$('#letterboxd-sync').addEventListener('click', () => loadForUs(true));
$('#letterboxd-more').addEventListener('click', () => loadForUs(false, true));
$('#letterboxd-random').addEventListener('click', () => {
  if (!letterboxdItems.length) return loadForUs();
  openRecommendation(recommendationId(letterboxdItems[Math.floor(Math.random() * letterboxdItems.length)]));
});

async function loadSettings() {
  try {
    const data = await api('config'), config = data.config;
    $('#qbit-host').value = config.qbitHost; $('#qbit-port').value = config.qbitPort; $('#qbit-https').checked = config.qbitHttps; $('#category').value = config.category;
    $('#qbit-key').placeholder = config.hasQbitKey ? 'Saved securely — enter only to replace' : 'qbt_…';
    $('#tmdb-token').placeholder = config.hasTmdbToken ? 'Saved securely — enter only to replace' : 'TMDB read token';
    $('#opensubtitles-key').placeholder = config.hasOpenSubtitlesKey ? 'Saved securely — enter only to replace' : 'Free API key from opensubtitles.com';
    $('#letterboxd-tyler').value = config.letterboxdTyler || 'xMATLOCKx'; $('#letterboxd-gloria').value = config.letterboxdGloria || 'gloriaileana'; $('#letterboxd-lists').value = config.letterboxdLists || '';
    const lb = config.letterboxd;
    $('#letterboxd-settings-status').textContent = lb?.updatedAt ? `Synced ${new Date(lb.updatedAt).toLocaleString()} · Tyler ${lb.users.tyler.watched} watched · Gloria ${lb.users.gloria.watched} watched` : 'Public watchlists will sync after saving.';
    $('#companion-version').textContent = `v${data.products?.windowsCompanion || data.version} · running on this PC`;
    $('#phone-version').textContent = `v${data.products?.phoneControl || data.version} · updates with Windows Companion`;
    const tvProduct = $('#tv-product');
    tvProduct.classList.toggle('offline', !data.products?.tvConnected);
    $('#tv-version').textContent = data.products?.tvApp
      ? `v${data.products.tvApp} · ${data.products.tvConnected ? 'connected now' : 'last seen; currently offline'}`
      : 'Not reported yet · TV updates separately';
    checkUpdate(true);
  } catch (error) { $('#settings-status').textContent = error.message; }
}
async function checkUpdate(silent = false) {
  const button = $('#update-companion'), copy = $('#update-copy'); button.disabled = true;
  if (!silent) copy.textContent = 'Checking the secure SCREENGLO release channel…';
  try {
    const data = await api('update/check');
    if (data.available) { button.dataset.action = 'install'; button.textContent = `UPDATE TO ${data.latestVersion}`; copy.textContent = data.notes || 'A verified companion update is ready.'; }
    else { button.dataset.action = 'check'; button.textContent = 'CHECK AGAIN'; copy.textContent = `You have the latest version (${data.currentVersion}).`; }
  } catch (error) { button.dataset.action = 'check'; button.textContent = 'TRY AGAIN'; copy.textContent = `Update check unavailable: ${error.message}`; }
  finally { button.disabled = false; }
}
$('#update-companion').addEventListener('click', async () => {
  const button = $('#update-companion'), copy = $('#update-copy');
  if (button.dataset.action !== 'install') return checkUpdate();
  button.disabled = true; button.textContent = 'VERIFYING…'; copy.textContent = 'Downloading and verifying the signed update…';
  try {
    const data = await api('update/install', { method: 'POST', body: '{}' }); button.textContent = data.restarting ? 'RESTARTING…' : 'UP TO DATE'; copy.textContent = data.message; setTimeout(() => location.reload(), 6500);
  } catch (error) { button.disabled = false; button.textContent = 'TRY AGAIN'; copy.textContent = error.message; }
});
async function saveSettings(section = 'downloads') {
  const metadata = section === 'metadata';
  const status = metadata ? $('#letterboxd-settings-status') : $('#settings-status');
  const button = metadata ? $('#save-metadata') : $('#settings-form button[type="submit"]');
  const original = button.textContent;
  button.disabled = true; button.classList.add('saving'); button.textContent = 'SAVING…'; status.textContent = metadata ? 'Checking and saving your public lists…' : 'Saving securely…';
  const payload = {
    qbitHost: $('#qbit-host').value.trim(), qbitPort: Number($('#qbit-port').value), qbitHttps: $('#qbit-https').checked,
    qbitApiKey: $('#qbit-key').value.trim(), tmdbToken: $('#tmdb-token').value.trim(), openSubtitlesApiKey: $('#opensubtitles-key').value.trim(), category: $('#category').value.trim(),
    letterboxdTyler: $('#letterboxd-tyler').value.trim(), letterboxdGloria: $('#letterboxd-gloria').value.trim(), letterboxdLists: $('#letterboxd-lists').value.trim(),
  };
  try {
    const saved = await api('config', { method: 'POST', body: JSON.stringify(payload) });
    $('#qbit-key').value = ''; $('#tmdb-token').value = ''; $('#opensubtitles-key').value = '';
    if (metadata) {
      const counts = saved.letterboxdSave || { submitted: 0, saved: 0, rejected: 0, duplicates: 0 };
      $('#letterboxd-lists').value = saved.config.letterboxdLists || '';
      button.textContent = 'SAVED'; button.classList.add('saved');
      status.textContent = counts.rejected
        ? `Saved ${counts.saved} list${counts.saved === 1 ? '' : 's'} · ${counts.rejected} URL${counts.rejected === 1 ? '' : 's'} not recognized`
        : `Saved ${counts.saved} public list${counts.saved === 1 ? '' : 's'}${counts.duplicates ? ` · ${counts.duplicates} duplicate removed` : ''} · syncing now`;
      api('letterboxd/sync', { method: 'POST', body: '{}' }).then(() => {
        status.textContent = `Saved ${counts.saved} public list${counts.saved === 1 ? '' : 's'} · sync complete`;
      }).catch(() => { status.textContent += ' · sync will retry automatically'; });
    } else {
      const test = await api('test', { method: 'POST', body: '{}' });
      status.textContent = `Connected to qBittorrent ${test.version}`; button.textContent = 'SAVED + CONNECTED'; button.classList.add('saved');
    }
  } catch (error) { status.textContent = error.message; button.textContent = 'TRY AGAIN'; }
  finally {
    button.disabled = false; button.classList.remove('saving');
    setTimeout(() => { button.classList.remove('saved'); if (button.textContent !== 'TRY AGAIN') button.textContent = original; }, 1800);
  }
}
$('#settings-form').addEventListener('submit', event => { event.preventDefault(); saveSettings('downloads'); });
$('#save-metadata').addEventListener('click', () => saveSettings('metadata'));
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); deferredInstall = event; $('#install').classList.remove('hidden'); });
$('#install').addEventListener('click', async () => {
  if (!deferredInstall) return; deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; $('#install').classList.add('hidden');
});
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
