import test from 'node:test';
import assert from 'node:assert/strict';
import { returnRequestDraft, RETURN_REASONS, RETURN_RESOLUTIONS } from '../backend/returns.js';

test('accepts a policy-aligned return request', () => {
  assert.deepEqual(returnRequestDraft({ item_index: '1', reason: 'damaged', resolution: 'replacement', details: 'The item arrived with visible damage.' }, 2),
    { item_index: 1, reason: 'damaged', resolution: 'replacement', details: 'The item arrived with visible damage.' });
});
test('rejects ineligible reasons and invalid item indexes', () => {
  assert.equal(returnRequestDraft({ item_index: '2', reason: 'changed_mind', resolution: 'refund', details: 'I simply changed my mind about this.' }, 2), null);
  assert.equal(RETURN_REASONS.changed_mind, undefined);
  assert.equal(RETURN_RESOLUTIONS.refund, 'Refund');
});
