// The theme list, shared by the page (Settings picker, dark/light toggle) and main.js (native dialogs follow `dark`).
// Colours live in style.css under :root[data-theme="<id>"]; keep the two in sync (test/themes.test.js checks it).
const THEMES = [
  { id: 'system', label: 'System' },
  { id: 'dark', label: 'Dark', dark: true },
  { id: 'light', label: 'Light', dark: false },
  { id: 'ocean', label: 'Ocean', dark: true },
  { id: 'forest', label: 'Forest', dark: true },
  { id: 'amethyst', label: 'Amethyst', dark: true },
  { id: 'sand', label: 'Sand', dark: false },
  { id: 'blossom', label: 'Blossom', dark: false },
];
if (typeof module !== 'undefined') module.exports = { THEMES };
