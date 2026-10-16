// Shared helpers for the camera tools. Requires Node 18+ (built-in fetch).

import { readFile, writeFile } from 'node:fs/promises';

export const CAMERAS_FILE = new URL('../cameras.json', import.meta.url);
const ORIGIN = 'https://example.github.io';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

export async function get(url, headers = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US', Cookie: 'CONSENT=YES+1', ...headers },
    signal: AbortSignal.timeout(15000),
  });
  return { res, text: await res.text() };
}

export async function readJson(url, fallback) {
  try { return JSON.parse(await readFile(url, 'utf8')); } catch (err) {
    if (fallback !== undefined && err.code === 'ENOENT') return fallback;
    throw err;
  }
}

export async function writeJson(url, data) {
  await writeFile(url, JSON.stringify(data, null, 2) + '\n');
}

// Runs fn over items with at most `limit` in flight, so we don't hammer anyone's servers.
export async function mapLimit(items, limit, fn) {
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

// Returns null if YouTube allows embedding this video, otherwise the reason it doesn't.
export async function checkEmbeddable(videoId) {
  const res = await fetch(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${videoId}`, {
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 401) return 'embedding disabled';
  if (!res.ok) return `oembed ${res.status}`;
  return null;
}

// Returns null if the HLS stream is playable from a browser on another site (https + CORS), otherwise why not.
export async function checkHls(url) {
  if (!url.startsWith('https://')) return 'not https';
  const origin = { Origin: ORIGIN };
  const { res, text } = await get(url, origin);
  if (!res.ok) return `HTTP ${res.status}`;
  if (!text.trimStart().startsWith('#EXTM3U')) return 'not an m3u8 playlist';
  if (!res.headers.get('access-control-allow-origin')) return 'no CORS header';
  // Master playlists list variants; make sure the first one loads too.
  const variant = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  if (variant && /\.m3u8(\?|$)/.test(variant)) {
    const sub = await get(new URL(variant, url).href, origin);
    if (!sub.res.ok) return `variant HTTP ${sub.res.status}`;
    if (!sub.res.headers.get('access-control-allow-origin')) return 'variant has no CORS header';
  }
  return null;
}

// Lists the videos a channel is streaming right now, read from the LIVE badges on its Live tab.
// (Channel pages aren't bot-blocked the way watch pages are.)
export async function channelLiveVideos(channelId) {
  const { res, text } = await get(`https://www.youtube.com/channel/${channelId}/streams`);
  if (!res.ok) throw new Error(`channel page HTTP ${res.status}`);
  const m = text.match(/var ytInitialData = (\{.*?\});<\/script>/s);
  if (!m) throw new Error('channel page had no ytInitialData');
  const found = new Map();
  (function walk(o) {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== 'object') return;
    const lockup = o.lockupViewModel;
    if (lockup?.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
      const badges = JSON.stringify(lockup.contentImage ?? lockup);
      if (/"text":"LIVE"/.test(badges) && !found.has(lockup.contentId)) {
        found.set(lockup.contentId, lockup.metadata?.lockupMetadataViewModel?.title?.content ?? '');
      }
      return;
    }
    Object.values(o).forEach(walk);
  })(JSON.parse(m[1]));
  return [...found].map(([videoId, title]) => ({ videoId, title }));
}
