import { describe, expect, it } from 'vitest';
import {
  cleanBrand,
  dimensionFrom,
  extractAsin,
  marketplaceAdapter,
  normalizeFilterLabel,
  parsePrice,
} from './marketplace';

describe('extractAsin', () => {
  it('reads ASINs from product URLs', () => {
    expect(extractAsin('https://www.amazon.com/dp/B0ABC12345')).toBe('B0ABC12345');
    expect(extractAsin('/gp/product/B0ABC12345?th=1')).toBe('B0ABC12345');
  });

  it('accepts a bare ASIN and rejects junk', () => {
    expect(extractAsin('b0abc12345')).toBe('B0ABC12345');
    expect(extractAsin('https://example.com/collections/tees')).toBeNull();
    expect(extractAsin(null)).toBeNull();
  });
});

describe('parsePrice', () => {
  it('parses currency-prefixed prices', () => {
    expect(parsePrice('$8.99')).toEqual({ price: 8.99, currency: 'USD' });
    expect(parsePrice('€1,299.50')).toEqual({ price: 1299.5, currency: 'EUR' });
    expect(parsePrice(null)).toEqual({ price: null, currency: null });
  });
});

describe('cleanBrand', () => {
  it('strips Amazon byline noise', () => {
    expect(cleanBrand('Visit the Gildan Store')).toBe('Gildan');
    expect(cleanBrand('Brand: Gildan')).toBe('Gildan');
    expect(cleanBrand(null)).toBeNull();
  });
});

describe('dimensionFrom', () => {
  it('maps variation ids to dimensions', () => {
    expect(dimensionFrom('variation_color_name')).toBe('color');
    expect(dimensionFrom('variation_size_name')).toBe('size');
    expect(dimensionFrom('variation_style_name')).toBe('style');
    expect(dimensionFrom('inline-twister-row-color_name')).toBe('color');
    expect(dimensionFrom('inline-twister-row-size_name')).toBe('size');
    expect(dimensionFrom('twister')).toBe('variant');
  });
});

describe('pageType', () => {
  const type = (path: string) =>
    marketplaceAdapter.pageType(new URL(`https://www.amazon.in${path}`));

  it('recognizes cart URLs', () => {
    expect(type('/cart/smart-wagon')).toBe('cart');
    expect(type('/gp/cart/view.html')).toBe('cart');
    expect(type('/gp/aw/c')).toBe('cart');
    expect(type('/checkout/cart')).toBe('cart');
  });

  it('recognizes other page types', () => {
    expect(type('/dp/B0ABC12345')).toBe('pdp');
    expect(type('/gp/product/B0ABC12345')).toBe('pdp');
    expect(type('/s?k=hoodies')).toBe('search_results');
    expect(type('/')).toBe('home');
    expect(type('/customer-preferences')).toBe('other');
  });
});

describe('normalizeFilterLabel', () => {
  it('cleans applied-filter chip text', () => {
    expect(normalizeFilterLabel('  Prime  Clear ')).toBe('Prime');
    expect(normalizeFilterLabel('Clear Brand: Nike')).toBe('Brand: Nike');
    expect(normalizeFilterLabel('Size: M remove')).toBe('Size: M');
  });

  it('truncates very long labels', () => {
    expect(normalizeFilterLabel('x'.repeat(100))).toHaveLength(60);
  });
});
