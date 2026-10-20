const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detect, openUrl, IDS } = require('../browsers');

const mkdir = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'kyuch-br-'));
const script = (dir, name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return p; };

test('detects installed browsers on Linux (PATH) and Windows (known folders)', () => {
  const dir = mkdir(); script(dir, 'firefox', 'true'); script(dir, 'google-chrome-stable', 'true'); fs.writeFileSync(path.join(dir, 'brave-browser'), 'not executable', { mode: 0o644 });
  const linux = detect({ platform: 'linux', env: { PATH: dir + ':/nonexistent' } });
  assert.deepEqual(linux.map((b) => b.id), ['chrome', 'firefox']);                    // brave is not executable, so it is not offered
  assert.equal(linux[1].path, path.join(dir, 'firefox'));
  const have = new Set(['C:\\Program Files\\Mozilla Firefox\\firefox.exe', 'C:\\Users\\me\\AppData\\Local\\Vivaldi\\Application\\vivaldi.exe']);
  const win = detect({ platform: 'win32', env: { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, exists: (p) => have.has(p) });
  assert.deepEqual(win.map((b) => b.id), ['firefox', 'vivaldi']);
  assert.ok(IDS.has('system') && IDS.has('firefox') && !IDS.has('sh'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the URL reaches the browser as one inert argument (no shell involved)', async () => {
  const dir = mkdir(), out = path.join(dir, 'args.txt'), pwned = path.join(dir, 'pwned');
  script(dir, 'firefox', `printf '%s\\n' "$@" > "${out}"`);
  const url = `https://example.com/a b?x=1&y=$(touch ${pwned})&z=;touch ${pwned}#\`touch ${pwned}\``;
  await openUrl(url, 'firefox', { openExternal: () => assert.fail('must not fall back') }, { platform: 'linux', env: { PATH: dir } });
  for (let i = 0; i < 50 && !fs.existsSync(out); i++) await new Promise((r) => setTimeout(r, 40));
  assert.equal(fs.readFileSync(out, 'utf8'), url + '\n');
  assert.ok(!fs.existsSync(pwned), 'nothing in the URL was executed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('falls back to the system browser: "system", an uninstalled choice, a broken browser, and rejects non-http URLs', async () => {
  const dir = mkdir(); script(dir, 'chromium', 'exit 1');
  const opened = []; const shell = { openExternal: (u) => { opened.push(u); } };
  const opts = { platform: 'linux', env: { PATH: dir } };
  await openUrl('https://a.example/', 'system', shell, opts);
  await openUrl('https://b.example/', 'firefox', shell, opts);                        // chosen but not installed
  assert.deepEqual(opened, ['https://a.example/', 'https://b.example/']);
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://x/', '-new-window https://x']) await assert.rejects(openUrl(bad, 'system', shell, opts), /Only http/);
  fs.rmSync(dir, { recursive: true, force: true });
});
