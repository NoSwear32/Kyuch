// Vault logic on top of kdbxweb. No Electron here so it can be tested headless.
// Passwords never leave this module except through secret()/getEntry().
const fs = require('node:fs');
const kdbxweb = require('kdbxweb');
const { argon2d, argon2id } = require('hash-wasm');
const totp = require('./totp');
const { ProtectedValue, KdbxUuid } = kdbxweb;

// Electron's BoringSSL has no crypto.argon2, so use WASM (memory is in KiB for both APIs).
kdbxweb.CryptoEngine.setArgon2Impl(async (pw, salt, memory, iterations, hashLength, parallelism, type, version) => {
  if (version !== 0x13) throw new Error('Argon2 v1.0 databases are not supported');
  const hash = type === 2 ? argon2id : argon2d;
  const out = await hash({ password: new Uint8Array(pw), salt: new Uint8Array(salt), parallelism, iterations, memorySize: memory, hashLength, outputType: 'binary' });
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
});

// Final fallback when no folder up the chain sets a value.
const DEFAULTS = { autoType: true, searching: true, autoTypeSeq: '{USERNAME}{TAB}{PASSWORD}{ENTER}', clipboardClear: 12, typeDelay: 12 };
const NUM_KEYS = ['clipboardClear', 'typeDelay']; // stored in group customData (KDBX4 only)

const rawSetting = (g, key) => {
  if (key === 'autoType') return g.enableAutoType ?? null;
  if (key === 'searching') return g.enableSearching ?? null;
  if (key === 'autoTypeSeq') return g.defaultAutoTypeSeq || null;
  const v = (g.customData?.get('kyuch.' + key) ?? g.customData?.get('keeper.' + key))?.value; // keeper.* = pre-rename databases
  return v === undefined || v === '' ? null : Number(v);
};

// Walk up from the folder; first folder that sets the key wins.
function resolve(group, key) {
  for (let g = group; g; g = g.parentGroup) {
    const value = rawSetting(g, key);
    if (value !== null) return { value, from: g.name };
  }
  return { value: DEFAULTS[key], from: null };
}

const resolveAll = (group) => Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, resolve(group, k)]));

function writeSettings(g, s) {
  if ('autoType' in s) g.enableAutoType = s.autoType;
  if ('searching' in s) g.enableSearching = s.searching;
  if ('autoTypeSeq' in s) g.defaultAutoTypeSeq = s.autoTypeSeq || '';
  for (const k of NUM_KEYS) {
    if (!(k in s)) continue;
    g.customData ??= new Map();
    g.customData.delete('keeper.' + k);
    if (s[k] === null || s[k] === '' || s[k] === undefined) g.customData.delete('kyuch.' + k);
    else g.customData.set('kyuch.' + k, { value: String(Math.max(0, Math.round(Number(s[k])))) });
  }
}

// kdbxweb's defaults (1 MiB, 2 passes) are far too weak; use 64 MiB / 3 passes / 2 lanes.
function hardenKdf(db) {
  const p = db.header.kdfParameters, T = kdbxweb.VarDictionary.ValueType;
  if (!p || p.get('M') === undefined) return; // AES-KDF (legacy) is replaced by upgrade()
  p.set('M', T.UInt64, new kdbxweb.Int64(64 * 1024 * 1024));
  p.set('I', T.UInt64, new kdbxweb.Int64(3));
  p.set('P', T.UInt32, 2);
}

const str = (v) => (v instanceof ProtectedValue ? v.getText() : v || '');

class Vault {
  constructor(db, path) { this.db = db; this.path = path; this.dirty = false; }

  static async create(path, password, name = 'Kyuch') {
    const db = kdbxweb.Kdbx.create(new kdbxweb.Credentials(ProtectedValue.fromString(password)), name);
    db.upgrade(); // KDBX4 + Argon2 + custom data support
    hardenKdf(db);
    db.createRecycleBin();
    const v = new Vault(db, path);
    await v.save();
    return v;
  }

  static async open(path, password) {
    const buf = fs.readFileSync(path);
    const cred = new kdbxweb.Credentials(ProtectedValue.fromString(password));
    const db = await kdbxweb.Kdbx.load(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), cred);
    return new Vault(db, path);
  }

  get legacy() { return this.db.versionMajor < 4; }
  upgrade() { this.db.upgrade(); hardenKdf(this.db); this.dirty = true; }

  async save(path = this.path) {
    this.db.cleanup({ customIcons: true }); // drop uploaded icons nothing uses any more
    const data = Buffer.from(await this.db.save());
    const tmp = path + '.tmp';
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, path); // atomic: a crash mid-write can't corrupt the existing file
    this.path = path;
    this.dirty = false;
  }

  async changePassword(password) {
    await this.db.credentials.setPassword(ProtectedValue.fromString(password));
    this.db.meta.masterKeyChanged = new Date();
    this.dirty = true;
  }

  // ---- custom icons (stored in the database, so other KeePass apps show them too) ----
  addIcon(png, name = 'icon') {
    const id = KdbxUuid.random();
    const data = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength);
    this.db.meta.customIcons.set(id.id, { data, name, lastModified: new Date() });
    this.dirty = true;
    return id.id;
  }
  icons() {
    return Object.fromEntries([...this.db.meta.customIcons].map(([id, i]) => [id, 'data:image/png;base64,' + Buffer.from(i.data).toString('base64')]));
  }
  _setIcon(item, p) {
    if (p.icon !== undefined) item.icon = p.icon;
    if (p.customIcon === undefined) return;
    if (p.customIcon && !this.db.meta.customIcons.has(p.customIcon)) throw new Error('Icon not found');
    item.customIcon = p.customIcon ? new KdbxUuid(p.customIcon) : undefined;
  }

  // ---- lookup ----
  get root() { return this.db.getDefaultGroup(); }
  get bin() { return this.db.meta.recycleBinUuid && this.db.getGroup(this.db.meta.recycleBinUuid); }
  group(id) { const g = this.db.getGroup(id); if (!g) throw new Error('Folder not found'); return g; }
  entry(id) {
    for (const e of this.root.allEntries()) if (e.uuid.id === id) return e;
    throw new Error('Entry not found');
  }
  inBin(item) { const b = this.bin; for (let g = item; g; g = g.parentGroup) if (g === b) return true; return false; }

  // ---- renderer-safe view (no passwords) ----
  tree() {
    const bin = this.bin;
    const walk = (g) => {
      const eff = resolveAll(g);
      return {
        id: g.uuid.id, name: g.name, icon: g.icon ?? 48, customIcon: g.customIcon?.id ?? null, notes: g.notes || '', isBin: g === bin,
        raw: Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, rawSetting(g, k)])),
        effective: eff,
        entries: g.entries.map((e) => ({
          id: e.uuid.id, title: str(e.fields.get('Title')), username: str(e.fields.get('UserName')),
          url: str(e.fields.get('URL')), notes: str(e.fields.get('Notes')), icon: e.icon ?? 0, customIcon: e.customIcon?.id ?? null,
          tags: e.tags, hasOtp: e.fields.has('otp'), searchable: eff.searching.value,
          autoType: e.autoType.enabled, autoTypeSeq: e.autoType.defaultSequence || '',
        })),
        groups: g.groups.map(walk),
      };
    };
    return walk(this.root);
  }

  // ---- folders ----
  addGroup(parentId, { name, icon, customIcon, notes, settings }) {
    const g = this.db.createGroup(this.group(parentId), name || 'New folder');
    this._setIcon(g, { icon, customIcon });
    g.notes = notes || '';
    writeSettings(g, settings || {});
    this.dirty = true;
    return g.uuid.id;
  }

  updateGroup(id, { name, icon, customIcon, notes, settings }) {
    const g = this.group(id);
    if (name !== undefined) g.name = name;
    this._setIcon(g, { icon, customIcon });
    if (notes !== undefined) g.notes = notes;
    if (settings) writeSettings(g, settings);
    g.times.update();
    this.dirty = true;
  }

  deleteGroup(id) {
    const g = this.group(id);
    if (g === this.root || g === this.bin) throw new Error('This folder cannot be deleted');
    this.db.remove(g); // moves to recycle bin; deleting from the bin is permanent
    this.dirty = true;
  }

  move(id, toId) {
    const to = this.group(toId);
    const item = this.db.getGroup(id) || this.entry(id);
    if (item === this.root || item === this.bin) throw new Error('This folder cannot be moved');
    if (item.entries) for (let g = to; g; g = g.parentGroup) if (g === item) throw new Error('Cannot move a folder into itself');
    this.db.move(item, to);
    this.dirty = true;
  }

  // ---- entries ----
  addEntry(groupId, props) {
    const e = this.db.createEntry(this.group(groupId));
    this._fill(e, props);
    return e.uuid.id;
  }

  updateEntry(id, props) {
    const e = this.entry(id);
    e.pushHistory();
    this._fill(e, props);
    e.times.update();
  }

  _fill(e, p) {
    const set = { title: 'Title', username: 'UserName', url: 'URL', notes: 'Notes' };
    for (const [k, f] of Object.entries(set)) if (p[k] !== undefined) e.fields.set(f, p[k]);
    if (p.password !== undefined) e.fields.set('Password', ProtectedValue.fromString(p.password));
    this._setIcon(e, p);
    if (p.tags !== undefined) e.tags = p.tags;
    if (p.otp !== undefined) { // otpauth:// link in the protected 'otp' field, as KeePassXC does
      if (p.otp) { totp.parse(p.otp); e.fields.set('otp', ProtectedValue.fromString(p.otp)); } else e.fields.delete('otp');
    }
    if (p.autoType !== undefined) e.autoType.enabled = !!p.autoType;
    if (p.autoTypeSeq !== undefined) e.autoType.defaultSequence = p.autoTypeSeq || undefined;
    this.dirty = true;
  }

  deleteEntry(id) { this.db.remove(this.entry(id)); this.dirty = true; }

  // Full entry including the password, for the edit dialog only.
  getEntry(id) {
    const e = this.entry(id);
    return { id, title: str(e.fields.get('Title')), username: str(e.fields.get('UserName')), password: str(e.fields.get('Password')),
      url: str(e.fields.get('URL')), notes: str(e.fields.get('Notes')), icon: e.icon ?? 0, customIcon: e.customIcon?.id ?? null, tags: e.tags, otp: str(e.fields.get('otp')),
      autoType: e.autoType.enabled, autoTypeSeq: e.autoType.defaultSequence || '' };
  }

  secret(id, field) { return str(this.entry(id).fields.get(field)); }

  // Current one-time code for an entry, or null if it has none. Throws a readable error if the stored data is unusable.
  otpInfo(id, now = Date.now()) {
    const raw = this.secret(id, 'otp');
    if (!raw) return null;
    try { return totp.code(totp.parse(raw), now); } catch (e) { throw new Error('Unsupported one-time password data: ' + e.message); }
  }

  // Everything auto-type needs for one entry, with inherited settings resolved.
  typeInfo(id) {
    const e = this.entry(id);
    const eff = resolveAll(e.parentGroup);
    return {
      enabled: e.autoType.enabled && eff.autoType.value,
      seq: e.autoType.defaultSequence || eff.autoTypeSeq.value,
      delay: eff.typeDelay.value,
      fields: { USERNAME: this.secret(id, 'UserName'), PASSWORD: this.secret(id, 'Password'), URL: this.secret(id, 'URL'),
        TITLE: this.secret(id, 'Title'), NOTES: this.secret(id, 'Notes'), OTP: this.otpInfo(id)?.code ?? '' },
    };
  }

  clipboardClear(id) { return resolve(this.entry(id).parentGroup, 'clipboardClear').value; }
}

module.exports = { Vault, DEFAULTS, resolve, resolveAll };
