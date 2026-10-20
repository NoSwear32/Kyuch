// Finds the web browsers installed on this machine and opens links in the one the user chose in Settings.
// Only browsers from this fixed table can be chosen, never an arbitrary command: a compromised page must not be able to pick a program to run.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// win: [environment variable holding the base folder, relative path]
const BROWSERS = [
  { id: 'chrome', label: 'Google Chrome', linux: ['google-chrome', 'google-chrome-stable'], win: [['ProgramFiles', 'Google\\Chrome\\Application\\chrome.exe'], ['ProgramFiles(x86)', 'Google\\Chrome\\Application\\chrome.exe'], ['LOCALAPPDATA', 'Google\\Chrome\\Application\\chrome.exe']] },
  { id: 'chromium', label: 'Chromium', linux: ['chromium', 'chromium-browser'], win: [] },
  { id: 'firefox', label: 'Mozilla Firefox', linux: ['firefox'], win: [['ProgramFiles', 'Mozilla Firefox\\firefox.exe'], ['ProgramFiles(x86)', 'Mozilla Firefox\\firefox.exe']] },
  { id: 'edge', label: 'Microsoft Edge', linux: ['microsoft-edge', 'microsoft-edge-stable'], win: [['ProgramFiles(x86)', 'Microsoft\\Edge\\Application\\msedge.exe'], ['ProgramFiles', 'Microsoft\\Edge\\Application\\msedge.exe']] },
  { id: 'brave', label: 'Brave', linux: ['brave-browser', 'brave'], win: [['ProgramFiles', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'], ['LOCALAPPDATA', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe']] },
  { id: 'vivaldi', label: 'Vivaldi', linux: ['vivaldi', 'vivaldi-stable'], win: [['LOCALAPPDATA', 'Vivaldi\\Application\\vivaldi.exe'], ['ProgramFiles', 'Vivaldi\\Application\\vivaldi.exe']] },
  { id: 'opera', label: 'Opera', linux: ['opera'], win: [['LOCALAPPDATA', 'Programs\\Opera\\opera.exe'], ['ProgramFiles', 'Opera\\opera.exe']] },
  { id: 'epiphany', label: 'GNOME Web', linux: ['epiphany', 'epiphany-browser'], win: [] },
];
const IDS = new Set(['system', ...BROWSERS.map((b) => b.id)]);
const isExecutable = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };

// -> [{id, label, path}] for the browsers that are installed
function detect({ platform = process.platform, env = process.env, exists = isExecutable } = {}) {
  const found = [];
  for (const b of BROWSERS) {
    let hit = null;
    if (platform === 'win32') {
      for (const [root, rel] of b.win) if (env[root] && !hit && exists(path.win32.join(env[root], rel))) hit = path.win32.join(env[root], rel);
    } else {
      const dirs = [...(env.PATH || '').split(':').filter(Boolean), '/snap/bin']; // snap browsers live here even when PATH misses it
      for (const name of b.linux) for (const d of dirs) if (!hit && exists(path.posix.join(d, name))) hit = path.posix.join(d, name);
    }
    if (hit) found.push({ id: b.id, label: b.label, path: hit });
  }
  return found;
}

// Opens `url` (http/https only) in the chosen browser, or the system default if "system" is chosen or that browser is gone.
// The URL is passed as ONE argument, never through a shell, so characters like ; & $( ) in it are inert.
async function openUrl(url, browserId, shell, detectOpts) {
  if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs can be opened');
  const chosen = browserId && browserId !== 'system' ? detect(detectOpts).find((b) => b.id === browserId) : null;
  if (!chosen) return shell.openExternal(url);
  await new Promise((resolve, reject) => {
    const child = spawn(chosen.path, [url], { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  }).catch(() => shell.openExternal(url)); // the browser would not start: fall back to the default one
}

module.exports = { BROWSERS, IDS, detect, openUrl };
