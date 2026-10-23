// Discovers new live cameras from insecam.org.
//   node tools/insecam-discover.mjs         find new cameras and write them to tools/candidates.json for review
//   node tools/insecam-discover.mjs --accept move reviewed candidates into cameras.json
//   node tools/insecam-discover.mjs --add    find new cameras and add them to cameras.json directly (for scheduled runs)
//   --max-pages=N                           scrape at most N listing pages per country
//
// Reviewing: in tools/candidates.json, fix any names/categories, and set "skip": true on cameras you don't want.
// --accept adds the rest to cameras.json and remembers skipped ones in tools/rejected.json so they're never suggested again.
// Requires Node 18+ (built-in fetch).

import { readFile, writeFile, rm } from 'node:fs/promises';

const CAMERAS_FILE = new URL('../cameras.json', import.meta.url);
const CANDIDATES_FILE = new URL('./candidates.json', import.meta.url);
const REJECTED_FILE = new URL('./rejected.json', import.meta.url);

// A camera's identity is its video ID or stream URL, matching the keys stored in rejected.json.
const keyOf = (cam) => (cam.type === 'hls' ? cam.url : cam.videoId);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

async function readJson(url, fallback) {
  try { return JSON.parse(await readFile(url, 'utf8')); } catch (err) {
    if (fallback !== undefined && err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJson(url, data) {
  await writeFile(url, JSON.stringify(data, null, 2) + '\n');
}
const INSECAM_BASE = 'http://www.insecam.org';
const INSECAM_COUNTRIES = `${INSECAM_BASE}/en/jsoncountries/`;

// Runs fn over items with at most `limit` in flight.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const n = i++;
      out[n] = await fn(items[n], n);
    }
  }));
  return out;
}

// Fetch a URL with timeout and user agent.
async function get(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US' },
    signal: AbortSignal.timeout(15000),
  });
  return { res, text: await res.text() };
}

// Check if a YouTube video is embeddable.
async function checkEmbeddable(videoId) {
  const res = await fetch(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${videoId}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 401) return 'embedding disabled';
  if (!res.ok) return `oembed ${res.status}`;
  return null;
}

// Check if an HLS stream is playable from another site (https + CORS).
async function checkHls(url) {
  if (!url.startsWith('https://')) return 'not https';
  const origin = { Origin: 'https://example.github.io' };
  const { res, text } = await get(url, origin);
  if (!res.ok) return `HTTP ${res.status}`;
  if (!text.trimStart().startsWith('#EXTM3U')) return 'not an m3u8 playlist';
  if (!res.headers.get('access-control-allow-origin')) return 'no CORS header';
  const variant = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  if (variant && /\.m3u8(\?|$)/.test(variant)) {
    const sub = await get(new URL(variant, url).href, origin);
    if (!sub.res.ok) return `variant HTTP ${sub.res.status}`;
    if (!sub.res.headers.get('access-control-allow-origin')) return 'variant has no CORS header';
  }
  return null;
}

// Extract country code from insecam page.
function extractCountryCode(html) {
  const m = html.match(/\/en\/bycountry\/(\w+)\//);
  return m ? m[1] : null;
}

// Extract camera details from insecam camera page.
async function extractCamera(cameraId) {
  const url = `${INSECAM_BASE}/en/view/${cameraId}/`;
  const { res, text } = await get(url);
  if (!res.ok) return null;

  const countryCode = extractCountryCode(text);
  
  // Extract country name from page
  const countryMatch = text.match(/<span class="[^"]*country[^"]*"[^>]*>[\s\S]*?<\/span>/i);
  const country = countryMatch ? countryMatch[0].replace(/<[^>]*>/g, '').trim() : 'Unknown location';
  
  // Extract manufacturer from page
  const manufacturerMatch = text.match(/<a[^>]*>[\s\S]*?bytype\/(\w+)[^>]*<\/a>/i);
  const manufacturer = manufacturerMatch ? manufacturerMatch[1].toUpperCase() : 'Unknown';
  
  // Extract tags
  const tags = [];
  const tagMatches = text.match(/addtagset\("(\w+)"\);/g);
  if (tagMatches) tags.push(...tagMatches.map(m => m.match(/addtagset\("(\w+)"\)/)[1]));
  
  // Extract image URL (stream)
  const imgMatches = text.match(/<img[^>]*id=["']image0["'][^>]*src=["']([^"']+)["']/);
  if (!imgMatches || imgMatches[1].includes('/static/no.jpg')) return null;
  
  const streamUrl = imgMatches[1];
  
  // Determine if it's YouTube or HLS
  let type = 'unknown', videoId = null, stream = null, name = `Camera ${cameraId}`;
  
  if (/youtube\.com\/watch\?v=/.test(streamUrl)) {
    type = 'youtube';
    const match = streamUrl.match(/youtube\.com\/watch\?v=([^&]+)/);
    videoId = match ? match[1] : null;
  } else if (streamUrl.endsWith('.m3u8') || streamUrl.includes('/live/')) {
    type = 'hls';
    stream = streamUrl;
  }
  
  if (!videoId && !stream) return null;
  
  return {
    id: `insecam-${cameraId}`,
    name,
    type,
    videoId,
    url: stream,
    country,
    manufacturer,
    tags,
    source: INSECAM_BASE,
    insecamId: cameraId,
    countryCode,
  };
}

// Determine category from tags.
function getCategory(tags, countryCode) {
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

// Slugify for unique IDs.
function slug(s) {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
}

function uniqueId(base, taken) {
  let id = base || 'camera';
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

// Get max page number for a country.
async function getMaxPage(countryCode) {
  const url = `${INSECAM_BASE}/en/bycountry/${countryCode}/`;
  const { res, text } = await get(url);
  if (!res.ok) return 1;
  
  const m = text.match(/pagenavigator\("\?page=", (\d+), \d+\);/);
  return m ? parseInt(m[1], 10) : 1;
}

// Check if camera ID already exists.
const knownCameras = new Set([
  ...['montereybay', 'sanfrancisco', 'seattle', 'la', 'chicago', 'boston', 'nyc', 'miami'].map(s => `insecam-${s}`),
]);

async function discover(cameras, rejected, candidates, maxPages, verbose) {
  const ids = new Set([...cameras, ...candidates].map(c => c.id));
  // Don't re-suggest anything already listed, rejected, or waiting for review.
  const known = new Set([...cameras.map(keyOf), ...rejected, ...candidates.map(keyOf)]);
  const perCountry = new Map();
  
  for (const c of cameras) {
    if (c.country) {
      const count = perCountry.get(c.country) || 0;
      perCountry.set(c.country, count + 1);
    }
  }
  
  const found = [];
  
  for (const [countryCode, max] of Object.entries(maxPages)) {
    const skip = perCountry.get(countryCode) && perCountry.get(countryCode) >= (max || 10);
    if (skip && !verbose) {
      console.log(`  skipping ${countryCode} (already have ${perCountry.get(countryCode)} cameras)`);
      continue;
    }
    
    console.log(`  scraping ${countryCode} (${max} pages)...`);
    
    for (let page = 1; page <= max; page++) {
      const url = `${INSECAM_BASE}/en/bycountry/${countryCode}/?page=${page}`;
      const { res, text } = await get(url);
      if (!res.ok) {
        console.log(`    ! page ${page}: HTTP ${res.status}`);
        continue;
      }
      
      // Each camera on a listing page links to its view page, /en/view/<numeric id>/.
      const cameraIds = new Set([...text.matchAll(/\/en\/view\/(\d+)\//g)].map((m) => m[1]));

      for (const cameraId of cameraIds) {
        if (ids.has(`insecam-${cameraId}`)) continue;

        const cam = await extractCamera(cameraId);
        if (!cam) continue;
        
        if (ids.has(cam.id) || known.has(keyOf(cam))) continue;

        // Check embeddability
        const why = cam.type === 'youtube' 
          ? await checkEmbeddable(cam.videoId).catch(() => 'unknown')
          : await checkHls(cam.url).catch(() => 'unknown');
        
        if (why && !verbose) {
          console.log(`    - ${cam.id}: "${cam.name}" skipped (${why})`);
          continue;
        }
        
        // Determine category
        const category = getCategory(cam.tags, cam.countryCode);
        
        found.push({
          id: cam.id,
          name: cam.name,
          type: cam.type,
          // Same shape as cameras.json: YouTube cameras carry videoId, HLS cameras carry url.
          ...(cam.type === 'hls' ? { url: cam.url } : { videoId: cam.videoId }),
          category,
          // cameras.json uses two-letter codes for country; the full name goes in location.
          country: cam.countryCode?.toUpperCase() ?? '',
          location: cam.country,
          credit: 'insecam.org',
          source: INSECAM_BASE,
          insecamId: cam.insecamId,
          manufacturer: cam.manufacturer,
          tags: cam.tags,
        });
        
        ids.add(cam.id);
        known.add(keyOf(cam));

        if (verbose) console.log(`    + [${category}] ${cam.name} (${cam.type})`);
      }
    }
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
  await rm(CANDIDATES_FILE).catch(() => {});
  console.log(`Added ${added} camera(s) to cameras.json; ${candidates.length - added} skipped or already present.`);
}

async function discoverInsecam(addDirectly, verbose, maxPages) {
  const cameras = await readJson(CAMERAS_FILE, []);
  const rejected = await readJson(REJECTED_FILE, []);
  const pending = await readJson(CANDIDATES_FILE, []);
  const maxPagesJson = await readJson(new URL('./max-pages.json', import.meta.url), {});
  // --max-pages=N caps every country at N pages, on top of its limit in max-pages.json.
  if (maxPages > 0) {
    for (const code of Object.keys(maxPagesJson)) maxPagesJson[code] = Math.min(maxPagesJson[code], maxPages);
  }

  const known = new Set([...cameras.map(keyOf), ...rejected, ...pending.map(keyOf)]);
  
  if (verbose) {
    console.log(`Known: ${known.size} cameras`);
    console.log(`Rejected: ${rejected.length} cameras`);
    console.log(`Pending: ${pending.length} cameras`);
  }
  
  const found = await discover(cameras, rejected, pending, maxPagesJson, verbose);
  
  console.log(`\nFound ${found.length} new camera(s):`);
  for (const c of found) {
    console.log(`  + [${c.category}] ${c.name}${c.location ? ' — ' + c.location : ''}  (${c.credit})`);
  }
  
  if (!found.length) return;
  
  if (addDirectly) {
    await writeJson(CAMERAS_FILE, [...cameras, ...found.map(({ title, ...c }) => c)]);
    console.log('\nAdded them to cameras.json.');
  } else {
    await writeJson(CANDIDATES_FILE, [...pending, ...found]);
    console.log('\nWrote tools/candidates.json. Review it (set "skip": true on any you don\'t want), then run with --accept.');
  }
}

if (process.argv.includes('--accept')) {
  await accept();
} else {
  const verbose = process.argv.includes('--verbose');
  const addDirectly = process.argv.includes('--add');
  const maxPagesArg = process.argv.find(arg => arg.startsWith('--max-pages='));
  const maxPages = maxPagesArg ? parseInt(maxPagesArg.split('=')[1], 10) : undefined;
  await discoverInsecam(addDirectly, verbose, maxPages);
}