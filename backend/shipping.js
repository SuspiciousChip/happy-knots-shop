export const FREE_SHIPPING_THRESHOLD_PAISE = 100000;
export const STANDARD_SHIPPING_PAISE = 8000;

export function shippingPaise(subtotalPaise) {
  if (!Number.isSafeInteger(subtotalPaise) || subtotalPaise < 0) throw new RangeError('Invalid subtotal');
  return subtotalPaise >= FREE_SHIPPING_THRESHOLD_PAISE ? 0 : STANDARD_SHIPPING_PAISE;
}
