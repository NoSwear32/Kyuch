// UI only. Passwords stay in the main process; this file only ever sees them when the user opens an entry.
const $ = (id) => document.getElementById(id);
const call = (ch, arg) => keeper.call(ch, arg);
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

// ---------- state ----------
function setState(s) {
  S = s;
  $('lock').hidden = !!s; $('app').hidden = !s;
  if (!s) {
    // Locking must not leave an open dialog (or a plaintext password field) on screen.
    document.querySelectorAll('dialog[open]').forEach((d) => d.close());
    for (const id of ['ePass', 'aNewPw', 'nPw', 'nPw2']) $(id).value = '';
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
const yn = (v) => (v === true ? 'Yes' : v === false ? 'No' : v);

// ---------- render ----------
function render() {
  $('btnSave').textContent = S.dirty ? '💾 Save •' : '💾 Save';
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
    h('span', {}, ICONS[g.icon] || '📁'), h('span', {}, g.name));
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
    h('strong', {}, `${ICONS[cur.icon] || '📁'} ${cur.name}`),
    h('span', { class: 'muted grow' }, cur.notes),
    h('button', { onclick: () => editFolder(cur.id) }, '✎ Folder settings'),
    cur.id === S.root.id || cur.isBin ? null : h('button', { class: 'danger', onclick: () => delFolder(cur) }, 'Delete'));
  const table = rows.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Title'), h('th', {}, 'Username'), h('th', {}, query ? 'Folder' : 'URL'))),
    h('tbody', {}, rows.map(({ e, g }) => h('tr', {
      class: e.id === selEntry ? 'sel' : '', draggable: 'true',
      onclick: () => { selEntry = e.id; reveal = null; renderList(); renderDetail(); },
      ondblclick: () => editEntry(e.id),
      ondragstart: (ev) => ev.dataTransfer.setData('text/plain', e.id),
    }, h('td', {}, `${ICONS[e.icon] || '🔑'} ${e.title}`), h('td', {}, e.username), h('td', {}, query ? pathOf(g.id) || g.name : e.url)))))
    : h('div', { class: 'empty' }, query ? 'No matches' : 'No entries here. Use “＋ Entry”.');
  $('list').replaceChildren(bar, table);
}

function renderDetail() {
  const hit = entries.get(selEntry);
  if (!hit) return $('detail').replaceChildren(h('div', { class: 'muted' }, 'Select an entry'));
  const { e, g } = hit;
  const field = (label, text, ...btns) => h('div', { class: 'field' }, h('label', {}, label), h('div', { class: 'v' }, h('span', {}, text), btns));
  const pw = reveal?.id === e.id ? reveal.text : '••••••••';
  $('detail').replaceChildren(...[
    h('h2', {}, ICONS[e.icon] || '🔑', e.title),
    h('div', { class: 'muted' }, pathOf(g.id) || g.name),
    field('Username', e.username, h('button', { onclick: () => copy(e.id, 'username') }, 'Copy')),
    field('Password', pw,
      h('button', { onclick: () => act(async () => { reveal = reveal?.id === e.id ? null : { id: e.id, text: (await call('entry:get', { id: e.id })).password }; renderDetail(); }) }, reveal?.id === e.id ? 'Hide' : 'Show'),
      h('button', { onclick: () => copy(e.id, 'password') }, 'Copy')),
    e.url ? field('URL', e.url, h('button', { onclick: () => copy(e.id, 'url') }, 'Copy'), h('button', { onclick: () => act(() => call('entry:open', { id: e.id })) }, 'Open')) : null,
    e.notes ? field('Comments', e.notes) : null,
    e.tags.length ? field('Tags', e.tags.join(', ')) : null,
    h('div', { class: 'actions' },
      h('button', { class: 'primary', onclick: () => autoType(e.id) }, '⌨ Auto-type'),
      h('button', { onclick: () => editEntry(e.id) }, '✎ Edit'),
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
function pickIcon(current) {
  const grid = $('iconGrid');
  return new Promise((res) => {
    const dlg = $('iconDlg');
    grid.replaceChildren(...ICONS.map((ic, i) => h('button', { type: 'button', class: i === current ? 'on' : '', title: `#${i}`, onclick: () => { res(i); dlg.close(); } }, ic)));
    dlg.addEventListener('close', () => res(current), { once: true });
    dlg.showModal();
  });
}
const iconButton = (btn, get, set) => { btn.textContent = ICONS[get()]; btn.onclick = async () => { set(await pickIcon(get())); btn.textContent = ICONS[get()]; }; };

// ---------- entry dialog ----------
const CLASSES = ['abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789', '!@#$%^&*-_=+?'];
function rnd(n) { const a = new Uint32Array(1), lim = 2 ** 32 - (2 ** 32 % n); do crypto.getRandomValues(a); while (a[0] >= lim); return a[0] % n; }
function generate(len) {
  const all = CLASSES.join(''), out = CLASSES.map((c) => c[rnd(c.length)]);
  while (out.length < len) out.push(all[rnd(all.length)]);
  for (let i = out.length - 1; i > 0; i--) { const j = rnd(i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out.join('');
}

async function editEntry(id) {
  const base = id ? await act(() => call('entry:get', { id })) : { title: '', username: '', password: '', url: '', notes: '', icon: 0, tags: [], autoType: true, autoTypeSeq: '' };
  if (!base) return;
  const groupId = id ? entries.get(id).g.id : selGroup, g = groups.get(groupId).g;
  let icon = base.icon;
  $('entryDlgTitle').textContent = id ? 'Edit entry' : 'New entry';
  iconButton($('eIcon'), () => icon, (v) => (icon = v));
  $('eTitle').value = base.title; $('eUser').value = base.username; $('ePass').value = base.password; $('ePass').type = 'password';
  $('eUrl').value = base.url; $('eNotes').value = base.notes; $('eTags').value = base.tags.join(', ');
  $('eAuto').checked = base.autoType; $('eSeq').value = base.autoTypeSeq;
  const inh = g.effective.autoTypeSeq;
  $('eSeq').placeholder = `Inherit: ${inh.value}${inh.from ? ` (from ${inh.from})` : ''}`;
  $('eShow').onclick = () => ($('ePass').type = $('ePass').type === 'password' ? 'text' : 'password');
  $('eGen').onclick = () => { $('ePass').value = generate(Math.min(128, Math.max(8, +$('eGenLen').value || 20))); $('ePass').type = 'text'; };
  if (!(await show($('entryDlg')))) return;
  const p = {
    title: $('eTitle').value, username: $('eUser').value, password: $('ePass').value, url: $('eUrl').value.trim(), notes: $('eNotes').value, icon,
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
  let icon = g ? g.icon : 48;
  $('folderDlgTitle').textContent = g ? 'Folder settings' : 'New folder';
  iconButton($('fIcon'), () => icon, (v) => (icon = v));
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
    const p = { name: $('fName').value, notes: $('fNotes').value, icon, settings };
    if (g) update('group:update', { id: g.id, ...p }); else { expanded.add(parentId); update('group:add', { parentId, ...p }); }
  });
}

// ---------- settings dialog ----------
async function appSettings() {
  $('aLock').value = S.cfg.autoLockMin; $('aDelay').value = S.cfg.typeStartDelay; $('aNewPw').value = '';
  $('dbInfo').textContent = `${S.name} — ${S.path} — KDBX${S.legacy ? 3 : 4}`;
  if (!(await show($('settingsDlg')))) return;
  await act(async () => {
    S.cfg = await call('cfg:set', { autoLockMin: $('aLock').value, typeStartDelay: $('aDelay').value });
    armIdle();
    if ($('aNewPw').value) { setState(await call('db:changePassword', { password: $('aNewPw').value })); toast('Master password changed'); }
  });
}

// ---------- lock screen ----------
let unlockPath = null;
async function showRecent() {
  unlockPath = null; $('unlockForm').hidden = true; $('lockErr').textContent = '';
  const cfg = await call('cfg:get');
  $('recent').replaceChildren(...cfg.recent.map((p) => h('button', { onclick: () => pickUnlock(p) }, '📂 ' + p)));
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
$('btnSave').onclick = () => update('db:save');
$('btnSettings').onclick = appSettings;
$('btnEntry').onclick = () => editEntry(null);
$('btnFolder').onclick = () => editFolder(null, selGroup);
$('search').oninput = (e) => { query = e.target.value.trim(); selEntry = null; render(); };

document.addEventListener('keydown', (e) => {
  if (!S || document.querySelector('dialog[open]')) return;
  const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey, typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if (ctrl && k === 's') { e.preventDefault(); update('db:save'); }
  else if (ctrl && k === 'f') { e.preventDefault(); $('search').focus(); }
  else if (ctrl && k === 'l') { e.preventDefault(); lock(); }
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

act(async () => { const s = await call('state'); setState(s); if (s) armIdle(); });
