import test from 'node:test';
import assert from 'node:assert/strict';
import { checkoutSelection, discountPercent, pricedLines } from '../backend/catalog-options.js';

const product = { id: 7, active: 1, stock: 3, name: 'Lotus set', price_paise: 49900, variants: [
  { code: 'set-2', label: 'Set of 2', price_paise: 49900 },
  { code: 'set-3', label: 'Set of 3', price_paise: 69900 }
] };

test('variant pricing and quantity are taken from the catalog', () => {
  const selection = checkoutSelection([{ id: 7, variant: 'set-2', personalisation: '', quantity: 1 }, { id: 7, variant: 'set-3', personalisation: '', quantity: 2 }]);
  assert.equal(selection.totals.get(7), 3);
  assert.deepEqual(pricedLines([product], selection).map(line => [line.variant_label, line.unit_price_paise, line.quantity]), [['Set of 2', 49900, 1], ['Set of 3', 69900, 2]]);
  assert.equal(pricedLines([product], checkoutSelection([{ id: 7, variant: 'fake', personalisation: '', quantity: 1 }])), null);
  assert.equal(pricedLines([product], checkoutSelection([{ id: 7, variant: 'set-2', personalisation: '', quantity: 4 }])), null);
});

test('personalized name is required and saved with the order line', () => {
  const named = { id: 8, active: 1, stock: 2, name: 'Name hanging', price_paise: 119900, personalisation: { label: 'Name for the hanging' } };
  const selection = checkoutSelection([{ id: 8, variant: '', personalisation: 'Sarth', quantity: 1 }]);
  assert.equal(pricedLines([named], selection)[0].personalisation, 'Sarth');
  assert.equal(pricedLines([named], checkoutSelection([{ id: 8, variant: '', personalisation: '', quantity: 1 }])), null);
  assert.equal(pricedLines([named], checkoutSelection([{ id: 8, variant: '', personalisation: 'A longer custom name', quantity: 1 }]))[0].personalisation, 'A longer custom name');
});

test('discount percentage is rounded from the genuine regular price', () => {
  assert.equal(discountPercent(19900, 39900), 50);
  assert.equal(discountPercent(16900, 24900), 32);
  assert.equal(discountPercent(49900, 69900), 29);
  assert.equal(discountPercent(49900, 49900), null);
  assert.equal(discountPercent(59900, 49900), null);
});
