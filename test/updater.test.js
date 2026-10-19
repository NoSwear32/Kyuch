const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { createUpdater, compare } = require('../updater');

const key = crypto.generateKeyPairSync('ed25519');
const other = crypto.generateKeyPairSync('ed25519');
const pub = key.publicKey.export({ type: 'spki', format: 'pem' });
const deb = crypto.randomBytes(400_000);
const sign = (data, k) => crypto.sign(null, data, k.privateKey).toString('base64');
let server, base, tweak = {};

test.before(async () => {
  server = http.createServer((req, res) => {
    const files = { '/k.deb': tweak.deb || deb, '/k.deb.sig': tweak.sig || sign(deb, key) };
    if (req.url === '/k.deb' && tweak.slow) { // trickle the body out so a download can be watched and cancelled
      const body = files['/k.deb']; let i = 0;
      res.setHeader('content-length', body.length);
      const t = setInterval(() => { if (i >= body.length) { clearInterval(t); return res.end(); } res.write(body.subarray(i, i + 40_000)); i += 40_000; }, 40);
      req.on('close', () => clearInterval(t));
      return;
    }
    if (req.url === '/api') {
      const rel = { tag_name: tweak.tag || 'v0.9.0', body: 'notes', html_url: base + '/page', assets: tweak.noAssets ? [] : [
        { name: 'kyuch_0.9.0_amd64.deb', browser_download_url: base + '/k.deb', size: 400000 }, { name: 'kyuch_0.9.0_amd64.deb.sig', browser_download_url: base + '/k.deb.sig' }] };
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

// The root step (run via pkexec in production). Here it runs as the current user with a fake apt-get on PATH.
test('root install script: installs a copy only when the hash matches', () => {
  const { execFileSync, spawnSync } = require('node:child_process');
  const os = require('node:os'), path = require('node:path');
  const { ROOT_SCRIPT } = require('../updater');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyuch-root-')), log = path.join(dir, 'apt.log');
  fs.writeFileSync(path.join(dir, 'apt-get'), `#!/bin/sh\necho "$@" > "${log}"\ncp "$3" "${dir}/seen.deb"\n`, { mode: 0o755 });
  const pkg = path.join(dir, 'a b.deb'); fs.writeFileSync(pkg, deb);          // a space in the path must survive
  const env = { ...process.env, PATH: dir + ':' + process.env.PATH };
  const good = crypto.createHash('sha256').update(deb).digest('hex');

  execFileSync('sh', ['-c', ROOT_SCRIPT, 'sh', pkg, good], { env });
  assert.match(fs.readFileSync(log, 'utf8'), /^install -y \/.*\/kyuch\.deb\n$/);                // apt got a root-made copy, not our file
  assert.ok(!fs.readFileSync(log, 'utf8').includes('a b.deb'));
  assert.ok(fs.readFileSync(path.join(dir, 'seen.deb')).equals(deb));

  fs.rmSync(log);
  const bad = spawnSync('sh', ['-c', ROOT_SCRIPT, 'sh', pkg, '0'.repeat(64)], { env });
  assert.notEqual(bad.status, 0, 'wrong hash must fail');
  assert.ok(!fs.existsSync(log), 'apt-get must never run when the hash is wrong');
  const tampered = spawnSync('sh', ['-c', ROOT_SCRIPT, 'sh', pkg, crypto.createHash('sha256').update('other').digest('hex')], { env });
  assert.notEqual(tampered.status, 0); assert.ok(!fs.existsSync(log));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('download reports progress up to the full size', async () => {
  tweak = { slow: true };
  const u = mk(), calls = [];
  await u.download(await u.check(), { onProgress: (received, total) => calls.push([received, total]) });
  assert.ok(calls.length > 3, 'several progress events, got ' + calls.length);
  assert.ok(calls.every(([r], i) => i === 0 || r >= calls[i - 1][0]), 'monotonic');
  assert.deepEqual(calls.at(-1), [400_000, 400_000]);
});

test('cancel stops the download, reports it, and installs nothing', async () => {
  tweak = { slow: true };
  const u = mk(), ac = new AbortController(), info = await u.check();
  let seen = 0;
  const started = Date.now();
  await assert.rejects(u.download(info, { signal: ac.signal, onProgress: (r) => { seen = r; if (r > 0) ac.abort(); } }), /Download cancelled/);
  assert.ok(seen > 0 && seen < 400_000, 'stopped part-way: ' + seen);
  assert.ok(Date.now() - started < 1000, 'cancel is immediate, not after the download');
});
