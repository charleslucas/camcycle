// CamCycle: shuffles through live public webcams (YouTube live + HLS streams).

const HLS_JS_URL = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js';
const LOAD_TIMEOUT_MS = 20000;   // give up on a camera that hasn't started playing by then
const STALL_TIMEOUT_MS = 30000;  // skip a camera that buffers this long mid-play
const DEAD_TTL_MS = 2 * 60 * 60 * 1000; // remember failed cameras for 2 hours
const IDLE_MS = 4000;            // hide controls after this much inactivity
const CAPTION_MS = 8000;         // keep the caption up this long after each switch
const REFRESH_MS = 60 * 60 * 1000; // re-fetch cameras.json this often

const $ = (id) => document.getElementById(id);
const els = {
  slot: $('player-slot'), video: $('hls-video'), tap: $('tap-layer'),
  loading: $('loading'), loadingText: $('loading-text'),
  caption: $('caption'), name: $('cam-name'), meta: $('cam-meta'),
  bar: $('progress-bar'), start: $('start'), startBtn: $('start-btn'),
  prev: $('prev-btn'), pause: $('pause-btn'), next: $('next-btn'),
  mute: $('mute-btn'), fav: $('fav-btn'), cat: $('cat-select'),
  time: $('time-select'), listBtn: $('list-btn'), fs: $('fs-btn'),
  panel: $('list-panel'), listClose: $('list-close'), list: $('cam-list'), retry: $('retry-btn'),
};

// ---------- persistence (all optional: storage can be unavailable) ----------

function load(key, fallback) {
  try {
    const v = localStorage.getItem('camcycle.' + key);
    return v === null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem('camcycle.' + key, JSON.stringify(value)); } catch { /* ignore */ }
}

const params = new URLSearchParams(location.search);
const state = {
  cams: [],
  byId: new Map(),
  category: params.get('cat') || load('category', 'all'),
  seconds: Number(params.get('t')) || load('seconds', 60),
  muted: params.has('sound') ? params.get('sound') !== '1' : load('muted', true),
  paused: false,
  favorites: new Set(load('favorites', [])),
  dead: new Map(Object.entries(load('dead', {})).filter(([, t]) => Date.now() - t < DEAD_TTL_MS)),
  deck: [],
  history: [],
  pos: -1,
  current: null,
  token: 0,          // bumps on every switch so stale callbacks can tell they're stale
  ytPlayer: null,
  hls: null,
  playingSince: 0,   // when the dwell timer started (0 = not playing yet)
  elapsed: 0,        // dwell time already used before a pause
  loadTimer: 0,
  stallTimer: 0,
  lastSwitch: 0,
};

// ---------- camera list and shuffling ----------

function inCategory(cam) {
  if (state.category === 'all') return true;
  if (state.category === 'favorites') return state.favorites.has(cam.id);
  return cam.category === state.category;
}

function playable() {
  return state.cams.filter((c) => inCategory(c) && !state.dead.has(c.id));
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function drawFromDeck() {
  state.deck = state.deck.filter((id) => {
    const c = state.byId.get(id);
    return c && inCategory(c) && !state.dead.has(id);
  });
  if (!state.deck.length) {
    state.deck = shuffle(playable().map((c) => c.id));
    // Don't replay the camera we're on straight after a reshuffle.
    if (state.deck.length > 1 && state.deck[state.deck.length - 1] === state.current?.id) {
      state.deck.unshift(state.deck.pop());
    }
  }
  return state.byId.get(state.deck.pop());
}

function next() {
  let cam;
  if (state.pos < state.history.length - 1) {
    cam = state.byId.get(state.history[++state.pos]);
    if (!cam || state.dead.has(cam.id) || !inCategory(cam)) return next();
  } else {
    cam = drawFromDeck();
    if (!cam) return showEmpty();
    state.history.push(cam.id);
    state.pos = state.history.length - 1;
  }
  play(cam);
}

function prev() {
  while (state.pos > 0) {
    const cam = state.byId.get(state.history[--state.pos]);
    if (cam && !state.dead.has(cam.id)) return play(cam);
  }
}

function jumpTo(cam) {
  state.history.splice(state.pos + 1, 0, cam.id);
  state.pos++;
  state.dead.delete(cam.id); // the user explicitly picked it, so give it another chance
  play(cam);
}

function markDead(cam) {
  state.dead.set(cam.id, Date.now());
  save('dead', Object.fromEntries(state.dead));
}

function showEmpty() {
  teardown();
  state.current = null;
  els.loading.hidden = false;
  els.loadingText.textContent = state.category === 'favorites'
    ? 'No favorites yet. Tap ☆ on a camera you like.'
    : 'No working cameras in this category right now. Retrying in a minute…';
  if (state.category !== 'favorites') {
    const token = ++state.token;
    setTimeout(() => {
      if (token !== state.token) return;
      for (const c of state.cams) if (inCategory(c)) state.dead.delete(c.id);
      next();
    }, 60000);
  }
}

// ---------- playback ----------

function clearStall() {
  clearTimeout(state.stallTimer);
  state.stallTimer = 0;
}

function teardown() {
  clearTimeout(state.loadTimer);
  clearStall();
  if (state.ytPlayer) {
    try { state.ytPlayer.destroy(); } catch { /* ignore */ }
    state.ytPlayer = null;
  }
  els.slot.replaceChildren();
  if (state.hls) { state.hls.destroy(); state.hls = null; }
  els.video.onplaying = els.video.onwaiting = els.video.onerror = els.video.onended = null;
  els.video.pause();
  els.video.removeAttribute('src');
  els.video.load();
  els.video.hidden = true;
}

function play(cam) {
  teardown();
  const token = ++state.token;
  state.current = cam;
  state.playingSince = 0;
  state.elapsed = 0;
  state.lastSwitch = Date.now();
  els.bar.style.width = '0';
  els.loading.hidden = false;
  els.loadingText.textContent = 'Loading ' + cam.name + '…';
  els.name.textContent = cam.name;
  els.meta.textContent = [cam.location, cam.country, cam.credit && 'Source: ' + cam.credit].filter(Boolean).join(' · ');
  els.fav.classList.toggle('on', state.favorites.has(cam.id));
  els.fav.textContent = state.favorites.has(cam.id) ? '★' : '☆';
  renderList();
  wake();

  state.loadTimer = setTimeout(() => {
    if (token === state.token) fail(cam, 'timed out');
  }, LOAD_TIMEOUT_MS);

  const start = cam.type === 'hls' ? playHls : playYouTube;
  start(cam, token).catch((err) => {
    if (token === state.token) fail(cam, err?.message || 'error');
  });
}

function fail(cam, reason) {
  console.warn(`Skipping ${cam.id}: ${reason}`);
  markDead(cam);
  // Drop it from history so ⏮ doesn't land on it again.
  const i = state.history.lastIndexOf(cam.id);
  if (i !== -1) { state.history.splice(i, 1); if (state.pos >= i) state.pos--; }
  next();
}

function onPlaying(token) {
  if (token !== state.token) return;
  clearTimeout(state.loadTimer);
  clearStall();
  els.loading.hidden = true;
  if (!state.playingSince && !state.paused) state.playingSince = Date.now();
}

function onStall(token) {
  if (token !== state.token || state.stallTimer) return;
  const cam = state.current;
  state.stallTimer = setTimeout(() => {
    if (token === state.token) fail(cam, 'stalled');
  }, STALL_TIMEOUT_MS);
}

// --- YouTube ---

let ytReady;
function loadYouTubeApi() {
  ytReady ??= new Promise((resolve, reject) => {
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { ytReady = null; reject(new Error('YouTube API failed to load')); };
    document.head.append(s);
  });
  return ytReady;
}

async function playYouTube(cam, token, useChannel = !cam.videoId) {
  const YT = await loadYouTubeApi();
  if (token !== state.token) return;

  const playerVars = {
    autoplay: 1, mute: state.muted ? 1 : 0, controls: 0, playsinline: 1,
    rel: 0, iv_load_policy: 3, disablekb: 1, fs: 0, origin: location.origin,
  };
  const events = {
    onReady: (e) => {
      if (token !== state.token) return;
      state.muted ? e.target.mute() : e.target.unMute();
      e.target.playVideo();
    },
    onStateChange: (e) => {
      if (e.data === YT.PlayerState.PLAYING) onPlaying(token);
      else if (e.data === YT.PlayerState.BUFFERING && state.playingSince) onStall(token);
      else if (e.data === YT.PlayerState.ENDED && token === state.token) next();
    },
    onError: (e) => {
      if (token !== state.token) return;
      // Live video IDs change when a channel restarts its stream; fall back to the channel's current live stream.
      if (!useChannel && cam.channelId) playYouTube(cam, token, true).catch(() => fail(cam, 'yt error'));
      else fail(cam, 'yt error ' + e.data);
    },
  };

  if (state.ytPlayer) { try { state.ytPlayer.destroy(); } catch { /* ignore */ } }
  els.slot.replaceChildren();

  if (useChannel) {
    // The IFrame API has no "channel live stream" option, so build the embed URL ourselves and attach to it.
    const iframe = document.createElement('iframe');
    const q = new URLSearchParams({ channel: cam.channelId, enablejsapi: 1, ...playerVars });
    iframe.src = 'https://www.youtube.com/embed/live_stream?' + q;
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture';
    els.slot.append(iframe);
    state.ytPlayer = new YT.Player(iframe, { events });
  } else {
    const div = document.createElement('div');
    els.slot.append(div);
    state.ytPlayer = new YT.Player(div, { videoId: cam.videoId, playerVars, events });
  }
}

// --- HLS ---

let hlsReady;
function loadHlsJs() {
  hlsReady ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = HLS_JS_URL;
    s.onload = () => resolve(window.Hls);
    s.onerror = () => { hlsReady = null; reject(new Error('hls.js failed to load')); };
    document.head.append(s);
  });
  return hlsReady;
}

const nativeHls = () => els.video.canPlayType('application/vnd.apple.mpegurl') !== '';

async function playHls(cam, token) {
  const v = els.video;
  v.hidden = false;
  v.muted = state.muted;
  v.onplaying = () => onPlaying(token);
  v.onwaiting = () => { if (state.playingSince) onStall(token); };
  v.onerror = () => { if (token === state.token) fail(cam, 'video error'); };
  v.onended = () => { if (token === state.token) next(); };

  const start = async () => {
    try {
      await v.play();
    } catch {
      // Browsers refuse unmuted autoplay without a recent tap; fall back to muted.
      if (token !== state.token) return;
      setMuted(true);
      await v.play().catch(() => { if (token === state.token) fail(cam, 'autoplay blocked'); });
    }
  };

  // Safari plays HLS natively, which also gives us AirPlay.
  if (nativeHls()) {
    v.src = cam.url;
    return start();
  }
  const Hls = await loadHlsJs();
  if (token !== state.token) return;
  if (!Hls.isSupported()) throw new Error('HLS not supported in this browser');
  const hls = new Hls({ liveDurationInfinity: true });
  hls.on(Hls.Events.ERROR, (_, data) => {
    if (data.fatal && token === state.token) fail(cam, 'hls ' + data.details);
  });
  hls.on(Hls.Events.MANIFEST_PARSED, () => { if (token === state.token) start(); });
  hls.loadSource(cam.url);
  hls.attachMedia(v);
  state.hls = hls;
}

// AirPlay (Safari only, HLS cameras only; YouTube's embed has its own AirPlay handling).
if (window.WebKitPlaybackTargetAvailabilityEvent) {
  els.video.addEventListener('webkitplaybacktargetavailabilitychanged', (e) => {
    $('airplay-btn').hidden = e.availability !== 'available';
  });
  $('airplay-btn').onclick = () => els.video.webkitShowPlaybackTargetPicker();
}

// ---------- dwell timer and progress ----------

function remainingMs() {
  const used = state.elapsed + (state.playingSince ? Date.now() - state.playingSince : 0);
  return state.seconds * 1000 - used;
}

setInterval(() => {
  if (!state.current || !state.playingSince) return;
  const left = remainingMs();
  els.bar.style.width = Math.min(100, 100 * (1 - left / (state.seconds * 1000))) + '%';
  if (left <= 0) next();
}, 250);

function togglePause() {
  state.paused = !state.paused;
  if (state.paused && state.playingSince) {
    state.elapsed += Date.now() - state.playingSince;
    state.playingSince = 0;
  } else if (!state.paused && els.loading.hidden && state.current) {
    state.playingSince = Date.now();
  }
  els.pause.textContent = state.paused ? '▶' : '⏸';
  els.pause.title = state.paused ? 'Resume shuffle (Space)' : 'Pause shuffle (Space)';
}

// ---------- controls ----------

function setMuted(muted) {
  state.muted = muted;
  save('muted', muted);
  els.mute.textContent = muted ? '🔇' : '🔊';
  if (state.ytPlayer?.mute) muted ? state.ytPlayer.mute() : state.ytPlayer.unMute();
  els.video.muted = muted;
}

function toggleFavorite() {
  const cam = state.current;
  if (!cam) return;
  state.favorites.has(cam.id) ? state.favorites.delete(cam.id) : state.favorites.add(cam.id);
  save('favorites', [...state.favorites]);
  els.fav.classList.toggle('on', state.favorites.has(cam.id));
  els.fav.textContent = state.favorites.has(cam.id) ? '★' : '☆';
  renderCategories();
  renderList();
}

function setCategory(cat) {
  state.category = cat;
  save('category', cat);
  state.deck = [];
  // Keep the current camera only if it still fits; otherwise move on now.
  if (!state.current || !inCategory(state.current)) next();
  renderList();
}

function renderCategories() {
  const counts = {};
  for (const c of state.cams) counts[c.category] = (counts[c.category] || 0) + 1;
  const label = (s) => s[0].toUpperCase() + s.slice(1);
  const opts = [['all', `All (${state.cams.length})`], ['favorites', `★ Favorites (${state.favorites.size})`]]
    .concat(Object.keys(counts).sort().map((k) => [k, `${label(k)} (${counts[k]})`]));
  els.cat.replaceChildren(...opts.map(([value, text]) => new Option(text, value, false, value === state.category)));
}

function renderList() {
  if (els.panel.hidden) return;
  const items = state.cams.filter(inCategory).map((cam) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    const small = document.createElement('small');
    b.textContent = (state.favorites.has(cam.id) ? '★ ' : '') + cam.name;
    small.textContent = [cam.location, cam.category].filter(Boolean).join(' · ');
    b.append(small);
    // Compare ids: after a list refresh the current camera is an object from the old list.
    b.classList.toggle('current', cam.id === state.current?.id);
    b.classList.toggle('dead', state.dead.has(cam.id));
    b.onclick = () => { jumpTo(cam); toggleList(false); };
    li.append(b);
    return li;
  });
  els.list.replaceChildren(...items);
  const skipped = state.cams.filter((c) => state.dead.has(c.id)).length;
  els.retry.hidden = !skipped;
  els.retry.textContent = `↻ Retry skipped cameras (${skipped})`;
}

function toggleList(show = els.panel.hidden) {
  els.panel.hidden = !show;
  if (show) {
    renderList();
    (els.list.querySelector('.current') || els.listClose).focus();
  }
}

const canFullscreen = !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
function toggleFullscreen() {
  const d = document;
  if (d.fullscreenElement || d.webkitFullscreenElement) {
    (d.exitFullscreen || d.webkitExitFullscreen).call(d);
  } else {
    const el = d.documentElement;
    (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
  }
}

// Keep phones and tablets from sleeping mid-show.
let wakeLock = null;
async function wake() {
  if (!('wakeLock' in navigator) || wakeLock || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* not allowed right now */ }
}
document.addEventListener('visibilitychange', wake);

// ---------- idle UI ----------

let lastActivity = Date.now();
function activity() {
  lastActivity = Date.now();
  document.body.classList.remove('idle');
}
setInterval(() => {
  const idle = Date.now() - lastActivity > IDLE_MS && els.panel.hidden && els.start.hidden;
  document.body.classList.toggle('idle', idle);
  els.caption.classList.toggle('auto-hide', Date.now() - state.lastSwitch > CAPTION_MS);
}, 500);

['pointermove', 'pointerdown'].forEach((t) => document.addEventListener(t, activity, { passive: true }));
els.tap.addEventListener('pointerdown', (e) => {
  // A tap on the video toggles the controls, which is what people expect on phones.
  // Stop it here so the document-level activity listener doesn't re-show them first.
  e.stopPropagation();
  if (document.body.classList.contains('idle')) activity();
  else lastActivity = 0;
});

document.addEventListener('keydown', (e) => {
  const wasIdle = document.body.classList.contains('idle');
  activity();
  const inSelect = e.target instanceof HTMLSelectElement;
  switch (e.key) {
    case 'ArrowRight': case 'MediaTrackNext': case 'MediaFastForward':
      if (inSelect || !els.panel.hidden) return;
      e.preventDefault(); next(); break;
    case 'ArrowLeft': case 'MediaTrackPrevious': case 'MediaRewind':
      if (inSelect || !els.panel.hidden) return;
      e.preventDefault(); prev(); break;
    case ' ': case 'MediaPlayPause': case 'MediaPlay': case 'MediaPause':
      if (inSelect) return;
      e.preventDefault(); togglePause(); break;
    case 'm': case 'M': setMuted(!state.muted); break;
    case 'f': case 'F': toggleFavorite(); break;
    case 'l': case 'L': toggleList(); break;
    case 'Escape': case 'Backspace': case 'GoBack':
      if (!els.panel.hidden) { e.preventDefault(); toggleList(false); }
      break;
    case 'Enter':
      // First press just wakes the controls instead of activating something invisible.
      if (wasIdle) { e.preventDefault(); els.next.focus(); }
      break;
  }
});

els.prev.onclick = prev;
els.next.onclick = next;
els.pause.onclick = togglePause;
els.mute.onclick = () => setMuted(!state.muted);
els.fav.onclick = toggleFavorite;
els.listBtn.onclick = () => toggleList();
els.listClose.onclick = () => toggleList(false);
els.retry.onclick = retrySkipped;
els.fs.onclick = toggleFullscreen;
els.fs.hidden = !canFullscreen;
els.cat.onchange = () => setCategory(els.cat.value);
els.time.onchange = () => {
  state.seconds = Number(els.time.value);
  save('seconds', state.seconds);
};

// ---------- startup ----------

async function loadCameras() {
  const res = await fetch('cameras.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('cameras.json HTTP ' + res.status);
  const cams = (await res.json()).filter((c) => c.id && c.name && (c.type === 'hls' ? c.url : c.videoId || c.channelId));
  if (!cams.length) throw new Error('cameras.json has no usable cameras');
  state.cams = cams;
  state.byId = new Map(cams.map((c) => [c.id, c]));
}

// Pick up list changes on long-running TVs without interrupting the current camera.
// Removed cameras fall out of the deck and history on their own because lookups go through byId.
async function refreshCameras() {
  try {
    await loadCameras();
    renderCategories();
    renderList();
    if (!state.current) next(); // we were showing "no cameras"; the new list may have some
  } catch (err) {
    console.warn('Camera list refresh failed; keeping the old list.', err);
  }
}

function retrySkipped() {
  state.dead.clear();
  save('dead', {});
  renderList();
  els.listClose.focus(); // the retry button just hid itself; keep TV remote focus inside the panel
  if (!state.current) next();
}

async function init() {
  try {
    await loadCameras();
  } catch (err) {
    els.startBtn.disabled = true;
    els.startBtn.textContent = 'Could not load camera list';
    console.error(err);
    return;
  }
  setInterval(refreshCameras, REFRESH_MS);

  if (state.category !== 'all' && state.category !== 'favorites' && !state.cams.some((c) => c.category === state.category)) {
    state.category = 'all';
  }
  if (![...els.time.options].some((o) => Number(o.value) === state.seconds)) {
    els.time.append(new Option(state.seconds + ' s', state.seconds));
  }
  els.time.value = String(state.seconds);
  renderCategories();
  setMuted(state.muted);

  const begin = () => {
    els.start.hidden = true;
    activity();
    next();
  };
  els.startBtn.onclick = begin;
  if (params.get('autostart') === '1') begin();
  loadYouTubeApi().catch(() => { /* retried when a YouTube camera comes up */ });
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
}

init();
