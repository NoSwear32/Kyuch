// Settings window. Apply saves the app settings (and a new master password, if one was typed) and closes the window;
// the main window picks the changes up from the cfg:changed / state:changed events.
const closeMe = () => call('popup:close').catch(() => {});

(async function boot() {
  let cfg, s, info, list;
  try { [cfg, s, info, list] = await Promise.all([call('cfg:get'), call('state'), call('app:info'), call('browsers:list')]); } catch (e) { document.body.textContent = e.message; return; }
  applyTheme(cfg.theme);
  $('edX').onclick = $('edCancel').onclick = closeMe;
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeMe());
  watchActivity();

  $('aLock').value = cfg.autoLockMin; $('aDelay').value = cfg.altTabDelayMs; $('aAutoUpd').checked = cfg.autoUpdateCheck !== false;
  $('aTray').checked = cfg.closeToTray !== false; $('aTrayLock').checked = cfg.lockOnTray !== false; $('aConfirmRm').checked = cfg.confirmRemoveDb !== false;
  $('aPwBox').hidden = !s;                                    // the master password belongs to an open database
  $('dbInfo').hidden = !s; if (s) $('dbInfo').textContent = `${s.name} — ${s.path} — KDBX${s.legacy ? 3 : 4}`;
  $('aLayoutWrap').hidden = info.platform === 'win32'; $('aLayout').value = cfg.keyboardLayout || 'auto';
  $('aBrowser').replaceChildren(...list.map((b) => h('option', { value: b.id }, b.label)));
  $('aBrowser').value = list.some((b) => b.id === cfg.browser) ? cfg.browser : 'system';

  const paintAccess = (st) => {
    $('aAccessBox').hidden = !st.supported;
    if (!st.supported) return;
    $('aAccessText').textContent = st.writable
      ? (st.ours ? 'Enabled. Auto-type may emulate a keyboard.' : 'Enabled by a rule outside Kyuch (nothing to change here).')
      : 'Off. Auto-type needs permission to emulate a keyboard (/dev/uinput). While this is on, every program you run can type into any window, so it is off until you allow it.';
    $('aAccessBtn').hidden = !st.canChange || (st.writable && !st.ours);
    $('aAccessBtn').textContent = st.writable ? 'Withdraw permission…' : 'Allow auto-type…';
    $('aAccessBtn').onclick = () => act(async () => { paintAccess(await call('autotype:setAccess', { enable: !st.writable })); });
  };
  paintAccess(await call('autotype:status'));

  let chosen = cfg.theme || 'system';
  const cards = THEMES.map((t) => h('button', { type: 'button', class: 'theme-card', 'data-theme': t.id, role: 'radio', onclick: () => { chosen = t.id; applyTheme(chosen); mark(); } },
    h('span', {}, t.label), t.id === 'system' ? null : h('span', { class: 'chips' }, h('i'), h('i'), h('i'))));
  const mark = () => cards.forEach((c) => c.setAttribute('aria-checked', String(c.dataset.theme === chosen)));
  $('aThemes').replaceChildren(...cards); mark(); // clicking a card previews it live (in this window until Apply)

  $('settingsForm').onsubmit = async (e) => {
    e.preventDefault(); $('aErr').textContent = '';
    // A typo in a new master password would lock the user out of their own database: make them type it twice, like when creating one.
    if ($('aNewPw').value !== $('aNewPw2').value) { $('aErr').textContent = 'The two master passwords do not match.'; return; }
    $('edSave').disabled = true;
    try {
      await call('cfg:set', {
        autoLockMin: $('aLock').value, altTabDelayMs: $('aDelay').value, theme: chosen, autoUpdateCheck: $('aAutoUpd').checked, keyboardLayout: $('aLayout').value,
        closeToTray: $('aTray').checked, lockOnTray: $('aTrayLock').checked, confirmRemoveDb: $('aConfirmRm').checked, browser: $('aBrowser').value,
      });
      if (s && $('aNewPw').value) {
        await call('db:changePassword', { password: $('aNewPw').value });
        $('aNewPw').value = $('aNewPw2').value = '';
        toast('Master password changed'); setTimeout(closeMe, 900); return;
      }
      closeMe();
    } catch (err) { $('aErr').textContent = err.message; $('edSave').disabled = false; }
  };
})();
