// Editor popup window: one entry or one folder. The main process hands over the data (editor:init); Save sends the result back
// (editor:save), which updates the database and closes this window. Cancel / the X / Esc just close it.
let ctx = null;                                   // what editor:init returned
const closeMe = () => call('editor:close').catch(() => {});

// ---------- icon picker ----------
// Resolves with {icon, customIcon}. Cancel, Esc and clicking outside all resolve with the unchanged value.
function pickIcon(cur) {
  return new Promise((res) => {
    const dlg = $('iconDlg');
    let done = false;
    const finish = (v) => { if (!done) { done = true; res(v); } dlg.close(); };
    $('iconGrid').replaceChildren(...ICONS.map((ic, i) => h('button', { type: 'button', class: !cur.customIcon && cur.icon === i ? 'on' : '', title: `#${i}`, onclick: () => finish({ icon: i, customIcon: null }) }, ic)));
    $('customGrid').replaceChildren(...Object.entries(ICON_MAP).map(([id, src]) =>
      h('button', { type: 'button', class: cur.customIcon === id ? 'on' : '', onclick: () => finish({ icon: cur.icon, customIcon: id }) }, h('img', { class: 'ico', src, alt: '' }))));
    $('iconAdd').onclick = () => act(async () => {
      const s = await call('icon:add');
      if (s) { ICON_MAP = s.icons || ICON_MAP; finish({ icon: cur.icon, customIcon: s.newIcon }); } // the new icon is applied straight away
    });
    dlg.addEventListener('close', () => finish(cur), { once: true });
    dlg.showModal();
  });
}
const iconButton = (btn, get, set) => {
  const paint = () => btn.replaceChildren(iconNode(get(), '🔑'));
  paint();
  btn.onclick = async () => { set(await pickIcon(get())); paint(); };
};

// ---------- one-time password (TOTP) tab ----------
let otpState = { uri: '', bad: false }, otpSeq = 0, otpExpires = 0, otpTimer = null, otpWasLink = false, otpTouched = false;

function setTab(name) {
  const otp = name === 'otp';
  $('panelDetails').hidden = otp; $('panelOtp').hidden = !otp;
  $('tabBtnDetails').setAttribute('aria-selected', String(!otp)); $('tabBtnOtp').setAttribute('aria-selected', String(otp));
}
$('tabBtnDetails').onclick = () => setTab('details');
$('tabBtnOtp').onclick = () => { setTab('otp'); $('oSecret').focus(); };
$('oShow').onclick = () => { const hidden = $('oSecret').type === 'password'; $('oSecret').type = hidden ? 'text' : 'password'; $('oShow').textContent = hidden ? 'Hide' : 'Show'; };

async function otpPreview() {
  const mine = ++otpSeq, input = $('oSecret').value.trim();
  const isLink = /^otpauth:/i.test(input);
  if (otpWasLink && !isLink) { $('oDigits').value = '6'; $('oPeriod').value = '30'; $('oAlg').value = 'SHA1'; } // link replaced by a bare secret: back to defaults
  otpWasLink = isLink;
  for (const id of ['oDigits', 'oPeriod', 'oAlg']) $(id).disabled = isLink; // a pasted link carries its own settings
  if (!input) { otpState = { uri: '', bad: false }; $('oBox').hidden = true; $('oErr').textContent = ''; return; }
  try {
    const r = await call('otp:preview', { input, digits: $('oDigits').value, period: $('oPeriod').value, algorithm: $('oAlg').value });
    if (mine !== otpSeq) return; // a newer keystroke already superseded this answer
    otpState = { uri: r.uri, bad: false }; $('oErr').textContent = '';
    $('oDigits').value = r.digits; $('oPeriod').value = r.period; $('oAlg').value = r.algorithm;
    $('oBox').hidden = false; $('oCode').textContent = fmtCode(r.code); $('oBar').max = r.period; otpExpires = r.validUntil; tickOtp();
  } catch (e) {
    if (mine !== otpSeq) return;
    otpState = { uri: '', bad: true }; $('oBox').hidden = true; $('oErr').textContent = e.message;
  }
}
function tickOtp() {
  if (!otpState.uri) return;
  const left = Math.max(0, (otpExpires - Date.now()) / 1000);
  $('oBar').value = left; $('oInfo').textContent = `New code in ${Math.ceil(left)} s`;
  if (left <= 0) { otpExpires = Infinity; otpPreview(); } // next time window: fetch the next code once
}
for (const id of ['oSecret', 'oDigits', 'oPeriod', 'oAlg']) $(id).addEventListener('input', () => { otpTouched = true; otpPreview(); });
$('oCopy').onclick = () => act(async () => { await call('clip:copy', { text: $('oCode').textContent.replace(' ', '') }); toast('One-time password copied'); });

// ---------- entry ----------
function startEntry() {
  const base = ctx.entry || { title: '', username: '', password: '', url: '', notes: '', icon: 0, tags: [], autoType: true, autoTypeSeq: '', otp: '' };
  $('entryForm').hidden = false; $('edSave').setAttribute('form', 'entryForm');
  $('edTitle').textContent = ctx.id ? 'Edit entry' : 'New entry';
  let ico = { icon: base.icon, customIcon: base.customIcon ?? null };
  iconButton($('eIcon'), () => ico, (v) => (ico = v));
  $('eTitle').value = base.title; $('eUser').value = base.username; $('ePass').value = base.password; $('ePass').type = 'password'; $('eShow').textContent = 'Show';
  $('eUrl').value = base.url; $('eNotes').value = base.notes; $('eTags').value = base.tags.join(', ');
  $('eAuto').checked = base.autoType; $('eSeq').value = base.autoTypeSeq;
  const inh = ctx.inheritedSeq;
  $('eSeq').placeholder = `Inherit: ${inh.value}${inh.from ? ` (from ${inh.from})` : ''}`;
  $('eShow').onclick = () => { const hidden = $('ePass').type === 'password'; $('ePass').type = hidden ? 'text' : 'password'; $('eShow').textContent = hidden ? 'Hide' : 'Show'; };
  $('eGen').onclick = async () => { const pw = await openGenerator(true); if (pw) { $('ePass').value = pw; $('ePass').type = 'text'; $('eShow').textContent = 'Hide'; } };
  setTab('details');
  $('oSecret').value = base.otp || ''; $('oSecret').type = 'password'; $('oShow').textContent = 'Show';
  $('oDigits').value = '6'; $('oPeriod').value = '30'; $('oAlg').value = 'SHA1'; $('oBox').hidden = true; $('oErr').textContent = '';
  otpTouched = false; otpState = { uri: base.otp || '', bad: false }; otpSeq++; otpWasLink = /^otpauth:/i.test(base.otp || '');
  if (base.otp) otpPreview(); else for (const k of ['oDigits', 'oPeriod', 'oAlg']) $(k).disabled = false;
  otpTimer = setInterval(tickOtp, 500);
  $('entryForm').onsubmit = async (e) => {
    e.preventDefault(); $('edErr').textContent = '';
    // An unusable one-time password must not be saved silently. (Stored data we cannot read, e.g. a Steam link, is left exactly as it is unless this tab is touched.)
    if (otpState.bad && otpTouched) { setTab('otp'); $('edErr').textContent = 'Fix the one-time password, or clear that field.'; return; }
    const p = {
      title: $('eTitle').value, username: $('eUser').value, password: $('ePass').value, url: $('eUrl').value.trim(), notes: $('eNotes').value, icon: ico.icon, customIcon: ico.customIcon,
      tags: $('eTags').value.split(',').map((t) => t.trim()).filter(Boolean), autoType: $('eAuto').checked, autoTypeSeq: $('eSeq').value.trim(),
      ...(otpTouched ? { otp: otpState.uri } : {}), // an untouched link is saved exactly as stored
    };
    await save(p);
  };
  $('eTitle').focus();
}

// ---------- folder (settings inherit from the parent folder) ----------
function startFolder() {
  const g = ctx.g, parentEff = ctx.parentEff, legacy = ctx.legacy;
  $('folderForm').hidden = false; $('edSave').setAttribute('form', 'folderForm');
  const inherited = (k) => (parentEff ? parentEff[k] : { value: ctx.defaults[k], from: null });
  const label = (k, fmt = (v) => v) => { const i = inherited(k); return `Inherit: ${fmt(i.value)} (${i.from ? 'from ' + i.from : 'default'})`; };
  const tri = (sel, k) => {
    const raw = g?.raw[k] ?? null;
    sel.replaceChildren(h('option', { value: '' }, label(k, yn)), h('option', { value: 'true' }, 'Yes'), h('option', { value: 'false' }, 'No'));
    sel.value = raw === null ? '' : String(raw);
  };
  let ico = { icon: g ? g.icon : 48, customIcon: g?.customIcon ?? null };
  $('edTitle').textContent = g ? 'Folder settings' : 'New folder';
  iconButton($('fIcon'), () => ico, (v) => (ico = v));
  $('fName').value = g ? g.name : ''; $('fNotes').value = g ? g.notes : '';
  tri($('sAuto'), 'autoType'); tri($('sSearch'), 'searching');
  for (const [el, k] of [[$('sSeq'), 'autoTypeSeq'], [$('sClip'), 'clipboardClear'], [$('sDelay'), 'typeDelay']]) {
    el.value = g?.raw[k] ?? ''; el.placeholder = label(k); el.disabled = legacy && k !== 'autoTypeSeq';
  }
  $('sNote').textContent = legacy ? 'Clipboard and keystroke settings need KDBX4 (this database is KDBX3).' : '';
  $('folderForm').onsubmit = async (e) => {
    e.preventDefault(); $('edErr').textContent = '';
    const num = (el) => (el.value === '' ? null : Number(el.value));
    const tv = (el) => (el.value === '' ? null : el.value === 'true');
    const settings = { autoType: tv($('sAuto')), searching: tv($('sSearch')), autoTypeSeq: $('sSeq').value.trim() };
    if (!legacy) Object.assign(settings, { clipboardClear: num($('sClip')), typeDelay: num($('sDelay')) });
    await save({ name: $('fName').value, notes: $('fNotes').value, icon: ico.icon, customIcon: ico.customIcon, settings });
  };
  $('fName').focus();
}

async function save(props) {
  $('edSave').disabled = true;
  try { await call('editor:save', { props }); } // on success the main process closes this window
  catch (err) { $('edErr').textContent = err.message; $('edSave').disabled = false; }
}

// ---------- boot ----------
(async function boot() {
  try { ctx = await call('editor:init'); } catch (e) { document.body.textContent = e.message; return; }
  applyTheme(ctx.cfg.theme);
  ICON_MAP = ctx.icons || {};
  $('edX').onclick = $('edCancel').onclick = closeMe;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) closeMe(); });
  // typing here counts as activity, so the idle auto-lock does not fire in the middle of an edit (throttled)
  let last = 0;
  for (const ev of ['keydown', 'mousedown']) document.addEventListener(ev, () => { if (Date.now() - last > 10_000) { last = Date.now(); call('app:activity').catch(() => {}); } }, { passive: true });
  ctx.kind === 'entry' ? startEntry() : startFolder();
})();
