const normalize = value => String(value || '').toLocaleLowerCase('en').normalize('NFKD').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

const related = {
  bag: ['bag', 'bags', 'handbag', 'purse', 'pouch', 'tote'],
  flower: ['flower', 'flowers', 'floral', 'bouquet', 'lotus', 'lily', 'lilies'],
  hanging: ['hanging', 'hangings', 'wall', 'door'],
  accessory: ['accessory', 'accessories', 'clothing', 'wearable']
};

function searchTerms(query) {
  const words = normalize(query).split(' ').filter(Boolean);
  return words.map(word => Object.values(related).find(group => group.includes(word)) || [word]);
}

export function searchProducts(items, query) {
  const terms = searchTerms(query);
  if (!terms.length) return items;
  return items.filter(product => {
    const text = normalize([product.name, product.description, ...(product.tags || [])].join(' '));
    return terms.every(group => group.some(term => text.includes(term)));
  });
}
