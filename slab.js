// CMC 3D slab viewer. Loaded on demand (the first time someone clicks SLAB VIEW), so it costs nothing until then.
// index.html calls: showSlab(container, cardInfo) -> Promise<{ ok, reason? }>, hideSlab(), slabFlip(), slabColour(), slabReset().
// The card art is fetched through a CORS-enabled image proxy: the Bluesky CDN does not allow WebGL to use its images directly.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

// Our own Cloudflare Worker (source: cloudflare-worker/) serves the card art. If it fails twice, the caller falls back to the flat card.
const PROXY_HOST = 'img.cultmovie.cards';
// Bluesky images and still PNG/JPEG/WebP files on postimg can be shown; GIFs and everything else stay flat. Keep in step with slabEligible in index.html and the Worker.
const isSlabImage = u => /^https?:\/\/cdn\.bsky\.app\/img\//i.test(String(u || '')) || /^https?:\/\/i\.postimg\.cc\/.+\.(png|jpe?g|webp)$/i.test(String(u || ''));
const proxied = u => `https://${PROXY_HOST}/?url=` + encodeURIComponent(u.replace(/^https?:\/\//, ''));

const PALETTES = {
  synth:  { name: 'SYNTH TEAL / MAGENTA', a: '#12c9c4', mid: '#5a35d8', b: '#d61fd2' },
  hammer: { name: 'HAMMER LIME / YELLOW', a: '#1fdc57', mid: '#8fe83a', b: '#f0ff3a' },
  blood:  { name: 'BLOOD RED / AMBER',    a: '#ff2d3a', mid: '#c4185a', b: '#ff9a2e' },
  ice:    { name: 'ICE CYAN / VIOLET',    a: '#6fe0ff', mid: '#9ab4ff', b: '#8a6bff' },
  smoke:  { name: 'SMOKE STEEL / PURPLE', a: '#8798b0', mid: '#5d5a86', b: '#b07cff' },
};
const GRADES = [['NM', '7'], ['NM-MT', '8'], ['MINT', '9'], ['GEM MT', '10']];
const hash = s => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

let S = null;   // live viewer state; null while closed
let token = 0;  // cancels a load that was overtaken by a newer one

// ---- what goes on the label, worked out from the database entry ------------------------------------------
function describe(info) {
  const raw = String(info.setName || '').replace(/_/g, ' ').trim();
  const hadSeries = /\sseries$/i.test(raw);
  const base = raw.replace(/\sseries$/i, '').toUpperCase();
  const suffix = String(info.id || '').split('#')[1] || '';
  const num = /^\d+$/.test(suffix) ? String(parseInt(suffix, 10)) : suffix;
  const series = `CMC '${base}'${hadSeries ? ' SERIES' : ''}`;
  const cap = String(info.caption || '').trim();
  const m = cap.match(/^(.*?)\s*\((\d{4})\)\s*$/);
  const date = String(info.date || '');
  const lines = m
    ? [`${m[2]} ${m[1].toUpperCase()}`, `${series} #${num}`, `${info.id} · ISSUED ${date}`]
    : [series, `#${num}${cap ? ` "${cap.toUpperCase()}"` : ''}`, `${info.id} · ISSUED ${date}`];
  const cert = (date.split('/').join('') || '000000') + '-' + (/^\d+$/.test(num) ? num.padStart(2, '0') : num);
  const palettes = ['synth', 'blood'];   // the automatic choices; the COLOUR button reaches all five
  const palette = /hammer/i.test(raw) ? 'hammer' : palettes[hash(raw) % palettes.length];
  return { lines, cert, grade: GRADES[hash(info.id) % GRADES.length], setName: base, palette };
}

// ---- colours matched to the card -------------------------------------------------------------------------------
// Finds the strongest colour in the card art (ignoring near-black borders, near-white text and greys) and builds a slab gradient around that hue.
// Returns null for a card with no real colour (black and white), so the caller can use a preset instead.
const BORDER_BAND = 0.12, BORDER_WEIGHT = 5;   // the outer 12% of the card counts five times as much
function matchedPalette(img) {
  try {
    const N = 64, c = document.createElement('canvas'); c.width = c.height = N;
    const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0, N, N);
    const d = ctx.getImageData(0, 0, N, N).data, BINS = 36;
    const w = new Float64Array(BINS), sn = new Float64Array(BINS), cs = new Float64Array(BINS);
    let total = 0;
    for (let i = 0; i < d.length; i += 4) {
      const px = (i / 4) % N, py = Math.floor(i / 4 / N);
      // A coloured frame is the card's signature colour, so pixels in the outer band count extra: a bright shirt or curtain in the photo should not outvote it.
      // (Black or white borders are skipped by the colour tests below, so cards like that are still judged by their artwork.)
      const edge = Math.min(px, py, N - 1 - px, N - 1 - py) / N, frame = edge < BORDER_BAND ? BORDER_WEIGHT : 1;
      const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, dl = mx - mn;
      if (dl < 0.05 || l < 0.12 || l > 0.9) continue;                       // grey, near-black or near-white: no colour to speak of
      const s = dl / (1 - Math.abs(2 * l - 1));
      if (s < 0.25) continue;
      let h = mx === r ? ((g - b) / dl) % 6 : mx === g ? (b - r) / dl + 2 : (r - g) / dl + 4;
      h = ((h * 60) + 360) % 360;
      const weight = s * (1 - Math.abs(2 * l - 1)) * frame, bin = Math.floor(h / (360 / BINS)) % BINS;   // vivid, mid-tone pixels count most
      w[bin] += weight; sn[bin] += weight * Math.sin(h * Math.PI / 180); cs[bin] += weight * Math.cos(h * Math.PI / 180); total += weight;
    }
    if (total < N * N * 0.02) return null;
    let best = 0, bestW = -1;
    for (let b = 0; b < BINS; b++) { const sum = w[(b + BINS - 1) % BINS] + w[b] + w[(b + 1) % BINS]; if (sum > bestW) { bestW = sum; best = b; } }
    let sx = 0, cx = 0;
    for (const b of [(best + BINS - 1) % BINS, best, (best + 1) % BINS]) { sx += sn[b]; cx += cs[b]; }
    const hue = ((Math.atan2(sx, cx) * 180 / Math.PI) + 360) % 360;
    const hex = (dh, s, l) => '#' + new THREE.Color().setHSL(((hue + dh + 360) % 360) / 360, s, l, THREE.SRGBColorSpace).getHexString(THREE.SRGBColorSpace);
    return { name: 'MATCHED TO CARD', a: hex(-35, 0.78, 0.52), mid: hex(0, 0.72, 0.46), b: hex(35, 0.85, 0.56) };
  } catch (e) { return null; }   // e.g. the image would not let its pixels be read
}
const currentPalette = () => {
  if (!S.paletteKey || S.paletteKey === 'auto') return S.matched || PALETTES[S.desc.palette];
  return PALETTES[S.paletteKey];
};

// ---- textures -----------------------------------------------------------------------------------------------
const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
function canvasTex(c) { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = S.aniso; return t; }

function pebbleTexture() {   // hammered/pebbled surface, used as a bump map on the plastic
  const N = 256, c = mk(N, N), ctx = c.getContext('2d');
  ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, N, N);
  let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < 900; i++) {
    const x = rnd() * N, y = rnd() * N, r = 4 + rnd() * 7;
    for (const [ox, oy] of [[0, 0], [N, 0], [-N, 0], [0, N], [0, -N]]) {   // wrapped, so the tile repeats cleanly
      const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      g.addColorStop(0, 'rgba(255,255,255,.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x + ox, y + oy, r, 0, Math.PI * 2); ctx.fill();
    }
  }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = S.aniso; return t;
}

const LABEL_FACE = '"Arial Narrow", "Roboto Condensed", "Helvetica Neue", Arial, sans-serif';
function fitText(ctx, text, maxW, size, weight = '700') {
  for (let s = size; s > 20; s -= 2) { ctx.font = `${weight} ${s}px ${LABEL_FACE}`; if (ctx.measureText(text).width <= maxW) return s; }
  return 20;
}
function labelTexture(d, id, p, L, T) {
  // 600px per inch. The paper is 0.1in bigger than the window on every side (it tucks behind the rim), so the design is drawn inset by that margin.
  const PPI = 600, M = 0.1 * PPI, H = Math.round(T * PPI), W = Math.round(L * PPI);
  const c = mk(W + 2 * M, H + 2 * M), ctx = c.getContext('2d');
  ctx.fillStyle = '#eef3f2'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.translate(M, M);
  ctx.strokeStyle = p.a; ctx.lineWidth = 26; ctx.beginPath(); ctx.roundRect(13, 13, W - 26, H - 26, 0.25 * PPI - 13); ctx.stroke();   // follows the window's corner radius
  ctx.textBaseline = 'alphabetic';
  // The text column stops short of the grade, cert number and barcode on the right, whatever their widths turn out to be.
  const gradeText = d.grade[0] + ' ' + d.grade[1];
  ctx.font = '700 80px "Arial Narrow", Arial, sans-serif'; const gradeW = ctx.measureText(gradeText).width;
  ctx.font = '700 62px "Arial Narrow", Arial, sans-serif'; const certW = ctx.measureText(d.cert).width;
  const tx = 470, tw = W - 70 - Math.max(gradeW, certW, 330) - 70 - tx;
  ctx.fillStyle = '#111';
  if (fitText(ctx, d.lines[0], tw, 96) >= 56) ctx.fillText(d.lines[0], tx, 190);
  else {   // a long title goes on two lines, split as evenly as the words allow, rather than shrinking to nothing
    const words = d.lines[0].split(' '); let cut = 1, gap = Infinity;
    for (let i = 1; i < words.length; i++) { const g = Math.abs(words.slice(0, i).join(' ').length - words.slice(i).join(' ').length); if (g < gap) { gap = g; cut = i; } }
    const a = words.slice(0, cut).join(' '), b = words.slice(cut).join(' ');
    const size = Math.min(fitText(ctx, a, tw, 72), fitText(ctx, b, tw, 72));
    ctx.font = `700 ${size}px ${LABEL_FACE}`; ctx.fillText(a, tx, 140); ctx.fillText(b, tx, 140 + size * 1.1);
  }
  fitText(ctx, d.lines[1], tw, 70, '600'); ctx.fillText(d.lines[1], tx, 300);
  ctx.fillStyle = '#444'; fitText(ctx, d.lines[2], tw, 56, '600'); ctx.fillText(d.lines[2], tx, 390);
  ctx.fillStyle = '#111'; ctx.textAlign = 'right';
  ctx.font = '700 80px "Arial Narrow", Arial, sans-serif'; ctx.fillText(gradeText, W - 70, 175);
  ctx.font = '700 62px "Arial Narrow", Arial, sans-serif'; ctx.fillText(d.cert, W - 70, 270);
  ctx.textAlign = 'left';
  let seed = hash(id), x = W - 70 - 330;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  ctx.fillStyle = '#000';
  while (x < W - 70) { const bw = 3 + Math.floor(rnd() * 8); ctx.fillRect(x, 330, bw, 190); x += bw + 3 + Math.floor(rnd() * 6); }
  return canvasTex(c);
}
// The CMC logo for the hologram sticker (slab-logo.png, next to this file). If it cannot be loaded the sticker falls back to the letters "CMC".
const LOGO_URL = new URL('./slab-logo.png', import.meta.url).href;
let logoImg = null;
const loadLogo = () => new Promise(res => {
  if (logoImg) return res(logoImg);
  const i = new Image(); i.onload = () => res(logoImg = i); i.onerror = () => res(null); i.src = LOGO_URL;
});
function holoTexture() {
  const c = mk(512, 512), ctx = c.getContext('2d');
  const g = ctx.createConicGradient(0, 256, 256);
  ['#ff4fd8', '#ffd34d', '#4dff88', '#4dd2ff', '#8a6bff', '#ff4fd8'].forEach((col, i, a) => g.addColorStop(i / (a.length - 1), col));
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(256, 256, 250, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = .28; ctx.strokeStyle = '#fff';
  for (let i = -512; i < 1024; i += 28) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + 512, 512); ctx.stroke(); ctx.beginPath(); ctx.moveTo(i + 512, 0); ctx.lineTo(i, 512); ctx.stroke(); }
  ctx.globalAlpha = 1;
  if (logoImg) { const lw = 420, lh = lw * logoImg.height / logoImg.width; ctx.drawImage(logoImg, 256 - lw / 2, 256 - lh / 2, lw, lh); }
  else { ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.font = '700 150px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('CMC', 256, 262); }
  return canvasTex(c);
}
// The logo as a holographic foil: a rainbow filled into the logo's shape, with fine diagonal lines like a diffraction grating.
function foilLogoTexture() {
  const w = 600, h = Math.round(w * logoImg.height / logoImg.width), c = mk(w, h), ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, w, h);
  ['#ff4fd8', '#ffd34d', '#4dff88', '#4dd2ff', '#8a6bff', '#ff4fd8'].forEach((col, i, a) => g.addColorStop(i / (a.length - 1), col));
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = 0.3; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
  for (let i = -h; i < w + h; i += 9) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + h, h); ctx.stroke(); }
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(logoImg, 0, 0, w, h);   // keep the rainbow only where the logo is
  return canvasTex(c);
}
function cardBackTexture(d, p, landscape) {   // the real card backs are not in the database, so this is a generated stand-in
  const W = landscape ? 980 : 700, H = landscape ? 700 : 980, c = mk(W, H), ctx = c.getContext('2d');
  ctx.fillStyle = '#1c1f1d'; ctx.fillRect(0, 0, W, H);   // plain dark back: just the foil logo, no text or stripes
  if (!logoImg) {   // only if the logo file could not be loaded: plain letters in its place
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = p.b;
    ctx.font = '700 200px "Arial Black", Arial, sans-serif'; ctx.fillText('CMC', W / 2, H / 2);
  }
  return canvasTex(c);
}

// ---- reflections: a dark studio with coloured light panels, so the plastic sweeps between the two colours as it turns -------
function makeEnv(p) {
  const env = new THREE.Scene();
  env.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), new THREE.MeshBasicMaterial({ color: 0x05060d, side: THREE.BackSide })));
  const panel = (hex, k, w, h, pos) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(k), side: THREE.DoubleSide }));
    m.position.set(...pos); m.lookAt(0, 0, 0); env.add(m);
  };
  panel(p.a, 4.5, 22, 30, [-22, 4, 6]); panel(p.b, 4.5, 22, 30, [22, -3, 6]);
  panel('#ffffff', 5, 30, 6, [0, 26, 8]); panel(p.mid, 6, 40, 8, [0, -26, 10]); panel('#ffffff', 2.5, 10, 22, [-8, 2, 30]);
  panel(p.b, 5, 20, 20, [-14, 0, -26]); panel(p.a, 5, 20, 20, [14, 0, -26]);
  const t = S.pmrem.fromScene(env, 0.04).texture;   // as blurred as three.js allows (it caps the blur), so hard-edged light panels never show as sharp wedges
  env.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  return t;
}

// What the slab plastic reflects: a nearly black studio with a few narrow strips of light in several hues. Broad coloured panels made the
// faces one flat colour ("sweet wrapper"); narrow strips on black give dark plastic with bands of colour sliding across it, like oil.
function makeOilEnv(p) {
  const env = new THREE.Scene();
  env.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), new THREE.MeshBasicMaterial({ color: 0x020307, side: THREE.BackSide })));
  const shift = (hex, dh) => { const c = new THREE.Color(hex), hsl = {}; c.getHSL(hsl); return c.setHSL((hsl.h + dh + 1) % 1, 0.9, 0.55); };
  const strip = (col, k, w, h, pos) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(col).multiplyScalar(k), side: THREE.DoubleSide }));
    m.position.set(...pos); m.lookAt(0, 0, 0); env.add(m);
  };
  strip(p.a, 7, 5, 44, [-24, 0, 10]); strip(p.b, 7, 5, 44, [24, 0, 10]);
  strip(shift(p.mid, 0.1), 6, 3, 44, [-9, 0, 27]); strip(shift(p.a, 0.07), 6, 3, 44, [11, 0, 25]); strip(shift(p.b, -0.1), 6, 4, 44, [-18, 0, -22]);   // hues stay near the card's colour
  strip('#ffffff', 9, 34, 3, [0, 26, 10]); strip(p.mid, 2.5, 40, 5, [0, -26, 10]); strip('#ffffff', 5, 3, 36, [4, 0, 30]);
  const t = S.pmrem.fromScene(env, 0.02).texture;
  env.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  return t;
}

// ---- geometry ----------------------------------------------------------------------------------------------------
function rrPath(P, w, h, r, cx = 0, cy = 0) {   // rounded rectangle drawn into a Shape or Path
  const x = cx - w / 2, y = cy - h / 2;
  const side = (x0, y0, x1, y1) => { const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.05)); for (let i = 1; i <= n; i++) P.lineTo(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n); };
  P.moveTo(x + r, y); side(x + r, y, x + w - r, y); P.quadraticCurveTo(x + w, y, x + w, y + r);
  side(x + w, y + r, x + w, y + h - r); P.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  side(x + w - r, y + h, x + r, y + h); P.quadraticCurveTo(x, y + h, x, y + h - r);
  side(x, y + h - r, x, y + r); P.quadraticCurveTo(x, y, x + r, y); return P;
}
function layout(cw, ch) {
  // PAD and GAP are wide enough that the rounded bevel of one window never eats into the ridge beside it
  const landscape = cw > ch, PAD = 0.3, LT = 1.0, GAP = 0.3, BZ = 0.18, EDGE = 0.4;
  const wellW = cw + 2 * BZ, wellH = ch + 2 * BZ;
  if (!landscape) {
    const W = cw + 0.85, H = PAD + LT + GAP + wellH + EDGE;
    return { landscape, W, H, L: W - 2 * PAD, T: LT, label: { x: 0, y: H / 2 - PAD - LT / 2, rot: 0, ww: W - 2 * PAD, wh: LT },
      well: { x: 0, y: H / 2 - PAD - LT - GAP - wellH / 2, w: wellW, h: wellH } };
  }
  const H = ch + 0.85, W = PAD + LT + GAP + wellW + EDGE;
  return { landscape, W, H, L: H - 2 * PAD, T: LT, label: { x: -W / 2 + PAD + LT / 2, y: 0, rot: Math.PI / 2, ww: LT, wh: H - 2 * PAD },
    well: { x: -W / 2 + PAD + LT + GAP + wellW / 2, y: 0, w: wellW, h: wellH } };
}

// Layout, front to back:  rounded coloured rim | clear acrylic core holding the label and card | rounded coloured rim.
const RIM = { height: 0.13, bevel: 0.1 }, CORE = 0.06;

// The rims are built by hand rather than with ExtrudeGeometry, which averaged the surface directions at the hole corners and left pale wedges.
function sampleRoundRect(c, step = 0.05, arcSeg = 24) {
  const pts = [], { w, h, r, cx, cy } = c, x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
  const line = (ax, ay, bx, by, nx, ny) => { const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step)); for (let i = 0; i < n; i++) pts.push({ x: ax + (bx - ax) * i / n, y: ay + (by - ay) * i / n, nx, ny }); };
  const arc = (ax, ay, a0) => { for (let i = 0; i < arcSeg; i++) { const a = a0 + (Math.PI / 2) * i / arcSeg; pts.push({ x: ax + r * Math.cos(a), y: ay + r * Math.sin(a), nx: Math.cos(a), ny: Math.sin(a) }); } };
  line(x0 + r, y0, x1 - r, y0, 0, -1); arc(x1 - r, y0 + r, -Math.PI / 2);
  line(x1, y0 + r, x1, y1 - r, 1, 0);  arc(x1 - r, y1 - r, 0);
  line(x1 - r, y1, x0 + r, y1, 0, 1);  arc(x0 + r, y1 - r, Math.PI / 2);
  line(x0, y1 - r, x0, y0 + r, -1, 0); arc(x0 + r, y0 + r, Math.PI);
  return pts;   // counter-clockwise, outward normals
}
function finish(pos, nor, idx) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  const uv = new Float32Array((pos.length / 3) * 2); for (let i = 0; i < pos.length / 3; i++) { uv[i * 2] = pos[i * 3] / 1.2; uv[i * 2 + 1] = pos[i * 3 + 1] / 1.2; }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setIndex(idx); return g;
}
// A vertical wall following the outline between two heights: the solid edge between the rims.
function bandGeometry(contour, z0, z1) {
  const ring = sampleRoundRect(contour), n = ring.length, pos = [], nor = [], idx = [];
  for (const z of [z0, z1]) for (const p of ring) { pos.push(p.x, p.y, z); nor.push(p.nx, p.ny, 0); }
  for (let i = 0; i < n; i++) { const a = i, b = (i + 1) % n, c = n + (i + 1) % n, d = n + i; idx.push(a, b, c, a, c, d); }
  return finish(pos, nor, idx);
}
// One rim: a flat plate with rounded-over edges and window holes. contours[0] is the outside edge, the rest are windows.
function rimGeometry(contours, zBase, height, bevel, steps = 10) {
  const pos = [], nor = [], idx = [], capRings = [];
  const zWallTop = zBase + height - bevel, zTop = zBase + height;
  for (const c of contours) {
    let ring = sampleRoundRect(c);
    if (c.hole) ring = ring.reverse().map(p => ({ ...p, nx: -p.nx, ny: -p.ny }));
    const n = ring.length;
    const prof = [{ lat: 0, z: zBase, cn: 1, nz: 0 }, { lat: 0, z: zWallTop, cn: 1, nz: 0 }];
    for (let s = 1; s <= steps; s++) { const a = (Math.PI / 2) * s / steps; prof.push({ lat: bevel * (1 - Math.cos(a)), z: zWallTop + bevel * Math.sin(a), cn: Math.cos(a), nz: Math.sin(a) }); }
    const base = pos.length / 3;
    for (const pr of prof) for (const p of ring) { pos.push(p.x - p.nx * pr.lat, p.y - p.ny * pr.lat, pr.z); nor.push(p.nx * pr.cn, p.ny * pr.cn, pr.nz); }
    for (let j = 0; j < prof.length - 1; j++) for (let i = 0; i < n; i++) {
      const a = base + j * n + i, b = base + j * n + (i + 1) % n, c2 = base + (j + 1) * n + (i + 1) % n, e = base + (j + 1) * n + i;
      idx.push(a, b, c2, a, c2, e);
    }
    capRings.push(ring.map(p => new THREE.Vector2(p.x - p.nx * bevel, p.y - p.ny * bevel)));
  }
  const outer = capRings[0], holes = capRings.slice(1), flat = outer.concat(...holes), capBase = pos.length / 3;
  for (const v of flat) { pos.push(v.x, v.y, zTop); nor.push(0, 0, 1); }
  for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(outer, holes)) {
    const area = (flat[b].x - flat[a].x) * (flat[c].y - flat[a].y) - (flat[c].x - flat[a].x) * (flat[b].y - flat[a].y);
    if (area > 0) idx.push(capBase + a, capBase + b, capBase + c); else idx.push(capBase + a, capBase + c, capBase + b);
  }
  return finish(pos, nor, idx);
}

const OIL = { dark: 0.2, metal: 0.25, rough: 0.2, coat: 0.05, irid: 0.7, ior: 2.0, film: [250, 900], env: 1.6, bump: 0.4 };   // bump: how strong the pebbled texture is   // the look of the slab plastic; tune here
function plastic(pal, dirx, diry, span) {
  // the colour gradient is worked out per pixel from the model position (per-vertex colours left visible seams on the flat faces)
  // "Oil slick" rather than "sweet wrapper": a dark undercoat (OIL.dark scales the base colour down), mostly metallic so the coloured reflections
  // and the thin-film iridescence carry the colour instead of a flat bright paint.
  const m = new THREE.MeshPhysicalMaterial({ metalness: OIL.metal, roughness: OIL.rough, clearcoat: 1, clearcoatRoughness: OIL.coat,
    iridescence: OIL.irid, iridescenceIOR: OIL.ior, iridescenceThicknessRange: OIL.film, bumpMap: S.pebble, bumpScale: OIL.bump, envMap: S.oilEnv, envMapIntensity: OIL.env });
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, { cA: { value: pal.a }, cM: { value: pal.mid }, cB: { value: pal.b }, cDir: { value: new THREE.Vector2(dirx, diry) }, cSpan: { value: span }, cDark: { value: OIL.dark } });
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vObjPos;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjPos = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObjPos; uniform vec3 cA; uniform vec3 cM; uniform vec3 cB; uniform vec2 cDir; uniform float cSpan; uniform float cDark;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float gt = clamp(0.5 + dot(vObjPos.xy, cDir) / cSpan, 0.0, 1.0);
        diffuseColor.rgb *= (gt < 0.5 ? mix(cA, cM, gt * 2.0) : mix(cM, cB, (gt - 0.5) * 2.0)) * cDark;`);
  };
  m.customProgramCacheKey = () => 'cmc-plastic-gradient';
  return m;
}

function disposeGroup(g) {
  g.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    const m = o.material; if (!m) return;
    [].concat(m).forEach(x => { for (const k in x) if (x[k] && x[k].isTexture && x[k] !== S.pebble && x[k] !== S.white && x[k] !== S.art) x[k].dispose(); x.dispose(); });
  });
}

function buildSlab() {
  if (S.slab) { S.pivot.remove(S.slab); disposeGroup(S.slab); }
  const { info, desc, art } = S, p = currentPalette();
  if (S.oilEnv) S.oilEnv.dispose();
  S.oilEnv = makeOilEnv(p);   // before the plastic materials are made, which use it
  const slab = new THREE.Group();
  const aspect = art.image.width / art.image.height;
  const cw = aspect < 1 ? 3.5 * aspect : 3.5, ch = aspect < 1 ? 3.5 : 3.5 / aspect;
  const LY = layout(cw, ch);
  const pal = { a: new THREE.Color(p.a), mid: new THREE.Color(p.mid), b: new THREE.Color(p.b) };
  const dir = LY.landscape ? { dx: 0.85, dy: -0.5 } : { dx: 0.5, dy: -0.85 };
  const span = Math.hypot(LY.W, LY.H) * 0.8;

  // rims: front, and a mirrored copy for the back (built with x flipped, then turned half a revolution, so the windows line up)
  for (const back of [false, true]) {
    const sx = back ? -1 : 1;
    const geo = rimGeometry([
      { w: LY.W, h: LY.H, r: 0.5, cx: 0, cy: 0, hole: false },
      { w: LY.label.ww, h: LY.label.wh, r: 0.25, cx: sx * LY.label.x, cy: LY.label.y, hole: true },
      { w: LY.well.w, h: LY.well.h, r: 0.34, cx: sx * LY.well.x, cy: LY.well.y, hole: true },
    ], CORE / 2, RIM.height, RIM.bevel);
    const rim = new THREE.Mesh(geo, plastic(pal, sx * dir.dx, dir.dy, span));
    if (back) rim.rotation.y = Math.PI;
    slab.add(rim);
  }
  slab.add(new THREE.Mesh(bandGeometry({ w: LY.W, h: LY.H, r: 0.5, cx: 0, cy: 0 }, -CORE / 2, CORE / 2), plastic(pal, dir.dx, dir.dy, span)));

  // clear acrylic core: a plain solid block, so the card and label sit just behind its glossy faces
  const coreShape = new THREE.Shape(); rrPath(coreShape, LY.W, LY.H, 0.5);
  const coreGeo = new THREE.ExtrudeGeometry(coreShape, { depth: CORE, bevelEnabled: false, curveSegments: 28 }); coreGeo.translate(0, 0, -CORE / 2);
  const core = new THREE.Mesh(coreGeo, new THREE.MeshPhysicalMaterial({ color: pal.mid.clone().lerp(new THREE.Color(0xffffff), 0.55), transparent: true, opacity: 0.22,
    roughness: 0.03, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.6, depthWrite: false }));
  core.renderOrder = 2; slab.add(core);

  // dark mat around the card, with a window so the card back shows from behind
  const matShape = new THREE.Shape(); rrPath(matShape, LY.well.w + 0.16, LY.well.h + 0.16, 0.42, LY.well.x, LY.well.y);
  const matHole = new THREE.Path(); rrPath(matHole, cw - 0.06, ch - 0.06, 0.08, LY.well.x, LY.well.y); matShape.holes.push(matHole);
  const matGeo = new THREE.ExtrudeGeometry(matShape, { depth: 0.008, bevelEnabled: false, curveSegments: 20 }); matGeo.translate(0, 0, -0.016);
  slab.add(new THREE.Mesh(matGeo, new THREE.MeshPhysicalMaterial({ color: 0x0a0f24, roughness: 0.4, clearcoat: 0.6, bumpMap: S.pebble, bumpScale: OIL.bump * 0.8, envMapIntensity: 0.8 })));

  // the card: a thin box, art on the front, a stand-in back on the rear
  const edge = new THREE.MeshStandardMaterial({ color: 0xf3f3ee, roughness: 0.8 });
  const cardMesh = new THREE.Mesh(new THREE.BoxGeometry(cw, ch, 0.014), [edge, edge, edge, edge,
    new THREE.MeshStandardMaterial({ map: art, roughness: 0.5 }), new THREE.MeshStandardMaterial({ map: cardBackTexture(desc, p, cw > ch), roughness: 0.55 })]);
  cardMesh.position.set(LY.well.x, LY.well.y, 0); slab.add(cardMesh);

  // holographic foil logo on the back of the card: an iridescent metallic decal just behind the back face, so its colours shift as the slab turns
  if (logoImg) {
    const land = cw > ch;
    const lw = land ? cw * 0.29 : cw * 0.41, lh = lw * logoImg.height / logoImg.width;   // centred on the card
    const foil = foilLogoTexture();
    const decal = new THREE.Mesh(new THREE.PlaneGeometry(lw, lh), new THREE.MeshPhysicalMaterial({
      map: foil, emissiveMap: foil, emissive: 0xffffff, emissiveIntensity: 0.6,   // a glow of its own keeps the rainbow from washing out to silver
      transparent: true, metalness: 0.45, roughness: 0.25, iridescence: 1, iridescenceIOR: 1.8, iridescenceThicknessRange: [200, 800], envMapIntensity: 1.2 }));
    decal.rotation.y = Math.PI;   // faces the back
    decal.position.set(LY.well.x, LY.well.y, -0.0085);
    decal.renderOrder = 3;   // drawn after the clear core, so the core's tint does not wash it out when seen from behind
    slab.add(decal);
  }

  // the label, turned 90 degrees for landscape slabs
  const lg = new THREE.Group(); lg.position.set(LY.label.x, LY.label.y, 0); lg.rotation.z = LY.label.rot;
  const paper = new THREE.MeshStandardMaterial({ map: S.white, roughness: 0.7 });
  const printed = new THREE.MeshStandardMaterial({ map: labelTexture(desc, info.id, p, LY.L, LY.T), roughness: 0.6 });
  lg.add(new THREE.Mesh(new THREE.BoxGeometry(LY.L + 0.2, LY.T + 0.2, 0.012), [paper, paper, paper, paper, printed, paper]));
  const sticker = new THREE.Mesh(new THREE.CircleGeometry(0.26, 48), new THREE.MeshPhysicalMaterial({ map: holoTexture(), metalness: 0.6, roughness: 0.22, iridescence: 1, iridescenceIOR: 1.9, envMapIntensity: 1.6 }));
  sticker.position.set(-LY.L / 2 + 0.42, 0, 0.0075); lg.add(sticker);
  slab.add(lg);

  S.pivot.add(slab); S.slab = slab; S.size = { W: LY.W, H: LY.H };
  if (S.envTex) S.envTex.dispose();
  S.envTex = makeEnv(p); S.scene.environment = S.envTex;
  S.rim.color.set(p.b); S.key.color.set(p.a).lerp(new THREE.Color(0xffffff), 0.7);
  fitCamera();
}

// ---- camera / handling ---------------------------------------------------------------------------------------------
function fitCamera() {
  const w = S.container.clientWidth || 600, h = S.container.clientHeight || 400, aspect = w / h;
  const tanV = Math.tan(THREE.MathUtils.degToRad(S.camera.fov / 2)), { W, H } = S.size;
  S.fitDist = Math.max((H / 2) / tanV, (W / 2) / (tanV * aspect)) * 1.18 + 0.6;
  S.targetDist = S.fitDist;
}
// Move the slab across the screen: pixels to world units at the slab's distance, kept within roughly its own size so it can't be lost.
function panBy(dxPx, dyPx) {
  const h = Math.max(1, S.container.clientHeight), perPx = 2 * S.dist * Math.tan(THREE.MathUtils.degToRad(S.camera.fov / 2)) / h;
  const lim = { x: S.size.W * 0.9, y: S.size.H * 0.9 };
  S.pan.x = THREE.MathUtils.clamp(S.pan.x + dxPx * perPx, -lim.x, lim.x);
  S.pan.y = THREE.MathUtils.clamp(S.pan.y - dyPx * perPx, -lim.y, lim.y);
}
function spin(ax, ay) { S.qx.setFromAxisAngle(S.AX, ax); S.qy.setFromAxisAngle(S.AY, ay); S.pivot.quaternion.premultiply(S.qx).premultiply(S.qy); }
const clampDist = d => THREE.MathUtils.clamp(d, S.fitDist * 0.45, S.fitDist * 2.4);

function attachControls(el) {
  const on = (t, f, o) => { el.addEventListener(t, f, o); S.off.push(() => el.removeEventListener(t, f, o)); };
  // One finger / left button turns the slab. Moving it (panning) is: MOVE mode, Shift- or Ctrl-drag, right or middle button, or two fingers.
  on('contextmenu', e => e.preventDefault());
  on('pointerdown', e => {
    el.setPointerCapture(e.pointerId); S.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    S.idle = false; S.goal = null; S.vx = S.vy = 0; S.dragging = S.pointers.size === 1; S.lastX = e.clientX; S.lastY = e.clientY;
    if (S.pointers.size === 1) S.panDrag = S.moveMode || e.button === 1 || e.button === 2 || e.shiftKey || e.ctrlKey || e.metaKey;
    if (S.pointers.size === 2) { const [a, b] = [...S.pointers.values()]; S.pinch0 = Math.hypot(a.x - b.x, a.y - b.y); S.mid0 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
  });
  on('pointermove', e => {
    if (!S.pointers.has(e.pointerId)) return;
    S.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (S.pointers.size === 2) {   // pinch to zoom, and drag both fingers to move
      const [a, b] = [...S.pointers.values()], d = Math.hypot(a.x - b.x, a.y - b.y), mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      S.targetDist = clampDist(S.targetDist * S.pinch0 / d); S.pinch0 = d;
      panBy(mid.x - S.mid0.x, mid.y - S.mid0.y); S.mid0 = mid; return;
    }
    if (!S.dragging) return;
    const dx = e.clientX - S.lastX, dy = e.clientY - S.lastY; S.lastX = e.clientX; S.lastY = e.clientY;
    if (S.panDrag) { panBy(dx, dy); return; }
    S.vy = dx * 0.0085; S.vx = dy * 0.0085; spin(S.vx, S.vy);
  });
  const release = e => { S.pointers.delete(e.pointerId); S.dragging = S.pointers.size === 1; };
  on('pointerup', release); on('pointercancel', release);
  on('wheel', e => { e.preventDefault(); S.targetDist = clampDist(S.targetDist * Math.exp(e.deltaY * 0.001)); }, { passive: false });
  on('dblclick', () => slabReset());
}

function frame() {
  const dt = Math.min(S.clock.getDelta(), 0.05);
  if (S.goal) { S.pivot.quaternion.slerp(S.goal, 1 - Math.pow(0.0005, dt)); if (S.pivot.quaternion.angleTo(S.goal) < 0.002) S.goal = null; }
  else if (S.idle) { S.idleT += dt; S.pivot.quaternion.copy(S.home).multiply(S.qy.setFromEuler(new THREE.Euler(Math.sin(S.idleT * 0.5) * 0.04, Math.sin(S.idleT * 0.6) * 0.45, 0))); }
  else if (!S.dragging && (Math.abs(S.vx) > 1e-4 || Math.abs(S.vy) > 1e-4)) { spin(S.vx, S.vy); const k = Math.pow(0.06, dt); S.vx *= k; S.vy *= k; }
  S.dist += (S.targetDist - S.dist) * (1 - Math.pow(0.001, dt));
  S.pivot.position.lerp(S.pan, 1 - Math.pow(0.0001, dt));   // eases to where it was dragged, and back to centre on RESET
  S.camera.position.set(0, 0, S.dist); S.camera.lookAt(0, 0, 0);
  S.renderer.render(S.scene, S.camera);
}

function resize() {
  if (!S) return;
  const w = Math.max(1, S.container.clientWidth), h = Math.max(1, S.container.clientHeight);
  S.renderer.setSize(w, h); S.camera.aspect = w / h; S.camera.updateProjectionMatrix();
  if (S.slab) fitCamera();
}

// ---- public API -----------------------------------------------------------------------------------------------------
const loadTextureOnce = url => new Promise((res, rej) => new THREE.TextureLoader().setCrossOrigin('anonymous').load(url,
  t => { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = S ? S.aniso : 1; res(t); }, undefined, () => rej(new Error('image blocked or unavailable'))));
// two attempts, a moment apart, then give up (the caller shows the flat card instead)
const loadTexture = async file => {
  const url = proxied(file);
  try { return await loadTextureOnce(url); } catch (e) { await new Promise(r => setTimeout(r, 700)); return loadTextureOnce(url); }
};

export async function showSlab(container, info) {
  const mine = ++token;
  if (!isSlabImage(info.file)) return { ok: false, reason: '3D view is only for still cards' };
  try {
    if (!S) {
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      container.appendChild(renderer.domElement);
      renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;cursor:grab';
      const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
      const key = new THREE.DirectionalLight(0xffffff, 1.1); key.position.set(3, 5, 6); scene.add(key);
      const rim = new THREE.DirectionalLight(0xffffff, 1.0); rim.position.set(-5, -2, -3); scene.add(rim);
      const pivot = new THREE.Group(); scene.add(pivot);
      S = { renderer, scene, camera, key, rim, pivot, container, pmrem: new THREE.PMREMGenerator(renderer), aniso: renderer.capabilities.getMaxAnisotropy(),
        home: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.12, -0.5, 0)), clock: new THREE.Clock(), off: [], pointers: new Map(),
        qx: new THREE.Quaternion(), qy: new THREE.Quaternion(), AX: new THREE.Vector3(1, 0, 0), AY: new THREE.Vector3(0, 1, 0),
        pan: new THREE.Vector3(), moveMode: false, panDrag: false, mid0: { x: 0, y: 0 },
        idle: true, idleT: 0, goal: null, vx: 0, vy: 0, dragging: false, dist: 12, targetDist: 12, fitDist: 12, size: { W: 3.4, H: 5.5 } };
      S.pebble = pebbleTexture();
      S.white = (() => { const c = mk(8, 8), x = c.getContext('2d'); x.fillStyle = '#e9efee'; x.fillRect(0, 0, 8, 8); return canvasTex(c); })();
      pivot.quaternion.copy(S.home);
      attachControls(renderer.domElement);
      S.ro = new ResizeObserver(resize); S.ro.observe(container);
      container.addEventListener('click', stop); S.off.push(() => container.removeEventListener('click', stop));
      renderer.setAnimationLoop(frame);
    }
    // the card art, through the proxy when it lives on the Bluesky CDN; a failure here is reported so the caller can fall back to the flat card
    const [art] = await Promise.all([loadTexture(info.file), loadLogo()]);
    if (mine !== token || !S) { art.dispose(); return { ok: false, reason: 'cancelled' }; }
    if (S.art) S.art.dispose();
    S.art = art; S.info = info; S.desc = describe(info); S.paletteKey = null; S.matched = matchedPalette(art.image); S.pan.set(0, 0, 0);
    resize(); buildSlab(); S.dist = S.fitDist;
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e && e.message || 'WebGL unavailable' };
  }
}
const stop = e => e.stopPropagation();

export function hideSlab() {
  token++;
  if (!S) return;
  S.off.forEach(f => f()); if (S.ro) S.ro.disconnect();
  S.renderer.setAnimationLoop(null);
  if (S.slab) disposeGroup(S.slab);
  [S.art, S.pebble, S.white, S.envTex, S.oilEnv].forEach(t => t && t.dispose());
  S.pmrem.dispose(); S.renderer.dispose(); S.renderer.forceContextLoss();
  S.renderer.domElement.remove();
  S = null;
}

export function slabFlip() {
  if (!S) return;
  const facingBack = new THREE.Vector3(0, 0, 1).applyQuaternion(S.pivot.quaternion).z < 0;
  S.goal = facingBack ? S.home : new THREE.Quaternion().setFromEuler(new THREE.Euler(0.12, Math.PI + 0.5, 0)); S.idle = false; S.vx = S.vy = 0;
}
export function slabColour() {
  if (!S || !S.art) return;
  const k = ['auto', ...Object.keys(PALETTES)], cur = S.paletteKey || 'auto';   // 'auto' is the colour matched to the card
  S.paletteKey = k[(k.indexOf(cur) + 1) % k.length]; buildSlab();
  return currentPalette().name;
}
export function slabReset() {
  if (!S) return;
  S.goal = S.home; S.idle = true; S.idleT = 0; S.vx = S.vy = 0; S.targetDist = S.fitDist; S.pan.set(0, 0, 0);
  setMoveMode(false);   // a reset also puts a plain drag back to turning
}
// What a plain drag does: turn the slab (default) or move it. The page is told through a 'slabmode' event so its button label stays right.
function setMoveMode(on) {
  if (!S || S.moveMode === on) return;
  S.moveMode = on;
  S.renderer.domElement.style.cursor = on ? 'move' : 'grab';
  S.container.dispatchEvent(new CustomEvent('slabmode', { detail: { moving: on } }));
}
export function slabMoveToggle() {
  if (!S) return false;
  setMoveMode(!S.moveMode);
  return S.moveMode;
}
