import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyRecaptcha } from '../backend/recaptcha.js';

test('requires a token and matching hostname before accepting verification', async () => {
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls++;
    assert.equal(options.body.get('secret'), 'private-key');
    assert.equal(options.body.get('response'), 'token');
    return { ok: true, json: async () => ({ success: true, hostname: 'www.happyknots.shop' }) };
  };
  assert.equal(await verifyRecaptcha('', { secret: 'private-key', hostname: 'www.happyknots.shop', fetchImpl }), false);
  assert.equal(calls, 0);
  assert.equal(await verifyRecaptcha('token', { secret: 'private-key', hostname: 'wrong.example', fetchImpl }), false);
  assert.equal(await verifyRecaptcha('token', { secret: 'private-key', hostname: 'www.happyknots.shop', fetchImpl }), true);
});

test('fails closed when Google rejects or cannot verify the token', async () => {
  const args = { secret: 'private-key', hostname: 'www.happyknots.shop' };
  assert.equal(await verifyRecaptcha('token', { ...args, fetchImpl: async () => ({ ok: true, json: async () => ({ success: false }) }) }), false);
  assert.equal(await verifyRecaptcha('token', { ...args, fetchImpl: async () => { throw new Error('offline'); } }), false);
});
