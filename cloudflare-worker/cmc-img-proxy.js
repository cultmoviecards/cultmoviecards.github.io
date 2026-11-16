// CMC image proxy: a Cloudflare Worker that re-serves Bluesky card images with a CORS header,
// so the 3D slab viewer (WebGL) is allowed to use them as textures.
//
//   GET https://<worker-address>/?url=cdn.bsky.app/img/feed_thumbnail/plain/did:plc:.../bafk...@jpeg
//
// Served from img.cultmovie.cards (see wrangler.toml). Deploy with: npx wrangler deploy
// Only still images on the Bluesky CDN are served, so this cannot be used as an open proxy.

const ALLOWED_HOST = 'cdn.bsky.app';
const ALLOWED_PATH = '/img/';
const CACHE_SECONDS = 60 * 60 * 24 * 30;   // card images never change at a given URL

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

const fail = (status, message) =>
  new Response(message, { status, headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'Method not allowed');

    const raw = new URL(request.url).searchParams.get('url') || '';
    let target;
    try { target = new URL('https://' + raw.replace(/^https?:\/\//i, '')); }
    catch { return fail(400, 'Missing or invalid url parameter'); }

    if (target.hostname !== ALLOWED_HOST || !target.pathname.startsWith(ALLOWED_PATH)) {
      return fail(403, 'Only Bluesky card images are served here');
    }

    // Cloudflare caches the upstream image at the edge, so Bluesky is only asked once per image.
    const upstream = await fetch(target.toString(), {
      cf: { cacheEverything: true, cacheTtl: CACHE_SECONDS },
    });
    if (!upstream.ok) return fail(502, 'Upstream returned ' + upstream.status);

    const type = upstream.headers.get('Content-Type') || '';
    if (!type.startsWith('image/')) return fail(415, 'Not an image');

    return new Response(upstream.body, {
      status: 200,
      headers: {
        ...CORS,
        'Content-Type': type,
        'Cache-Control': `public, max-age=${CACHE_SECONDS}, immutable`,
      },
    });
  },
};
