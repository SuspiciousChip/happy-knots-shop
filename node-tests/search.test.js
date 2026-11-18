import test from 'node:test';
import assert from 'node:assert/strict';
import { searchProducts } from '../backend/search.js';

const items = [
  { name: 'Pink crochet handbag', description: 'A handmade purse', tags: ['Personal Accessories & Clothing'] },
  { name: 'Lotus bouquet', description: 'Pink crochet flowers', tags: ['Home Decor'] },
  { name: 'Floral door hanging', description: 'Handmade hanging decoration', tags: ['Door Hangings'] }
];

test('searches products using common buyer words and plurals', () => {
  assert.deepEqual(searchProducts(items, 'bags').map(x => x.name), ['Pink crochet handbag']);
  assert.deepEqual(searchProducts(items, 'flowers').map(x => x.name), ['Lotus bouquet', 'Floral door hanging']);
  assert.deepEqual(searchProducts(items, 'door hanging').map(x => x.name), ['Floral door hanging']);
});

test('search requires all query words and does not change the full catalog', () => {
  assert.deepEqual(searchProducts(items, 'pink bag').map(x => x.name), ['Pink crochet handbag']);
  assert.deepEqual(searchProducts(items, '').map(x => x.name), items.map(x => x.name));
  assert.deepEqual(searchProducts(items, 'not-for-sale'), []);
});

test('owner supplied product keywords are searchable', () => {
  const products = [{ name: 'Crochet Decor', description: 'Handmade item', tags: ['Home Decor'], keywords: ['housewarming', 'gift'] }];
  assert.equal(searchProducts(products, 'housewarming').length, 1);
});
