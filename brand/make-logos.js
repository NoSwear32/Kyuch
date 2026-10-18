// Generates the Kyuch logos as SVG (run: node brand/make-logos.js). Everything is code-drawn so it stays crisp at any size.
const fs = require('node:fs');
const path = require('node:path');

const f = (n) => +n.toFixed(1);
const GOLD = ['#ffd27a', '#f0a53a', '#c9731a'];   // bright: for dark backgrounds / the app icon
const DEEP = ['#f2a640', '#d9821c', '#a85408'];   // deeper: transparent logos that must also read on white
const defs = (id, [x1, y1, x2, y2], palette = GOLD) => `<defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">` +
  palette.map((c, i) => `<stop offset="${i / 2}" stop-color="${c}"/>`).join('') + `</linearGradient></defs>`;
const KEY_GRAD = [-90, -150, 120, 300]; // in the key's upright local space

// ---------- the key mark ----------
// Drawn upright with the bow centre at (0,0); the SVG rotates it onto a 45 degree diagonal.
const R = 84, HOLE = 38, d2r = Math.PI / 180;
const pol = (deg, r) => [r * Math.cos(deg * d2r), r * Math.sin(deg * d2r)];
const P = (pts) => 'M' + pts.map((p) => `${f(p[0])},${f(p[1])}`).join(' L') + 'Z';

function keyParts() {
  // Crown: straight-edged spikes fanning over the top of the bow, longest in the middle.
  const spikes = [[-90, 74, 15], [-90 - 34, 56, 13], [-90 + 34, 56, 13], [-90 - 68, 42, 12], [-90 + 68, 42, 12], [-90 - 102, 30, 11], [-90 + 102, 30, 11]]
    .map(([a, len, h]) => P([pol(a - h, R - 6), pol(a, R + len), pol(a + h, R - 6)])).join('');
  // Bow ring with a round hole and a band of triangle cut-outs (evenodd).
  const circle = (r) => `M${-r},0 a${r},${r} 0 1 0 ${2 * r},0 a${r},${r} 0 1 0 ${-2 * r},0Z`;
  const cuts = Array.from({ length: 10 }, (_, i) => { const a = i * 36 - 90; return P([pol(a - 9, 52), pol(a, 73), pol(a + 9, 52)]); }).join('');
  const ring = circle(R) + circle(HOLE) + cuts;
  // Shaft with chevron notches that stop short of the edges so it stays one piece.
  const chev = [112, 142, 172].map((y) => P([[-8, y], [0, y + 11], [8, y], [8, y + 6], [0, y + 17], [-8, y + 6]])).join('');
  const shaft = P([[-14, R - 8], [14, R - 8], [14, 262], [0, 296], [-14, 262]]) + chev;
  // Bit: a bar with three uneven shards hanging off it.
  const shard = (x0, x1, tip) => P([[x0, 238], [x1, 238], [(x0 + x1) / 2 + 3, tip]]);
  const bit = P([[14, 200], [84, 200], [84, 240], [14, 240]]) + shard(16, 32, 286) + shard(38, 54, 268) + shard(60, 82, 292);
  return { spikes, ring, shaft, bit };
}

function markGroup(fill, scale = 1) {
  const m = keyParts();
  // upright key spans y -158..296; centre it at the origin, then rotate 45 degrees
  return `<g transform="rotate(45) scale(${scale}) translate(0 -69)" fill="${fill}" fill-rule="evenodd">` +
    `<path d="${m.spikes}"/><path d="${m.ring}"/><path d="${m.shaft}"/><path d="${m.bit}"/></g>`;
}

const markSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">${defs('g', KEY_GRAD, DEEP)}<g transform="translate(256 256)">${markGroup('url(#g)', 1.12)}</g></svg>\n`;

// App icon: the mark on a dark rounded square with a thin gold frame.
const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">${defs('g', KEY_GRAD)}${defs('f', [0, 0, 512, 512])}
<rect width="512" height="512" rx="112" fill="#15171c"/>
<rect x="14" y="14" width="484" height="484" rx="100" fill="none" stroke="url(#f)" stroke-width="5" opacity=".55"/>
<g transform="translate(256 256)">${markGroup('url(#g)', 1.0)}</g></svg>\n`;

// ---------- the wordmark: K Y U C H as solid angular letters with dagger-pointed stems ----------
const H = 120, S = 24; // cap height, stroke weight
const stem = (x, top = 0) => P([[x, top], [x + S, top], [x + S, H], [x + S / 2, H + 20], [x, H]]); // pointed foot

function letters() {
  const clip = `<clipPath id="band"><rect x="-20" y="0" width="400" height="${H}"/></clipPath>`;
  const items = []; // {x, svg}
  const stroke = (d) => `<path d="${d}" fill="none" stroke="url(#g)" stroke-width="${S}" stroke-linejoin="miter"/>`;
  items.push({ w: 104, svg: `<path d="${stem(0)}"/><g clip-path="url(#band)">${stroke('M12 76 L96 -6')}${stroke('M30 52 L104 126')}</g>` });
  items.push({ w: 84, svg: `<g clip-path="url(#band)">${stroke('M2 -8 L42 58')}${stroke('M82 -8 L42 58')}</g><path d="${P([[30, 50], [54, 50], [54, H], [42, H + 20], [30, H]])}"/>` });
  items.push({ w: 82, svg: `<path d="${P([[0, 0], [S, 0], [S, 96], [58, 96], [58, 0], [82, 0], [82, 106], [68, H], [14, H], [0, 106]])}"/>` });
  items.push({ w: 90, svg: `<path d="${P([[90, 12], [78, 0], [14, 0], [0, 14], [0, 106], [14, H], [78, H], [90, 108], [76, 96], [28, 96], [S, 90], [S, 30], [28, 24], [76, 24]])}"/>` });
  items.push({ w: 82, svg: `<path d="${stem(0)}"/><path d="${stem(58)}"/><path d="${P([[S - 1, 48], [59, 48], [59, 72], [S - 1, 72]])}"/>` });
  let x = 0;
  const body = items.map((it) => { const g = `<g transform="translate(${x} 0)">${it.svg}</g>`; x += it.w + 20; return g; }).join('');
  return { svg: clip + body, width: x - 20 };
}

function wordmarkSvg(fill, bg) {
  const { svg, width } = letters();
  const pad = 36, vw = width + pad * 2, vh = H + 20 + pad * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f(vw)} ${vh}" width="${f(vw * 3)}" height="${vh * 3}">${defs('g', [0, 0, width, H + 20], bg ? GOLD : DEEP)}` +
    (bg ? `<rect width="100%" height="100%" fill="${bg}"/>` : '') +
    `<g transform="translate(${pad} ${pad})" fill="${fill}">${svg}</g></svg>\n`;
}

const out = path.join(__dirname);
fs.writeFileSync(path.join(out, 'logo-mark.svg'), markSvg);
fs.writeFileSync(path.join(out, 'icon.svg'), iconSvg);
fs.writeFileSync(path.join(out, 'logo-text.svg'), wordmarkSvg('url(#g)', null));
fs.writeFileSync(path.join(out, 'logo-text-dark.svg'), wordmarkSvg('url(#g)', '#15171c'));
console.log('wrote SVGs to', out);
