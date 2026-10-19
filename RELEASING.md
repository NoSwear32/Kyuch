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
