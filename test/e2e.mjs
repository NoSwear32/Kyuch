// UI smoke test (drives the real app with Playwright; it is not a dependency of this project).
// Run:  PLAYWRIGHT_FROM=/path/to/a/folder-with-node_modules-containing-playwright  node test/e2e.mjs
// It needs the release signing key (see RELEASING.md) to sign its mock update, and never types into your real windows.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
if (!process.env.PLAYWRIGHT_FROM) throw new Error('Set PLAYWRIGHT_FROM to a folder whose node_modules contains playwright');
const require = createRequire(path.join(process.env.PLAYWRIGHT_FROM, 'package.json'));
const { _electron } = require('playwright');
const K = path.resolve(import.meta.dirname, '..'), T = '/tmp/kt';
import http from 'node:http'; import crypto from 'node:crypto'; import os from 'node:os';
const keyPath = os.homedir() + '/.config/kyuch-release/ed25519.pem';
const debBytes = crypto.randomBytes(1_500_000); let tamper = false, slow = false;
const sig = crypto.sign(null, debBytes, crypto.createPrivateKey(fs.readFileSync(keyPath))).toString('base64');
const mock = http.createServer((req, res) => {
  const base = 'http://127.0.0.1:' + mock.address().port;
  if (req.url === '/api') return res.end(JSON.stringify({ tag_name: 'v9.9.9', body: 'Mock release notes', html_url: base, assets: [
    { name: 'kyuch_9.9.9_amd64.deb', browser_download_url: base + '/d.deb', size: 1_500_000 }, { name: 'kyuch_9.9.9_amd64.deb.sig', browser_download_url: base + '/d.sig' }] }));
  if (req.url === '/d.deb') {
    const body = tamper ? Buffer.concat([debBytes, Buffer.from('x')]) : debBytes;
    res.setHeader('content-length', body.length);
    if (!slow) return res.end(body);
    let i = 0; const timer = setInterval(() => { if (i >= body.length) { clearInterval(timer); return res.end(); } res.write(body.subarray(i, i + 100_000)); i += 100_000; }, 120);
    req.on('close', () => clearInterval(timer)); return;
  }
  if (req.url === '/d.sig') return res.end(sig);
  res.statusCode = 404; res.end();
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
fs.rmSync(T + '/ud', { recursive: true, force: true }); fs.rmSync(T + '/e2e.kdbx', { force: true });
fs.mkdirSync(T + '/ud', { recursive: true }); fs.writeFileSync(T + '/ud/config.json', JSON.stringify({ autoUpdateCheck: false }));
const app = await _electron.launch({ executablePath: K + '/node_modules/electron/dist/electron', args: ['.', '--user-data-dir=' + T + '/ud'], cwd: K, env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1', KYUCH_UPDATE_API: 'http://127.0.0.1:' + mock.address().port + '/api' } });
await app.evaluate(({ dialog, BrowserWindow }, f) => {
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: f });
  dialog.showMessageBox = async () => ({ response: 1 });
  const w = BrowserWindow.getAllWindows()[0]; w.show(); w.focus(); w.webContents.setBackgroundThrottling(false);
}, T + '/e2e.kdbx');
const page = await app.firstWindow();
await page.evaluate(() => { window.__confirms = []; window.confirm = (m) => { window.__confirms.push(m); return true; }; }); // record and accept window.confirm() prompts
const confirms = () => page.evaluate(() => window.__confirms);
const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
const shot = async (n) => { const b = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64')); fs.writeFileSync(`${T}/${n}.png`, Buffer.from(b, 'base64')); };
const shotWin = async (n, name) => { const b = await app.evaluate(async ({ BrowserWindow }, nm) => (await BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(nm)).webContents.capturePage()).toPNG().toString('base64'), name); fs.writeFileSync(`${T}/${n}.png`, Buffer.from(b, 'base64')); };
const shotEditor = (n) => shotWin(n, 'editor.html');
// Entry/folder editor, Settings and the generator are separate popup windows. These helpers open one and hand back that window's page.
const openWin = async (action, ready, a = app) => {
  const [pop] = await Promise.all([a.waitForEvent('window'), action()]);
  await pop.waitForSelector(ready);
  return pop;
};
const openEditor = (action) => openWin(action, '#entryForm:not([hidden]), #folderForm:not([hidden])');
const viaLogoMenu = (id, pg = page) => async () => { await pg.click('#brandBtn'); await pg.click(id); };
const settingsWin = (a = app, pg = page) => openWin(viaLogoMenu('#mSettings', pg), '#aThemes .theme-card', a);
const genWin = () => openWin(() => page.click('#btnGen'), '#genDlg[open]');
const addEntryWin = () => openEditor(async () => { await page.click('#btnAdd'); await page.click('#addEntry'); });
const addFolderWin = () => openEditor(async () => { await page.click('#btnAdd'); await page.click('#addFolder'); });
const editEntryWin = () => openEditor(() => page.click('#detail button:has-text("Edit")'));
const closeWinOn = async (pop, selector, pg) => { const closed = pop.waitForEvent('close'); await pop.click(selector).catch((e) => { if (!/has been closed/.test(e.message)) throw e; }); await closed; await pg.waitForTimeout(200); };
const closeWin = (pop, selector) => closeWinOn(pop, selector, page);
const saveWin = (pop) => closeWin(pop, '#edSave');
const cancelWin = (pop) => closeWin(pop, '#edCancel');
const rowsOf = (p) => p.evaluate(() => [...document.querySelectorAll('#gList .genrow input')].map((i) => i.value));
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('ok:', m); };

await page.click('#btnNewDb');
await page.fill('#nPw', 'hunter2'); await page.fill('#nPw2', 'hunter2'); await page.click('#newDbForm button.primary');
await page.waitForSelector('#app:not([hidden])');
ok(true, 'database created and app shown');

// folder with settings, then nested folder inheriting
const wWork = await addFolderWin();
await wWork.fill('#fName', 'Work'); await wWork.selectOption('#sAuto', 'true'); await wWork.fill('#sSeq', '{PASSWORD}{ENTER}'); await wWork.fill('#sClip', '30');
await saveWin(wWork);
await page.click('.node:has-text("Work")');
const wDeep = await addFolderWin(); await wDeep.fill('#fName', 'Deep'); await wDeep.waitForTimeout(100);
ok((await wDeep.getAttribute('#sSeq', 'placeholder')).includes('{PASSWORD}{ENTER}') && (await wDeep.getAttribute('#sSeq', 'placeholder')).includes('Work'), 'child placeholder shows inherited sequence + source');
ok((await wDeep.getAttribute('#sClip', 'placeholder')).includes('30'), 'child placeholder shows inherited clipboard time');
await saveWin(wDeep);
await page.click('.node:has-text("Deep")');

// entry
const wGit = await addEntryWin();
ok((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 2 && await page.evaluate(() => !document.getElementById('entryForm')), 'New entry opens in a window of its own, not inside the main window');
await wGit.fill('#eTitle', 'GitHub'); await wGit.fill('#eUser', 'octo'); await wGit.fill('#ePass', 's3cret!'); await wGit.fill('#eUrl', 'github.com'); await wGit.fill('#eNotes', 'my comment');
await saveWin(wGit);
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
const lockText = await page.textContent('#lock'); const recentText = await page.textContent('#recent');
ok(recentText.trim() === 'e2e' && !lockText.includes('/') && !/\.kdbx/i.test(lockText), 'database list shows only the name (no path, no .kdbx): ' + JSON.stringify(recentText.trim()));
await page.click('#recent button');
ok((await page.textContent('#unlockPath')) === 'e2e', 'unlock form shows only the name');
const tryOpen = (p) => page.evaluate((path) => kyuch.call('db:open', { path, password: 'x' }).then(() => 'no error', (e) => e.message), p);
const stranger = await tryOpen('/tmp/kt/never-chosen.kdbx');
ok(stranger === 'That file was not chosen in a file dialog', 'the page cannot name a file the user never picked: ' + stranger);
const creating = await page.evaluate(() => kyuch.call('db:create', { path: '/tmp/kt/evil-overwrite.kdbx', password: 'x' }).then(() => 'created', (e) => e.message));
ok(creating === 'That file was not chosen in a file dialog' && !fs.existsSync('/tmp/kt/evil-overwrite.kdbx'), 'db:create refuses a path that did not come from the save dialog');
fs.renameSync(T + '/e2e.kdbx', T + '/e2e.moved');
const gone = await tryOpen(T + '/e2e.kdbx'); fs.renameSync(T + '/e2e.moved', T + '/e2e.kdbx');
ok(gone === 'That database file no longer exists' && !gone.includes('/tmp'), 'a deleted database gives a plain message without the path: ' + gone);
await page.fill('#unlockPw', 'wrong'); await page.press('#unlockPw', 'Enter');
await page.waitForFunction(() => document.getElementById('lockErr').textContent.length);
ok((await page.textContent('#lockErr')) === 'Wrong master password', 'wrong password rejected with message');
await page.fill('#unlockPw', 'hunter2'); await page.press('#unlockPw', 'Enter');
await page.waitForSelector('#app:not([hidden])');
await shot('unlocked');
ok((await page.textContent('#tree')).includes('Deep'), 'data persisted across lock/unlock');
ok(errs.length === 0, 'no renderer errors ' + errs.join('|'));
// auto-lock with an open dialog and unsaved edits: must save, lock, and leave no dialog/password on screen
await page.evaluate(async () => { await kyuch.call('group:add', { parentId: S.root.id, name: 'Dirty' }); });
const wLock = await addEntryWin(); await wLock.fill('#eTitle', 'Unsaved'); await wLock.fill('#ePass', 'plaintext-pw');
await page.evaluate(() => lock(true));
await page.waitForSelector('#lock:not([hidden])'); await page.waitForTimeout(500);
ok(wLock.isClosed() && await page.evaluate(() => document.querySelectorAll('dialog[open]').length === 0), 'locking closes an open editor window (and the plaintext password in it) and any dialog');
await page.click('#recent button'); await page.fill('#unlockPw', 'hunter2'); await page.press('#unlockPw', 'Enter');
await page.waitForSelector('#app:not([hidden])');
ok((await page.textContent('#tree')).includes('Dirty'), 'auto-lock saved unsaved edits before locking');
// branding, generator, theme
const logoInfo = (sel) => page.evaluate((s) => { const el = document.querySelector(s), cs = getComputedStyle(el), r = el.getBoundingClientRect(); return { w: r.width, h: r.height, mask: cs.maskImage || cs.webkitMaskImage, bg: cs.backgroundColor }; }, sel);
const pngLoads = (name) => page.evaluate((n) => new Promise((res) => { const i = new Image(); i.onload = () => res(i.naturalWidth > 0); i.onerror = () => res(false); i.src = n; }), name);
const bar = await logoInfo('#brand');
ok(bar.mask.includes('logo-text.png') && bar.h === 18 && Math.abs(bar.w / bar.h - 3.149) < 0.05 && await pngLoads('logo-text.png') && await pngLoads('logo-mark.png'), 'the name logo is drawn in the toolbar (mask image loads, correct proportions): ' + JSON.stringify(bar));
const wG = await genWin();
ok((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 2 && await page.evaluate(() => !document.getElementById('genDlg')), 'the generator opens in a window of its own, not inside the main window');
ok((await wG.inputValue('#gOut')).length === 20, 'generator opens with a 20 char password');
await wG.fill('#gLenN', '32'); await wG.dispatchEvent('#gLenN', 'input'); await wG.uncheck('#gSymbols');
const gp = await wG.inputValue('#gOut');
ok(gp.length === 32 && /^[A-Za-z0-9]+$/.test(gp), 'length + symbol toggle respected: ' + gp.length);
await wG.click('#gCopy'); await wG.waitForTimeout(150);
ok(await app.evaluate(({ clipboard }) => clipboard.readText()) === gp, 'generator Copy puts the password on the clipboard');
await wG.check('#gMulti');
ok(await wG.isVisible('#gCountWrap') && await wG.isVisible('#gList') && !(await wG.isVisible('#gOut')), 'multiple-passwords checkbox reveals the count box and the list');
const rows = () => rowsOf(wG);
await wG.fill('#gCount', '30'); await wG.dispatchEvent('#gCount', 'input');
const r30 = await rows(); ok(r30.length === 30 && r30.every((p) => /^[A-Za-z0-9]{32}$/.test(p)) && new Set(r30).size === 30, '30 distinct passwords generated with the current settings');
await wG.fill('#gCount', '99'); await wG.dispatchEvent('#gCount', 'change');
ok((await wG.inputValue('#gCount')) === '30' && (await rows()).length === 30, 'count is capped at 30');
await wG.fill('#gCount', '4'); await wG.dispatchEvent('#gCount', 'change');
await wG.click('#gCopy'); await wG.waitForTimeout(150);
const four = await rows(), clip = await app.evaluate(({ clipboard }) => clipboard.readText());
ok(four.length === 4 && clip === four.join('\n'), 'Copy all puts exactly the 4 listed passwords on the clipboard');
await wG.fill('#gCount', '12'); await shotWin('genmulti', 'genwin.html'); await wG.fill('#gCount', '4');
await wG.click('#gRegen'); ok(JSON.stringify(await rows()) !== JSON.stringify(four), 'Regenerate makes a fresh list');
await wG.uncheck('#gMulti');
ok((await wG.inputValue('#gOut')).length === 32 && !(await wG.isVisible('#gList')), 'unchecking returns to a single password');
await closeWin(wG, '#genForm button[value=cancel]');
ok(wG.isClosed(), 'Close closes the generator window');
const wG2 = await genWin(); await closeWin(wG2, '#edX');
const wG3 = await genWin(); const g3 = wG3.waitForEvent('close'); await wG3.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))).catch(() => {}); await g3;
ok(wG2.isClosed() && wG3.isClosed(), 'the generator window also closes with its X button and Escape');
const wGen = await addEntryWin(); await wGen.click('#eGen'); const gp2 = await wGen.inputValue('#gOut'); await wGen.click('#gUse');
ok((await wGen.inputValue('#ePass')) === gp2 && gp2.length === 32, 'Use password fills the entry form');
ok((await wGen.inputValue('#gOut')) === '', 'generator output wiped after closing');
await wGen.click('#eGen'); await wGen.check('#gMulti'); await wGen.fill('#gCount', '3');
ok(!(await wGen.isVisible('#gUse')), 'single "Use password" button is replaced by per-row Use buttons');
const pick = (await rowsOf(wGen))[1]; await wGen.click('#gList .genrow:nth-child(2) button.primary');
await wGen.waitForTimeout(250); // the wipe runs a tick after the dialog closes
ok((await wGen.inputValue('#ePass')) === pick && (await wGen.evaluate(() => document.querySelectorAll('#gList .genrow').length)) === 0, 'a row\'s Use fills the entry form with exactly that password, then the list is wiped');
await wGen.evaluate(() => localStorage.removeItem('kyuch.gen'));
await cancelWin(wGen);
const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const setTheme = (theme) => page.evaluate((th) => kyuch.call('cfg:set', { autoLockMin: 5, altTabDelayMs: 500, theme: th }).then((c) => { S.cfg = c; applyTheme(c.theme); }), theme); // keep the page's saved settings in step, like the real controls do
await setTheme('light'); const lightBg = await bg();
await page.click('#themeBtn'); await page.waitForTimeout(200);
const darkBg = await bg(); await shot('dark');
ok(lightBg !== darkBg && darkBg === 'rgb(27, 29, 34)', 'theme button switches light -> dark: ' + lightBg + ' -> ' + darkBg);
await page.click('#themeBtn'); await page.waitForTimeout(200);
ok((await bg()) === lightBg, 'theme button switches back to light'); await shot('light');
await setTheme('dark'); ok((await bg()) === darkBg, 'settings theme "dark" applies');
await setTheme('system');
// Themes: 8 cards, live preview, Cancel reverts, Apply saves, the logo takes the theme colour
const bodyBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
await setTheme('dark');
ok((await logoInfo('#brand')).bg === 'rgb(248, 88, 0)', 'default themes keep the brand-orange logo');
const wS = await settingsWin();
ok((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('settings.html')).isModal())) && await page.evaluate(() => !document.getElementById('settingsDlg')), 'Settings opens in its own modal window, not inside the main window');
const cardIds = await wS.evaluate(() => [...document.querySelectorAll('#aThemes .theme-card')].map((c) => c.dataset.theme));
ok(JSON.stringify(cardIds) === JSON.stringify(['system', 'dark', 'light', 'ocean', 'forest', 'amethyst', 'sand', 'blossom']), 'Settings offers 8 themes: ' + cardIds.join(', '));
const sBg = () => wS.evaluate(() => getComputedStyle(document.body).backgroundColor);
const primaryBg = () => wS.evaluate(() => getComputedStyle(document.getElementById('edSave')).backgroundColor);
ok((await primaryBg()) === 'rgb(248, 88, 0)', 'Dark theme: primary buttons are the brand orange');
await wS.click('#aThemes [data-theme="light"]');
ok((await primaryBg()) === 'rgb(201, 66, 0)', 'Light theme: primary buttons are a deeper orange (readable with white text)');
await wS.click('#aThemes [data-theme="dark"]');
await shotWin('themes', 'settings.html');
await wS.click('#aThemes [data-theme="ocean"]');
ok((await sBg()) === 'rgb(11, 26, 38)', 'clicking a theme previews it live (Ocean)');
ok((await bodyBg()) === 'rgb(27, 29, 34)', 'the main window keeps its theme until Apply');
await cancelWin(wS);
ok((await bodyBg()) === 'rgb(27, 29, 34)', 'Cancel leaves the saved theme');
const wS2 = await settingsWin();
await wS2.click('#aThemes [data-theme="blossom"]'); await saveWin(wS2);
ok((await bodyBg()) === 'rgb(251, 241, 245)' && (await page.evaluate(() => kyuch.call('cfg:get'))).theme === 'blossom', 'Apply saves the chosen theme and the main window follows (Blossom)');
const expectBg = { ocean: 'rgb(11, 26, 38)', forest: 'rgb(14, 26, 20)', amethyst: 'rgb(23, 18, 31)', sand: 'rgb(245, 239, 227)', blossom: 'rgb(251, 241, 245)' };
for (const [name, bg] of Object.entries(expectBg)) { await setTheme(name); if ((await bodyBg()) !== bg) throw new Error('FAIL: theme ' + name + ' background ' + (await bodyBg())); await shot('theme-' + name); }
ok(true, 'all five new themes apply their own colours');
await setTheme('system');
// title bar size (was 44 px; -20% = 35 px) and smaller window buttons
const dims = await page.evaluate(() => ({ bar: document.getElementById('top').getBoundingClientRect().height, btn: document.getElementById('wMin').getBoundingClientRect().width, glyph: document.querySelector('#wClose svg').getBoundingClientRect().width }));
ok(Math.round(dims.bar) === 35 && Math.round(dims.btn) === 24 && Math.round(dims.glyph) === 12, 'title bar is 35 px tall, window buttons are 24 px circles: ' + JSON.stringify(dims));
// Alt+Tab delay is in milliseconds, default 500
await page.evaluate(() => kyuch.call('cfg:set', { autoLockMin: 5, altTabDelayMs: 500, theme: 'system' }));
const wA = await settingsWin();
ok((await wA.textContent('body')).includes('Alt+Tab delay (milliseconds') && (await wA.inputValue('#aDelay')) === '500', 'Settings shows the Alt+Tab delay in milliseconds, default 500');
ok(!(await wA.isChecked('#aAutoUpd')), 'Settings has the daily update check switch (off in this run)');
ok(await wA.isChecked('#aConfirmRm'), 'Settings has "Ask before removing a database from the list" (on by default)');
await wA.check('#aAutoUpd'); await wA.fill('#aDelay', '250'); await saveWin(wA);
ok((await page.evaluate(() => kyuch.call('cfg:get'))).altTabDelayMs === 250, 'new Alt+Tab delay is saved (250 ms)');
ok((await page.evaluate(() => kyuch.call('cfg:get'))).autoUpdateCheck === true, 'daily update check switch is saved');
await page.evaluate(() => kyuch.call('cfg:set', { autoUpdateCheck: false }));
const partial = await page.evaluate(() => kyuch.call('cfg:set', { confirmRemoveDb: true }));
ok(partial.altTabDelayMs === 250 && partial.autoLockMin === 5, 'cfg:set with a single key leaves every other setting alone');
await page.evaluate(() => kyuch.call('cfg:set', { autoLockMin: 5, altTabDelayMs: 500, theme: 'system', autoUpdateCheck: false }));
await page.evaluate(() => kyuch.call('cfg:set', { autoLockMin: 5, altTabDelayMs: 500, theme: 'system' }));
// One-time password tab
const totpMod = require(K + '/totp.js');
const near = (input, digits) => [-30000, 0, 30000].map((d) => totpMod.code(totpMod.parse(input, { digits }), Date.now() + d).code); // tolerate a window rollover mid-test
const wOtp = await addEntryWin();
await wOtp.fill('#eTitle', 'OTP Site'); await wOtp.fill('#ePass', 'pw-otp');
ok(await wOtp.isVisible('#tabBtnOtp') && await wOtp.isVisible('#eUser') && !(await wOtp.isVisible('#panelOtp')), 'entry editor has a Details tab (active) and a One-time password tab');
await wOtp.click('#tabBtnOtp');
ok(await wOtp.isVisible('#panelOtp') && !(await wOtp.isVisible('#eUser')), 'One-time password tab replaces the details fields');
await wOtp.fill('#oSecret', 'JBSWY3DPEHPK3PXP');
await wOtp.waitForFunction(() => /^\d{3} \d{3}$/.test(document.getElementById('oCode').textContent));
const shown = (await wOtp.textContent('#oCode')).replace(' ', '');
await shotEditor('otp'); ok(near('JBSWY3DPEHPK3PXP').includes(shown) && await wOtp.isVisible('#oBar'), 'secret key shows the matching 6-digit code with a countdown: ' + shown);
await wOtp.fill('#oSecret', 'otpauth://totp/Ex:me?secret=JBSWY3DPEHPK3PXP&issuer=Ex&digits=8&period=60&algorithm=SHA256');
await wOtp.waitForFunction(() => document.getElementById('oCode').textContent.replace(' ', '').length === 8);
const linkVals = await wOtp.evaluate(() => [oDigits.value, oPeriod.value, oAlg.value, oDigits.disabled]);
ok(JSON.stringify(linkVals) === JSON.stringify(['8', '60', 'SHA256', true]), 'a pasted otpauth:// link fills (and locks) digits, period and algorithm');
await wOtp.fill('#oSecret', '1!!');
await wOtp.waitForFunction(() => document.getElementById('oErr').textContent.length > 0);
await wOtp.click('#edSave'); await wOtp.waitForTimeout(300);
ok(!wOtp.isClosed() && await wOtp.isVisible('#panelOtp'), 'an invalid secret blocks saving and keeps the OTP tab open');
await wOtp.fill('#oSecret', 'JBSWY3DPEHPK3PXP');
await wOtp.waitForFunction(() => /^\d{3} \d{3}$/.test(document.getElementById('oCode').textContent));
ok(JSON.stringify(await wOtp.evaluate(() => [oDigits.value, oPeriod.value, oAlg.value, oDigits.disabled])) === JSON.stringify(['6', '30', 'SHA1', false]), 'replacing a link with a bare secret resets digits/period/algorithm to defaults');
await saveWin(wOtp);
ok(wOtp.isClosed(), 'the editor window, and the secret in it, is gone after saving');
await page.click('tbody tr:has-text("OTP Site")');
await page.waitForFunction(() => /^\d{3} \d{3}$/.test((document.querySelector('#detail .otpcode') || {}).textContent || ''));
const dShown = (await page.textContent('#detail .otpcode')).replace(' ', '');
ok((await page.textContent('#detail')).includes('One-time password') && near('JBSWY3DPEHPK3PXP').includes(dShown), 'detail pane shows the live code: ' + dShown);
await page.click('#detail .field:has-text("One-time password") button'); await page.waitForTimeout(200);
ok((await app.evaluate(({ clipboard }) => clipboard.readText())) === (await page.textContent('#detail .otpcode')).replace(' ', ''), 'Copy puts the current code (not the secret) on the clipboard');
const wEd = await editEntryWin(); await wEd.click('#tabBtnOtp');
await wEd.waitForFunction(() => /^\d{3} \d{3}$/.test(document.getElementById('oCode').textContent));
ok((await wEd.inputValue('#oSecret')).startsWith('otpauth://totp/') && (await wEd.inputValue('#oSecret')).includes('JBSWY3DPEHPK3PXP'), 'editing shows the stored otpauth:// link');
await cancelWin(wEd);
ok(wEd.isClosed(), 'cancel closes the editor window, taking the secret with it');

// ---- fixes from the code review ----
// keyboard navigation: the entry list and the folder tree work without a mouse, and focus survives re-rendering
await page.click('.node:has-text("Deep")');
await page.focus('tbody tr >> nth=0'); await page.keyboard.press('Enter');
await page.keyboard.press('ArrowDown');
ok(await page.evaluate(() => entries.get(selEntry).e.title === 'OTP Site' && document.activeElement.matches('tbody tr.sel')), 'entry list: Enter selects, ArrowDown moves the selection and keeps the focus');
await page.focus('.node:has-text("Work")'); await page.keyboard.press('ArrowDown');
ok(await page.evaluate(() => groups.get(selGroup).g.name === 'Deep' && document.activeElement.matches('.node.sel')), 'folder tree: ArrowDown selects the next folder and keeps the focus');
// recycle bin: first delete moves it there, deleting it from the bin is really permanent
await page.evaluate(async () => { setState(await kyuch.call('entry:add', { groupId: S.root.id, title: 'ToBin' })); });
await page.click('.node:has-text("e2e")'); await page.click('tbody tr:has-text("ToBin")'); await page.click('#detail button:has-text("Delete")'); await page.waitForTimeout(300);
await page.click('.node:has-text("Recycle Bin")');
ok(await page.isVisible('tbody tr:has-text("ToBin")'), 'a deleted entry lands in the Recycle Bin');
await page.click('tbody tr:has-text("ToBin")'); await page.click('#detail button:has-text("Delete")'); await page.waitForTimeout(300);
const cf = await confirms();
ok((await page.locator('tbody tr:has-text("ToBin")').count()) === 0 && /Recycle Bin/.test(cf.at(-2)) && /Permanently delete/.test(cf.at(-1)), 'deleting from the bin is permanent, and the prompt says so: ' + cf.at(-1));
// master password change needs the new password twice
const wP = await settingsWin();
ok(await wP.isVisible('#aLayout') && (await wP.inputValue('#aLayout')) === 'auto' && await wP.isVisible('#aPwBox'), 'Settings has a keyboard layout choice for auto-type (Linux) and the master password fields');
await wP.fill('#aNewPw', 'abc'); await wP.fill('#aNewPw2', 'abd'); await wP.click('#edSave'); await wP.waitForTimeout(250);
ok(!wP.isClosed() && (await wP.textContent('#aErr')).includes('do not match'), 'a mistyped new master password is refused before anything is saved');
await wP.fill('#aNewPw', ''); await wP.fill('#aNewPw2', ''); await cancelWin(wP);
// a stored OTP link the user did not touch is saved exactly as it was (extra parameters survive)
const keepUri = 'otpauth://totp/X?secret=JBSWY3DPEHPK3PXP&extra=keepme&digits=7';
const keepId = await page.evaluate(async (u) => { setState(await kyuch.call('entry:add', { groupId: S.root.id, title: 'KeepOtp', otp: u })); return [...entries.values()].find((x) => x.e.title === 'KeepOtp').e.id; }, keepUri);
await page.click('.node:has-text("e2e")'); await page.click('tbody tr:has-text("KeepOtp")'); const wKeep = await editEntryWin();
await wKeep.fill('#eNotes', 'edited without touching the OTP tab'); await saveWin(wKeep);
const afterEdit = await page.evaluate((id) => kyuch.call('entry:get', { id }), keepId);
ok(afterEdit.otp === keepUri && afterEdit.notes.startsWith('edited'), 'an untouched OTP link is saved exactly as stored');
// pressing OK on an entry without changing anything adds no history



// Add menu, icon picker Cancel, custom icon, window controls, About + update flow
await page.click('#btnAdd'); ok(await page.isVisible('#addMenu') && (await page.textContent('#addMenu')).includes('Entry') && (await page.textContent('#addMenu')).includes('Folder'), 'Add button opens a menu with Entry and Folder');
await shot('addmenu'); await page.keyboard.press('Escape'); ok(!(await page.isVisible('#addMenu')), 'Escape closes the Add menu');
const wI = await addEntryWin();
await wI.click('#eIcon'); await wI.waitForSelector('#iconDlg[open]');
ok((await wI.locator('#iconGrid button').count()) === 140 && await wI.evaluate(() => [...document.querySelectorAll('#iconGrid .kic')].every((k) => k.style.backgroundPosition)), 'the icon picker offers all 140 icons (69 KeePass + the new set), drawn from the sprite sheet');
await shotEditor('icons');
await wI.click('#iconGrid button[title="#85"]'); await wI.waitForTimeout(150);
const pos = await wI.evaluate(() => getComputedStyle(document.querySelector('#eIcon .kic')).backgroundPosition.split(' ').map(parseFloat));
ok(Math.abs(pos[0] - 500 / 9) < 0.1 && Math.abs(pos[1] - 800 / 13) < 0.1 && (await wI.evaluate(() => getComputedStyle(document.querySelector('#eIcon .kic')).backgroundImage)).includes('icons.png'), 'picking icon #85 shows that cell of the sprite on the button (inline CSSOM styles pass the CSP): ' + pos);
await wI.click('#eIcon'); await wI.waitForSelector('#iconDlg[open]');
await wI.click('#iconClose'); await wI.waitForTimeout(150);
ok(!(await wI.evaluate(() => document.getElementById('iconDlg').open)) && !wI.isClosed(), 'icon picker Cancel closes it and keeps the editor window open');
await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, K + '/brand/png/icon-64.png');
await wI.fill('#eTitle', 'Iconic'); await wI.click('#eIcon'); await wI.click('#iconAdd'); await wI.waitForTimeout(400);
ok(await wI.evaluate(() => !document.getElementById('iconDlg').open && !!document.querySelector('#eIcon img.ico')), 'adding a custom icon applies it and shows it on the button');
await saveWin(wI);
await page.click('tbody tr:has-text("Iconic")');
ok(await page.evaluate(() => !!document.querySelector('#detail h2 img.ico') && !!document.querySelector('tbody tr.sel img.ico')), 'custom icon shown in the list and detail pane');
// the editor window can be dismissed without saving, and the main page contains no editor forms any more
const wEsc = await addEntryWin(); await wEsc.fill('#eTitle', 'never saved');
const escClosed = wEsc.waitForEvent('close'); await wEsc.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))).catch(() => {}); await escClosed; await page.waitForTimeout(200);
ok(wEsc.isClosed() && (await page.locator('tbody tr:has-text("never saved")').count()) === 0, 'Escape closes the editor window without saving');
const wX = await addFolderWin(); await closeWin(wX, '#edX');
ok(wX.isClosed(), 'the X button closes the editor window');
const wMod = await addEntryWin();
ok((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('editor.html')).isModal())), 'the editor is modal over the main window');
await cancelWin(wMod);
ok(await page.evaluate(() => !document.getElementById('entryForm') && !document.getElementById('entryDlg') && !document.getElementById('folderForm')), 'the main window has no entry or folder form any more');
await page.click('#btnSave'); await page.waitForTimeout(300);
const wasMax = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized());
await page.click('#wMax'); await page.waitForTimeout(500);
ok((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())) === !wasMax, 'maximize button toggles the window');
await page.click('#wMax'); await page.waitForTimeout(300);
await page.click('#wMin'); await page.waitForTimeout(500);
ok(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()), 'minimize button minimizes the window');
await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.restore(); w.show(); w.focus(); }); await page.waitForTimeout(400);
await viaLogoMenu('#mAbout')(); await page.waitForSelector('#aboutDlg[open]');
ok((await page.textContent('#aboutVersion')).includes(JSON.parse(fs.readFileSync(K + '/package.json', 'utf8')).version) && (await page.textContent('#aboutDlg')).includes('Made by NoSwear32') && await page.evaluate(() => document.querySelectorAll('#aboutDlg .logomark, #aboutDlg .logoword').length === 2), 'About shows logo, version and author');
await page.click('#updCheck'); await page.waitForFunction(() => document.getElementById('updStatus').textContent.includes('available')); await shot('about');
ok((await page.textContent('#updNotes')).includes('Mock release notes') && await page.isVisible('#updInstall'), 'update check finds the newer (mock) release');
slow = true;
await page.click('#updInstall');
await page.waitForFunction(() => { const b = document.getElementById('updBar'); return !b.hidden && b.value > 0 && b.value < b.max; });
ok(await page.isVisible('#updBar') && await page.isVisible('#updCancel') && !(await page.isVisible('#updInstall')), 'while downloading: a progress bar and Cancel replace the Download button');
await shot('updating');
ok((await page.evaluate(() => getComputedStyle(document.getElementById('updCancel')).backgroundColor)) === 'rgb(217, 58, 63)', 'the Cancel button is red');
ok(/\d+\.\d of 1\.4 MB \(\d+%\)/.test(await page.textContent('#updPct')), 'progress text shows size and percent: ' + (await page.textContent('#updPct')));
const v1 = await page.evaluate(() => document.getElementById('updBar').value); await page.waitForTimeout(300);
ok((await page.evaluate(() => document.getElementById('updBar').value)) > v1, 'the bar keeps advancing');
await page.click('#updCancel');
await page.waitForFunction(() => document.getElementById('updStatus').textContent === 'Download cancelled.');
ok(await page.isVisible('#updInstall') && !(await page.isVisible('#updCancel')) && !(await page.isVisible('#updBar')), 'Cancel stops the download and brings back the Download button');
slow = false;
await page.click('#updInstall'); await page.waitForFunction(() => /verified|failed/i.test(document.getElementById('updStatus').textContent));
ok((await page.textContent('#updStatus')).includes('signature verified'), 'signed update downloads and verifies: ' + (await page.textContent('#updStatus')).slice(0, 60));
tamper = true;
await page.click('#updCheck'); await page.waitForFunction(() => document.getElementById('updStatus').textContent.includes('available')); await page.click('#updInstall');
await page.waitForFunction(() => /failed/i.test(document.getElementById('updStatus').textContent));
ok((await page.textContent('#updStatus')).includes('Signature check FAILED'), 'tampered update is refused'); tamper = false;
await page.click('#aboutForm button[value=cancel]');
await page.click('tbody tr:has-text("Iconic")');
// ---- right-click menu on an entry ----
await page.evaluate(async () => { setState(await kyuch.call('entry:add', { groupId: S.root.id, title: 'Linky', username: 'lin', password: 'linpw', url: 'example.org', icon: 85 })); });
await page.click('.node:has-text("e2e")');
ok(await page.evaluate(() => { const k = [...document.querySelectorAll('tbody tr')].find((r) => r.textContent.includes('Linky')).querySelector('.kic'); return !!k && getComputedStyle(k).backgroundPosition !== '0% 0%'; }), 'list rows draw the new sprite icons');
await app.evaluate(({ shell }) => { globalThis.__opened = []; shell.openExternal = async (u) => { globalThis.__opened.push(u); }; }); // never open a real browser from a test
await page.click('tbody tr:has-text("Linky")', { button: 'right' });
const ctxText = await page.textContent('#ctxMenu');
ok(await page.isVisible('#ctxMenu') && ['Edit entry', 'Copy username', 'Copy password', 'Auto-type', 'Open URL', 'Open with', 'Move to', 'Delete'].every((t) => ctxText.includes(t)), 'right-clicking an entry opens its menu: ' + ctxText.replace(/\s+/g, ' '));
await shot('ctxmenu');
await page.click('#ctxMenu button:has-text("Copy username")'); await page.waitForTimeout(150);
ok(!(await page.isVisible('#ctxMenu')) && await app.evaluate(({ clipboard }) => clipboard.readText()) === 'lin', 'Copy username from the menu copies it and closes the menu');
await page.click('tbody tr:has-text("Linky")', { button: 'right' }); await page.click('#ctxMenu button:has-text("Copy password")'); await page.waitForTimeout(150);
ok(await app.evaluate(({ clipboard }) => clipboard.readText()) === 'linpw', 'Copy password from the menu');
await page.click('tbody tr:has-text("Linky")', { button: 'right' }); await page.click('#ctxMenu button:has-text("Open URL")'); await page.waitForTimeout(200);
ok(JSON.stringify(await app.evaluate(() => globalThis.__opened)) === JSON.stringify(['https://example.org']), 'Open URL uses the browser chosen in Settings (here the system default)');
await page.click('tbody tr:has-text("Linky")', { button: 'right' }); await page.hover('#ctxMenu .subwrap:has-text("Open with")');
const owText = await page.textContent('#ctxMenu .subwrap:has-text("Open with") .sub');
ok(await page.isVisible('#ctxMenu .sub') && owText.includes('System default'), '"Open with" lists the browsers to choose from: ' + owText.replace(/\s+/g, ' ').trim());
await shot('openwith');
await page.click('#ctxMenu .sub button:has-text("System default")'); await page.waitForTimeout(200);
ok((await app.evaluate(() => globalThis.__opened)).length === 2, 'choosing a browser in "Open with" opens the link');
const badBrowser = await page.evaluate(() => kyuch.call('entry:open', { id: [...entries.values()].find((x) => x.e.title === 'Linky').e.id, browser: 'sh -c evil' }).then(() => 'opened', (e) => e.message));
ok(badBrowser === 'Unknown browser' && (await app.evaluate(() => globalThis.__opened)).length === 2, 'a browser that is not in the fixed list is refused');
await page.click('tbody tr:has-text("Iconic")', { button: 'right' });
ok(await page.isDisabled('#ctxMenu button:has-text("Open URL")') && await page.isDisabled('#ctxMenu button:has-text("Open with")'), 'an entry without a URL has Open URL / Open with greyed out');
await page.keyboard.press('Escape'); ok(!(await page.isVisible('#ctxMenu')), 'Escape closes the entry menu');
await page.click('tbody tr:has-text("Linky")', { button: 'right' }); await page.hover('#ctxMenu .subwrap:has-text("Move to")');
const mvText = await page.textContent('#ctxMenu .subwrap:has-text("Move to") .sub');
ok(mvText.includes('Work') && mvText.includes('Deep') && !mvText.includes('Recycle Bin'), '"Move to" lists the folders (not the Recycle Bin): ' + mvText.replace(/\s+/g, ' ').trim());
await page.click('#ctxMenu .sub button:has-text("Deep")'); await page.waitForTimeout(300);
ok((await page.locator('tbody tr:has-text("Linky")').count()) === 0, 'Move to sends the entry to that folder');
await page.click('.node:has-text("Deep")');
ok((await page.locator('tbody tr:has-text("Linky")').count()) === 1, 'the entry is now in the chosen folder');
const wCtx = await openEditor(async () => { await page.click('tbody tr:has-text("Linky")', { button: 'right' }); await page.click('#ctxMenu button:has-text("Edit entry")'); });
ok((await wCtx.inputValue('#eTitle')) === 'Linky', 'Edit entry from the menu opens the entry editor window'); await cancelWin(wCtx);
await page.click('tbody tr:has-text("Linky")', { button: 'right' }); await page.click('#ctxMenu button:has-text("Delete")'); await page.waitForTimeout(300);
ok((await page.locator('tbody tr:has-text("Linky")').count()) === 0 && /Recycle Bin/.test((await confirms()).at(-1)), 'Delete from the menu asks, then moves the entry to the Recycle Bin');
await page.click('.node:has-text("e2e")');
// ---- window buttons, logo menu, Settings/About on the database screen ----
await page.hover('#wMin');
const circ = await page.evaluate(() => { const b = document.getElementById('wMin'), cs = getComputedStyle(b); return { bg: cs.backgroundColor, radius: cs.borderRadius, w: Math.round(b.getBoundingClientRect().width) }; });
ok(circ.bg === 'rgba(128, 128, 128, 0.34)' && circ.radius.includes('50%') && circ.w === 24, 'hovering a window button shows a gray circle: ' + JSON.stringify(circ));
await page.hover('#wClose');
ok((await page.evaluate(() => getComputedStyle(document.getElementById('wClose')).backgroundColor)) === 'rgba(128, 128, 128, 0.34)', 'the close button gets the same gray circle (no red)');
await page.click('#brandBtn');
const menuText = await page.textContent('#logoMenu');
ok(await page.isVisible('#logoMenu') && ['New database', 'Open database', 'Lock', 'Close database', 'Settings', 'About', 'Quit Kyuch'].every((s) => menuText.includes(s)), 'clicking the logo opens a menu with database, lock, settings and quit actions');
await page.hover('#mSettings');
ok((await page.evaluate(() => getComputedStyle(document.getElementById('mSettings')).backgroundColor)) !== 'rgba(0, 0, 0, 0)', 'logo menu items light up on hover like the other menus');
await page.keyboard.press('Escape'); ok(!(await page.isVisible('#logoMenu')), 'Escape closes the logo menu');
await page.click('#brandBtn'); await page.click('#mLock'); await page.waitForSelector('#lock:not([hidden])');
ok(await page.isVisible('#brandBtn') && !(await page.locator('#btnSettings, #btnAbout').count()) && !(await page.isVisible('#btnAdd')) && !(await page.isVisible('#btnSave')), 'Settings and About are gone from the toolbar (they live in the logo menu); the database screen keeps the logo menu and hides the vault-only buttons');
await page.click('#brandBtn');
ok(await page.isVisible('#mSettings') && await page.isVisible('#mAbout') && !(await page.isVisible('#mLock')) && !(await page.isVisible('#mClose')), 'the logo menu on the database screen offers Settings and About, not Lock / Close');
await page.keyboard.press('Escape');
const mk = await logoInfo('#lock .logomark');
ok(mk.mask.includes('logo-mark.png') && Math.abs(mk.w / mk.h - 640 / 557) < 0.02 && await pngLoads('icons.png'), 'the new key logo is drawn with the right proportions: ' + JSON.stringify(mk));
const wL = await settingsWin();
ok((await wL.locator('#aThemes .theme-card').count()) === 8 && !(await wL.isVisible('#aPwBox')) && (await wL.locator('#aBrowser option').first().textContent()) === 'System default', 'Settings opens without a database: themes, browser choice, no master-password fields');
ok(await wL.isChecked('#aTray') && await wL.isChecked('#aTrayLock'), 'closing to the tray (and locking when it goes there) is on by default');
await cancelWin(wL);
await viaLogoMenu('#mAbout')(); await page.waitForSelector('#aboutDlg[open]'); await page.click('#aboutForm button[value=cancel]');
await page.click('#recent button'); await page.fill('#unlockPw', 'hunter2'); await page.press('#unlockPw', 'Enter'); await page.waitForSelector('#app:not([hidden])');
// NOTE: real auto-type (Alt+Tab + typing) is deliberately NOT run here: it types into whatever window the desktop
// switches to, which on a real desktop is the developer's own app. Key events are covered by unit tests; the typing
// itself is covered by the sandboxed harness (a textarea in our own window). Verify Alt+Tab by hand.
await app.close();

// Daily update check: first launch shows the popup, the next launch within 24 h stays quiet, and the switch turns it off.
const launch = (ud) => _electron.launch({ executablePath: K + '/node_modules/electron/dist/electron', args: ['.', '--user-data-dir=' + ud], cwd: K,
  env: { ...process.env, KYUCH_UPDATE_API: 'http://127.0.0.1:' + mock.address().port + '/api', KYUCH_AUTOCHECK_DELAY_MS: '600' } });
const openDialogs = (pg) => pg.evaluate(() => [...document.querySelectorAll('dialog[open]')].map((d) => d.id));
fs.rmSync(T + '/ud2', { recursive: true, force: true });
let a2 = await launch(T + '/ud2'), p2 = await a2.firstWindow();
await p2.waitForSelector('#aboutDlg[open]', { timeout: 20000 });
const popup = await p2.textContent('#aboutDlg');
ok(popup.includes('Version 9.9.9 is available') && popup.includes('Mock release notes') && await p2.isVisible('#updInstall'), 'daily check: a popup offers the newer version on first launch of the day');
await a2.close();
const saved = JSON.parse(fs.readFileSync(T + '/ud2/config.json', 'utf8'));
ok(saved.lastUpdateCheck > Date.now() - 60000, 'the successful check is remembered');
a2 = await launch(T + '/ud2'); p2 = await a2.firstWindow(); await p2.waitForTimeout(3500);
ok((await openDialogs(p2)).length === 0, 'second launch within a day: no check, no popup');
await a2.close();
fs.rmSync(T + '/ud3', { recursive: true, force: true }); fs.mkdirSync(T + '/ud3', { recursive: true }); fs.writeFileSync(T + '/ud3/config.json', JSON.stringify({ autoUpdateCheck: false }));
a2 = await launch(T + '/ud3'); p2 = await a2.firstWindow(); await p2.waitForTimeout(3500);
ok((await openDialogs(p2)).length === 0, 'switched off in Settings: no check at launch');
await a2.close();

// ---- removing databases from the list (the file survives) and the close button minimizing to the tray ----
fs.rmSync(T + '/ud5', { recursive: true, force: true }); fs.mkdirSync(T + '/ud5', { recursive: true });
fs.writeFileSync(T + '/ud5/config.json', JSON.stringify({ autoUpdateCheck: false, recent: [T + '/e2e.kdbx', T + '/never-created.kdbx'] }));
const a5 = await launch(T + '/ud5'); const p5 = await a5.firstWindow();
await p5.waitForSelector('#recent .recentrow >> nth=1');
ok((await p5.locator('#recent .recentrow').count()) === 2 && (await p5.locator('#recent .trash').first().getAttribute('title')).includes('file is not deleted'), 'every database in the list has a trash can');
await p5.click('#recent .recentrow:nth-child(2) .trash'); await p5.waitForSelector('#rmDlg[open]');
ok((await p5.textContent('#rmDlg')).includes('never-created') && (await p5.textContent('#rmDlg')).includes("Don't show this again"), 'removing asks first, with a "Don\'t show this again" checkbox');
await p5.click('#rmForm button[value=cancel]'); await p5.waitForTimeout(150);
ok((await p5.locator('#recent .recentrow').count()) === 2, 'Cancel keeps the database in the list');
await p5.click('#recent .recentrow:nth-child(2) .trash'); await p5.waitForSelector('#rmDlg[open]'); await p5.click('#rmForm button.primary');
await p5.waitForFunction(() => document.querySelectorAll('#recent .recentrow').length === 1);
ok((await p5.evaluate(() => kyuch.call('cfg:get'))).confirmRemoveDb === true, 'without the checkbox the question keeps coming');
await p5.click('#recent .recentrow .trash'); await p5.waitForSelector('#rmDlg[open]'); await p5.check('#rmAsk'); await p5.click('#rmForm button.primary');
await p5.waitForFunction(() => document.querySelectorAll('#recent .recentrow').length === 0);
const cfg5 = JSON.parse(fs.readFileSync(T + '/ud5/config.json', 'utf8'));
ok(cfg5.recent.length === 0 && fs.existsSync(T + '/e2e.kdbx') && cfg5.confirmRemoveDb === false, 'removed databases leave the list (saved), the database file is untouched, and "Don\'t show again" is remembered');
await a5.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, T + '/e2e.kdbx');
await p5.click('#btnOpenDb'); await p5.fill('#unlockPw', 'hunter2'); await p5.press('#unlockPw', 'Enter'); await p5.waitForSelector('#app:not([hidden])');
ok(true, 'a removed database can be added again with Open file');
// "Don't show again" can be turned back on in Settings
const w5 = await settingsWin(a5, p5);
ok(!(await w5.isChecked('#aConfirmRm')), 'Settings shows the question as switched off');
await w5.check('#aConfirmRm'); await closeWinOn(w5, '#edSave', p5);
ok((await p5.evaluate(() => kyuch.call('cfg:get'))).confirmRemoveDb === true, 'Settings turns the question back on');
// Close database: asks about unsaved changes, then locks and removes the database from the list
await a5.evaluate(({ dialog }) => { globalThis.__answer = 2; dialog.showMessageBox = async () => ({ response: globalThis.__answer }); });
await p5.evaluate(async () => { setState(await kyuch.call('group:add', { parentId: S.root.id, name: 'Unsaved' })); });
await viaLogoMenu('#mClose', p5)(); await p5.waitForTimeout(400);
ok(!(await p5.isVisible('#lock')) && (await p5.evaluate(() => kyuch.call('cfg:get'))).recent.length === 1, 'Close database with unsaved changes asks first; Cancel keeps the database open and in the list');
await a5.evaluate(() => { globalThis.__answer = 1; });
await viaLogoMenu('#mClose', p5)(); await p5.waitForSelector('#lock:not([hidden])');
ok((await p5.locator('#recent .recentrow').count()) === 0 && (await p5.evaluate(() => kyuch.call('cfg:get'))).recent.length === 0 && fs.existsSync(T + '/e2e.kdbx'), 'Close database locks it, takes it off the list, and keeps the file');
await p5.click('#btnOpenDb'); await p5.fill('#unlockPw', 'hunter2'); await p5.press('#unlockPw', 'Enter'); await p5.waitForSelector('#app:not([hidden])');
ok(!(await p5.evaluate(() => [...document.querySelectorAll('#tree .node')].some((n) => n.textContent.includes('Unsaved')))), 'Close database > "Don\'t save" really discarded the change');
await a5.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
await p5.click('#wClose'); await p5.waitForTimeout(800);
const visible = () => a5.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible());
ok(!(await visible()) && (await p5.evaluate(() => S === null)), 'the close button hides the window to the tray, and locks the database on the way');
await a5.evaluate(({ app }) => app.emit('second-instance'));      // launching Kyuch again brings the hidden window back
await p5.waitForTimeout(400);
ok(await visible(), 'a hidden window comes back when Kyuch is started again');
await p5.evaluate(() => kyuch.call('cfg:set', { closeToTray: false }));
const closed = a5.waitForEvent('close'); await p5.click('#wClose');
await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error('FAIL: the app did not quit with "minimize to tray" off')), 15000))]);
ok(true, 'with "minimize to tray" turned off, the close button quits Kyuch');
mock.close();
