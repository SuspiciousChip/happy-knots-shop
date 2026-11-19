export const SITE_URL = 'https://www.happyknots.shop';
export const SITE_NAME = 'The Happy Knots';
export const SITE_DESCRIPTION = 'Shop handmade crochet gifts, yarn flowers, bags and home decor by Rakhi Dixit. Every piece is made to order and delivered across India in 10–15 days.';
export const SITE_UPDATED = '2026-11-19';
export const CONTACT_EMAIL = 'h4appy.knots.official@gmail.com';
export const INSTAGRAM_URL = 'https://www.instagram.com/the_happy_knots_by_rakhi/';
export const JOURNAL_PATH = '/journal/handmade-crochet-gift-guide';

export const FAQS = [
  { question: 'Are The Happy Knots products handmade?', answer: 'Yes. Rakhi Dixit makes every crochet piece by hand after the customer places an order.' },
  { question: 'How long does delivery take?', answer: 'Made-to-order products are usually delivered within 10–15 days.' },
  { question: 'How can I pay for my order?', answer: 'The shop currently accepts cash on delivery.' },
  { question: 'How much does shipping cost?', answer: 'Shipping is free for orders of ₹1,000 or more. Orders below ₹1,000 have an ₹80 shipping charge.' }
];

const absoluteUrl = value => !value ? `${SITE_URL}/static/assets/happy-knots-logo.webp` : value.startsWith('http') ? value : `${SITE_URL}${value}`;
const xml = value => String(value ?? '').replace(/[<>&"']/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character]);

export function seoFor(pathname, data = {}) {
  const privatePage = /^(?:\/account|\/checkout|\/owner|\/payments|\/orders)(?:\/|$)/.test(pathname);
  const product = data.product;
  let title = 'The Happy Knots | Handmade Crochet Gifts & Decor';
  let description = SITE_DESCRIPTION;
  let canonicalPath = pathname === '/' ? '/' : pathname.replace(/\/$/, '');
  let type = 'website';
  let image = '/static/assets/featured/pink-crochet-bag.webp';

  if (pathname === '/shop') {
    title = 'Shop Handmade Crochet Products | The Happy Knots';
    description = 'Browse made-to-order crochet bags, rakhi, yarn flower bouquets, door torans, accessories and handmade home decor by Rakhi Dixit.';
  } else if (pathname === '/about') {
    title = 'Our Story | The Happy Knots';
    description = 'Meet Rakhi Dixit, the maker and founder of The Happy Knots, and Aryan Dixit, who leads the handmade crochet shop online.';
    image = '/static/assets/about/rakhi-dixit.webp';
  } else if (pathname === '/contact') {
    title = 'Contact The Happy Knots';
    description = 'Contact The Happy Knots for order support, handmade product questions and general enquiries.';
  } else if (pathname === '/shipping') {
    title = 'Shipping Policy | The Happy Knots';
    description = 'Made-to-order delivery takes 10–15 days. Shipping is free from ₹1,000; otherwise it costs ₹80.';
  } else if (pathname === '/returns') {
    title = 'Returns and Refunds | The Happy Knots';
    description = 'Read the returns, cancellations and refund policy for handmade orders from The Happy Knots.';
  } else if (pathname === '/privacy') {
    title = 'Privacy Policy | The Happy Knots';
    description = 'Learn how The Happy Knots collects, uses and protects customer information.';
  } else if (pathname === '/terms') {
    title = 'Terms and Conditions | The Happy Knots';
    description = 'Read the terms for ordering handmade crochet products from The Happy Knots.';
  } else if (pathname === JOURNAL_PATH) {
    title = 'Handmade Crochet Gift Guide for Every Occasion | The Happy Knots';
    description = 'Find thoughtful handmade crochet gift ideas in India, from personalised name hangings and yarn bouquets to bags, rakhis and festive home decor.';
    image = '/static/assets/featured/lotus-crochet-flowers.webp';
  } else if (product) {
    title = `${product.name} | The Happy Knots`;
    description = String(product.description || `Shop ${product.name}, handmade by The Happy Knots.`).slice(0, 160);
    type = 'product';
    image = product.image;
  }

  return {
    meta_title: title,
    meta_description: description,
    canonical_url: `${SITE_URL}${canonicalPath || '/'}`,
    og_type: type,
    og_image: absoluteUrl(image),
    noindex: privatePage,
    site_updated: SITE_UPDATED
  };
}

export const organizationSchema = () => ({
  '@type': 'Organization', '@id': `${SITE_URL}/#organization`, name: SITE_NAME, alternateName: 'Happy Knots', url: SITE_URL,
  logo: { '@type': 'ImageObject', url: `${SITE_URL}/static/assets/happy-knots-logo.webp` },
  founder: { '@type': 'Person', name: 'Rakhi Dixit' },
  sameAs: [INSTAGRAM_URL],
  contactPoint: { '@type': 'ContactPoint', email: CONTACT_EMAIL, contactType: 'customer service', areaServed: 'IN', availableLanguage: ['English', 'Hindi'] },
  hasMerchantReturnPolicy: { '@type': 'MerchantReturnPolicy', '@id': `${SITE_URL}/#organization-return-policy`, applicableCountry: 'IN', returnPolicyCategory: 'https://schema.org/MerchantReturnNotPermitted', merchantReturnLink: `${SITE_URL}/returns` }
});

export const websiteSchema = () => ({
  '@type': 'WebSite', '@id': `${SITE_URL}/#website`, url: SITE_URL, name: SITE_NAME, alternateName: 'Happy Knots',
  description: SITE_DESCRIPTION, publisher: { '@id': `${SITE_URL}/#organization` }, dateModified: SITE_UPDATED,
  potentialAction: { '@type': 'SearchAction', target: `${SITE_URL}/shop?q={search_term_string}`, 'query-input': 'required name=search_term_string' }
});

export const faqSchema = () => ({
  '@type': 'FAQPage', mainEntity: FAQS.map(item => ({ '@type': 'Question', name: item.question, acceptedAnswer: { '@type': 'Answer', text: item.answer } }))
});

export const productSchema = (product, reviewData = {}) => ({
  '@type': 'Product', '@id': `${SITE_URL}/products/${product.id}#product`, name: product.name,
  description: product.description, image: (product.images?.length ? product.images : [product.image]).filter(Boolean).map(absoluteUrl),
  category: product.tags?.[0] || 'Handmade crochet', sku: product.sku || `HK-${product.id}`,
  color: (product.variants || []).map(item => item.label).filter(Boolean), material: 'Crochet yarn',
  brand: { '@type': 'Brand', name: SITE_NAME },
  ...(reviewData.summary?.count ? {
    aggregateRating: { '@type': 'AggregateRating', ratingValue: reviewData.summary.average, reviewCount: reviewData.summary.count, bestRating: 5, worstRating: 1 },
    review: (reviewData.reviews || []).slice(0, 20).map(item => ({ '@type': 'Review', author: { '@type': 'Person', name: item.display_name }, datePublished: String(item.created_at || '').slice(0, 10), reviewRating: { '@type': 'Rating', ratingValue: item.rating, bestRating: 5, worstRating: 1 }, reviewBody: item.comment }))
  } : {}),
  offers: {
    '@type': 'Offer', url: `${SITE_URL}/products/${product.id}`, priceCurrency: 'INR',
    price: (Number(product.price_paise || 0) / 100).toFixed(2),
    availability: product.stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
    itemCondition: 'https://schema.org/NewCondition', seller: { '@id': `${SITE_URL}/#organization` }, priceValidUntil: '2027-12-31', hasMerchantReturnPolicy: { '@id': `${SITE_URL}/#organization-return-policy` },
    shippingDetails: { '@type': 'OfferShippingDetails', shippingRate: { '@type': 'MonetaryAmount', value: '80.00', currency: 'INR' }, shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'IN' }, deliveryTime: { '@type': 'ShippingDeliveryTime', handlingTime: { '@type': 'QuantitativeValue', minValue: 7, maxValue: 12, unitCode: 'DAY' }, transitTime: { '@type': 'QuantitativeValue', minValue: 3, maxValue: 3, unitCode: 'DAY' } } }
  }
});

export const breadcrumbSchema = product => ({
  '@type': 'BreadcrumbList', itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL },
    { '@type': 'ListItem', position: 2, name: 'Shop', item: `${SITE_URL}/shop` },
    { '@type': 'ListItem', position: 3, name: product.name, item: `${SITE_URL}/products/${product.id}` }
  ]
});

export function robotsText() {
  return ['User-agent: *', 'Allow: /', 'Disallow: /owner', 'Disallow: /account', 'Disallow: /checkout', 'Disallow: /orders', 'Disallow: /payments', '', `Sitemap: ${SITE_URL}/sitemap.xml`, ''].join('\n');
}

export function sitemapXml(products) {
  const pages = ['/', '/shop', '/about', JOURNAL_PATH, '/contact', '/shipping', '/returns', '/privacy', '/terms'];
  const entries = [...pages.map(path => ({ loc: `${SITE_URL}${path}`, priority: path === '/' ? '1.0' : path === '/shop' ? '0.9' : '0.6' })), ...products.map(product => ({ loc: `${SITE_URL}/products/${product.id}`, priority: '0.8' }))];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.map(entry => `  <url><loc>${xml(entry.loc)}</loc><lastmod>${SITE_UPDATED}</lastmod><changefreq>weekly</changefreq><priority>${entry.priority}</priority></url>`).join('\n')}\n</urlset>\n`;
}

export function rssXml(products) {
  const items = products.slice(0, 20).map(product => `<item><title>${xml(product.name)}</title><link>${SITE_URL}/products/${product.id}</link><guid>${SITE_URL}/products/${product.id}</guid><description>${xml(product.description)}</description><pubDate>${new Date(`${SITE_UPDATED}T00:00:00Z`).toUTCString()}</pubDate></item>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${SITE_NAME}</title><link>${SITE_URL}</link><description>${xml(SITE_DESCRIPTION)}</description><language>en-IN</language>${items}</channel></rss>`;
}

export function googleProductsXml(products) {
  const items = products.flatMap(product => {
    const variants = product.variants?.length ? product.variants : [{ code: 'default', label: '', image: product.image, price_paise: product.price_paise }];
    return variants.map(variant => {
      const sku = product.sku || `HK-${product.id}`;
      const title = variant.label ? `${product.name} – ${variant.label}` : product.name;
      return `<item><g:id>${xml(`${sku}-${variant.code}`)}</g:id><g:item_group_id>${xml(sku)}</g:item_group_id><title>${xml(title)}</title><description>${xml(product.description)}</description><link>${SITE_URL}/products/${product.id}</link><g:image_link>${xml(absoluteUrl(variant.image || product.image))}</g:image_link><g:availability>${product.stock > 0 ? 'in_stock' : 'out_of_stock'}</g:availability><g:price>${(Number(variant.price_paise || product.price_paise) / 100).toFixed(2)} INR</g:price><g:condition>new</g:condition><g:brand>${SITE_NAME}</g:brand><g:identifier_exists>no</g:identifier_exists><g:product_type>${xml(product.tags?.[0] || 'Handmade crochet')}</g:product_type>${variant.label ? `<g:color>${xml(variant.label)}</g:color>` : ''}<g:shipping><g:country>IN</g:country><g:service>Standard</g:service><g:price>80.00 INR</g:price></g:shipping></item>`;
    });
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss xmlns:g="http://base.google.com/ns/1.0" version="2.0"><channel><title>${SITE_NAME} product feed</title><link>${SITE_URL}</link><description>${xml(SITE_DESCRIPTION)}</description>${items}</channel></rss>`;
}

export function llmsText(products, full = false) {
  const catalog = products.map(product => `- [${product.name}](${SITE_URL}/products/${product.id}): ${product.description} Price: ₹${(product.price_paise / 100).toFixed(2)}.`).join('\n');
  return `# ${SITE_NAME}\n\n> ${SITE_DESCRIPTION}\n\nThe Happy Knots is an Indian online shop for handmade, made-to-order crochet products. Rakhi Dixit is the maker and founder. Aryan Dixit manages the online shop and customer experience.\n\n## Essential pages\n\n- [Shop](${SITE_URL}/shop): Browse all available handmade products.\n- [Our story](${SITE_URL}/about): Meet Rakhi and Aryan Dixit.\n- [Contact](${SITE_URL}/contact): Customer support and product questions.\n- [Shipping policy](${SITE_URL}/shipping): Delivery timing and charges.\n- [Returns and refunds](${SITE_URL}/returns): Order cancellation, return and refund terms.\n\n## Ordering facts\n\n- Every item is handmade after the order is placed.\n- Estimated delivery is 10–15 days within India.\n- Payment is currently cash on delivery.\n- Shipping is free for orders of ₹1,000 or more and ₹80 below ₹1,000.\n- Handmade colours and dimensions can vary slightly.\n\n## Product catalogue\n\n${catalog}\n\n## Contact and identity\n\n- Customer support: ${CONTACT_EMAIL}\n- Instagram: ${INSTAGRAM_URL}\n- Canonical website: ${SITE_URL}\n- Last reviewed: ${SITE_UPDATED}\n${full ? '\n## Frequently asked questions\n\n' + FAQS.map(item => `### ${item.question}\n\n${item.answer}`).join('\n\n') : ''}`;
}
