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
const paintThemeBtn = () => { const b = $('themeBtn'); if (b) b.textContent = isDark() ? 'Light mode' : 'Dark mode'; };
function applyTheme(theme) { if (THEMES.some((t) => t.id === theme && t.id !== 'system')) document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme; paintThemeBtn(); }
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paintThemeBtn);

// Popup windows tell the main window about typing/clicking (throttled), so the idle auto-lock does not fire in the middle of an edit.
function watchActivity() {
  let last = 0;
  for (const ev of ['keydown', 'mousedown']) document.addEventListener(ev, () => { if (Date.now() - last > 10_000) { last = Date.now(); call('app:activity').catch(() => {}); } }, { passive: true });
}
