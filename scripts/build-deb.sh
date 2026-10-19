#!/usr/bin/env bash
# Builds dist/kyuch_<version>_amd64.deb with plain dpkg-deb (no electron-builder / fpm needed).
set -euo pipefail
cd "$(dirname "$0")/.."
VER=$(node -p "require('./package.json').version")
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
chmod 755 "$STAGE"  # mktemp makes it 0700; that would become the mode of / in the package
OPT="$STAGE/opt/Kyuch"
APP="$OPT/resources/app"

# 1. Electron runtime (renamed), minus things we don't ship
mkdir -p "$OPT"
cp -a node_modules/electron/dist/. "$OPT/"
mv "$OPT/electron" "$OPT/kyuch"
rm -f "$OPT/resources/default_app.asar"
find "$OPT/locales" -name '*.pak' ! -name 'en-US.pak' ! -name 'en-GB.pak' ! -name 'de.pak' -delete

# 2. The app + production-only node_modules
mkdir -p "$APP"
cp -a main.js preload.js core.js totp.js autotype.js updater.js update-key.pub uinput_type.py icon.png package.json package-lock.json renderer "$APP/"
(cd "$APP" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null && rm -f package-lock.json)

# 3. Launcher, desktop entry, icons, udev rule, docs
mkdir -p "$STAGE/usr/bin" "$STAGE/usr/share/applications" "$STAGE/usr/lib/udev/rules.d" "$STAGE/usr/share/doc/kyuch" "$STAGE/DEBIAN"
printf '#!/bin/sh\nexec /opt/Kyuch/kyuch "$@"\n' > "$STAGE/usr/bin/kyuch"
chmod 755 "$STAGE/usr/bin/kyuch"
cat > "$STAGE/usr/share/applications/kyuch.desktop" <<DESK
[Desktop Entry]
Name=Kyuch
Comment=KeePass-compatible password manager
Exec=/usr/bin/kyuch
Icon=kyuch
Terminal=false
Type=Application
Categories=Utility;Security;
StartupWMClass=Kyuch
Keywords=password;vault;keepass;kdbx;
DESK
for n in 16 32 48 64 128 256 512; do
  d="$STAGE/usr/share/icons/hicolor/${n}x${n}/apps"; mkdir -p "$d"; cp "brand/png/icon-$n.png" "$d/kyuch.png"
done
# auto-type types through /dev/uinput; give the logged-in desktop user (and nobody else) access to it
echo 'KERNEL=="uinput", SUBSYSTEM=="misc", TAG+="uaccess", OPTIONS+="static_node=uinput"' > "$STAGE/usr/lib/udev/rules.d/60-kyuch-uinput.rules"
printf 'Kyuch %s\nCopyright (c) NoSwear32. All rights reserved.\nBundles Electron (MIT) and Chromium; see /opt/Kyuch/LICENSE and LICENSES.chromium.html.\n' "$VER" > "$STAGE/usr/share/doc/kyuch/copyright"

# 4. Permissions + control files (policy: nothing group/world-writable; sandbox must be setuid root)
chmod -R go-w "$STAGE"
chmod 4755 "$OPT/chrome-sandbox"
cat > "$STAGE/DEBIAN/postinst" <<'POST'
#!/bin/sh
set -e
chmod 4755 /opt/Kyuch/chrome-sandbox || true
if command -v udevadm >/dev/null 2>&1; then
  udevadm control --reload 2>/dev/null || true
  udevadm trigger --name-match=uinput 2>/dev/null || true
fi
exit 0
POST
chmod 755 "$STAGE/DEBIAN/postinst"
SIZE=$(du -sk "$STAGE" | cut -f1)
cat > "$STAGE/DEBIAN/control" <<CTRL
Package: kyuch
Version: $VER
Section: utils
Priority: optional
Architecture: amd64
Installed-Size: $SIZE
Depends: libgtk-3-0 | libgtk-3-0t64, libnotify4, libnss3, libxss1, libxtst6, xdg-utils, libatspi2.0-0 | libatspi2.0-0t64, libuuid1, libgbm1, libasound2 | libasound2t64, python3
Maintainer: NoSwear32 <noreply@users.noreply.github.com>
Description: Kyuch - KeePass-compatible password manager
 Stores passwords in standard KDBX4 databases (openable in KeePassXC and
 KeePass2Android). Nested folders with inherited settings, icons, comments,
 URLs, a password generator, dark mode and auto-type.
CTRL

mkdir -p dist
dpkg-deb --root-owner-group -Zxz -z6 --build "$STAGE" "dist/kyuch_${VER}_amd64.deb"
ls -lh "dist/kyuch_${VER}_amd64.deb"
