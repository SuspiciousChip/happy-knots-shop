import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INDIAN_STATES_AND_UTS, parseAddress, isCompleteAddress, formatAddress } from '../backend/address.js';

const valid = { label: 'Home', name: 'Customer', phone: '+91 9876543210', address_line1: 'Flat 2, Main Road', address_line2: 'Near park, Jaipur', state: 'Rajasthan', pincode: '302001' };

test('Indian delivery address keeps two lines, state, and leading PIN code digits', () => {
  assert.equal(INDIAN_STATES_AND_UTS.length, 36);
  assert.deepEqual(parseAddress(valid), valid);
  assert.equal(formatAddress(valid), 'Flat 2, Main Road\nNear park, Jaipur\nRajasthan – 302001');
  assert.equal(isCompleteAddress(valid), true);
  assert.equal(parseAddress({ ...valid, address_line2: '' }).address_line2, '');
});

test('rejects missing and malformed delivery details', () => {
  for (const changed of [
    { state: 'Unknown' }, { state: '' }, { pincode: '30201' }, { pincode: '002001' },
    { pincode: '30200x' }, { address_line1: '' }, { phone: '123' }
  ]) assert.equal(parseAddress({ ...valid, ...changed }), null);
  assert.equal(isCompleteAddress({ address: 'Old address' }), false);
});
