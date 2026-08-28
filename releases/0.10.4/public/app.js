const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
let sort = 'seeders', selected = null, deferredInstall = null, activeView = 'control';
let downloadsLoading = false, downloadsTimer = null, downloadFailures = 0;
let letterboxdLoading = false, letterboxdFilter = 'all', letterboxdItems = [];
let connectionMisses = 0, lastConnectedAt = 0;
let detailReturn = 'results', edgeSwipeStart = null;
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
      await openDetail(state.selectedId, false);
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
  if (navigationIndex <= 0) return;
  navigationIndex -= 1; buzz(); applyNavigation(navigationStack[navigationIndex], 'back');
}
function navigateForward() {
  if (navigationIndex >= navigationStack.length - 1) return;
  navigationIndex += 1; buzz(); applyNavigation(navigationStack[navigationIndex], 'forward');
}
function showView(id, reset = false, record = true, direction = '') {
  document.documentElement.classList.remove('nav-back', 'nav-forward');
  if (direction) document.documentElement.classList.add(`nav-${direction}`);
  activeView = id;
  $$('.view').forEach(view => view.classList.toggle('active', view.id === id));
  $$('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.view === id));
  if (id === 'discover') { if (reset) resetDiscoverHome(); loadForUs(); }
  if (id === 'downloads') { loadDownloads(); scheduleDownloads(2000); } else clearTimeout(downloadsTimer);
  if (id === 'settings') loadSettings();
  scrollTo({ top: 0, behavior: 'smooth' });
  if (record) rememberNavigation(navigationState({ view: id, mode: reset ? 'home' : navigationState().mode }));
  if (direction) setTimeout(() => document.documentElement.classList.remove(`nav-${direction}`), 340);
}
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
setInterval(() => poll(), 4000); poll();

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
$('#search-form').addEventListener('submit', async event => {
  event.preventDefault(); const query = $('#search-input').value.trim(); if (query.length < 2) return;
  $('#search-input').blur(); detail.classList.add('hidden'); results.classList.remove('hidden'); results.replaceChildren();
  recommendations.classList.add('hidden'); searchStatus.textContent = 'Searching…';
  try {
    const data = await api('search', { method: 'POST', body: JSON.stringify({ query, sort }) });
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
  buzz(true); searchStatus.textContent = 'Opening release…';
  try {
    selected = await api('select', { method: 'POST', body: JSON.stringify({ id }) });
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
      <button class="download-now">DOWNLOAD</button>`;
    detail.classList.remove('hidden'); results.classList.add('hidden');
    detail.querySelector('.close').addEventListener('click', closeDetail);
    detail.querySelector('.download-now').addEventListener('click', downloadSelected);
    searchStatus.textContent = ''; detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (record) rememberNavigation(navigationState({ view: 'discover', mode: 'detail', selectedId: id }));
  } catch (error) { searchStatus.textContent = error.message; }
}
function closeDetail() {
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
  $('#download-list').innerHTML = items.map(item => {
    const primary = downloadPrimary(item);
    return `<article class="download ${item.complete ? 'complete' : ''}" data-download-id="${escape(item.id)}">
      <div class="download-head"><div><h2>${escape(item.title)}</h2><div class="meta"><strong>${escape(item.complete ? 'COMPLETE' : item.status)}</strong> · ${item.progress}%${item.complete ? '' : ' · ' + escape(item.speed)}</div></div><span class="progress-number">${item.progress}%</span></div>
      <div class="track"><div class="fill" style="width:${item.progress}%"></div></div>
      <div class="download-actions">${primary ? `<button data-download-action="${primary[0]}">${primary[1]}</button>` : ''}
        <details><summary>MORE</summary><div><button data-download-action="remove">REMOVE · KEEP FILES</button><button class="danger" data-download-action="delete">DELETE FILES</button></div></details>
      </div></article>`;
  }).join('');
  $$('[data-download-action]').forEach(button => button.addEventListener('click', () => {
    const card = button.closest('[data-download-id]'); runDownloadAction(card.dataset.downloadId, button.dataset.downloadAction, button);
  }));
}
async function runDownloadAction(id, action, button) {
  if (action === 'remove' || action === 'delete') {
    const message = action === 'delete' ? 'Delete this torrent and its downloaded movie files? This cannot be undone.' : 'Remove this torrent from qBittorrent but keep its movie files?';
    if (!confirm(message)) return;
  }
  const original = button.textContent; button.disabled = true; button.textContent = 'WORKING…';
  try {
    await api('downloads/action', { method: 'POST', body: JSON.stringify({ id, action }) }); await loadDownloads(true);
  } catch (error) { button.disabled = false; button.textContent = original; $('#download-status').textContent = error.message; }
}
async function loadDownloads(silent = false) {
  if (downloadsLoading) return; downloadsLoading = true;
  const list = $('#download-list'), status = $('#download-status');
  if (!silent && !list.children.length) status.textContent = 'Loading your downloads…';
  try {
    const data = await api('downloads'); downloadFailures = 0;
    const qbitState = data.qbit?.state || 'ready';
    if (qbitState === 'sleeping') status.textContent = 'qBit is napping · open it on the PC when you’re ready';
    else if (qbitState === 'auth') status.textContent = 'qBit needs its key · check Settings';
    else if (qbitState === 'setup') status.textContent = 'Finish qBit setup in Settings';
    else if (qbitState === 'problem') status.textContent = 'qBit needs a moment · check the PC';
    else if (qbitState === 'checking' && !data.items.length) status.textContent = 'Checking qBit…';
    else status.textContent = data.items.length ? `LIVE · ${data.items.length} download${data.items.length === 1 ? '' : 's'} · newest first` : 'No downloads yet';
    renderDownloads(data.items);
    if (activeView === 'downloads') scheduleDownloads(qbitState === 'ready' && data.items.some(item => !item.complete) ? 2000 : qbitState === 'ready' ? 5000 : 8000);
  } catch (error) {
    downloadFailures += 1;
    if (downloadFailures >= 3 || !list.children.length) status.textContent = `Updates delayed · ${error.message}`;
    if (activeView === 'downloads') scheduleDownloads(Math.min(30000, 4000 * downloadFailures));
  } finally { downloadsLoading = false; }
}
function scheduleDownloads(delay) {
  clearTimeout(downloadsTimer);
  downloadsTimer = setTimeout(() => { if (activeView === 'downloads' && !document.hidden) loadDownloads(true); }, delay);
}
$('#refresh').addEventListener('click', () => loadDownloads());
document.addEventListener('visibilitychange', () => { if (activeView === 'downloads' && !document.hidden) loadDownloads(true); });

function savedByText(item) {
  if (item.savedBy?.length === 2) return 'BOTH SAVED';
  if (item.savedBy?.includes('tyler')) return 'TYLER SAVED';
  if (item.savedBy?.includes('gloria')) return 'GLORIA SAVED';
  return 'CURATED LIST';
}
function findRelease(title) { $('#search-input').value = title; recommendations.classList.add('hidden'); $('#search-form').requestSubmit(); }
async function loadForUs(force = false) {
  if (letterboxdLoading) return; letterboxdLoading = true;
  const status = $('#letterboxd-status'), list = $('#letterboxd-list');
  if (!list.children.length) status.textContent = 'Mixing your watchlists…';
  try {
    if (force) await api('letterboxd/sync', { method: 'POST', body: '{}' });
    const data = await api(`letterboxd/discover?filter=${encodeURIComponent(letterboxdFilter)}&limit=12`);
    letterboxdItems = data.items;
    status.textContent = data.items.length ? `${data.items.length} unwatched picks` : data.status?.syncing ? 'First sync is still running…' : 'No matching unwatched picks yet.';
    list.innerHTML = data.items.slice(0, 12).map(item => `<article class="letterboxd-film">
      ${item.posterUrl ? `<img src="${escape(item.posterUrl)}" alt="">` : '<div class="letterboxd-placeholder">GLO</div>'}
      <div class="letterboxd-copy"><small>${savedByText(item)}</small><h2>${escape(item.title)}${item.year ? ` <span>${escape(item.year)}</span>` : ''}</h2>
      <p>${item.communityRating ? `Letterboxd ${escape(item.communityRating)} · ` : ''}${escape(item.overview || 'Ready to find a release.')}</p><button class="find-release" data-title="${escape(item.title)}">FIND RELEASE</button></div></article>`).join('');
    $$('.find-release').forEach(button => button.addEventListener('click', () => findRelease(button.dataset.title)));
  } catch (error) { status.textContent = error.message; }
  finally { letterboxdLoading = false; }
}
$$('.letterboxd-filter').forEach(button => button.addEventListener('click', () => {
  letterboxdFilter = button.dataset.letterboxdFilter; $$('.letterboxd-filter').forEach(item => item.classList.toggle('active', item === button)); loadForUs();
}));
$('#letterboxd-sync').addEventListener('click', () => loadForUs(true));
$('#letterboxd-random').addEventListener('click', () => {
  if (!letterboxdItems.length) return loadForUs();
  findRelease(letterboxdItems[Math.floor(Math.random() * letterboxdItems.length)].title);
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
async function saveSettings() {
  const status = $('#settings-status'); status.textContent = 'Saving securely…';
  const payload = {
    qbitHost: $('#qbit-host').value.trim(), qbitPort: Number($('#qbit-port').value), qbitHttps: $('#qbit-https').checked,
    qbitApiKey: $('#qbit-key').value.trim(), tmdbToken: $('#tmdb-token').value.trim(), openSubtitlesApiKey: $('#opensubtitles-key').value.trim(), category: $('#category').value.trim(),
    letterboxdTyler: $('#letterboxd-tyler').value.trim(), letterboxdGloria: $('#letterboxd-gloria').value.trim(), letterboxdLists: $('#letterboxd-lists').value.trim(),
  };
  try {
    await api('config', { method: 'POST', body: JSON.stringify(payload) }); const test = await api('test', { method: 'POST', body: '{}' });
    status.textContent = `Connected to qBittorrent ${test.version}`; $('#qbit-key').value = ''; $('#tmdb-token').value = ''; $('#opensubtitles-key').value = '';
    api('letterboxd/sync', { method: 'POST', body: '{}' }).then(loadSettings).catch(() => {});
  } catch (error) { status.textContent = error.message; }
}
$('#settings-form').addEventListener('submit', event => { event.preventDefault(); saveSettings(); });
$('#save-metadata').addEventListener('click', saveSettings);
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); deferredInstall = event; $('#install').classList.remove('hidden'); });
$('#install').addEventListener('click', async () => {
  if (!deferredInstall) return; deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; $('#install').classList.add('hidden');
});
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
