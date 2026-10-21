const { app, BrowserWindow, Menu, Tray, clipboard, dialog, ipcMain, nativeImage, nativeTheme, powerMonitor, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Vault, DEFAULTS, resolveAll } = require('./core');
const autotype = require('./autotype');
const { createUpdater } = require('./updater');
const totp = require('./totp');
const browsers = require('./browsers');
const { execFile } = require('node:child_process');
const ACCESS_HELPER = '/usr/lib/kyuch/autotype-access', ACCESS_RULE = '/etc/udev/rules.d/60-kyuch-uinput.rules';
function autotypeStatus() {
  if (process.platform !== 'linux') return { supported: false };
  let writable = false;
  try { fs.accessSync('/dev/uinput', fs.constants.W_OK); writable = true; } catch { /* no permission, or no uinput */ }
  return { supported: true, writable, ours: fs.existsSync(ACCESS_RULE), canChange: fs.existsSync(ACCESS_HELPER) };
}
const { THEMES } = require('./renderer/themes.js');

// Where releases come from. Dev runs may point KYUCH_UPDATE_API at a local test server; packaged builds never do.
const UPDATE_API = (!app.isPackaged && process.env.KYUCH_UPDATE_API) || 'https://api.github.com/repos/NoSwear32/Kyuch/releases/latest';
const updater = createUpdater({ api: UPDATE_API, current: app.getVersion(), publicKey: fs.readFileSync(path.join(__dirname, 'update-key.pub'), 'utf8'), allowLocal: !app.isPackaged });
// Linux installs the signed .deb via pkexec from /opt/Kyuch; Windows runs the signed installer. A dev checkout only downloads and verifies.
const canSelfInstall = () => app.isPackaged && (process.platform === 'win32' || process.execPath.startsWith('/opt/Kyuch/'));
let typing = false, pendingUpdate = null, download = null, pendingSave = null; // download = AbortController of the transfer in progress

let win, vault = null, clipTimer = null, clipText = null;

// ---- app-level config (not in the database) ----
const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
let cfg = { recent: [], autoLockMin: 5, altTabDelayMs: 500, theme: 'system', autoUpdateCheck: true, lastUpdateCheck: 0, keyboardLayout: 'auto', closeToTray: true, lockOnTray: true, browser: 'system', confirmRemoveDb: true };
try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(cfgFile(), 'utf8')) }; } catch { /* first run */ }
delete cfg.typeStartDelay; // pre-0.3.2 setting, was in seconds
// Native widgets (file dialogs, message boxes) follow the dark/light kind of the chosen theme.
const applyTheme = () => {
  const t = THEMES.find((x) => x.id === cfg.theme && x.id !== 'system');
  nativeTheme.themeSource = t ? (t.dark ? 'dark' : 'light') : 'system';
};
const saveCfg = () => fs.writeFileSync(cfgFile(), JSON.stringify(cfg), { mode: 0o600 }); // lists the user's recent database files: keep it private
const forget = (p) => { cfg.recent = cfg.recent.filter((r) => r !== p); approved.delete(p); saveCfg(); }; // drop a database from the list; the file is never touched
const remember = (p) => { cfg.recent = [p, ...cfg.recent.filter((r) => r !== p)].slice(0, 8); saveCfg(); approved.add(p); };

// ---- clipboard with auto-clear ----
function clearClipboard() {
  clearTimeout(clipTimer);
  if (clipText !== null) {
    let cur = ''; try { cur = clipboard.readText(); } catch { /* unreadable: clear anyway */ }
    if (cur === clipText || cur === '') clipboard.clear();
    clipText = null;
  }
}
function copy(text, seconds) {
  clearClipboard();
  clipboard.writeText(text);
  clipText = text;
  if (seconds > 0) clipTimer = setTimeout(clearClipboard, seconds * 1000);
}

// ---- unsaved changes: never silently drop edits ----
async function canLeave() {
  if (pendingSave) await pendingSave.catch(() => {}); // a save that is still writing decides whether there is anything left to ask about
  if (!vault?.dirty) return true;
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning', message: 'Save changes to the database?', detail: vault.path,
    buttons: ['Save', "Don't save", 'Cancel'], defaultId: 0, cancelId: 2,
  });
  if (response === 2) return false;
  if (response === 0) {
    try { await vault.save(); } catch (e) { dialog.showErrorBox('Could not save the database', e.message); return false; } // stay open so nothing is lost
  }
  return true;
}

const state = () => vault && {
  name: vault.db.meta.name, path: vault.path, dirty: vault.dirty, legacy: vault.legacy, binEnabled: vault.binEnabled, defaults: DEFAULTS, root: vault.tree(), icons: vault.icons(), cfg,
};

// Idle auto-lock must never wait on a modal (the user is away): save atomically, then lock. Everything else asks about unsaved changes first.
async function lockVault(auto) {
  if (auto && vault?.dirty) { try { await vault.save(); } catch { /* fall back to the prompt below */ } }
  if (!(await canLeave())) return false;
  clearClipboard(); closePopups(); // an open editor holds plaintext passwords
  vault = null;
  return true;
}

// ---- system tray: closing the window can minimize to the tray instead of quitting ----
let tray = null, quitting = false, closing = false;
function showWindow() { if (win) { win.show(); win.focus(); } }
function ensureTray() {
  if (tray && !tray.isDestroyed()) return;
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'renderer', 'logo-mark.png')).resize({ height: 32 });
    tray = new Tray(icon);
    tray.setToolTip('Kyuch');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show Kyuch', click: showWindow },
      { label: 'Lock', click: async () => { if (await lockVault(false)) win?.webContents.send('app:locked'); } },
      { type: 'separator' },
      { label: 'Quit Kyuch', click: () => quitApp() },
    ]));
    tray.on('click', () => (win?.isVisible() ? win.hide() : showWindow()));
  } catch { tray = null; } // no tray available: closing the window then quits, so it can never vanish with no way back
}
function dropTray() { if (tray && !tray.isDestroyed()) tray.destroy(); tray = null; }
async function hideToTray() {
  closePopups();
  if (cfg.lockOnTray && vault) { if (!(await lockVault(false))) return; win.webContents.send('app:locked'); } // a hidden window must not hold an open vault
  win.hide();
}
async function quitApp() {
  if (!(await canLeave())) return;
  closing = quitting = true; clearClipboard();
  app.quit();
}
app.on('before-quit', () => { quitting = true; });

const filters = [{ name: 'KeePass database', extensions: ['kdbx'] }];
const approved = new Set(cfg.recent);                       // paths the page may name: chosen in a native dialog, or opened before
const kdbxPath = (p) => (/\.kdbx$/i.test(p) ? p : p + '.kdbx');
// The native save dialog only checks the name you typed ("passwords"); we then add ".kdbx", so ask again if THAT file already exists.
async function confirmReplace(p, typed) {
  if (p === typed || !fs.existsSync(p)) return true;
  const { response } = await dialog.showMessageBox(win, { type: 'warning', message: `Replace the existing file “${path.basename(p)}”?`, detail: 'Its contents will be overwritten.', buttons: ['Cancel', 'Replace'], defaultId: 0, cancelId: 0 });
  return response === 1;
}
const needApproved = (p) => { if (!approved.has(p)) throw new Error('That file was not chosen in a file dialog'); };

async function adopt(v) {
  vault = v;
  remember(v.path);
  if (v.legacy) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'question', message: 'This is an older KDBX3 database',
      detail: 'Per-folder clipboard/keystroke settings and stronger encryption need KDBX4. Upgrade it on the next save? (KeePass 2.35+, KeePassXC and KeePass2Android all read KDBX4.)',
      buttons: ['Upgrade', 'Keep KDBX3'], defaultId: 0,
    });
    if (response === 0) v.upgrade();
  }
  return state();
}

// Every handler returns {ok,data} / {ok:false,error} so the renderer can show messages.
const handlers = {
  'cfg:get': () => cfg,
  'cfg:set': (c) => { // partial updates are fine: only the keys that are present (and valid) change
    const num = (v, hi) => Math.min(hi, Math.max(0, Math.round(+v) || 0)), next = { ...cfg };
    if (c.autoLockMin !== undefined) next.autoLockMin = num(c.autoLockMin, 1440); // 0 = never; a huge value would overflow the timer and fire at once
    if (c.altTabDelayMs !== undefined) next.altTabDelayMs = num(c.altTabDelayMs, 10000);
    if (['auto', 'us', 'gb'].includes(c.keyboardLayout)) next.keyboardLayout = c.keyboardLayout;
    if (THEMES.some((t) => t.id === c.theme)) next.theme = c.theme;
    for (const k of ['autoUpdateCheck', 'closeToTray', 'lockOnTray', 'confirmRemoveDb']) if (typeof c[k] === 'boolean') next[k] = c[k];
    if (browsers.IDS.has(c.browser)) next.browser = c.browser;       // only ids from the fixed browser table, never a command
    cfg = next;
    applyTheme(); saveCfg();
    if (cfg.closeToTray) ensureTray(); else dropTray();
    win?.webContents.send('cfg:changed', cfg);                        // the main window follows changes made in the Settings window
    return cfg;
  },
  'browsers:list': () => [{ id: 'system', label: 'System default' }, ...browsers.detect().map(({ id, label }) => ({ id, label }))],
  'recent:remove': ({ path: p }) => { forget(p); return cfg; },
  // "Close database": lock it (asking about unsaved changes first) and take it off the list of databases
  'db:close': async () => {
    if (!vault) return true;
    const p = vault.path;
    if (!(await lockVault(false))) return false;
    forget(p);
    return true;
  },
  'app:quit': () => quitApp(),
  'clip:copy': ({ text }) => copy(String(text), DEFAULTS.clipboardClear), // generator output; auto-clears like entry passwords
  'state': () => state(),
  'app:info': () => ({ version: app.getVersion(), canInstall: canSelfInstall(), platform: process.platform }),

  // window controls (the window is frameless, so the page draws its own buttons)
  'win:minimize': () => win.minimize(),
  'win:toggleMax': () => { win.isMaximized() ? win.unmaximize() : win.maximize(); return win.isMaximized(); },
  'win:close': () => win.close(), // goes through the unsaved-changes prompt

  'update:check': async () => { pendingUpdate = await updater.check(); cfg.lastUpdateCheck = Date.now(); saveCfg(); return pendingUpdate; },
  'update:cancel': () => { download?.abort(); },

  // Linux auto-type needs /dev/uinput. That permission is opt-in (see scripts/autotype-access.sh), never granted silently by the package.
  'autotype:status': () => autotypeStatus(),
  'autotype:setAccess': async ({ enable }) => {
    if (!fs.existsSync(ACCESS_HELPER)) throw new Error('This can only be changed in the installed app');
    await new Promise((resolve, reject) => execFile('/usr/bin/pkexec', [ACCESS_HELPER, enable ? 'enable' : 'disable'], (e) => {
      if (!e) return resolve();
      reject(new Error(e.code === 126 || e.code === 127 ? 'Cancelled' : e.message.split('\n').pop()));
    }));
    await new Promise((r) => setTimeout(r, 600)); // let udev apply the rule before we look again
    return autotypeStatus();
  },
  'update:install': async () => {
    if (!pendingUpdate?.newer) throw new Error('Check for updates first');
    if (download) throw new Error('A download is already running');
    download = new AbortController();
    let got, last = 0;
    try {
      got = await updater.download(pendingUpdate, { // throws unless the signature verifies
        signal: download.signal,
        onProgress: (received, total) => { // ~10 updates a second is plenty for a progress bar
          const now = Date.now();
          if (now - last > 100 || received === total) { last = now; win?.webContents.send('update:progress', { phase: 'download', received, total }); }
        },
      });
    } finally { download = null; }
    if (!canSelfInstall()) return { installed: false, file: got.file };
    if (process.platform === 'win32' && !(await canLeave())) throw new Error('Update cancelled: unsaved changes'); // the installer closes Kyuch
    win?.webContents.send('update:progress', { phase: 'install' }); // the download can no longer be cancelled; the password prompt follows
    await updater.install(got);
    if (process.platform === 'win32') setTimeout(() => { clearClipboard(); app.exit(0); }, 600); // let the installer replace our files
    return { installed: true };
  },
  'app:relaunch': async () => { if (await canLeave()) { clearClipboard(); app.relaunch(); app.exit(0); } },

  // custom icon: pick an image, crop to a square, shrink to 64px PNG so the database stays small
  'icon:add': async (_a, e) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender) || win, { title: 'Choose an icon image', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }], properties: ['openFile'] });
    if (r.canceled) return null;
    let img = nativeImage.createFromPath(r.filePaths[0]);
    if (img.isEmpty()) throw new Error('That file could not be read as a PNG or JPEG image');
    const { width, height } = img.getSize(), side = Math.min(width, height);
    img = img.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side }).resize({ width: 64, height: 64, quality: 'best' });
    const id = vault.addIcon(img.toPNG(), path.basename(r.filePaths[0]));
    const s = state();
    win?.webContents.send('state:changed', s); // the main window's icon list is now stale too
    return { ...s, newIcon: id };
  },

  // ---- popup windows (entry/folder editor, Settings, password generator) ----
  'popup:open': ({ kind, id, groupId, parentId }) => { openPopup({ kind, id: id || null, groupId: groupId || null, parentId: parentId || null }); },
  'popup:close': (_a, e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w && popupCtx.has(e.sender.id)) w.close(); },
  'editor:init': (_a, e) => {
    const c = ctxOf(e);
    const base = { kind: c.kind, id: c.id, cfg, icons: vault.icons(), legacy: vault.legacy, defaults: DEFAULTS };
    if (c.kind === 'entry') {
      const group = c.id ? vault.entry(c.id).parentGroup : vault.group(c.groupId);
      return { ...base, groupId: group.uuid.id, entry: c.id ? vault.getEntry(c.id) : null, inheritedSeq: resolveAll(group).autoTypeSeq };
    }
    const g = c.id ? vault.group(c.id) : null, parent = g ? g.parentGroup : vault.group(c.parentId);
    return { ...base, parentId: parent?.uuid.id ?? null, g: g ? findNode(vault.tree(), c.id) : null, parentEff: parent ? resolveAll(parent) : null };
  },
  'editor:save': ({ props }, e) => {
    const c = ctxOf(e), w = BrowserWindow.fromWebContents(e.sender);
    if (c.kind === 'entry') { if (c.id) vault.updateEntry(c.id, props); else vault.addEntry(c.groupId || vault.root.uuid.id, props); }
    else if (c.id) vault.updateGroup(c.id, props); else vault.addGroup(c.parentId || vault.root.uuid.id, props);
    win?.webContents.send('state:changed', state());
    setImmediate(() => w && !w.isDestroyed() && w.close());       // after this reply has been delivered
    return true;
  },
  'app:activity': (_a, e) => { if (popupCtx.has(e.sender.id)) win?.webContents.send('app:activity'); },

  'pick:new': async () => {
    const r = await dialog.showSaveDialog(win, { title: 'New database', defaultPath: 'passwords.kdbx', filters });
    if (r.canceled) return null;
    const p = kdbxPath(r.filePath);
    if (!(await confirmReplace(p, r.filePath))) return null;
    approved.add(p);
    return p;
  },
  'pick:open': async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Open database', filters: [...filters, { name: 'All files', extensions: ['*'] }], properties: ['openFile'] });
    if (r.canceled) return null;
    approved.add(r.filePaths[0]);
    return r.filePaths[0];
  },
  'db:create': async ({ path: p, password }) => {
    needApproved(p);
    if (!password) throw new Error('Master password cannot be empty');
    if (!(await canLeave())) return null;
    return adopt(await Vault.create(p, password, path.basename(p, '.kdbx')));
  },
  'db:open': async ({ path: p, password }) => {
    needApproved(p);
    if (vault && vault.path !== p && !(await canLeave())) return null;
    let v;
    try { v = await Vault.open(p, password); } catch (e) {
      if (e.code === 'ENOENT') throw new Error('That database file no longer exists');       // never echo the file path
      if (e.code === 'EACCES') throw new Error('Kyuch is not allowed to read that file');
      throw new Error(/credentials|hmac|key/i.test(e.message) || e.code === 'InvalidKey' ? 'Wrong master password' : e.message.replaceAll(p, 'the database'));
    }
    return adopt(v);
  },
  'db:save': async () => {
    pendingSave = vault.save();
    try { await pendingSave; } finally { pendingSave = null; }
    return state();
  },
  'db:saveAs': async () => {
    const r = await dialog.showSaveDialog(win, { title: 'Save a copy', defaultPath: vault.path, filters });
    if (r.canceled) return state();
    const p = kdbxPath(r.filePath);
    if (await confirmReplace(p, r.filePath)) await vault.save(p, { copy: true }); // a copy: the open database stays the open database
    return state();
  },
  'db:lock': ({ auto } = {}) => lockVault(auto),
  'db:changePassword': async ({ password }) => {
    if (!password) throw new Error('Master password cannot be empty');
    await vault.changePassword(password);
    await vault.save();
    const s = state();
    win?.webContents.send('state:changed', s);                        // asked from the Settings window: tell the main window
    return s;
  },

  'group:add': ({ parentId, ...p }) => (vault.addGroup(parentId, p), state()),
  'group:update': ({ id, ...p }) => (vault.updateGroup(id, p), state()),
  'group:delete': ({ id }) => (vault.deleteGroup(id), state()),
  'move': ({ id, toId }) => (vault.move(id, toId), state()),
  'entry:add': ({ groupId, ...p }) => (vault.addEntry(groupId, p), state()),
  'entry:update': ({ id, ...p }) => (vault.updateEntry(id, p), state()),
  'entry:delete': ({ id }) => (vault.deleteEntry(id), state()),
  'entry:get': ({ id }) => vault.getEntry(id),
  'entry:otp': ({ id }) => vault.otpInfo(id),
  // live preview while editing: validates input (bare secret or otpauth:// link) and returns the normalized link + current code
  'otp:preview': ({ input, digits, period, algorithm }) => {
    const c = totp.parse(input, { digits, period, algorithm });
    return { uri: totp.build(c), digits: c.digits, period: c.period, algorithm: c.algorithm, ...totp.code(c) };
  },

  'entry:copy': ({ id, field }) => {
    if (field === 'otp') { // copy the current code, not the secret
      const c = vault.otpInfo(id);
      if (!c) throw new Error('This entry has no one-time password');
      return copy(c.code, vault.clipboardClear(id));
    }
    const f = { username: 'UserName', password: 'Password', url: 'URL' }[field];
    if (!f) throw new Error('Unknown field');
    copy(vault.secret(id, f), vault.clipboardClear(id));
  },
  'entry:open': ({ id, browser }) => { // `browser`: one-off choice from the "Open with" menu; otherwise the one chosen in Settings
    let u = vault.secret(id, 'URL').trim();
    if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
    if (browser !== undefined && !browsers.IDS.has(browser)) throw new Error('Unknown browser');
    return browsers.openUrl(u, browser ?? cfg.browser, shell);
  },
  'entry:autotype': async ({ id }) => {
    if (typing) throw new Error('Auto-type is already running');
    const t = vault.typeInfo(id);
    if (!t.enabled) throw new Error('Auto-type is disabled for this entry or its folder');
    const actions = autotype.parse(t.seq, t.fields); // validate before hiding the window
    // Every auto-type starts with Alt+Tab, which selects the previous window; the short pause lets that window take focus.
    actions.unshift({ key: 'alttab' }, { delay: 500 });
    typing = true; // two runs at once would interleave their keystrokes
    try {
      await new Promise((r) => setTimeout(r, cfg.altTabDelayMs)); // time to let go of the shortcut keys
      try { await autotype.type(actions, t.delay, { layout: cfg.keyboardLayout }); } catch (e) {
        if (/uinput|Permission denied|Errno 13/i.test(e.message) && process.platform === 'linux') throw new Error('Auto-type is not allowed to emulate a keyboard yet. Open Settings and enable "Auto-type permission".');
        throw e;
      }
    } finally { typing = false; }
  },
};
// Anything that touches the open database: refuse cleanly when it has been locked in the meantime (e.g. Save then Lock in quick succession).
const NEEDS_VAULT = /^(group:|entry:|editor:|move$|db:save|db:changePassword|icon:add)/;
for (const [ch, fn] of Object.entries(handlers)) {
  ipcMain.handle(ch, async (_e, arg) => {
    try {
      if (NEEDS_VAULT.test(ch) && !vault) throw new Error('The database is locked'); return { ok: true, data: await fn(arg, _e) }; } catch (e) { return { ok: false, error: e.message }; }
  });
}

async function autoCheck() {
  if (!cfg.autoUpdateCheck || Date.now() - (cfg.lastUpdateCheck || 0) < 24 * 3600 * 1000) return;
  try {
    const u = await updater.check();
    cfg.lastUpdateCheck = Date.now(); saveCfg(); // only a successful check counts, so an offline launch tries again next time
    if (u.newer) { pendingUpdate = u; win?.webContents.send('update:available', u); }
  } catch { /* offline, rate-limited, or no release yet: stay quiet */ }
}

// One window only: two instances could each hold the same database open and overwrite each other's saves.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });

// Every window (main and editor popups) gets the same locked-down settings.
const webPrefs = () => ({
  preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false,
  devTools: !app.isPackaged,   // no inspector on an installed build
  spellcheck: false,           // spellcheck would see what is typed in password fields (and may fetch dictionaries online)
  webviewTag: false, allowRunningInsecureContent: false,
});
function hardenWindow(w) {
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.webContents.on('will-attach-webview', (e) => e.preventDefault());
}

// ---- popup windows: the entry/folder editor, Settings and the password generator each open in a window of their own ----
const POPUPS = {
  entry: { page: 'editor.html', width: 640, height: 800, needsVault: true },
  folder: { page: 'editor.html', width: 600, height: 720, needsVault: true },
  settings: { page: 'settings.html', width: 640, height: 800 },
  generator: { page: 'genwin.html', width: 520, height: 640 },
};
let popup = null;                  // the one open popup window (modal over the main window)
const popupCtx = new Map();        // webContents id -> what that window is for; only these windows may call popup:close, editor:init, ...
function openPopup(ctx) {
  const spec = POPUPS[ctx.kind];
  if (!spec) throw new Error('Unknown window');
  if (spec.needsVault && !vault) throw new Error('The database is locked');
  if (ctx.kind === 'entry' && ctx.id) vault.entry(ctx.id);       // throws if it does not exist
  if (ctx.kind === 'folder' && ctx.id) vault.group(ctx.id);
  if (popup && !popup.isDestroyed()) { popup.focus(); return; }
  const pb = win.getBounds();
  const w = new BrowserWindow({
    width: spec.width, height: spec.height, minWidth: 480, minHeight: 480, x: Math.max(0, Math.round(pb.x + (pb.width - spec.width) / 2)), y: Math.max(0, Math.round(pb.y + (pb.height - spec.height) / 2)),
    parent: win, modal: true, frame: false, show: false, skipTaskbar: true, minimizable: false, maximizable: false,
    title: 'Kyuch', icon: path.join(__dirname, 'icon.png'), backgroundColor: '#1b1d22', webPreferences: webPrefs(),
  });
  hardenWindow(w);
  const id = w.webContents.id;
  popupCtx.set(id, ctx); popup = w;
  w.once('ready-to-show', () => w.show());
  w.on('closed', () => { popupCtx.delete(id); if (popup === w) popup = null; });
  w.loadFile('renderer/' + spec.page);
}
const closePopups = () => { if (popup && !popup.isDestroyed()) popup.close(); };
const ctxOf = (e) => { const c = popupCtx.get(e.sender.id); if (!c || !vault) throw new Error('This window is no longer needed'); return c; };
const findNode = (n, id) => (n.id === id ? n : n.groups.reduce((f, c) => f || findNode(c, id), null));

if (gotLock) app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('com.noswear.kyuch'); // taskbar grouping and icon
  Menu.setApplicationMenu(null);
  applyTheme();
  // The page needs no camera, microphone, geolocation, notifications...: refuse every permission request.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  win = new BrowserWindow({
    width: 1100, height: 700, minWidth: 760, minHeight: 480, frame: false, title: 'Kyuch', icon: path.join(__dirname, 'icon.png'), backgroundColor: '#1b1d22',
    webPreferences: webPrefs(),
  });
  for (const ev of ['maximize', 'unmaximize']) win.on(ev, () => win.webContents.send('win:state', win.isMaximized()));
  hardenWindow(win);
  for (const ev of ['suspend', 'lock-screen']) powerMonitor.on(ev, () => win?.webContents.send('app:autolock')); // a sleeping/locked machine must not leave the vault open
  if (cfg.closeToTray) ensureTray();
  win.on('close', async (e) => {
    if (closing) return;
    e.preventDefault();
    if (!quitting && cfg.closeToTray && tray) { await hideToTray(); return; } // the X button: minimize to the tray
    if (await canLeave()) { closing = true; clearClipboard(); win.close(); }
  });
  win.loadFile('renderer/index.html');
  // Once a day (24 h since the last successful check), shortly after launch: look for a newer release and, if there is one, tell the page.
  win.webContents.once('did-finish-load', () => setTimeout(autoCheck, (!app.isPackaged && +process.env.KYUCH_AUTOCHECK_DELAY_MS) || 3000));
});
app.on('window-all-closed', () => app.quit());
