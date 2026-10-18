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
    else if (/^DELAY[ =]\d+$/.test(up)) out.push({ delay: Number(up.slice(6)) });
    else throw new Error(`Unknown auto-type placeholder {${tok}}`);
  }
  return out;
}

// Linux input keycodes. US layout is the base; other layouts override what differs.
const SHIFT = 42, ALTGR = 100;
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

function layout() {
  let out = '';
  try { out = execFileSync('gsettings', ['get', 'org.gnome.desktop.input-sources', 'sources'], { encoding: 'utf8' }); } catch { /* fall through */ }
  const name = (/'xkb',\s*'([a-z]+)/.exec(out) || [])[1] || 'us';
  if (!LAYOUTS[name]) throw new Error(`Auto-type does not support the "${name}" keyboard layout yet`);
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
    if (a.key) press([a.key === 'tab' ? 15 : 28]);
    else if (a.text) for (const c of a.text) {
      const keys = map.get(c);
      if (!keys) throw new Error(`Cannot auto-type the character "${c}" on this keyboard layout`);
      press(keys);
    }
  }
  return evs;
}

const helper = require('node:path').join(__dirname, 'uinput_type.py');
const run = (args) => new Promise((res, rej) => execFile('python3', [helper, ...args], (e, _o, err) => (e ? rej(new Error(err.trim().split('\n').pop() || e.message)) : res())));

// Types the actions into whatever window has focus. Validates everything before typing a single key.
// One helper call for the whole sequence: it creates a virtual keyboard, types, and removes it.
async function type(actions, delayMs) {
  if (process.platform !== 'linux') throw new Error('Auto-type is only implemented for Linux so far'); // ponytail: add win32 (SendInput) here
  const map = LAYOUTS[layout()];
  const tokens = actions.flatMap((a) => (a.delay ? [`sleep:${a.delay}`] : keyEvents([a], map).flatMap((e) => e.split(' '))));
  await run([String(delayMs), ...tokens]);
}

module.exports = { parse, keyEvents, type, LAYOUTS, layout };
