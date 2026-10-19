const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { createUpdater, compare } = require('../updater');

const key = crypto.generateKeyPairSync('ed25519');
const other = crypto.generateKeyPairSync('ed25519');
const pub = key.publicKey.export({ type: 'spki', format: 'pem' });
const deb = crypto.randomBytes(5000);
const sign = (data, k) => crypto.sign(null, data, k.privateKey).toString('base64');
let server, base, tweak = {};

test.before(async () => {
  server = http.createServer((req, res) => {
    const files = { '/k.deb': tweak.deb || deb, '/k.deb.sig': tweak.sig || sign(deb, key) };
    if (req.url === '/api') {
      const rel = { tag_name: tweak.tag || 'v0.9.0', body: 'notes', html_url: base + '/page', assets: tweak.noAssets ? [] : [
        { name: 'kyuch_0.9.0_amd64.deb', browser_download_url: base + '/k.deb', size: 5000 }, { name: 'kyuch_0.9.0_amd64.deb.sig', browser_download_url: base + '/k.deb.sig' }] };
      return res.end(JSON.stringify(rel));
    }
    if (files[req.url]) return res.end(files[req.url]);
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => server.close());
const mk = (o = {}) => createUpdater({ api: base + '/api', current: '0.2.0', publicKey: pub, allowLocal: true, ...o });
test.afterEach(() => { tweak = {}; });

test('version compare', () => {
  assert.ok(compare('0.10.0', '0.9.9') > 0); assert.ok(compare('v1.0.0', '0.99.99') > 0);
  assert.equal(compare('1.2.3', '1.2.3'), 0); assert.ok(compare('0.2.0', '0.3.0') < 0);
});

test('detects a newer release and downloads + verifies it', async () => {
  const u = mk(), info = await u.check();
  assert.equal(info.newer, true); assert.equal(info.latest, '0.9.0'); assert.equal(info.deb.name, 'kyuch_0.9.0_amd64.deb');
  const { file, sha256 } = await u.download(info);
  assert.ok(fs.readFileSync(file).equals(deb));
  assert.equal(sha256, crypto.createHash('sha256').update(deb).digest('hex'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('same or older version is not an update', async () => {
  tweak = { tag: 'v0.2.0' };
  const u = mk(), info = await u.check();
  assert.equal(info.newer, false);
  await assert.rejects(u.download(info), /No newer version/);
});

test('tampered package is rejected', async () => {
  tweak = { deb: Buffer.concat([deb, Buffer.from('x')]) };
  const u = mk();
  await assert.rejects(u.download(await u.check()), /Signature check FAILED/);
});

test('signature from a different key is rejected', async () => {
  tweak = { sig: sign(deb, other) };
  const u = mk();
  await assert.rejects(u.download(await u.check()), /Signature check FAILED/);
});

test('missing assets are reported, not guessed', async () => {
  tweak = { noAssets: true };
  const u = mk();
  await assert.rejects(u.download(await u.check()), /missing its .deb or .sig/);
});

test('refuses non-GitHub download addresses in normal mode', async () => {
  const u = mk({ allowLocal: false });
  await assert.rejects(u.download(await u.check()), /unexpected address/);
});
