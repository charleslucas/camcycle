// Review pending camera candidates one at a time and approve or reject each.
//   node tools/review.mjs
//
// Reads tools/candidates.json (written by discover-cameras.mjs). For each camera it prints
// the details, opens the stream so you can look, and waits for a key:
//   a  approve  -> add to cameras.json
//   x  reject   -> record in tools/rejected.json so it's never suggested again
//   s  skip     -> leave in candidates.json for next time
//   o  open the stream again
//   b  go back to the previous camera
//   q  save and quit
// Your decisions are saved as you go, so quitting early loses nothing.
// Requires Node 18+.

import { spawn } from 'node:child_process';
import { emitKeypressEvents } from 'node:readline';
import { CAMERAS_FILE, readJson, writeJson } from './lib.mjs';

const CANDIDATES_FILE = new URL('./candidates.json', import.meta.url);
const REJECTED_FILE = new URL('./rejected.json', import.meta.url);

const keyOf = (cam) => (cam.type === 'hls' ? cam.url : cam.videoId);
const streamUrl = (cam) => (cam.type === 'hls' ? cam.url : `https://www.youtube.com/watch?v=${cam.videoId}`);

function openInBrowser(url) {
  if (process.env.CAMCYCLE_NO_OPEN) return; // set this to review without launching the stream
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch { /* opening is best-effort; the URL is printed anyway */ }
}

// One persistent keypress reader. Keeps raw mode on for the whole session and queues keys,
// so fast typing (or piped input) is never dropped between prompts.
const keyQueue = [];
let keyWaiter = null;
let inputClosed = false;

function setupKeys() {
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.on('keypress', (_, key) => {
    if (key.ctrl && key.name === 'c') { restoreKeys(); process.exit(130); }
    const name = key.name ?? key.sequence;
    if (keyWaiter) { const w = keyWaiter; keyWaiter = null; w(name); }
    else keyQueue.push(name);
  });
  // If input ends (piped input runs out, or the terminal closes), stop asking for keys.
  process.stdin.on('end', () => { inputClosed = true; if (keyWaiter) { const w = keyWaiter; keyWaiter = null; w('q'); } });
}

function restoreKeys() {
  process.stdin.setRawMode?.(false);
  process.stdin.pause();
}

function readKey() {
  if (keyQueue.length) return Promise.resolve(keyQueue.shift());
  if (inputClosed) return Promise.resolve('q');
  return new Promise((resolve) => { keyWaiter = resolve; });
}

const candidates = await readJson(CANDIDATES_FILE, null);
if (!candidates?.length) {
  console.log('No tools/candidates.json to review. Run "node tools/discover-cameras.mjs" first.');
  process.exit(0);
}

const cams = await readJson(CAMERAS_FILE);
const rejected = new Set(await readJson(REJECTED_FILE, []));
const known = new Set(cams.map(keyOf));

// Decisions keyed by camera, so re-runs resume and "back" can change an earlier call.
const decisions = new Map();
const remaining = () => candidates.filter((c) => !decisions.has(keyOf(c)) && !known.has(keyOf(c)) && !rejected.has(keyOf(c)));

async function persist() {
  const approved = candidates.filter((c) => decisions.get(keyOf(c)) === 'a');
  for (const { skip, title, ...cam } of approved) if (!known.has(keyOf(cam))) { cams.push(cam); known.add(keyOf(cam)); }
  for (const c of candidates) if (decisions.get(keyOf(c)) === 'x') rejected.add(keyOf(c));
  const left = candidates.filter((c) => !['a', 'x'].includes(decisions.get(keyOf(c))) && !known.has(keyOf(c)) && !rejected.has(keyOf(c)));
  await writeJson(CAMERAS_FILE, cams);
  await writeJson(REJECTED_FILE, [...rejected]);
  if (left.length) await writeJson(CANDIDATES_FILE, left);
  else await import('node:fs/promises').then((fs) => fs.rm(CANDIDATES_FILE, { force: true }));
  return { approved: approved.length, left: left.length };
}

setupKeys();
const todo = remaining();
console.log(`${todo.length} camera(s) to review (${candidates.length - todo.length} already decided).`);
console.log('Keys:  a approve   x reject   s skip   o open again   b back   q save & quit\n');

const order = todo;
let i = 0;
while (i < order.length) {
  const cam = order[i];
  const key = keyOf(cam);
  if (decisions.has(key) || known.has(key) || rejected.has(key)) { i++; continue; }

  const n = `${i + 1}/${order.length}`;
  console.log(`[${n}] ${cam.name}`);
  console.log(`      ${[cam.category, cam.location, cam.country].filter(Boolean).join(' · ')}`);
  console.log(`      ${cam.credit ? 'source: ' + cam.credit + '  ' : ''}${streamUrl(cam)}`);
  if (cam.title && cam.title !== cam.name) console.log(`      original title: ${cam.title}`);
  openInBrowser(streamUrl(cam));

  let decided = false;
  while (!decided) {
    process.stdout.write('      > ');
    const k = await readKey();
    switch (k) {
      case 'a': case 'x': case 's':
        decisions.set(key, k);
        console.log({ a: 'approved', x: 'rejected', s: 'skipped' }[k]);
        await persist();
        i++; decided = true;
        break;
      case 'o': console.log('opening…'); openInBrowser(streamUrl(cam)); break;
      case 'b':
        if (i === 0) { console.log('(already at the first camera)'); break; }
        decisions.delete(keyOf(order[--i]));
        decided = true;
        break;
      case 'q':
        { const { approved, left } = await persist();
          console.log(`\nSaved. ${approved} approved, ${left} still pending in candidates.json.`); }
        restoreKeys();
        process.exit(0);
      default: console.log('keys: a approve · x reject · s skip · o open · b back · q quit');
    }
  }
  console.log('');
}

const done = await persist();
console.log(`Done. ${done.approved} approved this session; ${done.left} left pending.`);
restoreKeys();
