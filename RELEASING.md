# Releasing Kyuch (what the About > Check for updates button reads)

The app asks GitHub for the **latest release** of the repo set in `UPDATE_API` (top of `main.js`), compares its tag
(`v0.3.1`) with the running version, and if newer downloads the `.deb` + `.deb.sig`, verifies the ed25519 signature
against `update-key.pub` (built into the app), then installs with `pkexec apt-get install` (a polkit password prompt).

## One-time
- `node scripts/sign-release.js --init` was already run. The private key is `~/.config/kyuch-release/ed25519.pem`.
  **Back it up and never commit it.** Lose it and installed apps will refuse every future update (you would have to
  reinstall once by hand with a build containing a new `update-key.pub`).
- The releases must be readable **without logging in** (GitHub answers 404 to anonymous requests for a private repo):
  either make this repo public, or create a small public repo (e.g. `NoSwear32/Kyuch-releases`), publish the releases
  there, and change `UPDATE_API` in `main.js` to `https://api.github.com/repos/NoSwear32/Kyuch-releases/releases/latest`.

## Every release
1. Bump the version: `npm version minor --no-git-tag-version` (or edit `package.json`).
2. `npm test && npm run deb` -> `dist/kyuch_<version>_amd64.deb`
3. `node scripts/sign-release.js dist/kyuch_<version>_amd64.deb` -> `dist/kyuch_<version>_amd64.deb.sig`
4. Commit + push, then on GitHub: Releases > Draft a new release > tag `v<version>` > attach **both** the `.deb` and
   the `.deb.sig` > Publish.
5. In an older installed Kyuch: About > Check for updates.

## Windows release
Build on any machine that can run electron-builder (this repo builds it from Linux; `wine` embeds the exe icon):
1. `npm run dist:win` -> `dist-win/Kyuch-Setup-<version>.exe` (installer, per-user, no admin rights needed) and `dist-win/Kyuch-<version>-win.zip` (portable).
2. `node scripts/sign-release.js dist-win/Kyuch-Setup-<version>.exe` -> `Kyuch-Setup-<version>.exe.sig`
3. Attach `Kyuch-Setup-<version>.exe`, `Kyuch-Setup-<version>.exe.sig` (and optionally the zip) to the SAME GitHub release as the Linux files.
   The Windows updater only looks for `Kyuch-Setup-*.exe` + `.sig`; the Linux updater only for `kyuch_*_amd64.deb` + `.sig`.
Windows notes: the installer is not code-signed (no certificate), so SmartScreen shows "Unknown publisher" on first run.
Auto-type on Windows types Unicode through SendInput (it cannot type into windows running as administrator).

## Auto-type permission on Linux (changed in 0.6.0)
The package no longer grants access to /dev/uinput on install (that let every program of the user type into any window).
Settings > "Auto-type permission" runs `/usr/lib/kyuch/autotype-access enable` through pkexec (polkit policy
`com.noswear.kyuch.autotype-access`), which writes `/etc/udev/rules.d/60-kyuch-uinput.rules`; "Withdraw permission" removes it, and so does removing the package.
A rule created by hand elsewhere (e.g. the user's own /etc/udev/rules.d/60-uinput.rules) keeps working and is reported as "enabled by a rule outside Kyuch".

## Build prerequisites for releases
`npm run deb` needs dpkg-deb; `npm run dist:win` needs network access to GitHub for the Electron Windows runtime and electron-builder's helper tools
(if a download stalls, fetch the file with curl and place it in ~/.cache/electron, see the checksum in node_modules/electron/checksums.json).
Always run `npm ci` before building a release so the package contains exactly the locked dependencies.
