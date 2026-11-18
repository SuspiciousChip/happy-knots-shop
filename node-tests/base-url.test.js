import test from 'node:test';
import assert from 'node:assert/strict';
import { appBaseUrl } from '../backend/base-url.js';

test('production authentication always uses the public Happy Knots domain', () => {
  assert.equal(appBaseUrl({ NODE_ENV: 'production', APP_BASE_URL: 'https://happy-knots-shop.onrender.com' }), 'https://www.happyknots.shop');
});

test('local authentication keeps the configured development URL', () => {
  assert.equal(appBaseUrl({ NODE_ENV: 'development', APP_BASE_URL: 'http://localhost:5050' }), 'http://localhost:5050');
});
