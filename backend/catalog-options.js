export function checkoutSelection(submitted) {
  if (!Array.isArray(submitted) || submitted.length > 50) return null;
  const lines = new Map();
  const totals = new Map();
  for (const item of submitted) {
    if (!Number.isSafeInteger(item?.id) || item.id < 1 || !Number.isSafeInteger(item?.quantity) || item.quantity < 1 || item.quantity > 99 || typeof item.variant !== 'string' || item.variant.length > 80 || typeof item.personalisation !== 'string') return null;
    const key = JSON.stringify([item.id, item.variant, item.personalisation]);
    const quantity = (lines.get(key)?.quantity || 0) + item.quantity;
    const total = (totals.get(item.id) || 0) + item.quantity;
    if (quantity > 99 || total > 99) return null;
    lines.set(key, { id: item.id, variant: item.variant, personalisation: item.personalisation.trim(), quantity });
    totals.set(item.id, total);
  }
  return { lines: [...lines.values()], totals };
}
export function pricedLines(selected, selection) {
  const byId = new Map(selected.map(p => [p.id, p]));
  if (byId.size !== selection.totals.size) return null;
  const result = [];
  for (const line of selection.lines) {
    const product = byId.get(line.id);
    if (!product?.active || product.stock < selection.totals.get(line.id)) return null;
    const variants = Array.isArray(product.variants) ? product.variants : [];
    const variant = variants.find(v => v.code === line.variant);
    if (variants.length ? !variant : !!line.variant) return null;
    const requiresName = !!product.personalisation;
    if (requiresName ? !line.personalisation : !!line.personalisation) return null;
    const price = variant?.price_paise ?? product.price_paise;
    if (!Number.isSafeInteger(price) || price < 100) return null;
    result.push({ product_id: product.id, product_name: product.name, variant: line.variant, variant_label: variant?.label || '', personalisation: line.personalisation, unit_price_paise: price, quantity: line.quantity });
  }
  return result;
}

export function discountPercent(pricePaise, compareAtPaise) {
  if (!Number.isSafeInteger(pricePaise) || !Number.isSafeInteger(compareAtPaise) || compareAtPaise <= pricePaise || pricePaise < 0) return null;
  return Math.round(((compareAtPaise - pricePaise) / compareAtPaise) * 100);
}
