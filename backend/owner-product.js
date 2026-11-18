const IMAGE_TYPES = {
  'image/jpeg': buffer => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
  'image/png': buffer => buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  'image/webp': buffer => buffer.length >= 12 && buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP'
};

function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max + 1) : '';
}

function pricePaise(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const raw = String(value).trim();
  if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(raw)) return null;
  const paise = Math.round(Number(raw) * 100);
  return Number.isSafeInteger(paise) && paise >= 100 ? paise : null;
}

export function decodeProductImage(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return null;
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 5 * 1024 * 1024 || !IMAGE_TYPES[match[1]]?.(buffer)) return null;
  return { contentType: match[1], buffer };
}

export function ownerProductDraft(body, categories) {
  const name = text(body?.name, 120);
  const description = text(body?.description, 2000);
  const category = text(body?.category, 80);
  const price_paise = pricePaise(body?.selling_price);
  const compare_at_paise = pricePaise(body?.regular_price);
  const rawImages = Array.isArray(body?.images) ? body.images : [];
  const images = rawImages.length >= 1 && rawImages.length <= 4 ? rawImages.map(decodeProductImage) : [];
  const keywords = text(body?.tags, 300).split(',').map(tag => tag.trim().toLowerCase()).filter(Boolean);
  const uniqueKeywords = [...new Set(keywords)];
  const colors = text(body?.colors, 500).split(',').map(color => color.trim()).filter(Boolean);
  const uniqueColors = colors.filter((color, index) => colors.findIndex(candidate => candidate.toLocaleLowerCase('en-IN') === color.toLocaleLowerCase('en-IN')) === index);
  if (name.length < 3 || description.length < 20 || !categories.includes(category) || !price_paise || !compare_at_paise || compare_at_paise <= price_paise || images.length !== rawImages.length || uniqueKeywords.length > 10 || uniqueKeywords.some(tag => tag.length > 30) || uniqueColors.length > 12 || uniqueColors.some(color => color.length > 40)) return null;
  return { name, description, category, price_paise, compare_at_paise, keywords: uniqueKeywords, colors: uniqueColors, images };
}
