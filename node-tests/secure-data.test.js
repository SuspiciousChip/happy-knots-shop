import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptValue, decryptValue } from '../backend/secure-data.js';

test('encrypted values round-trip and are purpose-bound', () => {
  const key = 'a'.repeat(64);
  const encrypted = encryptValue('sensitive-token', key, 'refresh-token');
  assert.notEqual(encrypted, 'sensitive-token');
  assert.equal(decryptValue(encrypted, key, 'refresh-token'), 'sensitive-token');
  assert.throws(() => decryptValue(encrypted, key, 'owner-mfa'));
});

test('tampering is rejected', () => {
  const key = 'b'.repeat(64);
  const encrypted = encryptValue('secret', key, 'test');
  assert.throws(() => decryptValue(encrypted.slice(0, -1) + 'A', key, 'test'));
});
