// Helpers shared by the main window (app.js) and the editor popup windows (editor.js).
const $ = (id) => document.getElementById(id);
const call = (ch, arg) => kyuch.call(ch, arg);
const h = (tag, a = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(a)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat().filter((x) => x != null && x !== false));
  return el;
};

// ---------- button icons: 24x24 outlines in the text colour (white on the dark themes). Settings > Accessibility switches them for letters. ----------
const ICO = {
  add: 'M12 5v14M5 12h14', save: 'M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6', lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  dice: 'M7 4h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zM9 9h.01M15 9h.01M12 12h.01M9 15h.01M15 15h.01',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M13 5v4M7 15v4', 'folder-x': 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM10 11l4 4M14 11l-4 4',
  copy: 'M8 8h11v12H8zM5 16V5a1 1 0 0 1 1-1h10', eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  'eye-off': 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM4 4l16 16',
  open: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  keyboard: 'M3 6h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10',
  edit: 'M4 20l1-4L16 5l3 3L8 19zM14 7l3 3', trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z', search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16 16l5 5',
};
const svgIcon = (name) => {
  const ns = 'http://www.w3.org/2000/svg', s = document.createElementNS(ns, 'svg'), p = document.createElementNS(ns, 'path');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'bi'); s.setAttribute('aria-hidden', 'true'); p.setAttribute('d', ICO[name]); s.append(p); return s;
};
// A button that has both an icon and a label; CSS shows one of them (body[data-buttons]). The label stays as tooltip and screen-reader name.
const ib = (label, icon, a = {}) => h('button', { title: label, 'aria-label': label, ...a }, svgIcon(icon), h('span', { class: 'bl' }, label));
const setBtn = (b, label, icon) => { b.replaceChildren(svgIcon(icon), h('span', { class: 'bl' }, label)); b.title ||= label; b.setAttribute('aria-label', label); };
document.querySelectorAll('button[data-i]').forEach((b) => setBtn(b, b.textContent.trim(), b.dataset.i)); // the buttons written in the HTML

let ICON_MAP = {}; // custom icon id -> data URL; set by whichever page owns the current database data
// One cell of the icon sprite sheet, drawn with a CSS background (see .kic).
const kicon = (i) => { const el = h('span', { class: 'kic', role: 'img' }); el.style.backgroundPosition = `${((i % 10) * 100) / 9}% ${(Math.floor(i / 10) * 100) / 13}%`; return el; };
// Icon for an entry/folder: the user's own image if one is set, otherwise the standard icon with that number (`fallback` if it is unknown).
const iconNode = (o, fallback) => (o.customIcon && ICON_MAP[o.customIcon] ? h('img', { class: 'ico', src: ICON_MAP[o.customIcon], alt: '' }) : kicon(Number.isInteger(o.icon) && o.icon >= 0 && o.icon < ICON_COUNT ? o.icon : fallback));
const yn = (v) => (v === true ? 'Yes' : v === false ? 'No' : v);
const fmtCode = (c) => { const k = Math.ceil(c.length / 2); return c.slice(0, k) + ' ' + c.slice(k); }; // 123456 -> 123 456

function toast(msg, bad) {
  const t = $('toast'); t.textContent = msg; t.className = bad ? 'bad' : ''; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), bad ? 5000 : 1800);
}
const act = async (fn) => { try { return await fn(); } catch (e) { toast(e.message, true); } };

function show(dlg) {
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((r) => dlg.addEventListener('close', () => r(dlg.returnValue === 'ok'), { once: true }));
}

// ---------- theme: explicit data-theme wins, "system" follows the OS ----------
const isDark = () => {
  const t = THEMES.find((x) => x.id === document.documentElement.dataset.theme);
  return t ? t.dark : matchMedia('(prefers-color-scheme: dark)').matches; // no data-theme = "System"
};
const paintThemeBtn = () => { const b = $('themeBtn'); if (b) setBtn(b, isDark() ? 'Light mode' : 'Dark mode', isDark() ? 'sun' : 'moon'); };
// Everything the saved settings change in the look of a page: theme and button style (icons or letters).
function applyCfg(cfg) { applyTheme(cfg.theme); document.body.dataset.buttons = cfg.buttonStyle === 'text' ? 'text' : 'icons'; }
function applyTheme(theme) { if (THEMES.some((t) => t.id === theme && t.id !== 'system')) document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme; paintThemeBtn(); }
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paintThemeBtn);

// Popup windows tell the main window about typing/clicking (throttled), so the idle auto-lock does not fire in the middle of an edit.
function watchActivity() {
  let last = 0;
  for (const ev of ['keydown', 'mousedown']) document.addEventListener(ev, () => { if (Date.now() - last > 10_000) { last = Date.now(); call('app:activity').catch(() => {}); } }, { passive: true });
}
