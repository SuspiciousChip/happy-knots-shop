export const OWNER_EMAILS = new Set([
  'aryandixit2905@gmail.com',
  'rakhidixit987@gmail.com'
]);

export const ORDER_STATUSES = ['new', 'confirmed', 'making', 'ready', 'shipped', 'delivered', 'cancelled'];

export function isOwner(customer) {
  return typeof customer?.email === 'string' && OWNER_EMAILS.has(customer.email.trim().toLowerCase());
}

export function isOrderStatus(value) {
  return typeof value === 'string' && ORDER_STATUSES.includes(value);
}
