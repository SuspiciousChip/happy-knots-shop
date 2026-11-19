export const RETURN_REASONS = Object.freeze({
  damaged: 'Arrived damaged', defective: 'Defective or not usable', incorrect_item: 'Incorrect item received',
  not_as_described: 'Materially different from the listing', late_delivery: 'Qualifying late delivery'
});
export const RETURN_RESOLUTIONS = Object.freeze({ replacement: 'Replacement', refund: 'Refund' });
export const RETURN_STATUSES = Object.freeze(['submitted', 'under_review', 'approved', 'rejected', 'resolved']);

export function returnRequestDraft(body, itemCount) {
  const item_index = Number(body.item_index);
  const reason = String(body.reason || '');
  const resolution = String(body.resolution || '');
  const details = String(body.details || '').trim();
  if (!Number.isSafeInteger(item_index) || item_index < 0 || item_index >= itemCount ||
      !RETURN_REASONS[reason] || !RETURN_RESOLUTIONS[resolution] || details.length < 20 || details.length > 1500) return null;
  return { item_index, reason, resolution, details };
}

export const returnReasonLabel = reason => RETURN_REASONS[reason] || reason;
export const returnResolutionLabel = resolution => RETURN_RESOLUTIONS[resolution] || resolution;
