// Auto-type: sequence parser (pure) + Linux typer (raw keycodes via /dev/uinput, see uinput_type.py).
const { execFile, execFileSync } = require('node:child_process');

// "{USERNAME}{TAB}{PASSWORD}{ENTER}" -> [{text}|{key}|{delay}], with entry fields substituted.
function parse(seq, fields) {
  const out = [];
  const text = (t) => { if (t) out.push({ text: t }); };
  for (let i = 0; i < seq.length;) {
    if (seq[i] !== '{') { text(seq[i++]); continue; }
    const end = seq.indexOf('}', i + 2); // i+2 so "{}}" style literals work: "{{}" -> "{", "{}}" -> "}"
    if (end < 0) throw new Error('Unclosed { in auto-type sequence');
    const tok = seq.slice(i + 1, end), up = tok.toUpperCase();
    i = end + 1;
    if (tok === '{') text('{');
    else if (tok === '}') { text('}'); }
    else if (up in fields) text(fields[up]);
    else if (up === 'TAB' || up === 'ENTER') out.push({ key: up.toLowerCase() });
    else if (up === 'SPACE') text(' ');
    else if (/^DELAY[ =]\d+$/.test(up)) out.push({ delay: Math.min(Number(up.slice(6)), 10_000) }); // 10 s is plenty; no way to cancel a day-long wait
    else throw new Error(`Unknown auto-type placeholder {${tok}}`);
  }
  return out;
}

// Linux input keycodes. US layout is the base; other layouts override what differs.
const SHIFT = 42, ALT = 56, ALTGR = 100;
const US = new Map();
for (const [code, plain, shifted] of [
  [2, '1234567890-=', '!@#$%^&*()_+'], [16, 'qwertyuiop[]', 'QWERTYUIOP{}'], [30, "asdfghjkl;'", 'ASDFGHJKL:"'],
  [44, 'zxcvbnm,./', 'ZXCVBNM<>?'], [41, '`', '~'], [43, '\\', '|'],
]) [...plain].forEach((c, i) => { US.set(c, [code + i]); US.set(shifted[i], [SHIFT, code + i]); });
US.set(' ', [57]);

const GB = new Map(US);
for (const c of '@"#~\\|') GB.delete(c);
for (const [c, keys] of Object.entries({ '"': [SHIFT, 3], '@': [SHIFT, 40], '£': [SHIFT, 4], '#': [43], '~': [SHIFT, 43],
  '\\': [86], '|': [SHIFT, 86], '€': [ALTGR, 5] })) GB.set(c, keys);
const LAYOUTS = { us: US, gb: GB };

// The layout that is ACTIVE right now (not just the first one configured). Only GNOME exposes it; anything else must be chosen in Settings.
function layout() {
  const get = (key) => execFileSync('gsettings', ['get', 'org.gnome.desktop.input-sources', key], { encoding: 'utf8', timeout: 3000 });
  let sources, current;
  try { sources = get('sources'); current = get('current'); } catch {
    throw new Error('Kyuch cannot read your keyboard layout here (only GNOME is detected automatically). Choose US or GB under Settings > Keyboard layout.');
  }
  const list = [...sources.matchAll(/\('xkb',\s*'([^']+)'\)/g)].map((m) => m[1]);
  const name = list[Number((/(\d+)/.exec(current) || [])[1]) || 0] ?? list[0] ?? 'us'; // "current" is an index into "sources"
  if (!LAYOUTS[name]) throw new Error(`Auto-type does not support the "${name}" keyboard layout. Choose US or GB under Settings > Keyboard layout if yours matches one of them.`);
  return name;
}

// -> list of key-event strings for `ydotool key`, e.g. "42:1 30:1 30:0 42:0"
function keyEvents(actions, map) {
  const evs = [];
  const press = (keys) => {
    const mods = keys.slice(0, -1), k = keys[keys.length - 1];
    evs.push(...mods.map((m) => `${m}:1`), `${k}:1`, `${k}:0`, ...mods.reverse().map((m) => `${m}:0`));
  };
  for (const a of actions) {
    if (a.key === 'alttab') press([ALT, 15]); // switch to the previous window
    else if (a.key) press([a.key === 'tab' ? 15 : 28]);
    else if (a.text) for (const c of a.text) {
      const keys = map.get(c);
      if (!keys) throw new Error(`Cannot auto-type the character "${c}" on this keyboard layout`);
      press(keys);
    }
  }
  return evs;
}

// Helpers live next to this file. Inside a packaged app.asar they must be read from the unpacked copy (external processes cannot open asar entries).
const path = require('node:path');
const unpacked = (f) => path.join(__dirname, f).replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

// Runs a helper process and feeds it `input` on stdin. Secrets must never be passed on a command line, which any process of the same user can read.
const runHelper = (cmd, args, input) => new Promise((resolve, reject) => {
  const child = execFile(cmd, args, { windowsHide: true }, (e, _o, err) => (e ? reject(new Error((err || '').trim().split('\n').pop() || e.message)) : resolve()));
  child.stdin.on('error', () => { /* the helper exited early; its exit status carries the error */ });
  child.stdin.end(input);
});

// Windows: Unicode text via SendInput (layout independent). Actions -> the JSON ops win_type.ps1 understands.
const winOps = (actions) => actions.map((a) => (a.delay !== undefined ? { t: 'sleep', ms: a.delay } : a.key ? { t: 'key', v: a.key } : { t: 'text', v: a.text }));
const winPayload = (actions, delayMs) => Buffer.from(JSON.stringify({ delay: delayMs, ops: winOps(actions) }), 'utf8').toString('base64');

// Types the actions into whatever window has focus. Validates everything before typing a single key.
// One helper call for the whole sequence: it creates a virtual keyboard (Linux) or sends input (Windows), types, and finishes.
async function type(actions, delayMs, { layout: forced } = {}) {
  if (process.platform === 'win32') {
    return runHelper('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', unpacked('win_type.ps1')], winPayload(actions, delayMs));
  }
  if (process.platform !== 'linux') throw new Error('Auto-type is only available on Linux and Windows');
  const map = LAYOUTS[forced && forced !== 'auto' ? forced : layout()];
  const tokens = actions.flatMap((a) => (a.delay ? [`sleep:${a.delay}`] : keyEvents([a], map).flatMap((e) => e.split(' '))));
  await runHelper('python3', [unpacked('uinput_type.py')], [String(delayMs), ...tokens].join('\n') + '\n');
}

module.exports = { parse, keyEvents, type, winOps, winPayload, LAYOUTS, layout };
