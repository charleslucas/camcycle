// Looks for new live cameras from the trusted sources in tools/sources.json.
//   node tools/discover-cameras.mjs           find new cameras and write them to tools/candidates.json for review
//   node tools/discover-cameras.mjs --accept  move reviewed candidates into cameras.json
//   node tools/discover-cameras.mjs --add     find new cameras and add them to cameras.json directly (for scheduled runs)
//
// Reviewing: in tools/candidates.json, fix any names/categories, and set "skip": true on cameras you don't want.
// --accept adds the rest to cameras.json and remembers skipped ones in tools/rejected.json so they're never suggested again.
// Requires Node 18+ (built-in fetch).

import { rm } from 'node:fs/promises';
import { CAMERAS_FILE, get, readJson, writeJson, mapLimit, checkEmbeddable, checkHls, channelLiveVideos } from './lib.mjs';
import * as cheerio from 'cheerio';

const SOURCES_FILE = new URL('./sources.json', import.meta.url);
const CANDIDATES_FILE = new URL('./candidates.json', import.meta.url);
const REJECTED_FILE = new URL('./rejected.json', import.meta.url);
const CALTRANS_SOURCE = 'https://cwwp2.dot.ca.gov/documentation/cctv/cctv.htm';
const INSECAM_BASE = 'http://www.insecam.org';
const INSECAM_MAX_PAGES = new URL('./max-pages.json', import.meta.url);

// A camera's identity is its video ID or stream URL, so renamed entries still count as known.
const keyOf = (cam) => (cam.type === 'rtsp' || cam.type === 'hls' || cam.type === 'mjpeg' ? cam.url : cam.videoId);

const slug = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

function uniqueId(base, taken) {
  let id = base || 'camera';
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

// "🔴 LIVE 24/7: Shark Cam | Monterey Bay Aquarium" -> "Shark Cam"
// `strip` is an optional regex (from sources.json) for channel boilerplate like "powered by EXPLORE.org".
function cleanTitle(title, strip) {
  // Separators between alternate titles ("渋谷… / Shibuya…"): keep the first. A bare "/" (as in "24/7") doesn't count.
  let s = title.split(/\s+[|•–—]\s+|\s*[｜／]\s*|\s+\/\s*|\s*\/\s+/)[0]
    .replace(/\p{Extended_Pictographic}|\p{Regional_Indicator}|️|[♫♪*]/gu, '')
    .replace(/\b(24\/7|24h|4K|UHD|HD|LIVE ?NOW|LIVE ?STREAM|LIVE|EN VIVO|IN DIRETTA|DIRECTO|DIRECT)\b/gi, '')
    .replace(/(^|\s)#[\p{L}\p{N}_]+/gu, ' ')                // hashtags
    .replace(/^\d{1,2}\/\d{1,2}\/\d{2,4}\s*-\s*/, '')       // leading dates like "07/10/26 - "
    .replace(/【\s*】|\[\s*\]|\(\s*\)|（\s*）/g, ' ');       // brackets left empty by the removals above
  // Strip repeatedly: removing one suffix can expose another ("… Webcam - Full").
  for (let prev; strip && prev !== s;) { prev = s; s = s.replace(strip, ' ').trim(); }
  s = s.replace(/^[\s:,\-–#]+|[\s:,\-–.#]+$/g, '').replace(/\s{2,}/g, ' ').trim();
  // Captions wrap badly past ~70 characters; cut at a word boundary.
  if (s.length > 70) s = s.slice(0, 70).replace(/\s+\S*$/, '') + '…';
  return s || title.trim();
}

// "Aquarium Cam (Baltimore, Maryland)" -> ["Aquarium Cam", "Baltimore, Maryland"].
// Only "Place, Region"-shaped parentheses count, so "Penguin Cam (Biologist View)" stays intact.
function splitLocation(name) {
  const m = name.match(/^(.+?)\s*\(([^()]+,[^()]+)\)$/);
  return m ? [m[1], m[2].trim()] : [name, ''];
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// insecam: extract country code from bycountry page.
function extractInsecamCountryCode(html) {
  const m = html.match(/\/en\/bycountry\/(\w+)\//);
  return m ? m[1] : null;
}

// insecam: extract manufacturer from camera page.
function extractInsecamManufacturer(html) {
  const m = html.match(/<a[^>]*>[\s\S]*?bytype\/(\w+)[^>]*<\/a>/i);
  return m ? m[1].toUpperCase() : 'Unknown';
}

// insecam: extract tags from camera page.
function extractInsecamTags(html) {
  const tags = [];
  const matches = html.match(/addtagset\("(\w+)"\);/g);
  if (matches) tags.push(...matches.map(m => m.match(/addtagset\("(\w+)"\)/)[1]));
  return tags;
}

// Decode HTML entities like &amp; -> &
function decodeHtmlEntities(str) {
  return str.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

// Extract location from img title attribute: "Click here to enter the camera located in Japan, region Tokyo, Мэгуро-Ку"
function extractLocationFromTitle(title) {
  const m = decodeHtmlEntities(title).match(/camera located in ([^,]+), region (.+)$/);
  if (m) {
    const country = m[1].trim();
    const region = m[2].trim();
    return { country, region };
  }
  return null;
}

// insecam: extract camera details from insecam camera page.
async function extractInsecamCamera(cameraId) {
  const url = `${INSECAM_BASE}/en/view/${cameraId}/`;
  const { res, text } = await get(url);
  if (!res.ok) return null;

  // Extract manufacturer
  const manufacturer = extractInsecamManufacturer(text);

  // Extract tags
  const tags = extractInsecamTags(text);

  // Extract image URL (stream) - decode HTML entities
  const imgMatch = text.match(/<img[^>]*id=["']image0["'][^>]*src=["']([^"']+)["']/);
  if (!imgMatch || imgMatch[1].includes('/static/no.jpg')) return null;

  let streamUrl = decodeHtmlEntities(imgMatch[1]);

  // Also extract location from the img title attribute
  const titleAttrMatch = text.match(/<img[^>]*id=["']image0["'][^>]*title=["']([^"']+)["']/i);
  let location = 'Unknown location';
  if (titleAttrMatch) {
    const loc = extractLocationFromTitle(titleAttrMatch[1]);
    if (loc) {
      location = `${loc.country}, ${loc.region}`;
    } else {
      location = 'Unknown location';
    }
  }

  // Determine if it's YouTube, HLS, or IP-based MJPEG snapshot stream
  let type = 'unknown', videoId = null, stream = null, name = `Camera ${cameraId}`;

  if (/youtube\.com\/watch\?v=/.test(streamUrl)) {
    type = 'youtube';
    const match = streamUrl.match(/youtube\.com\/watch\?v=([^&]+)/);
    videoId = match ? match[1] : null;
  } else if (streamUrl.endsWith('.m3u8') || streamUrl.includes('/live/')) {
    type = 'hls';
    stream = streamUrl;
  } else if (/\/webcapture\.jpg\?command=snap/.test(streamUrl)) {
    // Xiongmai (XMEye) cameras only serve single snapshots over HTTP, so they'd show a frozen frame.
    return null;
  } else if (/^(http|https):\/\//.test(streamUrl)) {
    // IP-based MJPEG snapshot or direct stream URL (most common for insecam)
    type = 'mjpeg';
    stream = streamUrl;
    // Vivotek snapshot URLs are single stills; the same host serves a browser-playable MJPEG stream.
    // Pattern: http://<host>/cgi-bin/viewer/video.jpg -> http://<host>/video.mjpg
    const vivotekMatch = streamUrl.match(/^(https?:\/\/[^\/]+)\/cgi-bin\/viewer\/video\.jpg(\?|$)/);
    if (vivotekMatch) stream = `${vivotekMatch[1]}/video.mjpg`;
    // Panasonic cameras likewise: http://<host>/SnapshotJPEG?... -> http://<host>/nphMotionJpeg?...
    const panasonicMatch = streamUrl.match(/^(https?:\/\/[^\/]+)\/SnapshotJPEG\?/);
    if (panasonicMatch) stream = `${panasonicMatch[1]}/nphMotionJpeg?Resolution=640x480&Quality=Standard`;
    // Other Panasonic models: http://<host>/cgi-bin/camera?resolution=N... -> http://<host>/cgi-bin/mjpeg?resolution=N
    const cgiCameraMatch = streamUrl.match(/^(https?:\/\/[^\/]+)\/cgi-bin\/camera\?(?:.*&)?resolution=(\d+)/);
    if (cgiCameraMatch) stream = `${cgiCameraMatch[1]}/cgi-bin/mjpeg?resolution=${cgiCameraMatch[2]}`;
    // Axis cameras: http://<host>/jpg/image.jpg... -> http://<host>/mjpg/video.mjpg
    const axisMatch = streamUrl.match(/^(https?:\/\/[^\/]+)\/jpg\/image\.jpg(\?|$)/);
    if (axisMatch) stream = `${axisMatch[1]}/mjpg/video.mjpg`;
    // nph-jpeg.cgi cameras: http://<host>/nph-jpeg.cgi?N -> http://<host>/nph-mjpeg.cgi?N
    const nphJpegMatch = streamUrl.match(/^(https?:\/\/[^\/]+)\/nph-jpeg\.cgi\?(\d+)/);
    if (nphJpegMatch) stream = `${nphJpegMatch[1]}/nph-mjpeg.cgi?${nphJpegMatch[2]}`;
    // Yawcam serves snapshots on its web port and the stream on its stream port (8081 by default).
    const yawcamMatch = streamUrl.match(/^(https?:\/\/[^\/:]+)(:\d+)?\/out\.jpg\?/);
    if (yawcamMatch) stream = `${yawcamMatch[1]}:8081/video.mjpg`;
  }

  // We accept mjpeg cameras - they may not be embeddable but are still valid cameras
  if (!videoId && !stream) return null;

  return {
    id: `insecam-${cameraId}`,
    name: location,
    type,
    videoId,
    stream,
    country: location,
    manufacturer,
    tags,
  };
}

// insecam: determine category from tags.
function getInsecamCategory(tags, countryCode) {
  const tagMap = {
    'city': 'cities', 'street': 'cities',
    'nature': 'nature', 'forest': 'nature', 'park': 'nature',
    'animal': 'animals', 'bird': 'animals',
    'traffic': 'traffic', 'highway': 'traffic', 'road': 'traffic',
    'beach': 'beaches', 'sea': 'harbors', 'port': 'harbors',
    'snow': 'mountains', 'ski': 'mountains',
    'volcano': 'nature',
  };

  for (const [tag, category] of Object.entries(tagMap)) {
    if (tags.includes(tag)) return category;
  }

  // Fallback: check for country-based categories
  const countryMap = {
    'JP': 'cities', 'CN': 'cities',
    'US': 'cities', 'CA': 'cities', 'AU': 'cities',
    'NO': 'mountains', 'CH': 'mountains', 'AT': 'mountains', 'DE': 'cities',
    'FR': 'cities', 'IT': 'villages',
    'ES': 'cities', 'PT': 'cities', 'GR': 'cities', 'HR': 'cities',
    'FI': 'cities', 'SE': 'cities', 'DK': 'cities', 'NL': 'cities', 'BE': 'cities',
  };

  for (const [code, category] of Object.entries(countryMap)) {
    if (countryCode && countryCode.toUpperCase() === code) return category;
  }

  return 'cities';
}

// insecam: get max page number for byrating listing.
async function getByRatingMaxPage() {
  const url = `${INSECAM_BASE}/en/byrating/?page=1`;
  const { res, text } = await get(url);
  if (!res.ok) return 1;

  const m = text.match(/pagenavigator\("\?page=", (\d+), \d+\);/);
  return m ? parseInt(m[1], 10) : 1;
}

// insecam: Sleep for specified milliseconds.
function insecamSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// insecam: discover cameras from insecam.org using byrating endpoint.
async function discoverInsecam(insecamConfig, known, ids) {
  // Use byrating endpoint instead of country-specific pages
  const maxPagesByRating = insecamConfig.maxPages ?? 50; // Default to 50 pages
  console.log(`  scraping byrating (${maxPagesByRating} pages)...`);

  const found = [];

  for (let page = 1; page <= maxPagesByRating; page++) {
    const url = `${INSECAM_BASE}/en/byrating/?page=${page}`;
    const { res, text } = await get(url);
    if (!res.ok) {
      console.log(`    ! page ${page}: HTTP ${res.status}`);
      continue;
    }

    // Extract camera IDs from view links: /en/view/12345/
    const cameraIds = new Set([...text.matchAll(/\/en\/view\/(\d+)\//g)].map(m => m[1]));

    for (const cameraId of cameraIds) {
      if (known.has(`insecam-${cameraId}`)) continue;

      const cam = await extractInsecamCamera(cameraId);
      if (!cam) continue;

      if (known.has(cam.id)) continue;

      // Check stream compatibility (but don't filter out incompatible ones)
      let compatibility = null;
      if (cam.type === 'youtube') {
        compatibility = await checkEmbeddable(cam.videoId).catch(() => 'unknown');
      } else if (cam.stream) {
        // For mjpeg streams, check if it's https (browsers can show some)
        if (cam.type === 'hls') {
          compatibility = await checkHls(cam.stream).catch(() => 'unknown');
        } else {
          compatibility = cam.stream.startsWith('http://') ? 'not https' : null;
        }
      }

      // Determine category from tags
      const category = getInsecamCategory(cam.tags, null);

      // Parse location from country string (format: "Country, Region")
      const locParts = cam.country.split(', ');
      const country = locParts.length >= 2 ? locParts[0] : cam.country;
      const region = locParts.length >= 2 ? locParts.slice(1).join(', ') : '';

      found.push({
        id: cam.id,
        name: cam.name,
        type: cam.type,
        videoId: cam.videoId,
        url: cam.stream,
        compatibility,
        category,
        country: country,
        location: region,
        credit: 'insecam.org',
        source: INSECAM_BASE,
        insecamId: cameraId,
        manufacturer: cam.manufacturer,
        tags: cam.tags,
      });

      known.add(cam.id);
      ids.add(cam.id);
    }

    // Sleep to avoid rate limiting between pages
    await insecamSleep(1000);
  }

  return found;
}

// perChannel: how many cameras each channel already has (in the list or awaiting review).
async function discoverYouTube(channels, defaults, perChannel, known, ids) {
  const regex = (s) => s && new RegExp(s, 'i');
  const globalExclude = regex(defaults.exclude);
  const strip = regex(defaults.strip);
  const found = [];
  await mapLimit(channels, 4, async (ch) => {
    // Cap each channel so big networks (EarthCam, Venice) don't crowd out everything else in the shuffle.
    const room = (ch.max ?? defaults.maxPerChannel ?? Infinity) - (perChannel.get(ch.channelId) ?? 0);
    if (room <= 0) return;
    let live;
    try {
      live = await channelLiveVideos(ch.channelId);
    } catch (err) {
      console.warn(`  ! ${ch.channel}: ${err.message}`);
      return;
    }
    const include = regex(ch.include);
    const exclude = regex(ch.exclude);
    let added = 0;
    for (const { videoId, title } of live) {
      if (added >= room) break;
      if (known.has(videoId) || (include && !include.test(title))) continue;
      if ((exclude && exclude.test(title)) || (globalExclude && globalExclude.test(title))) continue;
      known.add(videoId);
      const why = await checkEmbeddable(videoId).catch((err) => err.message);
      if (why) { console.log(`  - ${ch.channel}: "${title}" skipped (${why})`); continue; }
      // Titles only supply the location for channels that cover many places.
      let name = cleanTitle(title, strip);
      let location = ch.location;
      if (!location) [name, location] = splitLocation(name);
      found.push({
        id: uniqueId(slug(name), ids), name, type: 'youtube', videoId, channelId: ch.channelId,
        channel: ch.channel, category: ch.category, location, country: ch.country,
        credit: ch.channel, source: `https://www.youtube.com/watch?v=${videoId}`, title,
      });
      added++;
    }
  });
  return found;
}

// listed: every camera in the list, awaiting review, or found earlier this run (used for the traffic share cap).
async function discoverCaltrans(cfg, known, ids, listed) {
  // Keep traffic cams to at most maxShare of the list: t / (t + others) <= share  =>  t <= share * others / (1 - share).
  const traffic = listed.filter((c) => c.category === cfg.category).length;
  const allowed = cfg.maxShare == null ? Infinity
    : Math.floor((cfg.maxShare * (listed.length - traffic)) / (1 - cfg.maxShare)) - traffic;
  const limit = Math.min(cfg.maxPerRun ?? Infinity, allowed);
  if (limit <= 0) {
    console.log(`  skipped: ${traffic} of ${listed.length} cameras are already ${cfg.category} (cap ${cfg.maxShare * 100}%)`);
    return [];
  }
  const match = cfg.match && new RegExp(cfg.match, 'i');
  const pool = [];
  for (const d of cfg.districts) {
    const url = `https://cwwp2.dot.ca.gov/data/d${d}/cctv/cctvStatusD${String(d).padStart(2, '0')}.json`;
    try {
      const { res, text } = await get(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      for (const { cctv } of JSON.parse(text).data) {
        const stream = cctv.imageData?.streamingVideoURL;
        const loc = cctv.location;
        if (cctv.inService !== 'true' || !stream || known.has(stream)) continue;
        if (match && !match.test(`${loc.locationName} ${loc.nearbyPlace}`)) continue;
        pool.push({ stream, loc });
      }
    } catch (err) {
      console.warn(`  ! Caltrans district ${d}: ${err.message}`);
    }
  }
  console.log(`  ${pool.length} matching Caltrans cameras not in the list yet; checking a random few`);

  // Caltrans has hundreds of matching cameras and many are offline at any moment,
  // so check a shuffled pool in small batches until we have enough working ones.
  const found = [];
  shuffle(pool);
  while (pool.length && found.length < limit) {
    const batch = pool.splice(0, 8);
    const results = await mapLimit(batch, 8, ({ stream }) => checkHls(stream).catch((err) => err.message));
    batch.forEach(({ stream, loc }, i) => {
      if (results[i] || found.length >= limit) return;
      known.add(stream);
      // Drop camera codes: "TV102 -- I-580 : West of SR-24" -> "I-580 West of SR-24",
      // "I-5 (95) El Toro Road" -> "I-5 El Toro Road", "(C513) I-5 SB…" -> "I-5 SB…", "29 - NB SR-99…" -> "NB SR-99…"
      const name = loc.locationName.replace(/^.*?--\s*/, '').replace(/\s*:\s*/g, ' ')
        .replace(/\([A-Z]?\d+\)\s*/g, '').replace(/^\d+\s*-\s*/, '').replace(/_/g, ' ')
        .replace(/\s{2,}/g, ' ').trim();
      found.push({
        id: uniqueId('caltrans-' + slug(name), ids), name, type: 'hls', url: stream,
        category: cfg.category, location: `${loc.nearbyPlace}, California`, country: 'US',
        credit: 'Caltrans', source: CALTRANS_SOURCE,
      });
    });
  }
  return found;
}

async function accept() {
  const candidates = await readJson(CANDIDATES_FILE, null);
  if (!candidates) return console.log('No tools/candidates.json to accept. Run without --accept first.');
  const cams = await readJson(CAMERAS_FILE);
  const rejected = await readJson(REJECTED_FILE, []);
  const known = new Set(cams.map(keyOf));
  let added = 0;
  for (const { skip, title, ...cam } of candidates) {
    if (skip) { rejected.push(keyOf(cam)); continue; }
    if (known.has(keyOf(cam))) continue;
    cams.push(cam);
    known.add(keyOf(cam));
    added++;
  }
  await writeJson(CAMERAS_FILE, cams);
  await writeJson(REJECTED_FILE, [...new Set(rejected)]);
  await rm(CANDIDATES_FILE);
  console.log(`Added ${added} camera(s) to cameras.json; ${candidates.length - added} skipped or already present.`);
}

async function discover(addDirectly, maxPagesOverride) {
  const sources = await readJson(SOURCES_FILE);
  const cams = await readJson(CAMERAS_FILE);
  const rejected = await readJson(REJECTED_FILE, []);
  const pending = await readJson(CANDIDATES_FILE, []);
  // Don't re-suggest anything already listed, rejected, or waiting for review.
  const known = new Set([...cams.map(keyOf), ...rejected, ...pending.map(keyOf)]);
  const ids = new Set([...cams, ...pending].map((c) => c.id));
  const perChannel = new Map();
  for (const c of [...cams, ...pending]) if (c.channelId) perChannel.set(c.channelId, (perChannel.get(c.channelId) ?? 0) + 1);

  // Override max pages if provided via CLI
  let insecamConfig = sources.insecam ?? {};
  if (maxPagesOverride > 0) {
    insecamConfig = { ...insecamConfig, maxPages: maxPagesOverride };
  }

  console.log(`Checking ${sources.youtube?.length ?? 0} YouTube channels…`);
  const found = await discoverYouTube(sources.youtube ?? [], sources.defaults ?? {}, perChannel, known, ids);
  if (sources.caltrans) {
    console.log('Checking Caltrans…');
    found.push(...await discoverCaltrans(sources.caltrans, known, ids, [...cams, ...pending, ...found]));
  }
  if (sources.insecam) {
    console.log('Checking insecam.org…');
    found.push(...await discoverInsecam(insecamConfig, known, ids));
  }

  console.log(`\nFound ${found.length} new camera(s):`);
  for (const c of found) console.log(`  + [${c.category}] ${c.name}${c.location ? ' — ' + c.location : ''}  (${c.credit})`);
  if (!found.length) return;

  if (addDirectly) {
    await writeJson(CAMERAS_FILE, [...cams, ...found.map(({ title, ...c }) => c)]);
    console.log('\nAdded them to cameras.json.');
  } else {
    await writeJson(CANDIDATES_FILE, [...pending, ...found]);
    console.log('\nWrote tools/candidates.json. Review it (set "skip": true on any you don\'t want), then run with --accept.');
  }
}

if (process.argv.includes('--accept')) await accept();
else {
  const maxPagesArg = process.argv.find(arg => arg.startsWith('--max-pages='));
  const maxPages = maxPagesArg ? parseInt(maxPagesArg.split('=')[1], 10) : 0;
  await discover(process.argv.includes('--add'), maxPages);
}
