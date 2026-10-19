const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeImage, nativeTheme, powerMonitor, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Vault, DEFAULTS } = require('./core');
const autotype = require('./autotype');
const { createUpdater } = require('./updater');
const totp = require('./totp');
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
let cfg = { recent: [], autoLockMin: 5, altTabDelayMs: 500, theme: 'system', autoUpdateCheck: true, lastUpdateCheck: 0, keyboardLayout: 'auto' };
try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(cfgFile(), 'utf8')) }; } catch { /* first run */ }
delete cfg.typeStartDelay; // pre-0.3.2 setting, was in seconds
// Native widgets (file dialogs, message boxes) follow the dark/light kind of the chosen theme.
const applyTheme = () => {
  const t = THEMES.find((x) => x.id === cfg.theme && x.id !== 'system');
  nativeTheme.themeSource = t ? (t.dark ? 'dark' : 'light') : 'system';
};
const saveCfg = () => fs.writeFileSync(cfgFile(), JSON.stringify(cfg), { mode: 0o600 }); // lists the user's recent database files: keep it private
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
  'cfg:set': (c) => {
    cfg = { ...cfg, autoLockMin: Math.min(1440, Math.max(0, +c.autoLockMin || 0)), // 0 = never; a huge value would overflow the timer and fire at once
      keyboardLayout: ['auto', 'us', 'gb'].includes(c.keyboardLayout) ? c.keyboardLayout : cfg.keyboardLayout, altTabDelayMs: Math.min(10000, Math.max(0, Math.round(+c.altTabDelayMs) || 0)), theme: THEMES.some((t) => t.id === c.theme) ? c.theme : cfg.theme, autoUpdateCheck: c.autoUpdateCheck === undefined ? cfg.autoUpdateCheck : !!c.autoUpdateCheck };
    applyTheme(); saveCfg(); return cfg;
  },
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
  'icon:add': async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose an icon image', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }], properties: ['openFile'] });
    if (r.canceled) return null;
    let img = nativeImage.createFromPath(r.filePaths[0]);
    if (img.isEmpty()) throw new Error('That file could not be read as a PNG or JPEG image');
    const { width, height } = img.getSize(), side = Math.min(width, height);
    img = img.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side }).resize({ width: 64, height: 64, quality: 'best' });
    const id = vault.addIcon(img.toPNG(), path.basename(r.filePaths[0]));
    return { ...state(), newIcon: id };
  },

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
  'db:lock': async ({ auto } = {}) => {
    // Idle auto-lock must never wait on a modal (the user is away): save atomically, then lock.
    if (auto && vault?.dirty) { try { await vault.save(); } catch { /* fall back to the prompt below */ } }
    if (!(await canLeave())) return false;
    clearClipboard();
    vault = null;
    return true;
  },
  'db:changePassword': async ({ password }) => {
    if (!password) throw new Error('Master password cannot be empty');
    await vault.changePassword(password);
    await vault.save();
    return state();
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
  'entry:open': ({ id }) => {
    let u = vault.secret(id, 'URL').trim();
    if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
    if (!/^https?:/i.test(u)) throw new Error('Only http(s) URLs can be opened');
    return shell.openExternal(u);
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
const NEEDS_VAULT = /^(group:|entry:|move$|db:save|db:changePassword|icon:add)/;
for (const [ch, fn] of Object.entries(handlers)) {
  ipcMain.handle(ch, async (_e, arg) => {
    try {
      if (NEEDS_VAULT.test(ch) && !vault) throw new Error('The database is locked'); return { ok: true, data: await fn(arg) }; } catch (e) { return { ok: false, error: e.message }; }
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

if (gotLock) app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('com.noswear.kyuch'); // taskbar grouping and icon
  Menu.setApplicationMenu(null);
  applyTheme();
  // The page needs no camera, microphone, geolocation, notifications...: refuse every permission request.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  win = new BrowserWindow({
    width: 1100, height: 700, minWidth: 760, minHeight: 480, frame: false, title: 'Kyuch', icon: path.join(__dirname, 'icon.png'), backgroundColor: '#1b1d22',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false,
      devTools: !app.isPackaged,   // no inspector on an installed build
      spellcheck: false,           // spellcheck would see what is typed in password fields (and may fetch dictionaries online)
      webviewTag: false, allowRunningInsecureContent: false,
    },
  });
  for (const ev of ['maximize', 'unmaximize']) win.on(ev, () => win.webContents.send('win:state', win.isMaximized()));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  for (const ev of ['suspend', 'lock-screen']) powerMonitor.on(ev, () => win?.webContents.send('app:autolock')); // a sleeping/locked machine must not leave the vault open
  let closing = false;
  win.on('close', async (e) => {
    if (closing) return;
    e.preventDefault();
    if (await canLeave()) { closing = true; clearClipboard(); win.close(); }
  });
  win.loadFile('renderer/index.html');
  // Once a day (24 h since the last successful check), shortly after launch: look for a newer release and, if there is one, tell the page.
  win.webContents.once('did-finish-load', () => setTimeout(autoCheck, (!app.isPackaged && +process.env.KYUCH_AUTOCHECK_DELAY_MS) || 3000));
});
app.on('window-all-closed', () => app.quit());
