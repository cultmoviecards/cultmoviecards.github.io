// CMC image proxy: a Cloudflare Worker that re-serves Bluesky card images with a CORS header,
// so the 3D slab viewer (WebGL) is allowed to use them as textures.
//
//   GET https://img.cultmovie.cards/?url=cdn.bsky.app/img/feed_thumbnail/plain/did:plc:.../bafk...@jpeg
//
// Served from img.cultmovie.cards (see wrangler.toml). Deploy with: npx wrangler deploy
// Only still images on the Bluesky CDN are served, so this cannot be used as an open proxy.
//
// Caching: successful images are stored in Cloudflare's cache for 30 days. Errors are never stored,
// so a passing hiccup at Bluesky cannot leave a card broken. A failed fetch is retried once.

const ALLOWED_HOST = 'cdn.bsky.app';
const ALLOWED_PATH = '/img/';
const CACHE_SECONDS = 60 * 60 * 24 * 30;   // card images never change at a given URL
const RETRY_DELAY_MS = 300;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

const fail = (status, message) =>
  new Response(message, { status, headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

async function fetchImage(target) {
  let last = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      // cacheTtl: 0 keeps Cloudflare's fetch cache out of it; we do our own caching below, successes only.
      const res = await fetch(target, { cf: { cacheTtl: 0, cacheEverything: false } });
      if (res.ok) return res;
      last = res.status;
      if (res.status < 500) break;   // a 4xx will not get better by asking again
      await res.body?.cancel();
    } catch (e) { last = 'network error'; }
    if (attempt === 1) await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
  }
  return { failed: last };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'Method not allowed');

    const raw = new URL(request.url).searchParams.get('url') || '';
    let target;
    try { target = new URL('https://' + raw.replace(/^https?:\/\//i, '')); }
    catch { return fail(400, 'Missing or invalid url parameter'); }

    if (target.hostname !== ALLOWED_HOST || !target.pathname.startsWith(ALLOWED_PATH)) {
      return fail(403, 'Only Bluesky card images are served here');
    }

    const cache = caches.default;
    const key = new Request(request.url, { method: 'GET' });
    const hit = await cache.match(key);
    if (hit) return hit;

    // Bluesky ignores this parameter. It gives the upstream request a fresh cache key, so error responses
    // that an earlier version of this Worker cached at Cloudflare (for up to 30 days) are never read back.
    target.searchParams.set('cmc', '2');
    const upstream = await fetchImage(target.toString());
    if (upstream.failed !== undefined) return fail(502, 'Upstream returned ' + upstream.failed);

    const type = upstream.headers.get('Content-Type') || '';
    if (!type.startsWith('image/')) return fail(415, 'Not an image');

    const out = new Response(upstream.body, {
      status: 200,
      headers: {
        ...CORS,
        'Content-Type': type,
        'Cache-Control': `public, max-age=${CACHE_SECONDS}, immutable`,
      },
    });
    ctx.waitUntil(cache.put(key, out.clone()));   // only successes get here
    return out;
  },
};
