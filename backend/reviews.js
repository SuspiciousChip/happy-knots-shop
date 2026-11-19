export function reviewDraft(body) {
  const rating = Number(body?.rating);
  const comment = typeof body?.comment === 'string' ? body.comment.replace(/\s+/g, ' ').trim() : '';
  if (!Number.isSafeInteger(rating) || rating < 1 || rating > 5 || comment.length < 10 || comment.length > 1000) return null;
  return { rating, comment };
}

export function reviewerDisplayName(value) {
  const words = String(value || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return 'Verified customer';
  return words.length === 1 ? words[0].slice(0, 40) : `${words[0].slice(0, 30)} ${words.at(-1)[0].toUpperCase()}.`;
}

export function reviewSummary(rows) {
  const ratings = rows.map(row => Number(row.rating)).filter(rating => Number.isSafeInteger(rating) && rating >= 1 && rating <= 5);
  return { count: ratings.length, average: ratings.length ? Math.round((ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length) * 10) / 10 : 0 };
}
