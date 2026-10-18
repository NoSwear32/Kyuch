const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Vault, DEFAULTS } = require('./core');
const autotype = require('./autotype');

let win, vault = null, clipTimer = null, clipText = null;

// ---- app-level config (not in the database) ----
const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
let cfg = { recent: [], autoLockMin: 5, typeStartDelay: 2 };
try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(cfgFile(), 'utf8')) }; } catch { /* first run */ }
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
  name: vault.db.meta.name, path: vault.path, dirty: vault.dirty, legacy: vault.legacy, defaults: DEFAULTS, root: vault.tree(), cfg,
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
  'cfg:set': (c) => { cfg = { ...cfg, autoLockMin: Math.max(0, +c.autoLockMin || 0), typeStartDelay: Math.max(0, +c.typeStartDelay || 0) }; saveCfg(); return cfg; },
  'state': () => state(),

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
      throw new Error(/credentials|hmac|key/i.test(e.message) || e.code === 'InvalidKey' ? 'Wrong master password' : e.message);
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

  'entry:copy': ({ id, field }) => {
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
    win.minimize(); // hands focus back to the window the user was in
    await new Promise((r) => setTimeout(r, cfg.typeStartDelay * 1000));
    try { await autotype.type(actions, t.delay); } finally { win.restore(); }
  },
};
for (const [ch, fn] of Object.entries(handlers)) {
  ipcMain.handle(ch, async (_e, arg) => {
    try { return { ok: true, data: await fn(arg) }; } catch (e) { return { ok: false, error: e.message }; }
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1100, height: 700, minWidth: 760, minHeight: 480, title: 'Keeper', backgroundColor: '#1b1d22',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  let closing = false;
  win.on('close', async (e) => {
    if (closing) return;
    e.preventDefault();
    if (await canLeave()) { closing = true; clearClipboard(); win.close(); }
  });
  win.loadFile('renderer/index.html');
});
app.on('window-all-closed', () => app.quit());
