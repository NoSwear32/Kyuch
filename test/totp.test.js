const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, build, code, base32Encode, base32Decode } = require('../totp');

// RFC 6238 appendix B test vectors (8 digits). Each hash uses a key of its own length.
const K1 = '12345678901234567890', K256 = '12345678901234567890123456789012', K512 = '1234567890123456789012345678901234567890123456789012345678901234';
const at = (alg, key, t) => code(parse(base32Encode(Buffer.from(key)), { digits: 8, algorithm: alg }), t * 1000).code;

test('RFC 6238 vectors', () => {
  const cases = [[59, '94287082', '46119246', '90693936'], [1111111109, '07081804', '68084774', '25091201'], [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'], [2000000000, '69279037', '90698825', '38618901'], [20000000000, '65353130', '77737706', '47863826']];
  for (const [t, s1, s256, s512] of cases) {
    assert.equal(at('SHA1', K1, t), s1, 'sha1 ' + t); assert.equal(at('SHA256', K256, t), s256, 'sha256 ' + t); assert.equal(at('SHA512', K512, t), s512, 'sha512 ' + t);
  }
});

test('base32 round trip and tolerant input', () => {
  const buf = Buffer.from('Hello, Kyuch!');
  assert.ok(base32Decode(base32Encode(buf)).equals(buf));
  assert.ok(base32Decode('jbsw y3dp-ehpk 3pxp==').equals(base32Decode('JBSWY3DPEHPK3PXP')));
  assert.throws(() => base32Decode('JBSWY3DP1'), /A–Z and the digits 2–7/);
  assert.throws(() => base32Decode('   '), /Enter the secret/);
});

test('window boundaries and countdown', () => {
  const c = parse('JBSWY3DPEHPK3PXP');
  const a = code(c, 59_000), b = code(c, 60_000);
  assert.equal(a.validUntil, 60_000); assert.equal(a.remaining, 1); assert.equal(b.remaining, 30);
  assert.notEqual(a.code, b.code); assert.match(a.code, /^\d{6}$/);
});

test('otpauth link: parse, build, defaults and errors', () => {
  const c = parse('otpauth://totp/Example:alice%40x.com?secret=JBSWY3DPEHPK3PXP&issuer=Example&digits=8&period=60&algorithm=SHA256');
  assert.deepEqual([c.digits, c.period, c.algorithm, c.issuer, c.label], [8, 60, 'SHA256', 'Example', 'Example:alice@x.com']);
  const again = parse(build(c));
  assert.deepEqual([again.secret, again.digits, again.period, again.algorithm, again.issuer], [c.secret, 8, 60, 'SHA256', 'Example']);
  assert.match(build(parse('JBSWY3DPEHPK3PXP')), /^otpauth:\/\/totp\/Kyuch\?secret=JBSWY3DPEHPK3PXP&period=30&digits=6&algorithm=SHA1$/);
  assert.throws(() => parse('otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1'), /time-based/);
  assert.throws(() => parse('otpauth://totp/x?digits=6'), /Enter the secret/);
  assert.throws(() => parse('JBSWY3DPEHPK3PXP', { digits: 9 }), /Digits/);
  assert.throws(() => parse('JBSWY3DPEHPK3PXP', { period: 1 }), /period/);
  assert.throws(() => parse('JBSWY3DPEHPK3PXP', { algorithm: 'MD5' }), /Algorithm/);
});
