// Prewarm: asks the image Worker for every Bluesky card image in database.js once, so Bluesky and
// Cloudflare have each one ready before a visitor opens it. Safe to re-run: images that are already
// warm come back quickly, and only the new ones take time.
//
//   node cloudflare-worker/prewarm.js              warm everything
//   node cloudflare-worker/prewarm.js --limit 20   try just the first 20
//   node cloudflare-worker/prewarm.js --dry        list what would be requested, request nothing
//
// It is deliberately gentle: a few requests at a time with a short pause between batches, and it
// stops straight away if the Worker or Bluesky starts refusing requests.

const fs = require('fs'), path = require('path');

const WORKER = 'https://img.cultmovie.cards/';
const CONCURRENCY = 4;          // requests in flight at once
const PAUSE_MS = 250;           // pause after each batch
const MAX_IN_A_ROW_FAILS = 5;   // stop if this many requests fail one after another
const RETRY_DELAY_MS = 1500;

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const li = args.indexOf('--limit');
const limit = li >= 0 ? Number(args[li + 1]) : Infinity;
if (li >= 0 && !(limit > 0)) { console.error('--limit needs a number, e.g. --limit 20'); process.exit(1); }

const db = fs.readFileSync(path.join(__dirname, '..', 'database.js'), 'utf8');
const urls = [...new Set(db.match(/https:\/\/cdn\.bsky\.app\/img\/[^"'\s]+/g) || [])].slice(0, limit);
console.log(`${urls.length} Bluesky card images${dry ? ' (dry run, nothing requested)' : ''}`);
if (dry || !urls.length) process.exit(0);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const endpoint = u => WORKER + '?url=' + encodeURIComponent(u.replace(/^https?:\/\//, ''));

async function warm(u) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(endpoint(u));
      await res.arrayBuffer();   // read the whole image so it is fully cached
      if (res.ok) return { ok: true };
      if (res.status === 429) return { ok: false, status: 429, stop: true };
      if (attempt === 2) return { ok: false, status: res.status };
    } catch (e) {
      if (attempt === 2) return { ok: false, status: 'network error' };
    }
    await sleep(RETRY_DELAY_MS);
  }
}

(async () => {
  const t0 = Date.now(); let done = 0, ok = 0, run = 0; const failed = [];
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(warm));
    results.forEach((r, j) => {
      done++;
      if (r.ok) { ok++; run = 0; } else { failed.push(`${r.status}  ${batch[j]}`); run++; }
    });
    if (results.some(r => r.stop)) { console.error('Rate limit (429) received. Stopping.'); break; }
    if (run >= MAX_IN_A_ROW_FAILS) { console.error(`${run} failures in a row. Stopping.`); break; }
    if (done % 100 < CONCURRENCY || done === urls.length) process.stdout.write(`\r${done}/${urls.length} done, ${failed.length} failed   `);
    await sleep(PAUSE_MS);
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nFinished in ${secs}s: ${ok} warmed, ${failed.length} failed, ${urls.length - done} not attempted.`);
  if (failed.length) { console.log('Failures:'); failed.slice(0, 20).forEach(f => console.log('  ' + f)); if (failed.length > 20) console.log(`  ...and ${failed.length - 20} more`); }
})();
