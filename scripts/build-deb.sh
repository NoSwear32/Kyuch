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
# Runtime hardening baked into the binary: nobody can turn it into a plain Node interpreter (ELECTRON_RUN_AS_NODE), attach an inspector
# (--inspect) or inject code through NODE_OPTIONS by editing the launcher or the environment.
node node_modules/@electron/fuses/dist/bin.js write --app "$OPT/kyuch" RunAsNode=off EnableNodeOptionsEnvironmentVariable=off EnableNodeCliInspectArguments=off > /dev/null
rm -f "$OPT/resources/default_app.asar"
find "$OPT/locales" -name '*.pak' ! -name 'en-US.pak' ! -name 'en-GB.pak' ! -name 'de.pak' -delete

# 2. The app + production-only node_modules
mkdir -p "$APP"
cp -a main.js preload.js core.js argon2-worker.js totp.js autotype.js updater.js update-key.pub uinput_type.py icon.png package.json package-lock.json renderer "$APP/"
(cd "$APP" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null && rm -f package-lock.json)

# 3. Launcher, desktop entry, icons, udev rule, docs
mkdir -p "$STAGE/usr/bin" "$STAGE/usr/share/applications" "$STAGE/usr/share/doc/kyuch" "$STAGE/DEBIAN"
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
# Auto-type types through /dev/uinput. Access is NOT granted by default (that would let every program of the user type into any window):
# the user enables it in Settings, which runs this script as root through pkexec under the polkit policy below.
mkdir -p "$STAGE/usr/lib/kyuch" "$STAGE/usr/share/polkit-1/actions"
install -m 755 scripts/autotype-access.sh "$STAGE/usr/lib/kyuch/autotype-access"
install -m 644 scripts/com.noswear.kyuch.autotype.policy "$STAGE/usr/share/polkit-1/actions/com.noswear.kyuch.autotype.policy"
printf 'Kyuch %s\nCopyright (c) NoSwear32. All rights reserved.\nBundles Electron (MIT) and Chromium; see /opt/Kyuch/LICENSE and LICENSES.chromium.html.\n' "$VER" > "$STAGE/usr/share/doc/kyuch/copyright"

# 4. Permissions + control files (policy: nothing group/world-writable; sandbox must be setuid root)
chmod -R go-w "$STAGE"
chmod 4755 "$OPT/chrome-sandbox"
cat > "$STAGE/DEBIAN/postinst" <<'POST'
#!/bin/sh
set -e
chmod 4755 /opt/Kyuch/chrome-sandbox || true
# remove the pre-0.6 package's always-on udev rule if an upgrade left it behind
rm -f /usr/lib/udev/rules.d/60-kyuch-uinput.rules
exit 0
POST
chmod 755 "$STAGE/DEBIAN/postinst"
cat > "$STAGE/DEBIAN/prerm" <<'PRERM'
#!/bin/sh
set -e
# withdraw the auto-type permission (if the user enabled it) when Kyuch is removed
case "$1" in remove|purge) /usr/lib/kyuch/autotype-access disable 2>/dev/null || true ;; esac
exit 0
PRERM
chmod 755 "$STAGE/DEBIAN/prerm"
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
