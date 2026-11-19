import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentPlanTotals, PARTIAL_COD_FEE_PAISE } from '../backend/payment-plans.js';
test('full online payment has no extra charge or delivery balance', () => assert.deepEqual(paymentPlanTotals(100000, 'full'), { plan: 'full', online_paise: 100000, partial_cod_fee_paise: 0, balance_due_paise: 0, payable_total_paise: 100000 }));
test('partial COD collects 30 percent and ₹90 online, leaving 70 percent for delivery', () => { assert.equal(PARTIAL_COD_FEE_PAISE, 9000); assert.deepEqual(paymentPlanTotals(100000, 'partial_cod'), { plan: 'partial_cod', online_paise: 39000, partial_cod_fee_paise: 9000, balance_due_paise: 70000, payable_total_paise: 109000 }); });
test('unknown payment plans are rejected', () => assert.equal(paymentPlanTotals(100000, 'cod'), null));
