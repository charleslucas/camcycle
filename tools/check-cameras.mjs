// Checks every camera in cameras.json and reports which ones are live.
//   node tools/check-cameras.mjs            report only
//   node tools/check-cameras.mjs --prune    also remove dead cameras from cameras.json
// Requires Node 18+ (built-in fetch).

import { CAMERAS_FILE, get, readJson, writeJson, mapLimit, checkEmbeddable, checkHls } from './lib.mjs';

async function checkYouTube(cam) {
  if (cam.videoId) {
    const notEmbeddable = await checkEmbeddable(cam.videoId);
    if (notEmbeddable) return notEmbeddable;
    const { text } = await get(`https://www.youtube.com/watch?v=${cam.videoId}`);
    if (text.includes('"isLiveNow":true')) return null;
  }
  // The video may have rotated; the app falls back to the channel's live stream, so accept that too.
  if (cam.channelId) {
    const { text } = await get(`https://www.youtube.com/channel/${cam.channelId}/live`);
    if (!text.includes('"isLiveNow":true')) return 'not live (video or channel)';
    const current = text.match(/"videoId":"([\w-]{11})"/)?.[1];
    return cam.videoId ? `WARN video rotated; channel is live now as videoId ${current}` : null;
  }
  return 'not live';
}

const cams = await readJson(CAMERAS_FILE);
const results = await mapLimit(cams, 8, async (cam) => {
  try {
    return [cam, await (cam.type === 'hls' || cam.type === 'rtsp' ? checkHls(cam.url) : checkYouTube(cam))];
  } catch (err) {
    return [cam, err.name === 'TimeoutError' ? 'timeout' : err.message];
  }
});

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
  await writeJson(CAMERAS_FILE, alive);
  console.log(`Removed ${dead} dead camera(s) from cameras.json`);
}
