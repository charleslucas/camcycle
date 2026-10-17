// Add a custom camera to cameras.json from a video link.
//   node tools/add-camera.mjs <url> [options]
//
// <url> may be a YouTube link (watch?v=, youtu.be/, /live/, /embed/, or a bare 11-char id)
// or a direct HLS stream (an https .m3u8 URL).
//
// It verifies the link, then fills in details — asking for anything you don't pass as a flag:
//   --name "..."  --category cities  --location "City, Region"  --country US  --credit "..."
//   --id my-id            set the id instead of deriving it from the name
//   --yes                 don't prompt; use flags and defaults (fails if name/category missing)
//   --no-verify           skip the live/embeddable/HLS check (use for a cam that's offline now)
//
// Known categories: space nature animals cities beaches mountains harbors traffic villages trains
// (any other word is allowed; you'll just be asked to confirm it.)
// Requires Node 18+.

import { createInterface } from 'node:readline/promises';
import { CAMERAS_FILE, get, readJson, writeJson, checkEmbeddable, checkHls } from './lib.mjs';

const KNOWN_CATEGORIES = ['space', 'nature', 'animals', 'cities', 'beaches', 'mountains', 'harbors', 'traffic', 'villages', 'trains'];

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes' || a === '--no-verify') opts[a.slice(2)] = true;
    else if (a.startsWith('--')) opts[a.slice(2)] = argv[++i];
    else opts._.push(a);
  }
  return opts;
}

// Pull an 11-character video id out of any common YouTube URL form.
function parseYouTube(s) {
  if (/^[\w-]{11}$/.test(s)) return s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (!/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(u.hostname)) return null;
  if (u.hostname.endsWith('youtu.be')) return u.pathname.slice(1, 12) || null;
  if (u.searchParams.get('v')) return u.searchParams.get('v');
  const m = u.pathname.match(/\/(?:live|embed|shorts|v)\/([\w-]{11})/);
  return m ? m[1] : null;
}

function classify(input) {
  const videoId = parseYouTube(input);
  if (videoId) return { type: 'youtube', videoId };
  let u;
  try { u = new URL(input); } catch { return null; }
  if (u.protocol === 'https:' && /\.m3u8(\?|$)/i.test(u.pathname + u.search)) return { type: 'hls', url: input };
  return null;
}

const slug = (s) => (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

function uniqueId(base, taken) {
  let id = base || 'camera';
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

const opts = parseArgs(process.argv.slice(2));
const input = opts._[0];
if (!input) {
  console.error('Usage: node tools/add-camera.mjs <youtube-or-m3u8-url> [--name ... --category ... --location ... --country ... --credit ...]');
  process.exit(1);
}

const cam = classify(input);
if (!cam) {
  console.error(`Not a recognized link: ${input}\nExpected a YouTube URL/id or an https .m3u8 stream.`);
  process.exit(1);
}

const cams = await readJson(CAMERAS_FILE);
const keyOf = (c) => (c.type === 'hls' ? c.url : c.videoId);
const dup = cams.find((c) => c.type === cam.type && keyOf(c) === keyOf(cam));
if (dup) {
  console.error(`Already in the list: "${dup.name}" (${dup.id}).`);
  process.exit(1);
}

// Verify, and for YouTube grab the title/channel to prefill fields.
let suggestedName = '';
let channelId, channelName;
if (!opts['no-verify']) {
  if (cam.type === 'youtube') {
    const why = await checkEmbeddable(cam.videoId).catch((e) => e.message);
    if (why) { console.error(`This video can't be embedded: ${why}`); process.exit(1); }
    try {
      const { text } = await get(`https://www.youtube.com/watch?v=${cam.videoId}`);
      if (!text.includes('"isLiveNow":true')) console.warn('Note: this video is not live right now. Adding it anyway.');
      channelId = text.match(/"channelId":"(UC[\w-]{22})"/)?.[1];
      suggestedName = (text.match(/"title":"((?:[^"\\]|\\.)*)","lengthSeconds"/)?.[1] ?? '')
        .replace(/\\u0026/g, '&').replace(/\\"/g, '"');
    } catch { /* prefill is best-effort */ }
    try {
      const o = await get(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${cam.videoId}`);
      const j = JSON.parse(o.text);
      suggestedName ||= j.title ?? '';
      channelName = j.author_name;
    } catch { /* ignore */ }
  } else {
    const why = await checkHls(cam.url).catch((e) => e.message);
    if (why) { console.error(`This stream won't play in a browser: ${why}`); process.exit(1); }
  }
  console.log('Verified OK.');
}

// Collect the remaining fields, from flags or by asking.
const rl = (opts.yes || !process.stdin.isTTY) ? null : createInterface({ input: process.stdin, output: process.stdout });
async function ask(label, fallback = '') {
  if (!rl) return fallback;
  const suffix = fallback ? ` [${fallback}]` : '';
  const answer = (await rl.question(`${label}${suffix}: `)).trim();
  return answer || fallback;
}

const name = opts.name ?? await ask('Name', suggestedName);
if (!name) { console.error('A name is required.'); rl?.close(); process.exit(1); }

let category = opts.category ?? await ask(`Category (${KNOWN_CATEGORIES.join(', ')})`);
category = category.trim().toLowerCase();
if (!category) { console.error('A category is required.'); rl?.close(); process.exit(1); }
if (!KNOWN_CATEGORIES.includes(category)) {
  const ok = rl ? (await ask(`"${category}" is a new category. Use it anyway? (y/N)`)).toLowerCase().startsWith('y') : true;
  if (!ok) { rl?.close(); process.exit(1); }
}

const location = opts.location ?? await ask('Location (optional)');
const country = (opts.country ?? await ask('Country code, e.g. US (optional)')).toUpperCase();
const credit = opts.credit ?? await ask('Credit / source name (optional)', channelName ?? '');
rl?.close();

const taken = new Set(cams.map((c) => c.id));
const entry = {
  id: uniqueId(opts.id ? slug(opts.id) : slug(name), taken),
  name, type: cam.type,
  ...(cam.type === 'youtube' ? { videoId: cam.videoId, ...(channelId ? { channelId } : {}) } : { url: cam.url }),
  category,
  ...(location ? { location } : {}),
  ...(country ? { country } : {}),
  ...(credit ? { credit } : {}),
  source: cam.type === 'youtube' ? `https://www.youtube.com/watch?v=${cam.videoId}` : cam.url,
};

cams.push(entry);
await writeJson(CAMERAS_FILE, cams);
console.log(`\nAdded "${entry.name}" (${entry.id}) to cameras.json — ${cams.length} cameras total.`);
console.log('Commit and push to publish it:  git commit -am "Add camera" && git push');
