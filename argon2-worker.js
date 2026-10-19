// Runs one Argon2 derivation off the main thread, so opening a database (or a hostile one with heavy settings) never freezes the window.
// core.js can terminate this worker if it takes too long. Input arrives in workerData; the key goes back as a message.
const { parentPort, workerData: j } = require('node:worker_threads');
const { argon2d, argon2id } = require('hash-wasm');

(j.type === 2 ? argon2id : argon2d)({
  password: j.password, salt: j.salt, parallelism: j.parallelism, iterations: j.iterations, memorySize: j.memory, hashLength: j.hashLength, outputType: 'binary',
}).then((out) => parentPort.postMessage({ ok: true, hash: out }), (e) => parentPort.postMessage({ ok: false, error: String(e && e.message || e) }));
