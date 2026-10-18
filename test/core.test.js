const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Vault } = require('../core');
const { parse, keyEvents, LAYOUTS } = require('../autotype');

const tmp = path.join(process.env.TMPDIR || os.tmpdir(), `keeper-${process.pid}.kdbx`);
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
