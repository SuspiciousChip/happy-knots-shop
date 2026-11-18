import test from 'node:test';
import assert from 'node:assert/strict';
import { generateTotpSecret, totpCode, totpUri, verifyTotp } from '../backend/owner-mfa.js';

test('TOTP accepts the current code and a small clock skew', () => {
  const secret = generateTotpSecret();
  const time = 1700000000000;
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.equal(verifyTotp(secret, totpCode(secret, time), time), true);
  assert.equal(verifyTotp(secret, totpCode(secret, time - 30000), time), true);
  assert.equal(verifyTotp(secret, '12345', time), false);
});

test('TOTP URI contains the issuer and encoded owner identity', () => {
  const uri = totpUri('ABCDEFGHIJKLMNOP234567', 'Owner+Shop@example.com');
  assert.match(uri, /^otpauth:\/\/totp\/Happy%20Knots%3Aowner%2Bshop%40example\.com\?/);
  assert.match(uri, /issuer=Happy%20Knots/);
});
