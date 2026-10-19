const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeImage, nativeTheme, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Vault, DEFAULTS } = require('./core');
const autotype = require('./autotype');
const { createUpdater } = require('./updater');
const totp = require('./totp');
const { THEMES } = require('./renderer/themes.js');

// Where releases come from. Dev runs may point KYUCH_UPDATE_API at a local test server; packaged builds never do.
const UPDATE_API = (!app.isPackaged && process.env.KYUCH_UPDATE_API) || 'https://api.github.com/repos/NoSwear32/Kyuch/releases/latest';
const updater = createUpdater({ api: UPDATE_API, current: app.getVersion(), publicKey: fs.readFileSync(path.join(__dirname, 'update-key.pub'), 'utf8'), allowLocal: !app.isPackaged });
let pendingUpdate = null, download = null; // download = AbortController of the transfer in progress

let win, vault = null, clipTimer = null, clipText = null;

// ---- app-level config (not in the database) ----
const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
let cfg = { recent: [], autoLockMin: 5, altTabDelayMs: 500, theme: 'system', autoUpdateCheck: true, lastUpdateCheck: 0 };
try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(cfgFile(), 'utf8')) }; } catch { /* first run */ }
delete cfg.typeStartDelay; // pre-0.3.2 setting, was in seconds
// Native widgets (file dialogs, message boxes) follow the dark/light kind of the chosen theme.
const applyTheme = () => {
  const t = THEMES.find((x) => x.id === cfg.theme && x.id !== 'system');
  nativeTheme.themeSource = t ? (t.dark ? 'dark' : 'light') : 'system';
};
const saveCfg = () => fs.writeFileSync(cfgFile(), JSON.stringify(cfg));
const remember = (p) => { cfg.recent = [p, ...cfg.recent.filter((r) => r !== p)].slice(0, 8); saveCfg(); };

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
  if (!vault?.dirty) return true;
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning', message: 'Save changes to the database?', detail: vault.path,
    buttons: ['Save', "Don't save", 'Cancel'], defaultId: 0, cancelId: 2,
  });
  if (response === 2) return false;
  if (response === 0) await vault.save();
  return true;
}

const state = () => vault && {
  name: vault.db.meta.name, path: vault.path, dirty: vault.dirty, legacy: vault.legacy, defaults: DEFAULTS, root: vault.tree(), icons: vault.icons(), cfg,
};

const filters = [{ name: 'KeePass database', extensions: ['kdbx'] }];

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
    cfg = { ...cfg, autoLockMin: Math.max(0, +c.autoLockMin || 0), altTabDelayMs: Math.min(10000, Math.max(0, Math.round(+c.altTabDelayMs) || 0)), theme: THEMES.some((t) => t.id === c.theme) ? c.theme : cfg.theme, autoUpdateCheck: c.autoUpdateCheck === undefined ? cfg.autoUpdateCheck : !!c.autoUpdateCheck };
    applyTheme(); saveCfg(); return cfg;
  },
  'clip:copy': ({ text }) => copy(String(text), DEFAULTS.clipboardClear), // generator output; auto-clears like entry passwords
  'state': () => state(),
  'app:info': () => ({ version: app.getVersion(), canInstall: app.isPackaged && process.execPath.startsWith('/opt/Kyuch/') }),

  // window controls (the window is frameless, so the page draws its own buttons)
  'win:minimize': () => win.minimize(),
  'win:toggleMax': () => { win.isMaximized() ? win.unmaximize() : win.maximize(); return win.isMaximized(); },
  'win:close': () => win.close(), // goes through the unsaved-changes prompt

  'update:check': async () => { pendingUpdate = await updater.check(); cfg.lastUpdateCheck = Date.now(); saveCfg(); return pendingUpdate; },
  'update:cancel': () => { download?.abort(); },
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
    if (!(app.isPackaged && process.execPath.startsWith('/opt/Kyuch/'))) return { installed: false, file: got.file };
    win?.webContents.send('update:progress', { phase: 'install' }); // the download can no longer be cancelled; the password prompt follows
    await updater.install(got);
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
    return r.canceled ? null : r.filePath.replace(/(\.kdbx)?$/, '.kdbx');
  },
  'pick:open': async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Open database', filters: [...filters, { name: 'All files', extensions: ['*'] }], properties: ['openFile'] });
    return r.canceled ? null : r.filePaths[0];
  },
  'db:create': async ({ path: p, password }) => {
    if (!password) throw new Error('Master password cannot be empty');
    if (!(await canLeave())) return null;
    return adopt(await Vault.create(p, password, path.basename(p, '.kdbx')));
  },
  'db:open': async ({ path: p, password }) => {
    if (vault && vault.path !== p && !(await canLeave())) return null;
    let v;
    try { v = await Vault.open(p, password); } catch (e) {
      if (e.code === 'ENOENT') throw new Error('That database file no longer exists');       // never echo the file path
      if (e.code === 'EACCES') throw new Error('Kyuch is not allowed to read that file');
      throw new Error(/credentials|hmac|key/i.test(e.message) || e.code === 'InvalidKey' ? 'Wrong master password' : e.message.replaceAll(p, 'the database'));
    }
    return adopt(v);
  },
  'db:save': async () => { await vault.save(); return state(); },
  'db:saveAs': async () => {
    const r = await dialog.showSaveDialog(win, { title: 'Save a copy', defaultPath: vault.path, filters });
    if (r.canceled) return state();
    await vault.save(r.filePath.replace(/(\.kdbx)?$/, '.kdbx'));
    remember(vault.path);
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
    const t = vault.typeInfo(id);
    if (!t.enabled) throw new Error('Auto-type is disabled for this entry or its folder');
    const actions = autotype.parse(t.seq, t.fields); // validate before hiding the window
    // Every auto-type starts with Alt+Tab, which selects the previous window; the short pause lets that window take focus.
    actions.unshift({ key: 'alttab' }, { delay: 500 });
    await new Promise((r) => setTimeout(r, cfg.altTabDelayMs)); // time to let go of the shortcut keys
    await autotype.type(actions, t.delay);
  },
};
for (const [ch, fn] of Object.entries(handlers)) {
  ipcMain.handle(ch, async (_e, arg) => {
    try { return { ok: true, data: await fn(arg) }; } catch (e) { return { ok: false, error: e.message }; }
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

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  applyTheme();
  win = new BrowserWindow({
    width: 1100, height: 700, minWidth: 760, minHeight: 480, frame: false, title: 'Kyuch', icon: path.join(__dirname, 'icon.png'), backgroundColor: '#1b1d22',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  for (const ev of ['maximize', 'unmaximize']) win.on(ev, () => win.webContents.send('win:state', win.isMaximized()));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
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
