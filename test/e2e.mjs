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
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('ok:', m); };

await page.click('#btnNewDb');
await page.fill('#nPw', 'hunter2'); await page.fill('#nPw2', 'hunter2'); await page.click('#newDbForm button.primary');
await page.waitForSelector('#app:not([hidden])');
ok(true, 'database created and app shown');

// folder with settings, then nested folder inheriting
await page.click('#btnAdd'); await page.click('#addFolder'); await page.fill('#fName', 'Work'); await page.selectOption('#sAuto', 'true'); await page.fill('#sSeq', '{PASSWORD}{ENTER}'); await page.fill('#sClip', '30');
await page.click('#folderForm button.primary');
await page.click('.node:has-text("Work")');
await page.click('#btnAdd'); await page.click('#addFolder'); await page.fill('#fName', 'Deep'); await page.waitForTimeout(100);
ok((await page.getAttribute('#sSeq', 'placeholder')).includes('{PASSWORD}{ENTER}') && (await page.getAttribute('#sSeq', 'placeholder')).includes('Work'), 'child placeholder shows inherited sequence + source');
ok((await page.getAttribute('#sClip', 'placeholder')).includes('30'), 'child placeholder shows inherited clipboard time');
await page.click('#folderForm button.primary');
await page.click('.node:has-text("Deep")');

// entry
await page.click('#btnAdd'); await page.click('#addEntry'); await page.fill('#eTitle', 'GitHub'); await page.fill('#eUser', 'octo'); await page.fill('#ePass', 's3cret!'); await page.fill('#eUrl', 'github.com'); await page.fill('#eNotes', 'my comment');
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
await page.click('#btnAdd'); await page.click('#addEntry'); await page.fill('#eTitle', 'Unsaved'); await page.fill('#ePass', 'plaintext-pw');
await page.evaluate(() => lock(true));
await page.waitForSelector('#lock:not([hidden])');
ok(await page.evaluate(() => document.querySelectorAll('dialog[open]').length === 0 && document.getElementById('ePass').value === ''), 'lock closes dialogs and clears password fields');
await page.click('#recent button'); await page.fill('#unlockPw', 'hunter2'); await page.press('#unlockPw', 'Enter');
await page.waitForSelector('#app:not([hidden])');
ok((await page.textContent('#tree')).includes('Dirty'), 'auto-lock saved unsaved edits before locking');
// branding, generator, theme
const logoInfo = (sel) => page.evaluate((s) => { const el = document.querySelector(s), cs = getComputedStyle(el), r = el.getBoundingClientRect(); return { w: r.width, h: r.height, mask: cs.maskImage || cs.webkitMaskImage, bg: cs.backgroundColor }; }, sel);
const pngLoads = (name) => page.evaluate((n) => new Promise((res) => { const i = new Image(); i.onload = () => res(i.naturalWidth > 0); i.onerror = () => res(false); i.src = n; }), name);
const bar = await logoInfo('#brand');
ok(bar.mask.includes('logo-text.png') && bar.h === 18 && Math.abs(bar.w / bar.h - 3.149) < 0.05 && await pngLoads('logo-text.png') && await pngLoads('logo-mark.png'), 'the name logo is drawn in the toolbar (mask image loads, correct proportions): ' + JSON.stringify(bar));
await page.click('#btnGen');
ok((await page.inputValue('#gOut')).length === 20, 'generator opens with a 20 char password');
await page.fill('#gLenN', '32'); await page.dispatchEvent('#gLenN', 'input'); await page.uncheck('#gSymbols');
const gp = await page.inputValue('#gOut');
ok(gp.length === 32 && /^[A-Za-z0-9]+$/.test(gp), 'length + symbol toggle respected: ' + gp.length);
await page.click('#gCopy'); await page.waitForTimeout(150);
ok(await app.evaluate(({ clipboard }) => clipboard.readText()) === gp, 'generator Copy puts the password on the clipboard');
await page.check('#gMulti');
ok(await page.isVisible('#gCountWrap') && await page.isVisible('#gList') && !(await page.isVisible('#gOut')), 'multiple-passwords checkbox reveals the count box and the list');
const rows = () => page.evaluate(() => [...document.querySelectorAll('#gList .genrow input')].map((i) => i.value));
await page.fill('#gCount', '30'); await page.dispatchEvent('#gCount', 'input');
const r30 = await rows(); ok(r30.length === 30 && r30.every((p) => /^[A-Za-z0-9]{32}$/.test(p)) && new Set(r30).size === 30, '30 distinct passwords generated with the current settings');
await page.fill('#gCount', '99'); await page.dispatchEvent('#gCount', 'change');
ok((await page.inputValue('#gCount')) === '30' && (await rows()).length === 30, 'count is capped at 30');
await page.fill('#gCount', '4'); await page.dispatchEvent('#gCount', 'change');
await page.click('#gCopy'); await page.waitForTimeout(150);
const four = await rows(), clip = await app.evaluate(({ clipboard }) => clipboard.readText());
ok(four.length === 4 && clip === four.join('\n'), 'Copy all puts exactly the 4 listed passwords on the clipboard');
await page.fill('#gCount', '12'); await shot('genmulti'); await page.fill('#gCount', '4');
await page.click('#gRegen'); ok(JSON.stringify(await rows()) !== JSON.stringify(four), 'Regenerate makes a fresh list');
await page.uncheck('#gMulti');
ok((await page.inputValue('#gOut')).length === 32 && !(await page.isVisible('#gList')), 'unchecking returns to a single password');
await page.click('#genForm button[value=cancel]');
await page.click('#btnAdd'); await page.click('#addEntry'); await page.click('#eGen'); const gp2 = await page.inputValue('#gOut'); await page.click('#gUse');
ok((await page.inputValue('#ePass')) === gp2 && gp2.length === 32, 'Use password fills the entry form');
ok((await page.inputValue('#gOut')) === '', 'generator output wiped after closing');
await page.click('#eGen'); await page.check('#gMulti'); await page.fill('#gCount', '3');
ok(!(await page.isVisible('#gUse')), 'single "Use password" button is replaced by per-row Use buttons');
const pick = (await rows())[1]; await page.click('#gList .genrow:nth-child(2) button.primary');
await page.waitForTimeout(250); // the wipe runs a tick after the dialog closes
ok((await page.inputValue('#ePass')) === pick && (await page.evaluate(() => document.querySelectorAll('#gList .genrow').length)) === 0, 'a row\'s Use fills the entry form with exactly that password, then the list is wiped');
await page.evaluate(() => localStorage.removeItem('kyuch.gen'));
await page.click('#entryForm button[value=cancel]');
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
await page.click('#btnSettings'); await page.waitForSelector('#settingsDlg[open]');
const cardIds = await page.evaluate(() => [...document.querySelectorAll('#aThemes .theme-card')].map((c) => c.dataset.theme));
ok(JSON.stringify(cardIds) === JSON.stringify(['system', 'dark', 'light', 'ocean', 'forest', 'amethyst', 'sand', 'blossom']), 'Settings offers 8 themes: ' + cardIds.join(', '));
const primaryBg = () => page.evaluate(() => getComputedStyle(document.querySelector('#settingsForm button.primary')).backgroundColor);
ok((await primaryBg()) === 'rgb(248, 88, 0)', 'Dark theme: primary buttons are the brand orange');
await page.click('#aThemes [data-theme="light"]');
ok((await primaryBg()) === 'rgb(201, 66, 0)', 'Light theme: primary buttons are a deeper orange (readable with white text)');
await page.click('#aThemes [data-theme="dark"]');
await shot('themes');
await page.click('#aThemes [data-theme="ocean"]');
ok((await bodyBg()) === 'rgb(11, 26, 38)' && (await logoInfo('#brand')).bg === 'rgb(56, 189, 248)', 'clicking a theme previews it live and the logo takes its colour (Ocean)');
await page.click('#settingsForm button[value=cancel]'); await page.waitForTimeout(200);
ok((await bodyBg()) === 'rgb(27, 29, 34)', 'Cancel reverts the previewed theme');
await page.click('#btnSettings'); await page.waitForSelector('#settingsDlg[open]');
await page.click('#aThemes [data-theme="blossom"]'); await page.click('#settingsForm button.primary'); await page.waitForTimeout(400);
ok((await bodyBg()) === 'rgb(251, 241, 245)' && (await page.evaluate(() => kyuch.call('cfg:get'))).theme === 'blossom', 'Apply saves the chosen theme (Blossom)');
const expectBg = { ocean: 'rgb(11, 26, 38)', forest: 'rgb(14, 26, 20)', amethyst: 'rgb(23, 18, 31)', sand: 'rgb(245, 239, 227)', blossom: 'rgb(251, 241, 245)' };
for (const [name, bg] of Object.entries(expectBg)) { await setTheme(name); if ((await bodyBg()) !== bg) throw new Error('FAIL: theme ' + name + ' background ' + (await bodyBg())); await shot('theme-' + name); }
ok(true, 'all five new themes apply their own colours');
await setTheme('system');
// title bar size (was 44 px; -20% = 35 px) and smaller window buttons
const dims = await page.evaluate(() => ({ bar: document.getElementById('top').getBoundingClientRect().height, btn: document.getElementById('wMin').getBoundingClientRect().width, glyph: document.querySelector('#wClose svg').getBoundingClientRect().width }));
ok(Math.round(dims.bar) === 35 && Math.round(dims.btn) === 34 && Math.round(dims.glyph) === 10, 'title bar is 35 px tall, window buttons 34 px wide: ' + JSON.stringify(dims));
// Alt+Tab delay is in milliseconds, default 500
await page.evaluate(() => kyuch.call('cfg:set', { autoLockMin: 5, altTabDelayMs: 500, theme: 'system' }));
await page.click('#btnSettings'); await page.waitForSelector('#settingsDlg[open]');
ok((await page.textContent('#settingsDlg')).includes('Alt+Tab delay (milliseconds') && (await page.inputValue('#aDelay')) === '500', 'Settings shows the Alt+Tab delay in milliseconds, default 500');
ok(!(await page.isChecked('#aAutoUpd')), 'Settings has the daily update check switch (off in this run)');
await page.check('#aAutoUpd'); await page.fill('#aDelay', '250'); await page.click('#settingsForm button.primary'); await page.waitForTimeout(300);
ok((await page.evaluate(() => kyuch.call('cfg:get'))).altTabDelayMs === 250, 'new Alt+Tab delay is saved (250 ms)');
ok((await page.evaluate(() => kyuch.call('cfg:get'))).autoUpdateCheck === true, 'daily update check switch is saved');
await page.evaluate(() => kyuch.call('cfg:set', { autoLockMin: 5, altTabDelayMs: 500, theme: 'system', autoUpdateCheck: false }));
await page.evaluate(() => kyuch.call('cfg:set', { autoLockMin: 5, altTabDelayMs: 500, theme: 'system' }));
// One-time password tab
const totpMod = require(K + '/totp.js');
const near = (input, digits) => [-30000, 0, 30000].map((d) => totpMod.code(totpMod.parse(input, { digits }), Date.now() + d).code); // tolerate a window rollover mid-test
await page.click('#btnAdd'); await page.click('#addEntry'); await page.waitForSelector('#entryDlg[open]');
await page.fill('#eTitle', 'OTP Site'); await page.fill('#ePass', 'pw-otp');
ok(await page.isVisible('#tabBtnOtp') && await page.isVisible('#eUser') && !(await page.isVisible('#panelOtp')), 'entry dialog has a Details tab (active) and a One-time password tab');
await page.click('#tabBtnOtp');
ok(await page.isVisible('#panelOtp') && !(await page.isVisible('#eUser')), 'One-time password tab replaces the details fields');
await page.fill('#oSecret', 'JBSWY3DPEHPK3PXP');
await page.waitForFunction(() => /^\d{3} \d{3}$/.test(document.getElementById('oCode').textContent));
const shown = (await page.textContent('#oCode')).replace(' ', '');
await shot('otp'); ok(near('JBSWY3DPEHPK3PXP').includes(shown) && await page.isVisible('#oBar'), 'secret key shows the matching 6-digit code with a countdown: ' + shown);
await page.fill('#oSecret', 'otpauth://totp/Ex:me?secret=JBSWY3DPEHPK3PXP&issuer=Ex&digits=8&period=60&algorithm=SHA256');
await page.waitForFunction(() => document.getElementById('oCode').textContent.replace(' ', '').length === 8);
const linkVals = await page.evaluate(() => [oDigits.value, oPeriod.value, oAlg.value, oDigits.disabled]);
ok(JSON.stringify(linkVals) === JSON.stringify(['8', '60', 'SHA256', true]), 'a pasted otpauth:// link fills (and locks) digits, period and algorithm');
await page.fill('#oSecret', '1!!');
await page.waitForFunction(() => document.getElementById('oErr').textContent.length > 0);
await page.click('#entryForm button.primary'); await page.waitForTimeout(300);
ok(await page.evaluate(() => document.getElementById('entryDlg').open) && await page.isVisible('#panelOtp'), 'an invalid secret blocks saving and keeps the OTP tab open');
await page.fill('#oSecret', 'JBSWY3DPEHPK3PXP');
await page.waitForFunction(() => /^\d{3} \d{3}$/.test(document.getElementById('oCode').textContent));
ok(JSON.stringify(await page.evaluate(() => [oDigits.value, oPeriod.value, oAlg.value, oDigits.disabled])) === JSON.stringify(['6', '30', 'SHA1', false]), 'replacing a link with a bare secret resets digits/period/algorithm to defaults');
await page.click('#entryForm button.primary'); await page.waitForTimeout(400);
ok(await page.evaluate(() => document.getElementById('oSecret').value === ''), 'secret field is cleared after the dialog closes');
await page.click('tbody tr:has-text("OTP Site")');
await page.waitForFunction(() => /^\d{3} \d{3}$/.test((document.querySelector('#detail .otpcode') || {}).textContent || ''));
const dShown = (await page.textContent('#detail .otpcode')).replace(' ', '');
ok((await page.textContent('#detail')).includes('One-time password') && near('JBSWY3DPEHPK3PXP').includes(dShown), 'detail pane shows the live code: ' + dShown);
await page.click('#detail .field:has-text("One-time password") button'); await page.waitForTimeout(200);
ok((await app.evaluate(({ clipboard }) => clipboard.readText())) === (await page.textContent('#detail .otpcode')).replace(' ', ''), 'Copy puts the current code (not the secret) on the clipboard');
await page.click('#detail button:has-text("Edit")'); await page.waitForSelector('#entryDlg[open]'); await page.click('#tabBtnOtp');
await page.waitForFunction(() => /^\d{3} \d{3}$/.test(document.getElementById('oCode').textContent));
ok((await page.inputValue('#oSecret')).startsWith('otpauth://totp/') && (await page.inputValue('#oSecret')).includes('JBSWY3DPEHPK3PXP'), 'editing shows the stored otpauth:// link');
await page.click('#entryForm button[value=cancel]'); await page.waitForTimeout(200);
ok((await page.inputValue('#oSecret')) === '', 'cancel also wipes the secret from the page');

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
await page.click('#btnSettings'); await page.waitForSelector('#settingsDlg[open]');
ok(await page.isVisible('#aLayout') && (await page.inputValue('#aLayout')) === 'auto', 'Settings has a keyboard layout choice for auto-type (Linux)');
await page.fill('#aNewPw', 'abc'); await page.fill('#aNewPw2', 'abd'); await page.click('#settingsForm button.primary'); await page.waitForTimeout(200);
ok(await page.evaluate(() => document.getElementById('settingsDlg').open) && (await page.textContent('#aErr')).includes('do not match'), 'a mistyped new master password is refused before anything is saved');
await page.fill('#aNewPw', ''); await page.fill('#aNewPw2', ''); await page.click('#settingsForm button[value=cancel]');
// a stored OTP link the user did not touch is saved exactly as it was (extra parameters survive)
const keepUri = 'otpauth://totp/X?secret=JBSWY3DPEHPK3PXP&extra=keepme&digits=7';
const keepId = await page.evaluate(async (u) => { setState(await kyuch.call('entry:add', { groupId: S.root.id, title: 'KeepOtp', otp: u })); return [...entries.values()].find((x) => x.e.title === 'KeepOtp').e.id; }, keepUri);
await page.click('.node:has-text("e2e")'); await page.click('tbody tr:has-text("KeepOtp")'); await page.click('#detail button:has-text("Edit")'); await page.waitForSelector('#entryDlg[open]');
await page.fill('#eNotes', 'edited without touching the OTP tab'); await page.click('#entryForm button.primary'); await page.waitForTimeout(400);
const afterEdit = await page.evaluate((id) => kyuch.call('entry:get', { id }), keepId);
ok(afterEdit.otp === keepUri && afterEdit.notes.startsWith('edited'), 'an untouched OTP link is saved exactly as stored');
// pressing OK on an entry without changing anything adds no history



// Add menu, icon picker Cancel, custom icon, window controls, About + update flow
await page.click('#btnAdd'); ok(await page.isVisible('#addMenu') && (await page.textContent('#addMenu')).includes('Entry') && (await page.textContent('#addMenu')).includes('Folder'), 'Add button opens a menu with Entry and Folder');
await shot('addmenu'); await page.keyboard.press('Escape'); ok(!(await page.isVisible('#addMenu')), 'Escape closes the Add menu');
await page.click('#btnAdd'); await page.click('#addEntry'); await page.waitForSelector('#entryDlg[open]');
await page.click('#eIcon'); await page.waitForSelector('#iconDlg[open]');
await page.click('#iconClose'); await page.waitForTimeout(150);
ok(!(await page.evaluate(() => document.getElementById('iconDlg').open)) && await page.evaluate(() => document.getElementById('entryDlg').open), 'icon picker Cancel closes it and keeps the entry dialog');
await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, K + '/brand/png/icon-64.png');
await page.fill('#eTitle', 'Iconic'); await page.click('#eIcon'); await page.click('#iconAdd'); await page.waitForTimeout(400);
ok(await page.evaluate(() => !document.getElementById('iconDlg').open && !!document.querySelector('#eIcon img.ico')), 'adding a custom icon applies it and shows it on the button');
await page.click('#entryForm button.primary'); await page.waitForTimeout(300);
await page.click('tbody tr:has-text("Iconic")');
ok(await page.evaluate(() => !!document.querySelector('#detail h2 img.ico') && !!document.querySelector('tbody tr.sel img.ico')), 'custom icon shown in the list and detail pane');
await page.click('#btnSave'); await page.waitForTimeout(300);
const wasMax = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized());
await page.click('#wMax'); await page.waitForTimeout(500);
ok((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())) === !wasMax, 'maximize button toggles the window');
await page.click('#wMax'); await page.waitForTimeout(300);
await page.click('#wMin'); await page.waitForTimeout(500);
ok(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()), 'minimize button minimizes the window');
await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.restore(); w.show(); w.focus(); }); await page.waitForTimeout(400);
await page.click('#btnAbout'); await page.waitForSelector('#aboutDlg[open]');
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
mock.close();
