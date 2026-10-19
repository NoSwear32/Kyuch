// UI only. Passwords stay in the main process; this file only ever sees them when the user opens an entry.
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

let S = null;                       // latest state from main (never contains passwords)
let selGroup = null, selEntry = null, query = '';
const expanded = new Set();
let groups = new Map(), entries = new Map(); // id -> {g,parent} / {e,g}
let reveal = null;                  // {id,text} while a password is shown in the detail pane

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
const isDark = () => document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
const paintThemeBtn = () => { $('themeBtn').textContent = isDark() ? 'Light mode' : 'Dark mode'; };
function applyTheme(theme) { if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme; paintThemeBtn(); }
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paintThemeBtn);

// ---------- state ----------
function setState(s) {
  S = s;
  if (s) applyTheme(s.cfg.theme);
  $('lock').hidden = !!s; $('app').hidden = !s;
  for (const id of ['tools', 'search', 'brand']) $(id).hidden = !s; // the title bar keeps only the window buttons while locked
  if (!s) {
    // Locking must not leave an open dialog (or a plaintext password field) on screen.
    document.querySelectorAll('dialog[open]').forEach((d) => d.close());
    for (const id of ['ePass', 'aNewPw', 'nPw', 'nPw2', 'gOut']) $(id).value = '';
    genCtl?.wipe();
    query = ''; $('search').value = ''; selEntry = null; reveal = null; showRecent(); return;
  }
  groups = new Map(); entries = new Map();
  const walk = (g, parent) => { groups.set(g.id, { g, parent }); g.entries.forEach((e) => entries.set(e.id, { e, g })); g.groups.forEach((c) => walk(c, g)); };
  walk(s.root, null);
  expanded.add(s.root.id);
  if (!groups.has(selGroup)) selGroup = s.root.id;
  if (!entries.has(selEntry)) selEntry = null;
  render();
}

const pathOf = (id) => { const out = []; for (let g = groups.get(id); g?.parent; g = groups.get(g.parent.id)) out.unshift(g.g.name); return out.join(' / '); };
// Icon for an entry/folder: the user's own image if one is set, otherwise the standard KeePass icon (emoji).
const iconNode = (o, fallback) => (o.customIcon && S?.icons?.[o.customIcon] ? h('img', { class: 'ico', src: S.icons[o.customIcon], alt: '' }) : (ICONS[o.icon] ?? fallback));
const yn = (v) => (v === true ? 'Yes' : v === false ? 'No' : v);

// ---------- render ----------
function render() {
  $('btnSave').textContent = S.dirty ? 'Save •' : 'Save';
  $('status').textContent = `${S.path} · KDBX${S.legacy ? 3 : 4} · ${entries.size} entries`;
  renderTree(); renderList(); renderDetail();
}

function renderTree() {
  const node = (g, isRoot) => {
    const open = expanded.has(g.id), kids = g.groups.length > 0;
    const row = h('div', {
      class: 'node' + (g.id === selGroup && !query ? ' sel' : ''), draggable: isRoot || g.isBin ? null : 'true',
      onclick: () => { selGroup = g.id; selEntry = null; query = ''; $('search').value = ''; render(); },
      ondragstart: (e) => e.dataTransfer.setData('text/plain', g.id),
      ondragover: (e) => { e.preventDefault(); row.classList.add('drop'); },
      ondragleave: () => row.classList.remove('drop'),
      ondrop: (e) => { e.preventDefault(); row.classList.remove('drop'); move(e.dataTransfer.getData('text/plain'), g.id); },
    },
    h('span', { class: 'tw', onclick: (e) => { e.stopPropagation(); open ? expanded.delete(g.id) : expanded.add(g.id); renderTree(); } }, kids ? (open ? '▾' : '▸') : ''),
    h('span', {}, iconNode(g, '📁')), h('span', {}, g.name));
    return h('div', {}, row, kids && open ? h('div', { class: 'kids' }, g.groups.map((c) => node(c))) : null);
  };
  $('tree').replaceChildren(node(S.root, true));
}

function visibleEntries() {
  if (!query) return groups.get(selGroup).g.entries.map((e) => ({ e, g: groups.get(selGroup).g }));
  const q = query.toLowerCase(), out = [];
  for (const { g } of groups.values()) {
    if (g.isBin || !g.effective.searching.value) continue;
    for (const e of g.entries) if ([e.title, e.username, e.url, e.notes, e.tags.join(' ')].some((f) => f.toLowerCase().includes(q))) out.push({ e, g });
  }
  return out;
}

function renderList() {
  const cur = groups.get(selGroup).g, rows = visibleEntries();
  const bar = query ? h('div', { class: 'muted bar' }, `Search results: ${rows.length}`) : h('div', { class: 'row bar' },
    h('strong', {}, iconNode(cur, '📁'), ' ' + cur.name),
    h('span', { class: 'muted grow' }, cur.notes),
    h('button', { onclick: () => editFolder(cur.id) }, 'Folder settings'),
    cur.id === S.root.id || cur.isBin ? null : h('button', { class: 'danger', onclick: () => delFolder(cur) }, 'Delete'));
  const table = rows.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Title'), h('th', {}, 'Username'), h('th', {}, query ? 'Folder' : 'URL'))),
    h('tbody', {}, rows.map(({ e, g }) => h('tr', {
      class: e.id === selEntry ? 'sel' : '', draggable: 'true',
      onclick: () => { selEntry = e.id; reveal = null; renderList(); renderDetail(); },
      ondblclick: () => editEntry(e.id),
      ondragstart: (ev) => ev.dataTransfer.setData('text/plain', e.id),
    }, h('td', {}, iconNode(e, '🔑'), ' ' + e.title), h('td', {}, e.username), h('td', {}, query ? pathOf(g.id) || g.name : e.url)))))
    : h('div', { class: 'empty' }, query ? 'No matches' : 'No entries here. Use Add, then Entry.');
  $('list').replaceChildren(bar, table);
}

function renderDetail() {
  const hit = entries.get(selEntry);
  if (!hit) return $('detail').replaceChildren(h('div', { class: 'muted' }, 'Select an entry'));
  const { e, g } = hit;
  const field = (label, text, ...btns) => h('div', { class: 'field' }, h('label', {}, label), h('div', { class: 'v' }, h('span', {}, text), btns));
  const pw = reveal?.id === e.id ? reveal.text : '••••••••';
  $('detail').replaceChildren(...[
    h('h2', {}, iconNode(e, '🔑'), e.title),
    h('div', { class: 'muted' }, pathOf(g.id) || g.name),
    field('Username', e.username, h('button', { onclick: () => copy(e.id, 'username') }, 'Copy')),
    field('Password', pw,
      h('button', { onclick: () => act(async () => { reveal = reveal?.id === e.id ? null : { id: e.id, text: (await call('entry:get', { id: e.id })).password }; renderDetail(); }) }, reveal?.id === e.id ? 'Hide' : 'Show'),
      h('button', { onclick: () => copy(e.id, 'password') }, 'Copy')),
    e.url ? field('URL', e.url, h('button', { onclick: () => copy(e.id, 'url') }, 'Copy'), h('button', { onclick: () => act(() => call('entry:open', { id: e.id })) }, 'Open')) : null,
    e.notes ? field('Comments', e.notes) : null,
    e.tags.length ? field('Tags', e.tags.join(', ')) : null,
    h('div', { class: 'actions' },
      h('button', { class: 'primary', onclick: () => autoType(e.id) }, 'Auto-type'),
      h('button', { onclick: () => editEntry(e.id) }, 'Edit'),
      h('button', { class: 'danger', onclick: () => delEntry(e, g) }, 'Delete')),
  ].filter(Boolean));
}

// ---------- actions ----------
const copy = (id, field) => act(async () => { await call('entry:copy', { id, field }); toast(`${field[0].toUpperCase() + field.slice(1)} copied`); });
const autoType = (id) => act(() => call('entry:autotype', { id }));
const move = (id, toId) => act(async () => { if (id && id !== toId) { expanded.add(toId); setState(await call('move', { id, toId })); } });
const update = (ch, arg) => act(async () => setState(await call(ch, arg)));

function delEntry(e, g) {
  if (confirm(g.isBin ? `Permanently delete “${e.title}”?` : `Move “${e.title}” to the Recycle Bin?`)) update('entry:delete', { id: e.id });
}
function delFolder(g) {
  if (confirm(`Move folder “${g.name}” and everything in it to the Recycle Bin?`)) { selGroup = groups.get(g.id).parent.id; update('group:delete', { id: g.id }); }
}

// ---------- icon picker ----------
// Resolves with {icon, customIcon}. Cancel, Esc and clicking outside all resolve with the unchanged value.
function pickIcon(cur) {
  return new Promise((res) => {
    const dlg = $('iconDlg');
    let done = false;
    const finish = (v) => { if (!done) { done = true; res(v); } dlg.close(); };
    $('iconGrid').replaceChildren(...ICONS.map((ic, i) => h('button', { type: 'button', class: !cur.customIcon && cur.icon === i ? 'on' : '', title: `#${i}`, onclick: () => finish({ icon: i, customIcon: null }) }, ic)));
    $('customGrid').replaceChildren(...Object.entries(S.icons || {}).map(([id, src]) =>
      h('button', { type: 'button', class: cur.customIcon === id ? 'on' : '', onclick: () => finish({ icon: cur.icon, customIcon: id }) }, h('img', { class: 'ico', src, alt: '' }))));
    $('iconAdd').onclick = () => act(async () => {
      const s = await call('icon:add');
      if (s) { setState(s); finish({ icon: cur.icon, customIcon: s.newIcon }); } // new icon is applied straight away
    });
    dlg.addEventListener('close', () => finish(cur), { once: true });
    dlg.showModal();
  });
}
const iconButton = (btn, get, set) => {
  const paint = () => btn.replaceChildren(iconNode(get(), '🔑'));
  paint();
  btn.onclick = async () => { set(await pickIcon(get())); paint(); };
};

// ---------- entry dialog ----------
// ---------- password generator dialog ----------
const GEN_KEY = 'kyuch.gen', MAX_MULTI = 30;
function genPrefs() {
  const d = { length: 20, lower: true, upper: true, digits: true, symbols: true, symbolSet: Gen.DEFAULT_SYMBOLS, noAmbiguous: false, multi: false, count: 5 };
  try { return { ...d, ...JSON.parse(localStorage.getItem(GEN_KEY) || '{}') }; } catch { return d; }
}
const clampCount = (v) => Math.min(MAX_MULTI, Math.max(2, Math.round(+v) || 5));
function wireGenerator() {
  const el = (id) => $(id);
  let useMode = false, current = []; // current = what is on screen, so Copy all matches it exactly
  const read = () => ({ length: +el('gLenN').value || 20, lower: el('gLower').checked, upper: el('gUpper').checked, digits: el('gDigits').checked,
    symbols: el('gSymbols').checked, symbolSet: el('gSyms').value, noAmbiguous: el('gAmbig').checked, multi: el('gMulti').checked, count: clampCount(el('gCount').value) });
  const copyText = (text, msg) => act(async () => { if (text) { await call('clip:copy', { text }); toast(msg); } });
  const row = (pw) => h('div', { class: 'genrow' },
    h('input', { class: 'mono', readonly: true, value: pw, 'aria-label': 'Generated password' }),
    h('button', { type: 'button', onclick: () => copyText(pw, 'Password copied') }, 'Copy'),
    useMode ? h('button', { type: 'button', class: 'primary', onclick: () => { el('gOut').value = pw; el('genDlg').close('ok'); } }, 'Use') : null);
  const regen = () => {
    const o = read();
    el('gCountWrap').hidden = !o.multi; el('gList').hidden = !o.multi; el('gOut').hidden = o.multi;
    el('gCopy').textContent = o.multi ? 'Copy all' : 'Copy';
    el('gUse').hidden = !useMode || o.multi; // in multi mode every row has its own Use button
    current = [];
    try {
      current = Array.from({ length: o.multi ? o.count : 1 }, () => Gen.generate(o)); el('gErr').textContent = '';
      try { localStorage.setItem(GEN_KEY, JSON.stringify(o)); } catch { /* prefs are optional */ }
    } catch (e) { el('gErr').textContent = e.message; }
    el('gOut').value = o.multi ? '' : (current[0] || '');
    el('gList').replaceChildren(...(o.multi ? current.map(row) : []));
    const bits = current.length ? Gen.entropy(o) : 0;
    el('gMeter').value = bits; el('gInfo').textContent = current.length ? `${Gen.label(bits)} · ${bits} bits each` : '';
  };
  const sync = (from, to) => el(from).addEventListener('input', () => { el(to).value = el(from).value; regen(); });
  sync('gLen', 'gLenN'); sync('gLenN', 'gLen');
  for (const id of ['gLower', 'gUpper', 'gDigits', 'gSymbols', 'gSyms', 'gAmbig', 'gMulti', 'gCount']) el(id).addEventListener('input', regen);
  // On blur just tidy the number (99 -> 30). Do NOT regenerate: the list already used the clamped count, and a regen here
  // would swap the rows out from under a click on a row's Copy/Use button.
  el('gCount').addEventListener('change', () => { el('gCount').value = clampCount(el('gCount').value); });
  el('gRegen').onclick = regen;
  el('gCopy').onclick = () => copyText(current.join('\n'), current.length > 1 ? `${current.length} passwords copied` : 'Password copied');
  return {
    open(useButton) {
      const p = genPrefs();
      useMode = useButton;
      el('gLen').value = el('gLenN').value = p.length;
      el('gLower').checked = p.lower; el('gUpper').checked = p.upper; el('gDigits').checked = p.digits; el('gSymbols').checked = p.symbols;
      el('gSyms').value = p.symbolSet; el('gAmbig').checked = p.noAmbiguous; el('gMulti').checked = p.multi; el('gCount').value = clampCount(p.count);
      regen();
    },
    wipe() { current = []; el('gOut').value = ''; el('gList').replaceChildren(); },
  };
}
let genCtl = null;
// Resolves with the password if one was chosen ("Use password" / a row's Use), otherwise null. Everything is wiped afterwards.
async function openGenerator(useButton) {
  genCtl ??= wireGenerator();
  genCtl.open(useButton);
  const ok = await show($('genDlg'));
  const pw = ok ? $('gOut').value : null;
  genCtl.wipe();
  return pw;
}
$('btnGen').onclick = () => openGenerator(false);

async function editEntry(id) {
  const base = id ? await act(() => call('entry:get', { id })) : { title: '', username: '', password: '', url: '', notes: '', icon: 0, tags: [], autoType: true, autoTypeSeq: '' };
  if (!base) return;
  const groupId = id ? entries.get(id).g.id : selGroup, g = groups.get(groupId).g;
  let ico = { icon: base.icon, customIcon: base.customIcon ?? null };
  $('entryDlgTitle').textContent = id ? 'Edit entry' : 'New entry';
  iconButton($('eIcon'), () => ico, (v) => (ico = v));
  $('eTitle').value = base.title; $('eUser').value = base.username; $('ePass').value = base.password; $('ePass').type = 'password'; $('eShow').textContent = 'Show';
  $('eUrl').value = base.url; $('eNotes').value = base.notes; $('eTags').value = base.tags.join(', ');
  $('eAuto').checked = base.autoType; $('eSeq').value = base.autoTypeSeq;
  const inh = g.effective.autoTypeSeq;
  $('eSeq').placeholder = `Inherit: ${inh.value}${inh.from ? ` (from ${inh.from})` : ''}`;
  $('eShow').onclick = () => { const hidden = $('ePass').type === 'password'; $('ePass').type = hidden ? 'text' : 'password'; $('eShow').textContent = hidden ? 'Hide' : 'Show'; };
  $('eGen').onclick = async () => { const pw = await openGenerator(true); if (pw) { $('ePass').value = pw; $('ePass').type = 'text'; $('eShow').textContent = 'Hide'; } };
  if (!(await show($('entryDlg')))) return;
  const p = {
    title: $('eTitle').value, username: $('eUser').value, password: $('ePass').value, url: $('eUrl').value.trim(), notes: $('eNotes').value, icon: ico.icon, customIcon: ico.customIcon,
    tags: $('eTags').value.split(',').map((t) => t.trim()).filter(Boolean), autoType: $('eAuto').checked, autoTypeSeq: $('eSeq').value.trim(),
  };
  update(id ? 'entry:update' : 'entry:add', id ? { id, ...p } : { groupId, ...p });
}

// ---------- folder dialog (settings inherit from the parent folder) ----------
function editFolder(id, parentId) {
  const g = id ? groups.get(id).g : null;
  const parent = id ? groups.get(id).parent : groups.get(parentId).g;
  const inherited = (k) => parent ? parent.effective[k] : { value: S.defaults[k], from: null };
  const label = (k, fmt = (v) => v) => { const i = inherited(k); return `Inherit: ${fmt(i.value)} (${i.from ? 'from ' + i.from : 'default'})`; };
  const tri = (sel, k) => {
    const raw = g?.raw[k] ?? null;
    sel.replaceChildren(h('option', { value: '' }, label(k, yn)), h('option', { value: 'true' }, 'Yes'), h('option', { value: 'false' }, 'No'));
    sel.value = raw === null ? '' : String(raw);
  };
  let ico = { icon: g ? g.icon : 48, customIcon: g?.customIcon ?? null };
  $('folderDlgTitle').textContent = g ? 'Folder settings' : 'New folder';
  iconButton($('fIcon'), () => ico, (v) => (ico = v));
  $('fName').value = g ? g.name : ''; $('fNotes').value = g ? g.notes : '';
  tri($('sAuto'), 'autoType'); tri($('sSearch'), 'searching');
  for (const [el, k] of [[$('sSeq'), 'autoTypeSeq'], [$('sClip'), 'clipboardClear'], [$('sDelay'), 'typeDelay']]) {
    el.value = g?.raw[k] ?? ''; el.placeholder = label(k); el.disabled = S.legacy && k !== 'autoTypeSeq';
  }
  $('sNote').textContent = S.legacy ? 'Clipboard and keystroke settings need KDBX4 (this database is KDBX3).' : '';
  show($('folderDlg')).then((ok) => {
    if (!ok) return;
    const num = (el) => (el.value === '' ? null : Number(el.value));
    const tv = (el) => (el.value === '' ? null : el.value === 'true');
    const settings = { autoType: tv($('sAuto')), searching: tv($('sSearch')), autoTypeSeq: $('sSeq').value.trim() };
    if (!S.legacy) Object.assign(settings, { clipboardClear: num($('sClip')), typeDelay: num($('sDelay')) });
    const p = { name: $('fName').value, notes: $('fNotes').value, icon: ico.icon, customIcon: ico.customIcon, settings };
    if (g) update('group:update', { id: g.id, ...p }); else { expanded.add(parentId); update('group:add', { parentId, ...p }); }
  });
}

// ---------- settings dialog ----------
async function appSettings() {
  $('aLock').value = S.cfg.autoLockMin; $('aDelay').value = S.cfg.altTabDelayMs; $('aTheme').value = S.cfg.theme || 'system'; $('aNewPw').value = '';
  $('dbInfo').textContent = `${S.name} — ${S.path} — KDBX${S.legacy ? 3 : 4}`;
  if (!(await show($('settingsDlg')))) return;
  await act(async () => {
    S.cfg = await call('cfg:set', { autoLockMin: $('aLock').value, altTabDelayMs: $('aDelay').value, theme: $('aTheme').value });
    applyTheme(S.cfg.theme);
    armIdle();
    if ($('aNewPw').value) { setState(await call('db:changePassword', { password: $('aNewPw').value })); toast('Master password changed'); }
  });
}

// ---------- lock screen ----------
let unlockPath = null;
async function showRecent() {
  unlockPath = null; $('unlockForm').hidden = true; $('lockErr').textContent = '';
  const cfg = await call('cfg:get');
  $('recent').replaceChildren(...cfg.recent.map((p) => h('button', { onclick: () => pickUnlock(p) }, p)));
}
function pickUnlock(p) {
  unlockPath = p; $('unlockPath').textContent = p; $('unlockForm').hidden = false; $('unlockPw').value = ''; $('unlockPw').focus();
}
$('unlockForm').onsubmit = (e) => {
  e.preventDefault();
  act(async () => {
    $('lockErr').textContent = '';
    try { const s = await call('db:open', { path: unlockPath, password: $('unlockPw').value }); $('unlockPw').value = ''; if (s) { setState(s); armIdle(); } }
    catch (err) { $('lockErr').textContent = err.message; $('unlockPw').select(); }
  });
};
$('btnOpenDb').onclick = () => act(async () => { const p = await call('pick:open'); if (p) pickUnlock(p); });
$('btnNewDb').onclick = () => act(async () => {
  const p = await call('pick:new'); if (!p) return;
  $('newDbPath').textContent = p; $('nPw').value = $('nPw2').value = ''; $('newDbErr').textContent = '';
  const dlg = $('newDbDlg');
  dlg.onclose = null;
  if (!(await show(dlg))) return;
  if ($('nPw').value !== $('nPw2').value) return toast('Passwords do not match', true);
  const s = await call('db:create', { path: p, password: $('nPw').value });
  $('nPw').value = $('nPw2').value = '';
  if (s) { setState(s); armIdle(); }
});

// ---------- toolbar, shortcuts, auto-lock ----------
const lock = (auto) => act(async () => { if (await call('db:lock', { auto: auto === true })) setState(null); else armIdle(); });
$('btnLock').onclick = () => lock();
$('themeBtn').onclick = () => act(async () => {
  const next = await call('cfg:set', { ...(await call('cfg:get')), theme: isDark() ? 'light' : 'dark' });
  applyTheme(next.theme);
  if (S) S.cfg = next;
});
$('btnSave').onclick = () => update('db:save');
$('btnSettings').onclick = appSettings;

// ---------- Add menu ----------
const closeAdd = () => { $('addMenu').hidden = true; $('btnAdd').setAttribute('aria-expanded', 'false'); };
$('btnAdd').onclick = (e) => { e.stopPropagation(); $('addMenu').hidden = !$('addMenu').hidden; $('btnAdd').setAttribute('aria-expanded', String(!$('addMenu').hidden)); };
$('addEntry').onclick = () => { closeAdd(); editEntry(null); };
$('addFolder').onclick = () => { closeAdd(); editFolder(null, selGroup); };
document.addEventListener('click', closeAdd);
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeAdd());

// ---------- window controls (frameless window) ----------
$('wMin').onclick = () => call('win:minimize');
$('wMax').onclick = () => call('win:toggleMax');
$('wClose').onclick = () => call('win:close');
kyuch.onWindowState((max) => { $('wMax').title = max ? 'Restore' : 'Maximize'; $('wMax').querySelector('.max').hidden = max; $('wMax').querySelector('.rest').hidden = !max; });
$('top').addEventListener('dblclick', (e) => { if (!e.target.closest('button,input')) call('win:toggleMax'); });

// ---------- About + updates ----------
let aboutInfo = null;
async function openAbout() {
  aboutInfo = await call('app:info');
  $('aboutVersion').textContent = 'Version ' + aboutInfo.version;
  $('updStatus').textContent = ''; $('updNotes').hidden = true;
  for (const id of ['updInstall', 'updRestart']) $(id).hidden = true;
  $('updCheck').disabled = false;
  $('aboutDlg').showModal();
}
$('btnAbout').onclick = () => act(openAbout);
$('updCheck').onclick = async () => {
  const status = $('updStatus');
  status.textContent = 'Checking…'; $('updCheck').disabled = true; $('updInstall').hidden = true; $('updNotes').hidden = true;
  try {
    const u = await call('update:check');
    if (!u.newer) status.textContent = `You are up to date (version ${u.current}).`;
    else {
      status.textContent = `Version ${u.latest} is available.`;
      $('updNotes').textContent = u.notes.slice(0, 1500); $('updNotes').hidden = !u.notes;
      $('updInstall').textContent = aboutInfo.canInstall ? 'Download and install' : 'Download and verify'; $('updInstall').hidden = false;
    }
  } catch (e) { status.textContent = 'Could not check for updates: ' + e.message; }
  $('updCheck').disabled = false;
};
$('updInstall').onclick = async () => {
  const status = $('updStatus');
  $('updInstall').disabled = true; status.textContent = 'Downloading and checking the signature…';
  try {
    const r = await call('update:install');
    if (r.installed) { status.textContent = 'Installed. Restart Kyuch to finish the update.'; $('updInstall').hidden = true; $('updRestart').hidden = false; }
    else status.textContent = `Downloaded and signature verified (${r.file}). This development build does not install packages.`;
  } catch (e) { status.textContent = 'Update failed: ' + e.message; }
  $('updInstall').disabled = false;
};
$('updRestart').onclick = () => act(() => call('app:relaunch'));
$('search').oninput = (e) => { query = e.target.value.trim(); selEntry = null; render(); };

document.addEventListener('keydown', (e) => {
  if (!S || document.querySelector('dialog[open]')) return;
  const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey, typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if (ctrl && k === 's') { e.preventDefault(); update('db:save'); }
  else if (ctrl && k === 'f') { e.preventDefault(); $('search').focus(); }
  else if (ctrl && k === 'l') { e.preventDefault(); lock(); }
  else if (ctrl && k === 'n') { e.preventDefault(); e.shiftKey ? editFolder(null, selGroup) : editEntry(null); }
  else if (selEntry && ctrl && k === 'b') { e.preventDefault(); copy(selEntry, 'username'); }
  else if (selEntry && ctrl && k === 'u') { e.preventDefault(); act(() => call('entry:open', { id: selEntry })); }
  else if (selEntry && ctrl && e.shiftKey && k === 'v') { e.preventDefault(); autoType(selEntry); }
  else if (selEntry && ctrl && k === 'c' && !typing && !getSelection().toString()) { e.preventDefault(); copy(selEntry, 'password'); }
});

let idle;
function armIdle() {
  clearTimeout(idle);
  if (S && S.cfg.autoLockMin > 0) idle = setTimeout(() => lock(true), S.cfg.autoLockMin * 60000);
}
for (const ev of ['mousemove', 'keydown', 'mousedown']) document.addEventListener(ev, () => S && armIdle(), { passive: true });

act(async () => { applyTheme((await call('cfg:get')).theme); const s = await call('state'); setState(s); if (s) armIdle(); });
