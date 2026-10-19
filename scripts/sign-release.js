#!/usr/bin/env node
// usage: node scripts/sign-release.js --init          one-time: make the signing key (private key stays OUTSIDE the repo)
//        node scripts/sign-release.js dist/kyuch_X.deb   writes dist/kyuch_X.deb.sig for the GitHub release
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const keyFile = path.join(os.homedir(), '.config', 'kyuch-release', 'ed25519.pem');
const arg = process.argv[2];

if (arg === '--init') {
  if (fs.existsSync(keyFile)) { console.error('Signing key already exists at ' + keyFile + ' (not overwriting).'); process.exit(1); }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(path.join(__dirname, '..', 'update-key.pub'), publicKey.export({ type: 'spki', format: 'pem' }));
  console.log('Private key: ' + keyFile + '  (BACK THIS UP; never commit it)\nPublic key:  update-key.pub  (commit this; it ships inside the app)');
} else if (arg) {
  const data = fs.readFileSync(arg);
  const sig = crypto.sign(null, data, crypto.createPrivateKey(fs.readFileSync(keyFile)));
  fs.writeFileSync(arg + '.sig', sig.toString('base64') + '\n');
  console.log('Wrote ' + arg + '.sig');
} else { console.error('usage: sign-release.js --init | <file.deb>'); process.exit(1); }
