// CamCycle: shuffles through live public webcams (YouTube live + HLS streams).

const HLS_JS_URL = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js';
const LOAD_TIMEOUT_MS = 20000;   // give up on a camera that hasn't started playing by then
const STALL_TIMEOUT_MS = 30000;  // skip a camera that buffers this long mid-play
const DEAD_TTL_MS = 2 * 60 * 60 * 1000; // remember failed cameras for 2 hours
const IDLE_MS = 4000;            // hide controls after this much inactivity
const CAPTION_MS = 8000;         // keep the caption up this long after each switch
const REFRESH_MS = 60 * 60 * 1000; // re-fetch cameras.json this often
const FAIL_STREAK_LIMIT = 4;     // this many failures in a row looks like our network, not the cameras

// Unregister any stale service workers IMMEDIATELY - they cause fetch() to fail on file://
if ('serviceWorker' in navigator && location.protocol === 'file:') {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    registrations.forEach((reg) => reg.unregister());
  });
}

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
  toast: $('toast'),
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
  mjpegImg: null,
  playingSince: 0,   // when the dwell timer started (0 = not playing yet)
  elapsed: 0,        // dwell time already used before a pause
  loadTimer: 0,
  stallTimer: 0,
  lastSwitch: 0,
  failStreak: 0,          // consecutive camera failures
  streakIds: [],          // cameras marked failed during the current streak
  retryOnVisible: false,  // a camera "failed" while the page was hidden; replay it when visible
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
  // Nothing playable in the chosen category: fall back to All rather than sitting on a blank screen.
  // The saved category is left alone, so it applies again on the next visit.
  if (state.category !== 'all') {
    toast(state.category === 'favorites'
      ? 'No favorites yet (tap ☆ to add one). Showing all cameras.'
      : `No working ${els.cat.selectedOptions[0]?.text.replace(/\s*\(\d+\)$/, '') ?? state.category} cameras right now. Showing all cameras.`);
    state.category = 'all';
    els.cat.value = 'all';
    state.deck = [];
    renderList();
    return next();
  }
  // Every camera is unavailable, which almost always means our connection.
  teardown();
  state.current = null;
  els.loading.hidden = false;
  els.loadingText.textContent = 'Can\'t reach any cameras right now. Check your connection; retrying in a minute…';
  const token = ++state.token;
  setTimeout(() => {
    if (token !== state.token) return;
    state.dead.clear();
    next();
  }, 60000);
}

let toastTimer = 0;
function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 6000);
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
  if (state.mjpegImg) { state.mjpegImg.onload = state.mjpegImg.onerror = null; state.mjpegImg.remove(); state.mjpegImg = null; }
  clearInterval(state.mjpegCheck);
  state.mjpegCheck = 0;
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

  const start = cam.type === 'hls' ? playHls : cam.type === 'mjpeg' ? playMjpeg : playYouTube;
  start(cam, token).catch((err) => {
    if (token === state.token) {
      // If this is an insecam camera with compatibility issues, try the fallback player
      if (cam.source === 'http://www.insecam.org' && cam.compatibility) {
        playInsecamFallback(cam, token, err.message);
        return;
      }
      fail(cam, err?.message || 'error');
    }
  });
}

function fail(cam, reason) {
  // Browsers hold back video in background tabs, so a "failure" there says nothing about the camera.
  // Try this camera again when the page is visible.
  if (document.hidden) {
    clearTimeout(state.loadTimer);
    clearStall();
    state.retryOnVisible = true;
    return;
  }
  // Several failures in a row usually means our connection is down, not that the cameras are.
  // Don't mark them; wait and try again.
  if (++state.failStreak >= FAIL_STREAK_LIMIT) {
    console.warn(`Skipping ${cam.id}: ${reason} (${state.failStreak} failures in a row; looks like a connection problem, pausing)`);
    // The cameras that failed just before this one were probably fine too.
    for (const id of state.streakIds) state.dead.delete(id);
    state.streakIds = [];
    save('dead', Object.fromEntries(state.dead));
    teardown();
    const token = ++state.token;
    els.loading.hidden = false;
    els.loadingText.textContent = 'Having trouble reaching the cameras. Check your connection; retrying in 30 seconds…';
    setTimeout(() => {
      if (token !== state.token) return;
      state.failStreak = FAIL_STREAK_LIMIT - 1; // one more failure pauses again; a success resets it
      next();
    }, 30000);
    return;
  }
  console.warn(`Skipping ${cam.id}: ${reason}`);
  markDead(cam);
  state.streakIds.push(cam.id);
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
  state.failStreak = 0;
  state.streakIds = [];
  thawDwell();
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
    } catch (err) {
      if (token !== state.token) return;
      // AbortError just means a reload/reconnect interrupted this play() call; the load timeout still guards us.
      if (err.name === 'AbortError') return;
      if (err.name !== 'NotAllowedError') return fail(cam, `play failed (${err.name})`);
      // Browsers refuse unmuted autoplay without a recent tap; fall back to muted.
      setMuted(true);
      await v.play().catch((e) => {
        if (token === state.token && e.name !== 'AbortError') fail(cam, `autoplay blocked (${e.name})`);
      });
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

// --- MJPEG (IP camera snapshot stream) ---

async function playMjpeg(cam, token) {
  const img = document.createElement('img');
  img.style.width = '100%';
  img.style.height = '100%';
  img.style.objectFit = 'contain';
  img.alt = cam.name;

  // Set the src to the stream URL. Browsers render MJPEG streams (Content-Type: image/jpeg with
  // repeated images) automatically as a video-like sequence when the URL points directly to
  // an IP camera's snapshot endpoint.
  img.src = cam.url || cam.stream;

  const onDone = () => {
    if (token !== state.token) return;
    teardown();
    // For MJPEG, a load failure usually means the stream is offline or blocking mixed content.
    fail(cam, 'mjpeg failed');
  };
  img.onerror = onDone;
  // For MJPEG streams, the first load is the "start playing" signal.
  img.onload = () => {
    if (token !== state.token) return;
    clearTimeout(state.loadTimer);
    clearStall();
    els.loading.hidden = true;
    state.failStreak = 0;
    state.streakIds = [];
    state.playingSince = Date.now();
    // Monitor for connection loss by tracking the last successful load time.
    // We poll by reassigning src; if it fails, the camera is down.
    state.mjpegCheck = setInterval(() => {
      if (token !== state.token || state.paused) return;
      const testImg = new Image();
      testImg.onerror = () => {
        if (token === state.token && !state.paused) fail(cam, 'mjpeg disconnected');
      };
      // Use a cache-busting param to force a new request.
      testImg.src = (cam.url || cam.stream) + '&_=' + Date.now();
    }, 5000);
  };

  els.slot.appendChild(img);
  state.mjpegImg = img;
}

// --- Insecam fallback player (iframe for incompatible streams) ---
async function playInsecamFallback(cam, token, error) {
  console.log(`Using fallback player for ${cam.id}: ${error}`);
  
  // Show a message to the user about the fallback
  els.loadingText.textContent = 'Loading camera via insecam.org…';
  
  teardown();
  
  // Create iframe to embed the insecam camera page
  const iframe = document.createElement('iframe');
  const cameraId = cam.insecamId || cam.id.replace('insecam-', '');
  iframe.src = `http://www.insecam.org/en/view/${cameraId}/`;
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.border = 'none';
  iframe.allow = 'autoplay; encrypted-media; picture-in-picture';
  iframe.allowFullscreen = true;
  
  els.slot.appendChild(iframe);
  
  // Mark as playing after a short delay
  setTimeout(() => {
    if (token === state.token) {
      onPlaying(token);
      // Show a toast with information
      toast(`Displaying ${cam.name} via insecam.org (stream not directly playable)`);
    }
  }, 2000);
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

// The dwell clock runs only while a camera is playing, the shuffle isn't paused, and the page is visible.
function freezeDwell() {
  if (!state.playingSince) return;
  state.elapsed += Date.now() - state.playingSince;
  state.playingSince = 0;
}
function thawDwell() {
  if (!state.playingSince && !state.paused && !document.hidden && els.loading.hidden && state.current) {
    state.playingSince = Date.now();
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return freezeDwell();
  if (state.retryOnVisible && state.current) {
    state.retryOnVisible = false;
    play(state.current);
  } else {
    thawDwell();
  }
});

function togglePause() {
  state.paused = !state.paused;
  state.paused ? freezeDwell() : thawDwell();
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

const isFileProtocol = location.protocol === 'file:';

async function loadCamerasFile(url) {
  // For file:// URLs, use fetch (works better than XHR with file://)
  if (isFileProtocol) {
    // Build absolute URL from relative path
    const absUrl = new URL(url, location.href).href;
    console.log(`[file://] Loading camera list:`);
    console.log(`  Relative URL: ${url}`);
    console.log(`  location.href: ${location.href}`);
    console.log(`  Resolved absolute URL: ${absUrl}`);
    console.log(`  Location pathname: ${location.pathname}`);
    
    // Try fetching with cache: no-store
    try {
      const res = await fetch(absUrl, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status} (${res.statusText})`);
      return { ok: true, text: await res.text() };
    } catch (err) {
      console.error(`[file://] fetch failed completely. Error type: ${err.constructor.name}`, err);
      throw new Error(`fetch failed: ${err.message}. Try running with --allow-file-access-from-files flag or use a local server (npm run dev)`);
    }
  }
  // For http/https URLs, use fetch
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return { ok: true, text: await res.text() };
}

function showStartupError(msg) {
  const el = $('start');
  if (!el) return;
  el.classList.add('error');
  const card = el.querySelector('.start-card');
  if (card) {
    card.innerHTML = `<h1>⚠ Error</h1><p>${msg}</p><p>Please make sure <code>cameras.json</code> exists in the same directory as this page.</p>`;
  }
}

async function loadCameras() {
  let data;
  try {
    data = await loadCamerasFile('cameras.json');
  } catch (err) {
    showStartupError(`Failed to load cameras.json: ${err.message}`);
    throw err;
  }
  const cams = JSON.parse(data.text).filter((c) => c.id && c.name && ((c.type === 'hls' || c.type === 'mjpeg') ? c.url : c.videoId || c.channelId));
  if (!cams.length) {
    showStartupError('cameras.json has no usable cameras');
    throw new Error('No usable cameras');
  }
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
    console.error('Startup failed:', err);
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

// Service workers don't work with file:// URLs and cause fetches to fail.
// Only register for http/https, and unregister any existing SW when on file://.
if ('serviceWorker' in navigator) {
  if (location.protocol === 'file:') {
    // Unregister any stale service worker that might be intercepting file:// requests.
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      registrations.forEach((reg) => reg.unregister());
    });
  } else {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
  }
}

init();
