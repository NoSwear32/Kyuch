// UI only. Passwords stay in the main process; this file only ever sees them when the user opens an entry.
let S = null;                       // latest state from main (never contains passwords)
let selGroup = null, selEntry = null, query = '';
const expanded = new Set();
let groups = new Map(), entries = new Map(); // id -> {g,parent} / {e,g}
let reveal = null;                  // {id,text} while a password is shown in the detail pane

// ---------- state ----------
function setState(s) {
  S = s;
  if (s) { applyTheme(s.cfg.theme); ICON_MAP = s.icons || {}; }
  $('lock').hidden = !!s; $('app').hidden = !s;
  document.body.toggleAttribute('data-locked', !s); $('search').hidden = !s; // while locked the bar keeps the logo menu, Settings, About and the window buttons
  if (!s) {
    // Locking must not leave an open dialog (or a plaintext password field) on screen.
    document.querySelectorAll('dialog[open]').forEach((d) => d.close());
    for (const id of ['aNewPw', 'aNewPw2', 'nPw', 'nPw2', 'gOut']) $(id).value = '';
    genCtl?.wipe(); clearInterval(detailTimer);
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

// ---------- render ----------
function render() {
  $('btnSave').textContent = S.dirty ? 'Save •' : 'Save';
  $('status').textContent = `${S.path} · KDBX${S.legacy ? 3 : 4} · ${entries.size} entries`;
  renderTree(); renderList(); renderDetail();
}

// Re-rendering replaces the DOM; if the keyboard focus was inside `el`, put it back on the selected item.
const keepFocus = (el, sel, fn) => { const had = el.contains(document.activeElement); fn(); if (had) el.querySelector(sel)?.focus(); };
const selectEntry = (id) => { selEntry = id; reveal = null; renderList(); renderDetail(); };
const stepFocus = (ev, container, selector) => { // Up/Down: activate the neighbouring item
  const items = [...container.querySelectorAll(selector)], i = items.indexOf(ev.currentTarget), next = items[i + (ev.key === 'ArrowDown' ? 1 : -1)];
  if (next) { ev.preventDefault(); next.click(); }
};

function renderTree() {
  const node = (g, isRoot) => {
    const open = expanded.has(g.id), kids = g.groups.length > 0;
    const row = h('div', {
      class: 'node' + (g.id === selGroup && !query ? ' sel' : ''), draggable: isRoot || g.isBin ? null : 'true',
      tabindex: '0', role: 'treeitem', 'aria-selected': String(g.id === selGroup && !query), 'aria-expanded': kids ? String(open) : null,
      onkeydown: (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.currentTarget.click(); }
        else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') stepFocus(ev, $('tree'), '.node');
        else if (ev.key === 'ArrowRight' && kids && !open) { expanded.add(g.id); keepFocus($('tree'), '.node.sel', renderTree); }
        else if (ev.key === 'ArrowLeft' && kids && open) { expanded.delete(g.id); keepFocus($('tree'), '.node.sel', renderTree); }
      },
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
  keepFocus($('tree'), '.node.sel', () => $('tree').replaceChildren(node(S.root, true)));
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
      class: e.id === selEntry ? 'sel' : '', draggable: 'true', tabindex: '0', 'aria-selected': String(e.id === selEntry),
      onkeydown: (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.currentTarget.click(); }
        else if (ev.key === 'F2') editEntry(e.id);
        else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') stepFocus(ev, $('list'), 'tbody tr');
      },
      onclick: () => selectEntry(e.id),
      ondblclick: () => editEntry(e.id),
      ondragstart: (ev) => ev.dataTransfer.setData('text/plain', e.id),
    }, h('td', {}, iconNode(e, '🔑'), ' ' + e.title), h('td', {}, e.username), h('td', {}, query ? pathOf(g.id) || g.name : e.url)))))
    : h('div', { class: 'empty' }, query ? 'No matches' : 'No entries here. Use Add, then Entry.');
  keepFocus($('list'), 'tr.sel', () => $('list').replaceChildren(bar, table));
}

let detailTimer = null;
function otpField(e) {
  const codeEl = h('span', { class: 'mono otpcode small' }, '…'), bar = h('progress', { max: 30, value: 0 });
  let expires = 0, fetching = false;
  const load = async () => {
    fetching = true;
    try {
      const r = await call('entry:otp', { id: e.id });
      if (selEntry !== e.id) return;
      codeEl.textContent = fmtCode(r.code); bar.max = r.period; expires = r.validUntil;
    } catch (err) { if (selEntry !== e.id) return; codeEl.textContent = err.message; clearInterval(detailTimer); } finally { fetching = false; }
  };
  clearInterval(detailTimer); load();
  detailTimer = setInterval(() => { const left = Math.max(0, (expires - Date.now()) / 1000); bar.value = left; if (left <= 0 && !fetching) load(); }, 500);
  return h('div', { class: 'field' }, h('label', {}, 'One-time password'), h('div', { class: 'v' }, codeEl, h('button', { onclick: () => copy(e.id, 'otp') }, 'Copy')), bar);
}

function renderDetail() {
  clearInterval(detailTimer);
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
    e.hasOtp ? otpField(e) : null,
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
const copy = (id, field) => act(async () => { await call('entry:copy', { id, field }); toast(field === 'otp' ? 'One-time password copied' : `${field[0].toUpperCase() + field.slice(1)} copied`); });
const autoType = (id) => act(() => call('entry:autotype', { id }));
// A reply of null means "locked". If the page is already on the lock screen (the user locked while this was in flight), do not redo the lock-screen reset:
// that would hide the unlock form they may already be typing into.
const applyState = (s) => { if (s || S) setState(s); };
const move = (id, toId) => act(async () => { if (id && id !== toId) { expanded.add(toId); applyState(await call('move', { id, toId })); } });
const update = (ch, arg) => act(async () => applyState(await call(ch, arg)));

const inBin = (gid) => { for (let n = groups.get(gid); n; n = n.parent && groups.get(n.parent.id)) if (n.g.isBin) return true; return false; };
function delEntry(e, g) {
  const gone = inBin(g.id) || !S.binEnabled; // already in the bin, or this database has no bin: deleting is permanent
  if (confirm(gone ? `Permanently delete “${e.title}”? This cannot be undone.` : `Move “${e.title}” to the Recycle Bin?`)) update('entry:delete', { id: e.id });
}
function delFolder(g) {
  const gone = inBin(g.id) || !S.binEnabled;
  if (confirm(gone ? `Permanently delete folder “${g.name}” and everything in it? This cannot be undone.` : `Move folder “${g.name}” and everything in it to the Recycle Bin?`)) {
    selGroup = groups.get(g.id).parent.id; update('group:delete', { id: g.id });
  }
}

// New/edit entry and folder open in their own popup window (see editor.js); the result comes back as a state:changed event.
const editEntry = (id) => act(() => call('editor:open', { kind: 'entry', id: id || undefined, groupId: id ? undefined : selGroup }));
const editFolder = (id, parentId) => act(() => call('editor:open', { kind: 'folder', id: id || undefined, parentId: id ? undefined : parentId }));
kyuch.onStateChanged((s) => { if (selGroup) expanded.add(selGroup); applyState(s); }); // a new folder is created inside the selected one: show it
kyuch.onActivity(() => { if (S) armIdle(); }); // typing in an editor window counts as activity for the idle auto-lock

// ---------- settings dialog ----------
async function appSettings() {
  const hadVault = !!S, cfg = S ? S.cfg : await call('cfg:get');
  $('aLock').value = cfg.autoLockMin; $('aDelay').value = cfg.altTabDelayMs; $('aAutoUpd').checked = cfg.autoUpdateCheck !== false;
  $('aTray').checked = cfg.closeToTray !== false; $('aTrayLock').checked = cfg.lockOnTray !== false;
  $('aNewPw').value = ''; $('aNewPw2').value = ''; $('aErr').textContent = '';
  $('aPwBox').hidden = $('dbInfo').hidden = !hadVault; // database-specific parts only make sense with one open
  const info = await call('app:info'); $('aLayoutWrap').hidden = info.platform === 'win32'; $('aLayout').value = cfg.keyboardLayout || 'auto';
  const list = await call('browsers:list');
  $('aBrowser').replaceChildren(...list.map((b) => h('option', { value: b.id }, b.label)));
  $('aBrowser').value = list.some((b) => b.id === cfg.browser) ? cfg.browser : 'system';
  const paintAccess = (st) => {
    $('aAccessBox').hidden = !st.supported;
    if (!st.supported) return;
    $('aAccessText').textContent = st.writable
      ? (st.ours ? 'Enabled. Auto-type may emulate a keyboard.' : 'Enabled by a rule outside Kyuch (nothing to change here).')
      : 'Off. Auto-type needs permission to emulate a keyboard (/dev/uinput). While this is on, every program you run can type into any window, so it is off until you allow it.';
    $('aAccessBtn').hidden = !st.canChange || (st.writable && !st.ours);
    $('aAccessBtn').textContent = st.writable ? 'Withdraw permission…' : 'Allow auto-type…';
    $('aAccessBtn').onclick = () => act(async () => { paintAccess(await call('autotype:setAccess', { enable: !st.writable })); });
  };
  paintAccess(await call('autotype:status'));
  if (hadVault) $('dbInfo').textContent = `${S.name} — ${S.path} — KDBX${S.legacy ? 3 : 4}`;
  let chosen = cfg.theme || 'system';
  const cards = THEMES.map((t) => h('button', { type: 'button', class: 'theme-card', 'data-theme': t.id, role: 'radio', onclick: () => { chosen = t.id; applyTheme(chosen); mark(); } },
    h('span', {}, t.label), t.id === 'system' ? null : h('span', { class: 'chips' }, h('i'), h('i'), h('i'))));
  const mark = () => cards.forEach((c) => c.setAttribute('aria-checked', String(c.dataset.theme === chosen)));
  $('aThemes').replaceChildren(...cards); mark(); // clicking a card previews it live
  const ok = await show($('settingsDlg'));
  if (hadVault && !S) return;                      // the vault locked while Settings was open: the lock already closed everything
  if (!ok) { applyTheme(cfg.theme); return; }     // Cancel / Esc: back to the saved theme
  await act(async () => {
    const next = await call('cfg:set', {
      autoLockMin: $('aLock').value, altTabDelayMs: $('aDelay').value, theme: chosen, autoUpdateCheck: $('aAutoUpd').checked, keyboardLayout: $('aLayout').value,
      closeToTray: $('aTray').checked, lockOnTray: $('aTrayLock').checked, browser: $('aBrowser').value,
    });
    if (S) S.cfg = next;
    applyTheme(next.theme);
    if (S) armIdle();
    if (S && $('aNewPw').value) { setState(await call('db:changePassword', { password: $('aNewPw').value })); toast('Master password changed'); }
    $('aNewPw').value = $('aNewPw2').value = '';
  });
}

// A typo in a new master password would lock the user out of their own database: make them type it twice, like when creating one.
$('settingsForm').addEventListener('submit', (e) => {
  if (e.submitter?.value === 'ok' && $('aNewPw').value !== $('aNewPw2').value) { e.preventDefault(); $('aErr').textContent = 'The two master passwords do not match.'; }
});

// ---------- lock screen ----------
const nameOf = (p) => p.split(/[\\/]/).pop().replace(/\.kdbx$/i, '');
// Names only, never paths. If two databases share a name, their folder is appended to tell them apart.
function dbLabels(paths) {
  const names = paths.map(nameOf);
  return paths.map((p, i) => (names.filter((n) => n === names[i]).length > 1 ? `${names[i]} (${p.split(/[\\/]/).slice(-2, -1)[0] || ''})` : names[i]));
}
let unlockPath = null;
async function showRecent() {
  unlockPath = null; $('unlockForm').hidden = true; $('lockErr').textContent = '';
  const cfg = await call('cfg:get');
  const labels = dbLabels(cfg.recent);
  $('recent').replaceChildren(...cfg.recent.map((p, i) => h('div', { class: 'recentrow' },
    h('button', { class: 'grow', onclick: () => pickUnlock(p, labels[i]) }, labels[i]),
    h('button', { class: 'trash', title: 'Remove from this list (the file is not deleted)', 'aria-label': `Remove ${labels[i]} from the list`, onclick: () => removeRecent(p, labels[i]) }, trashIcon()))));
}
const trashIcon = () => { // inline SVG (no innerHTML): a trash can
  const ns = 'http://www.w3.org/2000/svg', s = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({ width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) s.setAttribute(k, v);
  const p = document.createElementNS(ns, 'path'); p.setAttribute('d', 'M2.5 4h11M6.2 4V2.6h3.6V4M4 4l.7 9.2c0 .5.4.8.9.8h4.8c.5 0 .9-.3.9-.8L12 4M6.6 6.8v4.4M9.4 6.8v4.4');
  s.append(p); return s;
};
// Forgets a database in the list only. The file on disk is never touched.
const removeRecent = (p, label) => act(async () => {
  if (!confirm(`Remove “${label}” from this list?\n\nThe database file itself is not deleted; you can add it again with Open file.`)) return;
  if (unlockPath === p) { unlockPath = null; $('unlockForm').hidden = true; }
  await call('recent:remove', { path: p });
  showRecent();
});
function pickUnlock(p, label = nameOf(p)) {
  unlockPath = p; $('unlockPath').textContent = label; $('unlockForm').hidden = false; $('unlockPw').value = ''; $('unlockPw').focus();
}
$('unlockForm').onsubmit = (e) => {
  e.preventDefault();
  act(async () => {
    $('lockErr').textContent = '';
    try { const s = await call('db:open', { path: unlockPath, password: $('unlockPw').value }); $('unlockPw').value = ''; if (s) { setState(s); armIdle(); } }
    catch (err) { $('lockErr').textContent = err.message; $('unlockPw').select(); }
  });
};
// Open a database: when one is already open it is closed first (asking about unsaved changes), then the unlock form appears for the new one.
const openDatabase = () => act(async () => {
  const p = await call('pick:open'); if (!p) return;
  if (S) { if (!(await call('db:lock'))) return; setState(null); }
  pickUnlock(p);
});
$('btnOpenDb').onclick = openDatabase;
const newDatabase = () => act(async () => {
  const p = await call('pick:new'); if (!p) return;
  $('newDbPath').textContent = nameOf(p); $('nPw').value = $('nPw2').value = ''; $('newDbErr').textContent = '';
  const dlg = $('newDbDlg');
  dlg.onclose = null;
  if (!(await show(dlg))) return;
  if ($('nPw').value !== $('nPw2').value) return toast('Passwords do not match', true);
  const s = await call('db:create', { path: p, password: $('nPw').value });
  $('nPw').value = $('nPw2').value = '';
  if (s) { setState(s); armIdle(); }
});
$('btnNewDb').onclick = newDatabase;

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
const MENUS = [['btnAdd', 'addMenu'], ['brandBtn', 'logoMenu']];
const closeMenus = () => { for (const [b, m] of MENUS) { $(m).hidden = true; $(b).setAttribute('aria-expanded', 'false'); } };
for (const [b, m] of MENUS) {
  $(b).onclick = (e) => { e.stopPropagation(); const wasClosed = $(m).hidden; closeMenus(); $(m).hidden = !wasClosed; $(b).setAttribute('aria-expanded', String(wasClosed)); };
}
$('addEntry').onclick = () => { closeMenus(); editEntry(null); };
$('addFolder').onclick = () => { closeMenus(); editFolder(null, selGroup); };
// the logo menu
$('mNew').onclick = () => { closeMenus(); newDatabase(); };
$('mOpen').onclick = () => { closeMenus(); openDatabase(); };
$('mLock').onclick = () => { closeMenus(); lock(); };
$('mClose').onclick = () => { closeMenus(); lock(); };       // closing a database = back to the database list
$('mSettings').onclick = () => { closeMenus(); appSettings(); };
$('mAbout').onclick = () => { closeMenus(); act(() => openAbout()); };
$('mQuit').onclick = () => { closeMenus(); act(() => call('app:quit')); };
document.addEventListener('click', closeMenus);
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeMenus());
kyuch.onLocked(() => setState(null)); // the window went to the tray and the database was locked on the way

// ---------- window controls (frameless window) ----------
$('wMin').onclick = () => call('win:minimize');
$('wMax').onclick = () => call('win:toggleMax');
$('wClose').onclick = () => call('win:close');
kyuch.onWindowState((max) => { $('wMax').title = max ? 'Restore' : 'Maximize'; $('wMax').querySelector('.max').hidden = max; $('wMax').querySelector('.rest').hidden = !max; });
$('top').addEventListener('dblclick', (e) => { if (!e.target.closest('button,input')) call('win:toggleMax'); });

// ---------- About + updates ----------
let aboutInfo = null, downloading = false;
const mb = (n) => (n / 1048576).toFixed(1);
// idle | available | downloading | installing | installed: which of the update controls are on screen
function updUi(state) {
  const dl = state === 'downloading';
  $('updCheck').disabled = dl || state === 'installing';
  $('updInstall').hidden = state !== 'available';
  $('updCancel').hidden = !dl;                      // the red Cancel replaces "Download and install" while downloading
  $('updBar').hidden = $('updPct').hidden = !dl;
  $('updRestart').hidden = state !== 'installed';
}
function offerUpdate(u) {
  $('updStatus').textContent = `Version ${u.latest} is available.`;
  $('updNotes').textContent = u.notes.slice(0, 1500); $('updNotes').hidden = !u.notes;
  $('updInstall').textContent = aboutInfo.canInstall ? 'Download and install' : 'Download and verify';
  updUi('available');
}
// `found` = a check result, when the daily check opens this dialog as its popup
async function openAbout(found) {
  aboutInfo = await call('app:info');
  $('aboutVersion').textContent = 'Version ' + aboutInfo.version;
  $('updStatus').textContent = ''; $('updNotes').hidden = true; updUi('idle');
  if (found) offerUpdate(found);
  if (!$('aboutDlg').open) $('aboutDlg').showModal();
}
$('btnAbout').onclick = () => act(() => openAbout());
kyuch.onUpdateAvailable((u) => act(() => openAbout(u)));

$('updCheck').onclick = async () => {
  $('updStatus').textContent = 'Checking…'; $('updNotes').hidden = true; updUi('idle'); $('updCheck').disabled = true;
  try {
    const u = await call('update:check');
    if (!u.newer) $('updStatus').textContent = `You are up to date (version ${u.current}).`; else offerUpdate(u);
  } catch (e) { $('updStatus').textContent = 'Could not check for updates: ' + e.message; }
  $('updCheck').disabled = false;
};
kyuch.onUpdateProgress((p) => {
  if (p.phase === 'download') {
    $('updBar').max = p.total || p.received || 1; $('updBar').value = p.received;
    $('updPct').textContent = p.total ? `${mb(p.received)} of ${mb(p.total)} MB (${Math.floor((p.received * 100) / p.total)}%)` : `${mb(p.received)} MB`;
  } else if (p.phase === 'install') { // past the point of cancelling: the system password prompt is next
    updUi('installing'); $('updStatus').textContent = 'Installing… enter your password in the system prompt.';
  }
});
$('updInstall').onclick = async () => {
  downloading = true; updUi('downloading');
  $('updBar').max = 1; $('updBar').value = 0; $('updPct').textContent = 'Starting…'; $('updStatus').textContent = 'Downloading…';
  try {
    const r = await call('update:install');
    if (r.installed) { $('updStatus').textContent = 'Installed. Restart Kyuch to finish the update.'; updUi('installed'); }
    else { $('updStatus').textContent = `Downloaded and signature verified (${r.file}). This development build does not install packages.`; updUi('idle'); }
  } catch (e) {
    $('updStatus').textContent = /^Download cancelled/.test(e.message) ? 'Download cancelled.' : 'Update failed: ' + e.message;
    updUi('available'); // allow another try
  } finally { downloading = false; }
};
$('updCancel').onclick = () => act(() => call('update:cancel'));
$('aboutDlg').addEventListener('close', () => { if (downloading) call('update:cancel').catch(() => {}); }); // closing the dialog cancels a running download
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

kyuch.onAutoLock(() => { if (S) lock(true); }); // the machine is suspending or locking its screen

let idle;
function armIdle() {
  clearTimeout(idle);
  if (S && S.cfg.autoLockMin > 0) idle = setTimeout(() => lock(true), S.cfg.autoLockMin * 60000);
}
for (const ev of ['mousemove', 'keydown', 'mousedown']) document.addEventListener(ev, () => S && armIdle(), { passive: true });

act(async () => { applyTheme((await call('cfg:get')).theme); const s = await call('state'); setState(s); if (s) armIdle(); });
