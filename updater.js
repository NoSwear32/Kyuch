// Update check + download for GitHub Releases. Installing a .deb runs as root, so every package must carry an
// ed25519 signature (made by scripts/sign-release.js) that verifies against the public key shipped inside the app.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const MAX_BYTES = 500 * 1024 * 1024;
const num = (v) => String(v).replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
const compare = (a, b) => { const x = num(a), y = num(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };

// Runs as root via pkexec: copy to a root-owned dir, re-check the hash, then install. Nothing the user's account
// can write to is trusted between the check and the install.
const ROOT_SCRIPT = 'set -e; d=$(mktemp -d); trap \'rm -rf "$d"\' EXIT; cp "$1" "$d/kyuch.deb"; ' +
  'echo "$2  $d/kyuch.deb" | sha256sum -c - >/dev/null; apt-get install -y "$d/kyuch.deb"';

function createUpdater({ api, current, publicKey, allowLocal = false }) {
  const urlOk = (u) => typeof u === 'string' && (u.startsWith('https://github.com/') || (allowLocal && u.startsWith('http://127.0.0.1:')));

  // Streams the body so progress can be reported; `signal` cancels the transfer.
  async function get(url, { json = false, max = MAX_BYTES, onProgress, signal } = {}) {
    const timeout = AbortSignal.timeout(10 * 60 * 1000);
    let res;
    try {
      res = await fetch(url, { headers: { Accept: json ? 'application/vnd.github+json' : 'application/octet-stream', 'User-Agent': 'Kyuch' }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (res.status === 404) throw new Error('No release has been published yet (or the repository is private).');
      if (!res.ok) throw new Error(`Server answered ${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
      if (total > max) throw new Error('Download is unexpectedly large');
      const chunks = [];
      let received = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > max) throw new Error('Download is unexpectedly large');
        chunks.push(value);
        onProgress?.(received, total);
      }
      const buf = Buffer.concat(chunks);
      return json ? JSON.parse(buf.toString('utf8')) : buf;
    } catch (e) {
      if (signal?.aborted) throw new Error('Download cancelled');
      throw e;
    }
  }

  async function check() {
    const rel = await get(api, { json: true, max: 5 * 1024 * 1024 });
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+/.test(latest)) throw new Error('The latest release has no version tag like v1.2.3');
    const deb = (rel.assets || []).find((a) => /^kyuch_[\w.+~-]+_amd64\.deb$/.test(a.name));
    const sig = deb && (rel.assets || []).find((a) => a.name === deb.name + '.sig');
    return {
      current, latest, newer: compare(latest, current) > 0, notes: String(rel.body || ''), page: rel.html_url || null,
      deb: deb ? { name: deb.name, url: deb.browser_download_url, size: deb.size } : null, sigUrl: sig ? sig.browser_download_url : null,
    };
  }

  // Downloads and verifies; returns {file, sha256}. Throws unless the signature matches the embedded key.
  async function download(info, { onProgress, signal } = {}) {
    if (!info?.newer) throw new Error('No newer version to install');
    if (!info.deb || !info.sigUrl) throw new Error('The release is missing its .deb or .sig file, so it cannot be verified');
    if (!urlOk(info.deb.url) || !urlOk(info.sigUrl)) throw new Error('Refusing to download from an unexpected address');
    const expected = info.deb.size || 0; // GitHub's own size, in case the CDN omits Content-Length
    const [data, sigText] = await Promise.all([
      get(info.deb.url, { signal, onProgress: (received, total) => onProgress?.(received, total || expected) }),
      get(info.sigUrl, { max: 4096, signal }),
    ]);
    const ok = crypto.verify(null, data, crypto.createPublicKey(publicKey), Buffer.from(sigText.toString('utf8').trim(), 'base64'));
    if (!ok) throw new Error('Signature check FAILED. The download was discarded and nothing was installed.');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyuch-update-')); // 0700
    const file = path.join(dir, info.deb.name);
    fs.writeFileSync(file, data, { mode: 0o600 });
    return { file, sha256: crypto.createHash('sha256').update(data).digest('hex') };
  }

  const install = ({ file, sha256 }) => new Promise((res, rej) =>
    execFile('pkexec', ['sh', '-c', ROOT_SCRIPT, 'sh', file, sha256], (e, _o, err) => (e ? rej(new Error(e.code === 126 || e.code === 127 ? 'Installation was cancelled' : (err || e.message).trim().split('\n').pop())) : res())));

  return { check, download, install };
}

module.exports = { createUpdater, compare, ROOT_SCRIPT };
