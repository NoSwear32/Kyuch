// The password generator. Used by the generator window (genwin.html: the dialog is shown as the page) and by the entry editor window
// ("Generate" opens it as a dialog and takes the password). Its markup is injected here so both pages share one definition.
document.body.insertAdjacentHTML('beforeend', `<dialog id="genDlg">
  <form method="dialog" id="genForm">
    <h2>Password generator</h2>
    <input id="gOut" class="mono" readonly aria-label="Generated password">
    <div id="gList" hidden></div>
    <div class="row"><meter id="gMeter" min="0" max="128" low="50" high="100" optimum="128" value="0"></meter><small id="gInfo" class="muted"></small></div>
    <label>Length
      <span class="row"><input type="range" id="gLen" min="8" max="128"><input type="number" id="gLenN" min="8" max="128" class="num"></span>
    </label>
    <div class="checks">
      <label class="check"><input type="checkbox" id="gLower"> a–z</label>
      <label class="check"><input type="checkbox" id="gUpper"> A–Z</label>
      <label class="check"><input type="checkbox" id="gDigits"> 0–9</label>
      <label class="check"><input type="checkbox" id="gSymbols"> Symbols</label>
    </div>
    <label>Symbols used <input id="gSyms" class="mono"></label>
    <label class="check"><input type="checkbox" id="gAmbig"> Exclude look-alikes (0 O 1 l I)</label>
    <label class="check"><input type="checkbox" id="gMulti"> Generate multiple passwords</label>
    <label id="gCountWrap" hidden>How many (2–30) <input type="number" id="gCount" min="2" max="30" class="num"></label>
    <p class="error" id="gErr"></p>
    <menu>
      <button type="button" id="gRegen">Regenerate</button>
      <button type="button" id="gCopy">Copy</button>
      <button value="cancel" formnovalidate>Close</button>
      <button value="ok" class="primary" id="gUse">Use password</button>
    </menu>
  </form>
</dialog>`);

// ---------- password generator dialog ----------
const GEN_KEY = 'kyuch.gen', MAX_MULTI = 30;
function genPrefs() {
  const d = { length: 20, lower: true, upper: true, digits: true, symbols: true, symbolSet: Gen.DEFAULT_SYMBOLS, noAmbiguous: false, multi: false, count: 5 };
  try { return { ...d, ...JSON.parse(localStorage.getItem(GEN_KEY) || '{}') }; } catch { return d; }
}
const clampCount = (v) => Math.min(MAX_MULTI, Math.max(2, Math.round(+v) || 5));
function wireGenerator() {
  const el = (id) => $(id);
  let useMode = false, current = []; // current = what is on screen, so Copy all matches it exactly
  const read = () => ({ length: +el('gLenN').value || 20, lower: el('gLower').checked, upper: el('gUpper').checked, digits: el('gDigits').checked,
    symbols: el('gSymbols').checked, symbolSet: el('gSyms').value, noAmbiguous: el('gAmbig').checked, multi: el('gMulti').checked, count: clampCount(el('gCount').value) });
  const copyText = (text, msg) => act(async () => { if (text) { await call('clip:copy', { text }); toast(msg); } });
  const row = (pw) => h('div', { class: 'genrow' },
    h('input', { class: 'mono', readonly: true, value: pw, 'aria-label': 'Generated password' }),
    h('button', { type: 'button', onclick: () => copyText(pw, 'Password copied') }, 'Copy'),
    useMode ? h('button', { type: 'button', class: 'primary', onclick: () => { el('gOut').value = pw; el('genDlg').close('ok'); } }, 'Use') : null);
  const regen = () => {
    const o = read();
    el('gCountWrap').hidden = !o.multi; el('gList').hidden = !o.multi; el('gOut').hidden = o.multi;
    el('gCopy').textContent = o.multi ? 'Copy all' : 'Copy';
    el('gUse').hidden = !useMode || o.multi; // in multi mode every row has its own Use button
    current = [];
    try {
      current = Array.from({ length: o.multi ? o.count : 1 }, () => Gen.generate(o)); el('gErr').textContent = '';
      try { localStorage.setItem(GEN_KEY, JSON.stringify(o)); } catch { /* prefs are optional */ }
    } catch (e) { el('gErr').textContent = e.message; }
    el('gOut').value = o.multi ? '' : (current[0] || '');
    el('gList').replaceChildren(...(o.multi ? current.map(row) : []));
    const bits = current.length ? Gen.entropy(o) : 0;
    el('gMeter').value = bits; el('gInfo').textContent = current.length ? `${Gen.label(bits)} · ${bits} bits each` : '';
  };
  const sync = (from, to) => el(from).addEventListener('input', () => { el(to).value = el(from).value; regen(); });
  sync('gLen', 'gLenN'); sync('gLenN', 'gLen');
  for (const id of ['gLower', 'gUpper', 'gDigits', 'gSymbols', 'gSyms', 'gAmbig', 'gMulti', 'gCount']) el(id).addEventListener('input', regen);
  // On blur just tidy the number (99 -> 30). Do NOT regenerate: the list already used the clamped count, and a regen here
  // would swap the rows out from under a click on a row's Copy/Use button.
  el('gCount').addEventListener('change', () => { el('gCount').value = clampCount(el('gCount').value); });
  el('gRegen').onclick = regen;
  el('gCopy').onclick = () => copyText(current.join('\n'), current.length > 1 ? `${current.length} passwords copied` : 'Password copied');
  return {
    open(useButton) {
      const p = genPrefs();
      useMode = useButton;
      el('gLen').value = el('gLenN').value = p.length;
      el('gLower').checked = p.lower; el('gUpper').checked = p.upper; el('gDigits').checked = p.digits; el('gSymbols').checked = p.symbols;
      el('gSyms').value = p.symbolSet; el('gAmbig').checked = p.noAmbiguous; el('gMulti').checked = p.multi; el('gCount').value = clampCount(p.count);
      regen();
    },
    wipe() { current = []; el('gOut').value = ''; el('gList').replaceChildren(); },
  };
}
let genCtl = null;
// Resolves with the password if one was chosen ("Use password" / a row's Use), otherwise null. Everything is wiped afterwards.
async function openGenerator(useButton) {
  genCtl ??= wireGenerator();
  genCtl.open(useButton);
  const ok = await show($('genDlg'));
  const pw = ok ? $('gOut').value : null;
  genCtl.wipe();
  return pw;
}

// The generator window: the dialog fills the page, and closing it closes the window.
if (document.body.classList.contains('genwin')) (async () => {
  try { applyTheme((await call('cfg:get')).theme); } catch { /* keep the default theme */ }
  genCtl = wireGenerator(); genCtl.open(false);
  const dlg = $('genDlg'), closeMe = () => dlg.close();
  dlg.addEventListener('close', () => { genCtl.wipe(); call('popup:close').catch(() => {}); });
  $('edX').onclick = closeMe;
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeMe());
  watchActivity();
  dlg.show();
})();
