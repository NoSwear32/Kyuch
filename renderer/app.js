// UI only. Passwords stay in the main process; this file only ever sees them when the user opens an entry.
let S = null;                       // latest state from main (never contains passwords)
let selGroup = null, selEntry = null, selSet = new Set(), query = ''; // selSet = all selected entries (Ctrl/Shift-click); selEntry = the one shown on the right
const expanded = new Set();
let groups = new Map(), entries = new Map(); // id -> {g,parent,db} / {e,g,db}   (db = path of the database it lives in)
let reveal = null;                  // {id,text} while a password is shown in the detail pane

// ---------- state ----------
function setState(s) {
  S = s;
  if (s) { applyCfg(s.cfg); ICON_MAP = Object.assign({}, ...s.dbs.map((d) => d.icons)); }
  $('lock').hidden = !!s; $('app').hidden = !s;
  document.body.toggleAttribute('data-locked', !s); // while locked the bar keeps only the logo menu and the window buttons
  if (!s) {
    // Locking must not leave an open dialog (or a plaintext password field) on screen.
    document.querySelectorAll('dialog[open]').forEach((d) => d.close());
    for (const id of ['nPw', 'nPw2', 'pwIn']) $(id).value = '';
    clearInterval(detailTimer); closeMenus();
    query = ''; $('search').value = ''; $('searchWrap').classList.remove('open'); selEntry = null; selSet = new Set(); reveal = null; showRecent(); return;
  }
  groups = new Map(); entries = new Map();
  const walk = (g, parent, db) => { groups.set(g.id, { g, parent, db }); g.entries.forEach((e) => entries.set(e.id, { e, g, db })); g.groups.forEach((c) => walk(c, g, db)); };
  for (const d of s.dbs) { walk(d.root, null, d.path); expanded.add(d.root.id); }
  if (!groups.has(selGroup)) selGroup = s.dbs[0].root.id;
  if (!entries.has(selEntry)) selEntry = null;
  selSet = new Set([...selSet].filter((id) => entries.has(id)));
  render();
}

const dbOf = (id) => (groups.get(id) ?? entries.get(id))?.db;                     // path of the database an entry or folder is in
const dbRec = (id) => S.dbs.find((d) => d.path === dbOf(id)) ?? S.dbs[0];
const pathOf = (id) => { const out = []; for (let g = groups.get(id); g?.parent; g = groups.get(g.parent.id)) out.unshift(g.g.name); return out.join(' / '); };

// ---------- render ----------
function render() {
  $('btnSave').toggleAttribute('data-dirty', S.dbs.some((d) => d.dirty));
  const d = dbRec(selGroup);
  $('status').textContent = `${d.path} · KDBX${d.legacy ? 3 : 4} · ${[...entries.values()].filter((x) => x.db === d.path).length} entries`;
  renderTree(); renderList(); renderDetail();
}

// Re-rendering replaces the DOM; if the keyboard focus was inside `el`, put it back on the selected item.
const keepFocus = (el, sel, fn) => { const had = el.contains(document.activeElement); fn(); if (had) el.querySelector(sel)?.focus(); };
const selectEntry = (id) => { selEntry = id; selSet = new Set([id]); reveal = null; renderList(); renderDetail(); };
// Ctrl/Cmd-click adds or removes an entry, Shift-click selects the range from the entry shown on the right; a plain click selects just that one.
function pickEntry(ev, id) {
  if (ev.ctrlKey || ev.metaKey) { selSet.has(id) ? selSet.delete(id) : selSet.add(id); selEntry = selSet.has(id) ? id : ([...selSet].pop() ?? null); }
  else if (ev.shiftKey && selEntry) {
    const ids = visibleEntries().map(({ e }) => e.id), a = ids.indexOf(selEntry), b = ids.indexOf(id);
    if (a >= 0 && b >= 0) selSet = new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
  } else { selEntry = id; selSet = new Set([id]); }
  reveal = null; renderList(); renderDetail();
}
const stepFocus = (ev, container, selector) => { // Up/Down: activate the neighbouring item
  const items = [...container.querySelectorAll(selector)], i = items.indexOf(ev.currentTarget), next = items[i + (ev.key === 'ArrowDown' ? 1 : -1)];
  if (next) { ev.preventDefault(); next.click(); }
};

function renderTree() {
  const node = (g, isRoot, db) => {
    const open = expanded.has(g.id), kids = g.groups.length > 0;
    const row = h('div', {
      class: 'node' + (isRoot ? ' dbroot' : '') + (g.id === selGroup && !query ? ' sel' : ''), draggable: isRoot || g.isBin ? null : 'true',
      tabindex: '0', role: 'treeitem', 'aria-selected': String(g.id === selGroup && !query), 'aria-expanded': kids ? String(open) : null,
      onkeydown: (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.currentTarget.click(); }
        else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') stepFocus(ev, $('tree'), '.node');
        else if (ev.key === 'ArrowRight' && kids && !open) { expanded.add(g.id); keepFocus($('tree'), '.node.sel', renderTree); }
        else if (ev.key === 'ArrowLeft' && kids && open) { expanded.delete(g.id); keepFocus($('tree'), '.node.sel', renderTree); }
      },
      onclick: () => { selGroup = g.id; selEntry = null; selSet = new Set(); query = ''; $('search').value = ''; render(); },
      ondragstart: (e) => e.dataTransfer.setData('text/plain', g.id),
      ondragover: (e) => { e.preventDefault(); row.classList.add('drop'); },
      ondragleave: () => row.classList.remove('drop'),
      ondrop: (e) => { e.preventDefault(); row.classList.remove('drop'); drop(e.dataTransfer.getData('text/plain').split('\n').filter(Boolean), g.id); },
    },
    h('span', { class: 'tw', onclick: (e) => { e.stopPropagation(); open ? expanded.delete(g.id) : expanded.add(g.id); renderTree(); } }, kids ? (open ? '▾' : '▸') : ''),
    h('span', {}, iconNode(g, 48)), h('span', {}, isRoot ? db.name + (db.dirty ? ' •' : '') : g.name));
    return h('div', {}, row, kids && open ? h('div', { class: 'kids' }, g.groups.map((c) => node(c, false, db))) : null);
  };
  keepFocus($('tree'), '.node.sel', () => $('tree').replaceChildren(...S.dbs.map((d) => node(d.root, true, d))));
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
    h('strong', {}, iconNode(cur, 48), ' ' + cur.name),
    h('span', { class: 'muted grow' }, cur.notes),
    ib('Folder settings', 'sliders', { onclick: () => editFolder(cur.id) }),
    !groups.get(cur.id).parent || cur.isBin ? null : ib('Delete', 'folder-x', { class: 'danger', title: 'Delete folder', onclick: () => delFolder(cur) }));
  const table = rows.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Title'), h('th', {}, 'Username'), h('th', {}, query ? 'Folder' : 'URL'))),
    h('tbody', {}, rows.map(({ e, g }) => h('tr', {
      class: selSet.has(e.id) ? 'sel' : '', draggable: 'true', tabindex: '0', 'aria-selected': String(selSet.has(e.id)),
      onkeydown: (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.currentTarget.click(); }
        else if (ev.key === 'F2') editEntry(e.id);
        else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') stepFocus(ev, $('list'), 'tbody tr');
      },
      onclick: (ev) => pickEntry(ev, e.id),
      ondblclick: () => editEntry(e.id),
      oncontextmenu: (ev) => entryMenu(ev, e, g),
      ondragstart: (ev) => ev.dataTransfer.setData('text/plain', (selSet.has(e.id) ? [...selSet] : [e.id]).join('\n')),
    }, h('td', {}, iconNode(e, 0), ' ' + e.title), h('td', {}, e.username), h('td', {}, query ? pathOf(g.id) || g.name : e.url)))))
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
  return h('div', { class: 'field' }, h('label', {}, 'One-time password'), h('div', { class: 'v' }, codeEl, ib('Copy', 'copy', { title: 'Copy the code', onclick: () => copy(e.id, 'otp') })), bar);
}

function renderDetail() {
  clearInterval(detailTimer);
  if (selSet.size > 1) return $('detail').replaceChildren(h('div', { class: 'muted' }, `${selSet.size} entries selected. Right-click one to copy them to another folder or database.`));
  const hit = entries.get(selEntry);
  if (!hit) return $('detail').replaceChildren(h('div', { class: 'muted' }, 'Select an entry'));
  const { e, g } = hit;
  const field = (label, text, ...btns) => h('div', { class: 'field' }, h('label', {}, label), h('div', { class: 'v' }, h('span', {}, text), btns));
  const shown = reveal?.id === e.id, pw = shown ? reveal.text : '••••••••';
  const copyBtn = (field) => ib('Copy', 'copy', { title: `Copy ${field}`, onclick: () => copy(e.id, field) });
  $('detail').replaceChildren(...[
    h('h2', {}, iconNode(e, 0), e.title),
    h('div', { class: 'muted' }, pathOf(g.id) || g.name),
    field('Username', e.username, copyBtn('username')),
    field('Password', pw,
      ib(shown ? 'Hide' : 'Show', shown ? 'eye-off' : 'eye', { title: shown ? 'Hide password' : 'Show password', onclick: () => act(async () => { reveal = shown ? null : { id: e.id, text: (await call('entry:get', { id: e.id })).password }; renderDetail(); }) }),
      copyBtn('password')),
    e.hasOtp ? otpField(e) : null,
    e.url ? field('URL', e.url, copyBtn('url'), ib('Open', 'open', { title: 'Open the URL in the browser', onclick: () => act(() => call('entry:open', { id: e.id })) })) : null,
    e.tags.length ? field('Tags', e.tags.join(', ')) : null,
    h('div', { class: 'actions' },
      ib('Auto-type', 'keyboard', { class: 'primary', onclick: () => autoType(e.id) }),
      ib('Edit', 'edit', { onclick: () => editEntry(e.id) }),
      ib('Delete', 'trash', { class: 'danger', title: 'Delete entry', onclick: () => delEntry(e, g) })),
    e.notes ? h('div', { class: 'field' }, h('label', {}, 'Comments'), h('div', { class: 'v notesbox' }, e.notes)) : null, // below the buttons
  ].filter(Boolean));
}

// ---------- actions ----------
const copy = (id, field) => act(async () => { await call('entry:copy', { id, field }); toast(field === 'otp' ? 'One-time password copied' : `${field[0].toUpperCase() + field.slice(1)} copied`); });
const autoType = (id) => act(() => call('entry:autotype', { id }));
// A reply of null means "locked". If the page is already on the lock screen (the user locked while this was in flight), do not redo the lock-screen reset:
// that would hide the unlock form they may already be typing into.
const applyState = (s) => { if (s || S) setState(s); };
// Dropping onto a folder: inside one database it moves, into another database it copies (folders cannot cross databases).
const drop = (ids, toId) => act(async () => {
  ids = ids.filter((id) => id !== toId); expanded.add(toId);
  if (ids.some((id) => dbOf(id) !== dbOf(toId))) {
    if (ids.some((id) => groups.has(id))) throw new Error('Folders cannot be copied into another database');
    return copyTo(ids, toId);
  }
  for (const id of ids) applyState(await call('move', { id, toId }));
});
const move = (id, toId) => drop([id], toId);
const copyTo = (ids, toId) => act(async () => { expanded.add(toId); applyState(await call('entry:copyTo', { ids, toId })); toast(`${ids.length === 1 ? 'Entry' : ids.length + ' entries'} copied`); });
const update = (ch, arg) => act(async () => applyState(await call(ch, arg)));

const inBin = (gid) => { for (let n = groups.get(gid); n; n = n.parent && groups.get(n.parent.id)) if (n.g.isBin) return true; return false; };
function delEntry(e, g) {
  const gone = inBin(g.id) || !dbRec(g.id).binEnabled; // already in the bin, or this database has no bin: deleting is permanent
  if (confirm(gone ? `Permanently delete “${e.title}”? This cannot be undone.` : `Move “${e.title}” to the Recycle Bin?`)) update('entry:delete', { id: e.id });
}
function delEntries(ids) {
  if (ids.length === 1) { const { e, g } = entries.get(ids[0]); return delEntry(e, g); }
  if (confirm(`Delete ${ids.length} entries? Entries already in a Recycle Bin are deleted permanently; the others move to it.`)) act(async () => { for (const id of ids) applyState(await call('entry:delete', { id })); });
}
function delFolder(g) {
  const gone = inBin(g.id) || !dbRec(g.id).binEnabled;
  if (confirm(gone ? `Permanently delete folder “${g.name}” and everything in it? This cannot be undone.` : `Move folder “${g.name}” and everything in it to the Recycle Bin?`)) {
    selGroup = groups.get(g.id).parent.id; update('group:delete', { id: g.id });
  }
}

// New/edit entry and folder open in their own popup window (see editor.js); the result comes back as a state:changed event.
const editEntry = (id) => act(() => call('popup:open', { kind: 'entry', id: id || undefined, groupId: id ? undefined : selGroup }));
const editFolder = (id, parentId) => act(() => call('popup:open', { kind: 'folder', id: id || undefined, parentId: id ? undefined : parentId }));
kyuch.onStateChanged((s) => { if (selGroup) expanded.add(selGroup); applyState(s); }); // a new folder is created inside the selected one: show it
kyuch.onCfgChanged((c) => { applyCfg(c); if (S) { S.cfg = c; armIdle(); } }); // Settings were applied in their own window
kyuch.onActivity(() => { if (S) armIdle(); }); // typing in an editor window counts as activity for the idle auto-lock

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
// Forgets a database in the list only. The file on disk is never touched. "Don't show this again" turns the question off (Settings turns it back on).
const removeRecent = (p, label) => act(async () => {
  if ((await call('cfg:get')).confirmRemoveDb !== false) {
    $('rmName').textContent = label; $('rmAsk').checked = false;
    if (!(await show($('rmDlg')))) return;
    if ($('rmAsk').checked) await call('cfg:set', { confirmRemoveDb: false });
  }
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
// Open a database. With none open the unlock form on the lock screen asks for the password; with others open, a small dialog does, and the
// new database is stacked in the folder tree next to the open ones.
const openDatabase = () => act(async () => {
  const p = await call('pick:open'); if (!p) return;
  if (!S) return pickUnlock(p);
  $('pwName').textContent = nameOf(p);
  for (let err = ''; ;) {
    $('pwErr').textContent = err; $('pwIn').value = '';
    if (!(await show($('pwDlg')))) return;
    try { const s = await call('db:open', { path: p, password: $('pwIn').value }); $('pwIn').value = ''; if (s) { selGroup = s.dbs.at(-1).root.id; selEntry = null; setState(s); armIdle(); } return; }
    catch (e) { if (e.message !== 'Wrong master password') throw e; err = e.message; }
  }
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
  if (s) { selGroup = s.dbs.at(-1).root.id; selEntry = null; setState(s); armIdle(); }
});
$('btnNewDb').onclick = newDatabase;

// ---------- toolbar, shortcuts, auto-lock ----------
const lock = (auto) => act(async () => { if (await call('db:lock', { auto: auto === true })) setState(null); else armIdle(); });
$('btnLock').onclick = () => lock();
$('themeBtn').onclick = () => act(async () => {
  const next = await call('cfg:set', { ...(await call('cfg:get')), theme: isDark() ? 'light' : 'dark' });
  applyCfg(next);
  if (S) S.cfg = next;
});
$('btnSave').onclick = () => update('db:save');
$('btnGen').onclick = () => act(() => call('popup:open', { kind: 'generator' }));

// ---------- right-click menu on an entry ----------
let browserList = null;
// Sub menu: opens on hover or click (Right arrow from the keyboard), flips to the left / upwards when it would leave the window.
function subMenu(label, items) {
  const box = h('div', { class: 'popmenu sub', role: 'menu', hidden: true }, items);
  const open = (focus) => {
    for (const o of ctxMenu.querySelectorAll('.sub')) if (o !== box) o.hidden = true;
    box.hidden = false; box.classList.remove('flip', 'up');
    const r = box.getBoundingClientRect();
    box.classList.toggle('flip', r.right > innerWidth); box.classList.toggle('up', r.bottom > innerHeight);
    if (focus) box.querySelector('button')?.focus();
  };
  const btn = h('button', { role: 'menuitem', 'aria-haspopup': 'menu', onclick: (ev) => { ev.stopPropagation(); open(false); }, onkeydown: (ev) => { if (ev.key === 'ArrowRight') { ev.preventDefault(); open(true); } } }, label, h('span', { class: 'arrow' }, '▸'));
  return h('div', { class: 'subwrap', onmouseenter: () => open(false), onmouseleave: () => { box.hidden = true; } }, btn, box);
}
const ctxMenu = $('ctxMenu');
async function entryMenu(ev, e, g) {
  ev.preventDefault();
  const fromKeyboard = ev.clientX === 0 && ev.clientY === 0, row = ev.currentTarget.getBoundingClientRect();
  const x = fromKeyboard ? row.left + 24 : ev.clientX, y = fromKeyboard ? row.bottom : ev.clientY;
  closeMenus(); if (!selSet.has(e.id)) selectEntry(e.id); // right-clicking inside the selection acts on all of it
  const ids = [...selSet], multi = ids.length > 1;
  browserList ??= await call('browsers:list');
  const item = (label, fn, disabled) => h('button', { role: 'menuitem', disabled: disabled || null, onclick: () => { closeMenus(); fn(); } }, label);
  const open = (browser) => () => act(() => call('entry:open', { id: e.id, browser }));
  // folders to pick from: [folder, depth, label] for one database or for all of them (a database's root shows the database's name)
  const folders = (only) => { const out = [], walk = (n, depth, label) => { if (n.isBin) return; out.push([n, depth, label]); n.groups.forEach((c) => walk(c, depth + 1, c.name)); }; S.dbs.filter((d) => !only || d.path === only).forEach((d) => walk(d.root, 0, d.name)); return out; };
  const dest = (list, fn) => list.map(([n, depth, label]) => { const b = item('', () => fn(n.id)); b.append(iconNode(n, 48), ' ' + label); b.style.paddingLeft = 10 + depth * 14 + 'px'; return b; });
  const copyMenu = subMenu('Copy to', dest(folders(), (to) => copyTo(ids, to)));      // any folder of any open database
  ctxMenu.replaceChildren(...(multi ? [
    h('div', { class: 'muted menuhead' }, `${ids.length} entries selected`),
    copyMenu,
    h('hr', { class: 'sep' }),
    item('Delete', () => delEntries(ids)),
  ] : [
    item('Edit entry', () => editEntry(e.id)),
    h('hr', { class: 'sep' }),
    item('Copy username', () => copy(e.id, 'username')),
    item('Copy password', () => copy(e.id, 'password')),
    item('Auto-type', () => autoType(e.id)),
    h('hr', { class: 'sep' }),
    item('Open URL', open(undefined), !e.url),
    e.url ? subMenu('Open with', browserList.map((b) => item(b.label, open(b.id)))) : item('Open with', () => {}, true),
    h('hr', { class: 'sep' }),
    (() => { const list = folders(dbOf(g.id)).filter(([n]) => n.id !== g.id); return list.length ? subMenu('Move to', dest(list, (to) => move(e.id, to))) : item('Move to', () => {}, true); })(),
    copyMenu,
    item('Delete', () => delEntry(e, g)),
  ]));
  ctxMenu.hidden = false;
  const r = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px'; ctxMenu.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
  if (fromKeyboard) ctxMenu.querySelector('button').focus();
}
ctxMenu.addEventListener('keydown', (ev) => { // arrow keys move through the (sub) menu the focus is in
  const menu = ev.target.closest('.popmenu');
  const items = [...menu.querySelectorAll(':scope > button:not(:disabled), :scope > .subwrap > button')], i = items.indexOf(ev.target);
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); items[(i + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); }
  else if (ev.key === 'ArrowLeft' && menu.classList.contains('sub')) { ev.preventDefault(); menu.hidden = true; menu.parentElement.firstChild.focus(); }
});
$('list').addEventListener('scroll', () => closeMenus());
window.addEventListener('blur', () => closeMenus());

// ---------- Add menu ----------
const MENUS = [['btnAdd', 'addMenu'], ['brandBtn', 'logoMenu']];
const closeMenus = () => { for (const [b, m] of MENUS) { $(m).hidden = true; $(b).setAttribute('aria-expanded', 'false'); } $('ctxMenu').hidden = true; };
for (const [b, m] of MENUS) {
  $(b).onclick = (e) => { e.stopPropagation(); const wasClosed = $(m).hidden; closeMenus(); $(m).hidden = !wasClosed; $(b).setAttribute('aria-expanded', String(wasClosed)); };
}
$('addEntry').onclick = () => { closeMenus(); editEntry(null); };
$('addFolder').onclick = () => { closeMenus(); editFolder(null, selGroup); };
// the logo menu
$('mNew').onclick = () => { closeMenus(); newDatabase(); };
$('mOpen').onclick = () => { closeMenus(); openDatabase(); };
$('mLock').onclick = () => { closeMenus(); lock(); };
// Close database: closes the selected database (asking about unsaved changes first) and takes it off the list
$('mClose').onclick = () => { closeMenus(); act(async () => { const r = await call('db:close', { db: dbOf(selGroup) }); if (r) setState(r.state); }); }; // the open database (the one whose folder is selected)
$('mSettings').onclick = () => { closeMenus(); act(() => call('popup:open', { kind: 'settings' })); };
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
// The magnifier grows into the search field; it shrinks back when it loses focus while empty, and Esc clears it.
const expandSearch = () => { $('searchWrap').classList.add('open'); $('search').focus(); };
$('btnSearch').onclick = expandSearch;
$('search').onblur = () => { if (!$('search').value) $('searchWrap').classList.remove('open'); };
$('search').onkeydown = (e) => { if (e.key === 'Escape') { $('search').value = ''; query = ''; selEntry = null; selSet = new Set(); render(); $('search').blur(); } };
$('search').oninput = (e) => { query = e.target.value.trim(); selEntry = null; selSet = new Set(); render(); };

document.addEventListener('keydown', (e) => {
  if (!S || document.querySelector('dialog[open]')) return;
  const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey, typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if (ctrl && k === 's') { e.preventDefault(); update('db:save'); }
  else if (ctrl && k === 'f') { e.preventDefault(); expandSearch(); }
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

act(async () => { applyCfg(await call('cfg:get')); const s = await call('state'); setState(s); if (s) armIdle(); });
