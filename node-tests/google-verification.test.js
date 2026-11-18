import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const verificationFile = new URL('../frontend/static/googlea51508c5e38f5282.html', import.meta.url);
const serverFile = new URL('../backend/server.js', import.meta.url);

test('Google Search Console verification token is served from the required root path', () => {
  assert.equal(
    fs.readFileSync(verificationFile, 'utf8').trim(),
    'google-site-verification: googlea51508c5e38f5282.html'
  );
  assert.match(
    fs.readFileSync(serverFile, 'utf8'),
    /app\.get\('\/googlea51508c5e38f5282\.html'/
  );
});
