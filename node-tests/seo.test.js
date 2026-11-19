import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SITE_URL,
  breadcrumbSchema,
  faqSchema,
  googleProductsXml,
  llmsText,
  organizationSchema,
  productSchema,
  robotsText,
  seoFor,
  sitemapXml,
  websiteSchema
} from '../backend/seo.js';

const product = {
  id: 'lotus-holder',
  name: 'Crochet Lotus Tealight Holders',
  description: 'A handmade pair of crochet lotus tealight holders.',
  image: '/static/assets/products/lotus.webp',
  images: ['/static/assets/products/lotus.webp'],
  price_paise: 89900,
  stock: 1,
  tags: ['Home Decor']
};

test('robots policy allows discovery bots while protecting private routes', () => {
  const robots = robotsText();
  assert.match(robots, /User-agent: \*/);
  assert.match(robots, /Allow: \//);
  assert.match(robots, /Disallow: \/owner/);
  assert.match(robots, new RegExp(`Sitemap: ${SITE_URL}/sitemap\\.xml`));
});

test('page metadata uses canonical product URLs and noindexes account pages', () => {
  assert.match(seoFor('/').meta_title, /^The Happy Knots/);
  const productSeo = seoFor(`/products/${product.id}`, { product });
  assert.equal(productSeo.canonical_url, `${SITE_URL}/products/${product.id}`);
  assert.equal(productSeo.og_type, 'product');
  assert.match(productSeo.meta_title, /Crochet Lotus Tealight Holders/);

  const accountSeo = seoFor('/account/login');
  assert.equal(accountSeo.noindex, true);
  assert.equal(seoFor('/shop').noindex, false);
});

test('sitemap contains public pages and product detail URLs', () => {
  const sitemap = sitemapXml([product]);
  assert.match(sitemap, /<urlset/);
  assert.match(sitemap, new RegExp(`${SITE_URL}/shop`));
  assert.match(sitemap, new RegExp(`${SITE_URL}/products/${product.id}`));
  assert.doesNotMatch(sitemap, /\/owner/);
});

test('structured data identifies the business, website, FAQs and product', () => {
  assert.equal(organizationSchema()['@type'], 'Organization');
  assert.equal(websiteSchema()['@type'], 'WebSite');
  assert.equal(faqSchema()['@type'], 'FAQPage');
  assert.equal(productSchema(product)['@type'], 'Product');
  assert.equal(productSchema(product).offers.price, '899.00');
  const withReviews = productSchema(product, {
    summary: { count: 1, average: 5 },
    reviews: [{ display_name: 'Asha K.', rating: 5, comment: 'Beautifully finished and carefully packed.', created_at: '2026-11-19T10:00:00.000Z' }]
  });
  assert.equal(withReviews.aggregateRating.ratingValue, 5);
  assert.equal(withReviews.aggregateRating.reviewCount, 1);
  assert.equal(withReviews.review[0].reviewBody, 'Beautifully finished and carefully packed.');
  assert.equal(productSchema(product).aggregateRating, undefined);
  assert.equal(breadcrumbSchema(product)['@type'], 'BreadcrumbList');
});

test('llms file contains identity, policies and catalogue facts', () => {
  const content = llmsText([product], true);
  assert.match(content, /# The Happy Knots/);
  assert.match(content, /10–15 days/);
  assert.match(content, /Crochet Lotus Tealight Holders/);
  assert.match(content, /Frequently asked questions/);
});

test('Google product feed exposes merchant-ready product data', () => {
  const feed = googleProductsXml([product]);
  assert.match(feed, /xmlns:g="http:\/\/base\.google\.com\/ns\/1\.0"/);
  assert.match(feed, /<g:id>HK-lotus-holder-default<\/g:id>/);
  assert.match(feed, /<g:price>899\.00 INR<\/g:price>/);
  assert.match(feed, /<g:availability>in_stock<\/g:availability>/);
  assert.match(feed, /lotus\.webp/);
});
