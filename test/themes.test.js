const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { THEMES } = require('../renderer/themes.js');

const css = fs.readFileSync(path.join(__dirname, '../renderer/style.css'), 'utf8');
// every ".theme-card[data-theme=X] { ... }" block is a complete palette
const palettes = {};
for (const m of css.matchAll(/\.theme-card\[data-theme="(\w+)"\] \{([^}]*)\}/g)) {
  if (!m[2].includes('--bg:')) continue;
  palettes[m[1]] = { ...Object.fromEntries([...m[2].matchAll(/--([\w-]+):\s*([^;]+);/g)].map((v) => [v[1], v[2].trim()])), 'color-scheme': (m[2].match(/color-scheme:\s*(\w+)/) || [])[1] };
}
const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

test('every theme in themes.js has a full palette, and dark/light flags match color-scheme', () => {
  const ids = THEMES.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, 'unique ids');
  assert.ok(THEMES.length >= 8);
  for (const t of THEMES.filter((x) => x.id !== 'system')) {
    const p = palettes[t.id];
    assert.ok(p, `palette for ${t.id}`);
    for (const k of ['bg', 'panel', 'line', 'text', 'muted', 'accent', 'on-accent', 'danger', 'sel', 'btn', 'hover', 'logo']) assert.match(p[k] || '', /^#[0-9a-f]{6}$/i, `${t.id} --${k}`);
    assert.equal(p['color-scheme'], t.dark ? 'dark' : 'light', `${t.id} color-scheme`);
    assert.equal(t.dark, lum(p.bg) < 0.3, `${t.id} dark flag matches its background`);
  }
});

test('every theme is readable (WCAG contrast)', () => {
  for (const t of THEMES.filter((x) => x.id !== 'system')) {
    const p = palettes[t.id];
    const need = [['text', 'bg', 4.5], ['text', 'panel', 4.5], ['muted', 'bg', 4.5], ['muted', 'panel', 4.5], ['on-accent', 'accent', 4.5], ['danger', 'bg', 4.5],
      ['danger', 'btn', 4.5], ['text', 'sel', 4.5], ['text', 'btn', 4.5], ['text', 'hover', 4.5], ['accent', 'bg', 3], ['logo', 'bg', 3], ['logo', 'panel', 3]];
    for (const [fg, bg, min] of need) assert.ok(contrast(p[fg], p[bg]) >= min, `${t.id}: --${fg} on --${bg} is ${contrast(p[fg], p[bg]).toFixed(2)}, needs ${min}`);
  }
});
