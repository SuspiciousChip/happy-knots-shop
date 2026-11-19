export const PARTIAL_COD_PERCENT = 30;
export const PARTIAL_COD_FEE_PAISE = 9000;

export function paymentPlanTotals(orderTotalPaise, plan) {
  if (!Number.isSafeInteger(orderTotalPaise) || orderTotalPaise < 1) throw new RangeError('Invalid order total');
  if (plan === 'full') return { plan, online_paise: orderTotalPaise, partial_cod_fee_paise: 0, balance_due_paise: 0, payable_total_paise: orderTotalPaise };
  if (plan !== 'partial_cod') return null;
  const advancePaise = Math.ceil(orderTotalPaise * PARTIAL_COD_PERCENT / 100);
  return {
    plan, online_paise: advancePaise + PARTIAL_COD_FEE_PAISE,
    partial_cod_fee_paise: PARTIAL_COD_FEE_PAISE,
    balance_due_paise: orderTotalPaise - advancePaise,
    payable_total_paise: orderTotalPaise + PARTIAL_COD_FEE_PAISE
  };
}
