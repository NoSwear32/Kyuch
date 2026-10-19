const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Vault } = require('../core');
const { parse, keyEvents, LAYOUTS } = require('../autotype');

const tmp = path.join(process.env.TMPDIR || os.tmpdir(), `kyuch-${process.pid}.kdbx`);
test.after(() => fs.rmSync(tmp, { force: true }));

test('create, nest, save, reload, wrong password', async () => {
  const v = await Vault.create(tmp, 'master pw');
  const root = v.root.uuid.id;
  const work = v.addGroup(root, { name: 'Work', settings: { autoTypeSeq: '{PASSWORD}{ENTER}', clipboardClear: 30 } });
  const deep = v.addGroup(work, { name: 'Deep' });
  const sub = v.addGroup(work, { name: 'Sub', settings: { clipboardClear: 5 } });
  const e = v.addEntry(deep, { title: 'GitHub', username: 'me', password: 'p@ss"w\\rd#', url: 'https://github.com', notes: 'hi', icon: 61 });
  await v.save();

  const r = await Vault.open(tmp, 'master pw');
  assert.equal(r.legacy, false);
  assert.equal(r.getEntry(e).password, 'p@ss"w\\rd#');
  assert.equal(r.getEntry(e).icon, 61);
  const t = r.tree();
  assert.deepEqual(t.groups.map((g) => g.name).sort(), ['Recycle Bin', 'Work'].sort());
  assert.equal(JSON.stringify(t).includes('p@ss'), false, 'tree must not leak passwords');
  await assert.rejects(Vault.open(tmp, 'wrong'));
});

test('settings inherit from parent, child overrides win', async () => {
  const r = await Vault.open(tmp, 'master pw');
  const work = r.tree().groups.find((g) => g.name === 'Work');
  const deep = work.groups.find((g) => g.name === 'Deep'), sub = work.groups.find((g) => g.name === 'Sub');
  assert.deepEqual(deep.effective.autoTypeSeq, { value: '{PASSWORD}{ENTER}', from: 'Work' });
  assert.deepEqual(deep.effective.clipboardClear, { value: 30, from: 'Work' });
  assert.deepEqual(sub.effective.clipboardClear, { value: 5, from: 'Sub' });
  assert.deepEqual(deep.effective.typeDelay, { value: 12, from: null }); // nobody set it -> built-in default
  assert.equal(deep.raw.clipboardClear, null);
  const ti = r.typeInfo(deep.entries[0].id);
  assert.equal(ti.seq, '{PASSWORD}{ENTER}');
  r.updateGroup(work.id, { settings: { autoType: false } });
  assert.equal(r.typeInfo(deep.entries[0].id).enabled, false); // disabled folder disables entries below
});

test('move, delete to bin, no folder into itself', async () => {
  const r = await Vault.open(tmp, 'master pw');
  const t = r.tree(), work = t.groups.find((g) => g.name === 'Work'), deep = work.groups.find((g) => g.name === 'Deep');
  assert.throws(() => r.move(work.id, deep.id));
  r.move(deep.entries[0].id, r.root.uuid.id);
  assert.equal(r.tree().entries.length, 1);
  r.deleteEntry(r.tree().entries[0].id);
  assert.equal(r.tree().groups.find((g) => g.isBin).entries.length, 1);
  assert.throws(() => r.deleteGroup(r.root.uuid.id));
});

test('auto-type parser', () => {
  const f = { USERNAME: 'me', PASSWORD: 'pw', URL: '', TITLE: '', NOTES: '' };
  assert.deepEqual(parse('{USERNAME}{TAB}{PASSWORD}{ENTER}', f), [{ text: 'me' }, { key: 'tab' }, { text: 'pw' }, { key: 'enter' }]);
  assert.deepEqual(parse('a{DELAY 500}{{}', f), [{ text: 'a' }, { delay: 500 }, { text: '{' }]);
  assert.throws(() => parse('{NOPE}', f));
  assert.throws(() => parse('{USERNAME', f));
});

test('keymaps: gb differs from us on @ " # \\', () => {
  const ev = (c, l) => keyEvents([{ text: c }], LAYOUTS[l]).join(' ');
  assert.equal(ev('@', 'us'), '42:1 3:1 3:0 42:0');
  assert.equal(ev('@', 'gb'), '42:1 40:1 40:0 42:0');
  assert.equal(ev('#', 'gb'), '43:1 43:0');
  assert.equal(ev('A', 'gb'), '42:1 30:1 30:0 42:0');
  assert.throws(() => ev('ç', 'gb'));
});

test('KDF is hardened (64 MiB Argon2)', async () => {
  const r = await Vault.open(tmp, 'master pw');
  assert.equal(Number(r.db.header.kdfParameters.get('M').valueOf()), 64 * 1024 * 1024);
});

test('Argon2 adapter matches an independent implementation (node:crypto/OpenSSL)', async () => {
  const kdbxweb = require('kdbxweb'), crypto = require('node:crypto');
  const pw = Buffer.from('password'), salt = Buffer.alloc(32, 7);
  for (const [type, name] of [[0, 'argon2d'], [2, 'argon2id']]) {
    const ours = Buffer.from(await kdbxweb.CryptoEngine.argon2(pw, salt, 1024, 2, 32, 2, type, 0x13));
    const ref = crypto.argon2Sync(name, { message: pw, nonce: salt, parallelism: 2, tagLength: 32, memory: 1024, passes: 2 });
    assert.equal(ours.toString('hex'), ref.toString('hex'), name);
  }
});

test('password generator: length, classes, look-alikes, entropy', () => {
  const Gen = require('../renderer/gen.js');
  const all = { length: 24, lower: true, upper: true, digits: true, symbols: true, noAmbiguous: true };
  for (let i = 0; i < 200; i++) {
    const p = Gen.generate(all);
    assert.equal(p.length, 24);
    assert.match(p, /[a-z]/); assert.match(p, /[A-Z]/); assert.match(p, /[2-9]/); assert.match(p, /[!@#$%^&*\-_=+?]/);
    assert.doesNotMatch(p, /[0O1lI]/);
  }
  assert.match(Gen.generate({ length: 40, digits: true }), /^[0-9]{40}$/);
  assert.match(Gen.generate({ length: 10, symbols: true, symbolSet: 'ab' }), /^[ab]{10}$/);
  assert.throws(() => Gen.generate({ length: 10 }));                       // nothing selected
  assert.throws(() => Gen.generate({ length: 2, lower: true, upper: true, digits: true }));
  assert.equal(Gen.entropy({ length: 10, digits: true }), 33);            // 10 * log2(10)
  const counts = {}; for (let i = 0; i < 6000; i++) { const c = Gen.generate({ length: 1, digits: true }); counts[c] = (counts[c] || 0) + 1; }
  assert.ok(Object.values(counts).every((n) => n > 450 && n < 750), 'roughly uniform: ' + JSON.stringify(counts));
});

test('XML-hostile characters survive a save/load round trip', async () => {
  const nasty = `<a href="x">&amp; ]]> <!-- -->' äöü € 🔑</a>`;
  const v = await Vault.create(tmp, 'master pw');
  const id = v.addEntry(v.root.uuid.id, { title: nasty, username: nasty, password: nasty, url: nasty, notes: nasty + '\nline2' });
  await v.save();
  const r = await Vault.open(tmp, 'master pw');
  const e = r.getEntry(id);
  for (const k of ['title', 'username', 'password', 'url']) assert.equal(e[k], nasty, k);
  assert.equal(e.notes, nasty + '\nline2');
});

test('custom icons: add, assign, persist, unused ones are cleaned on save', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const v = await Vault.create(tmp, 'master pw');
  const used = v.addIcon(png, 'used'), unused = v.addIcon(png, 'unused');
  const gid = v.addGroup(v.root.uuid.id, { name: 'G', customIcon: used });
  const eid = v.addEntry(gid, { title: 'E', customIcon: used });
  assert.throws(() => v.addEntry(gid, { title: 'bad', customIcon: 'nope' }));
  await v.save();
  const r = await Vault.open(tmp, 'master pw');
  const t = r.tree(), g = t.groups.find((x) => x.name === 'G');
  assert.equal(g.customIcon, used); assert.equal(g.entries[0].customIcon, used);
  assert.ok(r.icons()[used].startsWith('data:image/png;base64,')); assert.equal(r.icons()[unused], undefined);
  r.updateEntry(eid, { customIcon: null, icon: 7 });            // back to a standard icon
  assert.equal(r.tree().groups.find((x) => x.name === 'G').entries[0].customIcon, null);
  assert.equal(r.getEntry(eid).icon, 7);
});

test('auto-type alt+tab key', () => {
  assert.deepEqual(keyEvents([{ key: 'alttab' }], LAYOUTS.gb), ['56:1', '15:1', '15:0', '56:0']);
});

test('one-time password: stored as KeePassXC-style otp field, survives save/load, feeds {OTP}', async () => {
  const totp = require('../totp');
  const uri = 'otpauth://totp/Ex:me?secret=JBSWY3DPEHPK3PXP&issuer=Ex&period=30&digits=6&algorithm=SHA1';
  const v = await Vault.create(tmp, 'master pw');
  const plain = v.addEntry(v.root.uuid.id, { title: 'no otp' });
  const id = v.addEntry(v.root.uuid.id, { title: 'with otp', otp: uri });
  assert.throws(() => v.addEntry(v.root.uuid.id, { title: 'bad', otp: 'not base32 !!' }));
  assert.equal(v.otpInfo(plain), null);
  await v.save();
  const r = await Vault.open(tmp, 'master pw');
  const t = r.tree();
  assert.equal(t.entries.find((e) => e.id === id).hasOtp, true); assert.equal(t.entries.find((e) => e.id === plain).hasOtp, false);
  assert.equal(JSON.stringify(t).includes('JBSWY3DP'), false, 'tree must not leak the secret');
  assert.equal(r.getEntry(id).otp, uri);
  assert.equal(r.secret(id, 'otp'), uri);                                    // the field name other KeePass apps read
  const now = 1_700_000_000_000, expect = totp.code(totp.parse(uri), now).code;
  assert.equal(r.otpInfo(id, now).code, expect);
  assert.match(r.typeInfo(id).fields.OTP, /^\d{6}$/);
  assert.equal(r.typeInfo(plain).fields.OTP, '');
  r.updateEntry(id, { otp: '' });                                             // remove it again
  assert.equal(r.otpInfo(id), null); assert.equal(r.getEntry(id).otp, '');
});

test('auto-type helpers: Windows payload and the Linux helper protocol (no keystrokes are sent)', () => {
  const { winOps, winPayload } = require('../autotype');
  const actions = [{ key: 'alttab' }, { delay: 500 }, { text: 'pä$$wörd €\u{1f511}' }, { key: 'tab' }, { text: 'x' }, { key: 'enter' }];
  assert.deepEqual(winOps(actions), [{ t: 'key', v: 'alttab' }, { t: 'sleep', ms: 500 }, { t: 'text', v: 'pä$$wörd €\u{1f511}' }, { t: 'key', v: 'tab' }, { t: 'text', v: 'x' }, { t: 'key', v: 'enter' }]);
  const job = JSON.parse(Buffer.from(winPayload(actions, 12), 'base64').toString('utf8'));
  assert.equal(job.delay, 12); assert.equal(job.ops[2].v, 'pä$$wörd €\u{1f511}');           // unicode survives the base64/JSON trip
  assert.match(winPayload(actions, 12), /^[A-Za-z0-9+/=]+$/);                                // pure ASCII on the wire, no code-page problems
  // the Linux helper must parse its stdin protocol and refuse anything malformed
  const { spawnSync } = require('node:child_process');
  const py = (input) => spawnSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..'))}); import uinput_type as u; print(u.parse(sys.stdin.read()))`], { input, encoding: 'utf8' });
  assert.equal(py('12\n42:1\n15:1\n15:0\n42:0\nsleep:500\n').status, 0);
  for (const bad of ['', 'x', '12\n999:1', '12\n5:2', '5000\n', '12\nsleep:99999999']) assert.notEqual(py(bad).status, 0, 'must reject ' + JSON.stringify(bad));
});

test('hostile KDF settings are refused instead of hanging the app', async () => {
  const kdbxweb = require('kdbxweb');
  const args = (memKiB, passes) => [Buffer.from('pw'), Buffer.alloc(32), memKiB, passes, 32, 2, 0, 0x13];
  await assert.rejects(kdbxweb.CryptoEngine.argon2(...args(64 * 1024 * 1024, 2)), /unreasonably heavy/);        // 64 GiB
  await assert.rejects(kdbxweb.CryptoEngine.argon2(...args(64 * 1024, 4_000_000_000)), /unreasonably heavy/);   // billions of passes
  assert.equal((await kdbxweb.CryptoEngine.argon2(...args(64 * 1024, 3))).byteLength, 32);                       // Kyuch's own settings still work
});

test('save: no temp file left behind, replaces an existing database, retries a busy rename', async () => {
  const fsx = require('node:fs');
  const dir = fsx.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'kyuch-save-'));
  const file = path.join(dir, 'a.kdbx');
  const v = await Vault.create(file, 'pw');
  v.addEntry(v.root.uuid.id, { title: 'second save' });
  await v.save();                                                        // replaces the file made by create()
  assert.deepEqual(fsx.readdirSync(dir), ['a.kdbx'], 'no .tmp left');
  assert.equal((await Vault.open(file, 'pw')).tree().entries.length, 1);
  // a rename that fails twice with EPERM (antivirus holding the file) and then works must succeed
  const real = fsx.renameSync; let calls = 0;
  fsx.renameSync = (a, b) => { if (++calls <= 2) { const e = new Error('busy'); e.code = 'EPERM'; throw e; } return real(a, b); };
  try { await v.save(); } finally { fsx.renameSync = real; }
  assert.equal(calls, 3); assert.deepEqual(fsx.readdirSync(dir), ['a.kdbx']);
  // a rename that never works must fail loudly and still clean up
  fsx.renameSync = () => { const e = new Error('locked'); e.code = 'EBUSY'; throw e; };
  try { await assert.rejects(v.save(), /locked/); } finally { fsx.renameSync = real; }
  assert.deepEqual(fsx.readdirSync(dir), ['a.kdbx'], 'tmp cleaned after failure');
  fsx.rmSync(dir, { recursive: true, force: true });
});

test('recycle bin: delete moves in, deleting from the bin is permanent, a disabled bin means permanent', async () => {
  const v = await Vault.create(tmp, 'master pw');
  const root = v.root.uuid.id;
  const e = v.addEntry(root, { title: 'x' }), g = v.addGroup(root, { name: 'G' }), inner = v.addEntry(g, { title: 'inner' });
  v.deleteEntry(e); v.deleteGroup(g);
  let bin = v.tree().groups.find((x) => x.isBin);
  assert.equal(bin.entries.length, 1); assert.equal(bin.groups.length, 1);              // both are in the bin now
  v.deleteEntry(e); v.deleteGroup(g);                                                    // delete again FROM the bin
  bin = v.tree().groups.find((x) => x.isBin);
  assert.equal(bin.entries.length, 0); assert.equal(bin.groups.length, 0, 'gone for good');
  assert.throws(() => v.entry(inner), /not found/);                                       // its contents went with the folder
  await v.save(); const r = await Vault.open(tmp, 'master pw');
  assert.equal(r.tree().groups.find((x) => x.isBin).entries.length, 0); assert.equal(r.tree().groups.length, 1);
  // a database from another app with the bin turned off: delete really deletes, and the UI is told
  r.db.meta.recycleBinEnabled = false;
  assert.equal(r.binEnabled, false);
  const e2 = r.addEntry(r.root.uuid.id, { title: 'y' }); r.deleteEntry(e2);
  assert.equal(r.tree().entries.length, 0);
  assert.equal(r.tree().groups.some((x) => x.isBin), false);
});

test('dirty stays true when an edit lands while a save is in flight', async () => {
  const v = await Vault.create(tmp, 'master pw');
  assert.equal(v.dirty, false);
  v.addEntry(v.root.uuid.id, { title: 'first' }); assert.equal(v.dirty, true);
  const saving = v.save();
  await new Promise((r) => setImmediate(r));                                              // the save is now running (encrypting/deriving the key)
  v.addEntry(v.root.uuid.id, { title: 'made during the save' });                         // not in the file being written
  await saving;
  assert.equal(v.dirty, true, 'the later edit is still unsaved');
  await v.save(); assert.equal(v.dirty, false);
});

test('unchanged edits add no history; changed ones do; empty folder names fall back', async () => {
  const v = await Vault.create(tmp, 'master pw');
  const id = v.addEntry(v.root.uuid.id, { title: 'a', username: 'u', password: 'p', tags: ['t'], icon: 3 });
  await v.save();
  v.updateEntry(id, { title: 'a', username: 'u', password: 'p', tags: ['t'], icon: 3, customIcon: null, autoType: true });
  assert.equal(v.dirty, false); assert.equal(v.entry(id).history.length, 0);
  v.updateEntry(id, { password: 'p2' });
  assert.equal(v.dirty, true); assert.equal(v.entry(id).history.length, 1);
  const g = v.addGroup(v.root.uuid.id, { name: 'G' }); v.updateGroup(g, { name: '' });
  assert.equal(v.tree().groups.find((x) => x.id === g).name, 'New folder');
});

test('settings from a hostile database are bounded and never NaN', async () => {
  const v = await Vault.create(tmp, 'master pw');
  const g = v.addGroup(v.root.uuid.id, { name: 'G', settings: { clipboardClear: 99999999999, typeDelay: 99999 } });
  const n = () => v.tree().groups.find((x) => x.id === g);
  assert.equal(n().effective.clipboardClear.value, 86_400); assert.equal(n().effective.typeDelay.value, 1000);
  v.db.getGroup(g).customData.set('kyuch.clipboardClear', { value: 'abc' });             // as if a hostile file said so
  assert.equal(n().effective.clipboardClear.value, 12, 'garbage = inherit the default, never NaN');
  v.updateGroup(g, { settings: { clipboardClear: 'abc' } });
  assert.equal(n().raw.clipboardClear, null);
});

test('save: a symlinked vault keeps its link, a planted tmp symlink is not followed, copy mode does not switch files', async () => {
  const fsx = require('node:fs');
  const dir = fsx.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'kyuch-link-'));
  const real = path.join(dir, 'real.kdbx'), link = path.join(dir, 'link.kdbx'), victim = path.join(dir, 'victim.txt');
  const v = await Vault.create(real, 'pw'); fsx.symlinkSync(real, link);
  v.path = link; v.addEntry(v.root.uuid.id, { title: 'via link' }); await v.save();
  assert.ok(fsx.lstatSync(link).isSymbolicLink(), 'the link survived'); assert.equal((await Vault.open(real, 'pw')).tree().entries.length, 1);
  fsx.writeFileSync(victim, 'precious'); fsx.symlinkSync(victim, real + '.tmp');          // attacker pre-plants real.kdbx.tmp -> victim
  v.addEntry(v.root.uuid.id, { title: 'again' }); await v.save();
  assert.equal(fsx.readFileSync(victim, 'utf8'), 'precious', 'the planted symlink was not written through');
  const copy = path.join(dir, 'backup.kdbx'); v.addEntry(v.root.uuid.id, { title: 'unsaved' });
  await v.save(copy, { copy: true });
  assert.equal(v.path, link); assert.equal(v.dirty, true, 'a copy does not count as saving the real file');
  assert.equal((await Vault.open(copy, 'pw')).tree().entries.length, 3);
  fsx.rmSync(dir, { recursive: true, force: true });
});

test('hardening fixes: delay cap, TOTP key length/steam/label, generator length and emoji, version compare', () => {
  const { parse: p } = require('../autotype'), totp = require('../totp'), Gen = require('../renderer/gen.js'), { compare } = require('../updater');
  assert.deepEqual(p('{DELAY 99999999999}', {}), [{ delay: 10_000 }]);
  assert.throws(() => totp.parse('A'), /too short/); assert.throws(() => totp.parse('JBSWY3DPEHPK3PXP'.slice(0, 8)), /too short/);
  assert.throws(() => totp.parse('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&encoder=steam'), /Steam/);
  assert.equal(totp.parse('otpauth://totp/100%zz?secret=JBSWY3DPEHPK3PXP').digits, 6);       // a stray % in the label is tolerated
  assert.equal(Gen.generate({ length: 100_000_000, lower: true }).length, 1024);
  const emoji = Gen.generate({ length: 200, symbols: true, symbolSet: '\u{1f511}\u{1f510}' });
  assert.ok(/^[\u{1f511}\u{1f510}]+$/u.test(emoji) && [...emoji].length === 200, 'whole emoji only, no lone surrogates');
  assert.ok(compare('1.2.3-beta', '1.2.3') < 0 && compare('1.2.3', '1.2.3-beta') > 0 && compare('1.2.4-beta', '1.2.3') > 0 && compare('1.2.3', '1.2.3') === 0);
});

test('key derivation runs off the main thread: the event loop keeps ticking during a heavy derivation', async () => {
  const kdbxweb = require('kdbxweb');
  let ticks = 0; const iv = setInterval(() => ticks++, 10);
  const t0 = Date.now();
  await kdbxweb.CryptoEngine.argon2(Buffer.from('pw'), Buffer.alloc(32), 256 * 1024, 4, 32, 2, 0, 0x13); // 256 MiB x 4
  clearInterval(iv);
  const ms = Date.now() - t0;
  assert.ok(ticks > ms / 10 / 3, `the loop kept ticking (${ticks} ticks in ${ms} ms)`);
});

test('autotype-access script: enable writes the udev rule, disable removes it, anything else is refused', () => {
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'kyuch-acc-'));
  const rule = path.join(dir, '60-kyuch-uinput.rules'), script = path.join(__dirname, '../scripts/autotype-access.sh');
  const run = (arg) => spawnSync('sh', [script, ...(arg ? [arg] : [])], { env: { ...process.env, KYUCH_RULE_FILE: rule }, encoding: 'utf8' });
  assert.notEqual(run().status, 0); assert.notEqual(run('nonsense').status, 0); assert.ok(!fs.existsSync(rule));
  assert.equal(run('enable').status, 0);
  assert.equal(fs.readFileSync(rule, 'utf8'), 'KERNEL=="uinput", SUBSYSTEM=="misc", TAG+="uaccess", OPTIONS+="static_node=uinput"\n');
  assert.equal(fs.statSync(rule).mode & 0o777, 0o644); assert.ok(!fs.existsSync(rule + '.tmp'));
  assert.equal(run('disable').status, 0); assert.ok(!fs.existsSync(rule));
  assert.equal(run('disable').status, 0, 'disabling twice is fine');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('concurrent saves are serialized: all succeed, nothing is left over, the last edit is on disk', async () => {
  const fsx = require('node:fs');
  const dir = fsx.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'kyuch-conc-'));
  const file = path.join(dir, 'c.kdbx');
  const v = await Vault.create(file, 'pw');
  v.addEntry(v.root.uuid.id, { title: 'one' });
  const a = v.save(); v.addEntry(v.root.uuid.id, { title: 'two' });
  const b = v.save(), c = v.save();
  await Promise.all([a, b, c]);
  assert.deepEqual(fsx.readdirSync(dir), ['c.kdbx']);
  assert.equal((await Vault.open(file, 'pw')).tree().entries.length, 2);
  assert.equal(v.dirty, false);
  fsx.rmSync(dir, { recursive: true, force: true });
});
