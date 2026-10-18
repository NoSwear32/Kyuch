// Password generator: pure, Web Crypto only, no DOM. Also loaded by the unit tests via require().
const Gen = (() => {
  const DEFAULT_SYMBOLS = '!@#$%^&*-_=+?';
  const SETS = { lower: 'abcdefghijklmnopqrstuvwxyz', upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', digits: '0123456789' };
  const LOOKALIKES = /[0O1lI]/g;

  // Unbiased random integer in [0, n): rejection sampling avoids modulo bias.
  function rnd(n) {
    const a = new Uint32Array(1), lim = 2 ** 32 - (2 ** 32 % n);
    do crypto.getRandomValues(a); while (a[0] >= lim);
    return a[0] % n;
  }

  // One de-duplicated pool per enabled character class.
  function pools(o) {
    const strip = (s) => [...new Set(o.noAmbiguous ? s.replace(LOOKALIKES, '') : s)].join('');
    const out = [];
    for (const k of ['lower', 'upper', 'digits']) if (o[k]) out.push(strip(SETS[k]));
    if (o.symbols && (o.symbolSet ?? DEFAULT_SYMBOLS)) out.push(strip(o.symbolSet ?? DEFAULT_SYMBOLS));
    return out.filter(Boolean);
  }

  function generate(o) {
    const p = pools(o), len = Math.max(1, Math.floor(o.length));
    if (!p.length) throw new Error('Select at least one character type');
    if (len < p.length) throw new Error(`Length must be at least ${p.length}`);
    const all = [...new Set(p.join(''))];
    const out = p.map((s) => s[rnd(s.length)]); // guarantee one of every selected class
    while (out.length < len) out.push(all[rnd(all.length)]);
    for (let i = out.length - 1; i > 0; i--) { const j = rnd(i + 1); [out[i], out[j]] = [out[j], out[i]]; } // Fisher-Yates
    return out.join('');
  }

  const entropy = (o) => { const n = new Set(pools(o).join('')).size; return n > 1 ? Math.floor(o.length * Math.log2(n)) : 0; };
  const label = (bits) => (bits < 50 ? 'Weak' : bits < 70 ? 'Fair' : bits < 100 ? 'Good' : bits < 128 ? 'Strong' : 'Excellent');

  return { generate, entropy, label, pools, DEFAULT_SYMBOLS };
})();
if (typeof module !== 'undefined') module.exports = Gen;
