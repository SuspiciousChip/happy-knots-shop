import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeProductImage, ownerProductDraft } from '../backend/owner-product.js';

const jpeg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString('base64')}`;
const categories = ['Home Decor', 'Wall Hangings'];

test('owner product listing validates prices, tags and image signatures', () => {
  const draft = ownerProductDraft({ name: 'Crochet Test Flower', description: 'A handmade crochet flower for gifting.', category: 'Home Decor', selling_price: '499', regular_price: '699', tags: 'flower, Gift, flower', colors: 'Red, Blue, red, Olive Green', images: [jpeg] }, categories);
  assert.equal(draft.price_paise, 49900);
  assert.equal(draft.compare_at_paise, 69900);
  assert.deepEqual(draft.keywords, ['flower', 'gift']);
  assert.deepEqual(draft.colors, ['Red', 'Blue', 'Olive Green']);
  assert.equal(draft.images[0].contentType, 'image/jpeg');
});

test('owner product listing rejects fake images and misleading price order', () => {
  const fake = `data:image/jpeg;base64,${Buffer.from('not an image').toString('base64')}`;
  assert.equal(decodeProductImage(fake), null);
  assert.equal(ownerProductDraft({ name: 'Crochet Test Flower', description: 'A handmade crochet flower for gifting.', category: 'Home Decor', selling_price: '699', regular_price: '499', images: [jpeg] }, categories), null);
  assert.equal(ownerProductDraft({ name: 'Crochet Test Flower', description: 'A handmade crochet flower for gifting.', category: 'Home Decor', selling_price: '499', regular_price: '699', colors: Array.from({ length: 13 }, (_, index) => `Colour ${index}`).join(','), images: [jpeg] }, categories), null);
});
