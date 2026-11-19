import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewDraft, reviewerDisplayName, reviewSummary } from '../backend/reviews.js';

test('reviews require a one-to-five rating and a meaningful comment', () => {
  assert.deepEqual(reviewDraft({ rating: '5', comment: '  Beautifully made and neatly finished.  ' }), { rating: 5, comment: 'Beautifully made and neatly finished.' });
  assert.equal(reviewDraft({ rating: '0', comment: 'Beautifully made and neatly finished.' }), null);
  assert.equal(reviewDraft({ rating: '5', comment: 'Nice' }), null);
  assert.equal(reviewDraft({ rating: '5', comment: 'x'.repeat(1001) }), null);
});

test('public reviewer names protect the customer surname', () => {
  assert.equal(reviewerDisplayName('Aryan Dixit'), 'Aryan D.');
  assert.equal(reviewerDisplayName('Rakhi'), 'Rakhi');
  assert.equal(reviewerDisplayName(''), 'Verified customer');
});

test('review summaries use only valid ratings', () => {
  assert.deepEqual(reviewSummary([{ rating: 5 }, { rating: 4 }, { rating: 9 }]), { count: 2, average: 4.5 });
  assert.deepEqual(reviewSummary([]), { count: 0, average: 0 });
});
