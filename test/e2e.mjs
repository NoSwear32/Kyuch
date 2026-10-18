// UI smoke test. Needs playwright from ../umbra/app. Run: mkdir -p /tmp/kt && cd /tmp/kt && node /home/noswear/Documents/Claude/keeper/test/e2e.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire('/home/noswear/Documents/Claude/umbra/app/package.json');
const { _electron } = require('playwright');
const K = '/home/noswear/Documents/Claude/keeper', T = '/tmp/kt';
fs.rmSync(T + '/ud', { recursive: true, force: true }); fs.rmSync(T + '/e2e.kdbx', { force: true });
const app = await _electron.launch({ executablePath: K + '/node_modules/electron/dist/electron', args: ['.', '--user-data-dir=' + T + '/ud'], cwd: K, env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' } });
await app.evaluate(({ dialog, BrowserWindow }, f) => {
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: f });
  dialog.showMessageBox = async () => ({ response: 1 });
  const w = BrowserWindow.getAllWindows()[0]; w.show(); w.focus(); w.webContents.setBackgroundThrottling(false);
}, T + '/e2e.kdbx');
const page = await app.firstWindow();
const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
const shot = async (n) => { const b = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64')); fs.writeFileSync(`${T}/${n}.png`, Buffer.from(b, 'base64')); };
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('ok:', m); };

await page.click('#btnNewDb');
await page.fill('#nPw', 'hunter2'); await page.fill('#nPw2', 'hunter2'); await page.click('#newDbForm button.primary');
await page.waitForSelector('#app:not([hidden])');
ok(true, 'database created and app shown');

// folder with settings, then nested folder inheriting
await page.click('#btnFolder'); await page.fill('#fName', 'Work'); await page.selectOption('#sAuto', 'true'); await page.fill('#sSeq', '{PASSWORD}{ENTER}'); await page.fill('#sClip', '30');
await page.click('#folderForm button.primary');
await page.click('.node:has-text("Work")');
await page.click('#btnFolder'); await page.fill('#fName', 'Deep'); await page.waitForTimeout(100);
ok((await page.getAttribute('#sSeq', 'placeholder')).includes('{PASSWORD}{ENTER}') && (await page.getAttribute('#sSeq', 'placeholder')).includes('Work'), 'child placeholder shows inherited sequence + source');
ok((await page.getAttribute('#sClip', 'placeholder')).includes('30'), 'child placeholder shows inherited clipboard time');
await page.click('#folderForm button.primary');
await page.click('.node:has-text("Deep")');

// entry
await page.click('#btnEntry'); await page.fill('#eTitle', 'GitHub'); await page.fill('#eUser', 'octo'); await page.fill('#ePass', 's3cret!'); await page.fill('#eUrl', 'github.com'); await page.fill('#eNotes', 'my comment');
await page.click('#entryForm button.primary');
await page.waitForSelector('tbody tr');
await page.click('tbody tr');
const det = await page.textContent('#detail');
ok(det.includes('GitHub') && det.includes('octo') && det.includes('my comment') && !det.includes('s3cret'), 'detail shows entry without password');
await page.click('#detail button:has-text("Show")');
ok((await page.textContent('#detail')).includes('s3cret!'), 'show reveals password');
await page.click('#detail .field:has-text("Username") button');
ok(await app.evaluate(({ clipboard }) => clipboard.readText()) === 'octo', 'copy username -> clipboard');
await page.click('#detail .field:has-text("Password") button:has-text("Copy")');
ok(await app.evaluate(({ clipboard }) => clipboard.readText()) === 's3cret!', 'copy password -> clipboard');
await shot('main');

// search + save + lock + unlock
await page.fill('#search', 'octo'); ok((await page.textContent('#list')).includes('Work / Deep'), 'search finds entry with folder path'); await page.fill('#search', '');
await page.click('#btnSave');
await page.click('#btnLock'); await page.waitForSelector('#lock:not([hidden])'); await shot('lock');
await page.click('#recent button'); await page.fill('#unlockPw', 'wrong'); await page.press('#unlockPw', 'Enter');
await page.waitForFunction(() => document.getElementById('lockErr').textContent.length);
ok((await page.textContent('#lockErr')) === 'Wrong master password', 'wrong password rejected with message');
await page.fill('#unlockPw', 'hunter2'); await page.press('#unlockPw', 'Enter');
await page.waitForSelector('#app:not([hidden])');
await shot('unlocked');
ok((await page.textContent('#tree')).includes('Deep'), 'data persisted across lock/unlock');
ok(errs.length === 0, 'no renderer errors ' + errs.join('|'));
// auto-lock with an open dialog and unsaved edits: must save, lock, and leave no dialog/password on screen
await page.evaluate(async () => { await keeper.call('group:add', { parentId: S.root.id, name: 'Dirty' }); });
await page.click('#btnEntry'); await page.fill('#eTitle', 'Unsaved'); await page.fill('#ePass', 'plaintext-pw');
await page.evaluate(() => lock(true));
await page.waitForSelector('#lock:not([hidden])');
ok(await page.evaluate(() => document.querySelectorAll('dialog[open]').length === 0 && document.getElementById('ePass').value === ''), 'lock closes dialogs and clears password fields');
await page.click('#recent button'); await page.fill('#unlockPw', 'hunter2'); await page.press('#unlockPw', 'Enter');
await page.waitForSelector('#app:not([hidden])');
ok((await page.textContent('#tree')).includes('Dirty'), 'auto-lock saved unsaved edits before locking');
// auto-type through the real IPC path into another window (needs /dev/uinput access, see autotype.js)
await page.evaluate(() => keeper.call('cfg:set', { autoLockMin: 5, typeStartDelay: 1 }));
await page.click('.node:has-text("Deep")'); await page.click('tbody tr');
const id = await page.evaluate(() => selEntry);
await app.evaluate(async ({ BrowserWindow }) => {
  const w = new BrowserWindow({ width: 500, height: 200, x: 50, y: 50 });
  await w.loadURL('data:text/html,<input id=a autofocus><input id=b>');
  w.show(); w.focus(); w.webContents.focus(); globalThis.__target = w;
});
const read = () => app.evaluate(async () => globalThis.__target.webContents.executeJavaScript('[a.value,b.value]'));
await page.waitForTimeout(800);
await page.evaluate((id) => keeper.call('entry:autotype', { id }), id);       // inherited from Work: {PASSWORD}{ENTER}
await page.waitForTimeout(500);
ok(JSON.stringify(await read()) === JSON.stringify(['s3cret!', '']), 'auto-type uses the sequence inherited from the parent folder: ' + JSON.stringify(await read()));
await app.evaluate(async () => { await globalThis.__target.webContents.executeJavaScript('a.value="";b.value="";a.focus()'); globalThis.__target.focus(); });
await page.evaluate((id) => keeper.call('entry:update', { id, autoTypeSeq: '{USERNAME}{TAB}{PASSWORD}' }), id);
await page.waitForTimeout(500);
await page.evaluate((id) => keeper.call('entry:autotype', { id }), id);       // entry override with a Tab between fields
await page.waitForTimeout(500);
ok(JSON.stringify(await read()) === JSON.stringify(['octo', 's3cret!']), 'entry sequence override + Tab moves between fields: ' + JSON.stringify(await read()));
await app.close();
