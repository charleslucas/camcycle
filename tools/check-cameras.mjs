// Checks every camera in cameras.json and reports which ones are live.
//   node tools/check-cameras.mjs            report only
//   node tools/check-cameras.mjs --prune    also remove dead cameras from cameras.json
// Requires Node 18+ (built-in fetch).

import { readFile, writeFile } from 'node:fs/promises';

const FILE = new URL('../cameras.json', import.meta.url);
const ORIGIN = 'https://example.github.io';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

async function get(url, headers = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US', ...headers },
    signal: AbortSignal.timeout(15000),
  });
  return { res, text: await res.text() };
}

async function checkYouTube(cam) {
  if (cam.videoId) {
    const oembed = await fetch(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${cam.videoId}`, { signal: AbortSignal.timeout(15000) });
    if (oembed.status === 401) return 'embedding disabled';
    if (!oembed.ok) return `oembed ${oembed.status}`;
    const { text } = await get(`https://www.youtube.com/watch?v=${cam.videoId}`, { Cookie: 'CONSENT=YES+1' });
    if (text.includes('"isLiveNow":true')) return null;
  }
  // The video may have rotated; the app falls back to the channel's live stream, so accept that too.
  if (cam.channelId) {
    const { text } = await get(`https://www.youtube.com/channel/${cam.channelId}/live`, { Cookie: 'CONSENT=YES+1' });
    if (!text.includes('"isLiveNow":true')) return 'not live (video or channel)';
    const current = text.match(/"videoId":"([\w-]{11})"/)?.[1];
    return cam.videoId ? `WARN video rotated; channel is live now as videoId ${current}` : null;
  }
  return 'not live';
}

async function checkHls(cam) {
  const origin = { Origin: ORIGIN };
  const { res, text } = await get(cam.url, origin);
  if (!res.ok) return `HTTP ${res.status}`;
  if (!text.trimStart().startsWith('#EXTM3U')) return 'not an m3u8 playlist';
  if (!res.headers.get('access-control-allow-origin')) return 'no CORS header';
  // Master playlists list variants; make sure the first one loads too.
  const variant = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  if (variant && /\.m3u8(\?|$)/.test(variant)) {
    const sub = await get(new URL(variant, cam.url).href, origin);
    if (!sub.res.ok) return `variant HTTP ${sub.res.status}`;
    if (!sub.res.headers.get('access-control-allow-origin')) return 'variant has no CORS header';
  }
  return null;
}

const cams = JSON.parse(await readFile(FILE, 'utf8'));
const results = await Promise.all(cams.map(async (cam) => {
  try {
    return [cam, await (cam.type === 'hls' ? checkHls(cam) : checkYouTube(cam))];
  } catch (err) {
    return [cam, err.name === 'TimeoutError' ? 'timeout' : err.message];
  }
}));

const isDead = (p) => p && !p.startsWith('WARN');
let dead = 0;
for (const [cam, problem] of results) {
  if (isDead(problem)) dead++;
  const tag = !problem ? ' ok ' : isDead(problem) ? 'DEAD' : 'warn';
  console.log(`${tag}  ${cam.type.padEnd(7)} ${cam.id}${problem ? '  — ' + problem.replace(/^WARN /, '') : ''}`);
}
console.log(`\n${cams.length - dead} live, ${dead} dead`);

if (process.argv.includes('--prune') && dead) {
  const alive = results.filter(([, p]) => !isDead(p)).map(([c]) => c);
  await writeFile(FILE, JSON.stringify(alive, null, 2) + '\n');
  console.log(`Removed ${dead} dead camera(s) from cameras.json`);
}
