import test from 'node:test';
import assert from 'node:assert/strict';
import { isOrderStatus, isOwner, OWNER_EMAILS } from '../backend/owner-access.js';

test('only the two approved verified customer emails are owners', () => {
  assert.equal(OWNER_EMAILS.size, 2);
  assert.equal(isOwner({ email: 'aryandixit2905@gmail.com' }), true);
  assert.equal(isOwner({ email: ' RAKHIDIXIT987@GMAIL.COM ' }), true);
  assert.equal(isOwner({ email: 'customer@example.com' }), false);
  assert.equal(isOwner(null), false);
});

test('owner order updates accept only known statuses', () => {
  assert.equal(isOrderStatus('making'), true);
  assert.equal(isOrderStatus('delivered'), true);
  assert.equal(isOrderStatus('refunded'), false);
  assert.equal(isOrderStatus({}), false);
});
