import type { ListContext, ProductRef, SiteAdapter, VariantContext } from './types';

const ASIN_PATTERN = /(?:\/dp\/|\/gp\/product\/|\/product\/)([A-Z0-9]{10})/i;

export function extractAsin(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^[A-Z0-9]{10}$/i.test(trimmed)) return trimmed.toUpperCase();
  const match = trimmed.match(ASIN_PATTERN);
  return match?.[1] ? match[1].toUpperCase() : null;
}

export function parsePrice(raw: string | null): { price: number | null; currency: string | null } {
  if (!raw) return { price: null, currency: null };
  const currency = /\$|USD/i.test(raw)
    ? 'USD'
    : /€|EUR/i.test(raw)
      ? 'EUR'
      : /£|GBP/i.test(raw)
        ? 'GBP'
        : null;
  const value = Number.parseFloat(raw.replace(/[^0-9.]/g, ''));
  return { price: Number.isFinite(value) ? value : null, currency };
}

export function cleanBrand(raw: string | null): string | null {
  if (!raw) return null;
  const value = raw
    .replace(/^visit the\s+/i, '')
    .replace(/^brand:\s*/i, '')
    .replace(/\s+store$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return value || null;
}

export function dimensionFrom(id: string): string {
  if (/color|colour/i.test(id)) return 'color';
  if (/size/i.test(id)) return 'size';
  if (/style|pattern/i.test(id)) return 'style';
  if (/configuration|edition/i.test(id)) return 'configuration';
  return 'variant';
}

const VARIANT_CONTAINER_SELECTOR = [
  '[id*="twister" i]',
  '[id^="variation_"]',
  '[data-csa-c-content-id*="twister"]',
  '[data-csa-c-content-id*="variation"]',
  '[data-defaultasin]',
  '[class*="swatch" i]',
].join(', ');

const VARIANT_ROW_SELECTOR = '[id*="twister-row" i], [id^="variation_"]';

const VARIANT_SELECTION_SELECTOR = [
  '.selection',
  '[id*="expanded-dimension-text"]',
  '[aria-checked="true"]',
  '.a-button-selected .a-button-text',
].join(', ');

export function normalizeFilterLabel(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^clear\s+/i, '')
    .replace(/\s*(?:clear|remove)\s*$/i, '')
    .trim()
    .slice(0, 60);
}

const FILTER_CONTAINERS = [
  '#fs-header-top',
  '#fs-header',
  '.s-navigation-container',
  '#s-refinements',
  '[data-component-type="s-search-filter"]',
  '[class*="applied-filter" i]',
  '[data-testid*="applied-filter" i]',
].join(', ');

function text(element: Element | null | undefined): string | null {
  const value = element?.textContent?.replace(/\s+/g, ' ').trim();
  return value || null;
}

function valueOf(element: Element): string | null {
  const own =
    element.getAttribute('alt') ||
    element.getAttribute('aria-label') ||
    element.getAttribute('title');
  if (own) return own;

  const imageAlt = element.querySelector('img')?.getAttribute('alt');
  if (imageAlt) return imageAlt;

  return text(element);
}

function readProduct(root: Document): ProductRef | null {
  if (marketplaceAdapter.pageType(new URL(location.href)) !== 'pdp') return null;

  const asin =
    extractAsin(location.href) ??
    extractAsin(root.querySelector<HTMLInputElement>('input#ASIN')?.value) ??
    extractAsin(root.querySelector('[data-asin]')?.getAttribute('data-asin'));

  if (!asin) return null;

  const priceInfo = parsePrice(
    text(
      root.querySelector(
        '#corePrice_feature_div .a-offscreen, .a-price .a-offscreen, #priceblock_ourprice, #priceblock_dealprice',
      ),
    ),
  );

  const categoryParts = Array.from(
    root.querySelectorAll('#wayfinding-breadcrumbs_feature_div a, .a-breadcrumb a'),
  )
    .map((part) => text(part))
    .filter((part): part is string => Boolean(part));

  const availability = text(root.querySelector('#availability'));
  const inStock = availability
    ? !/unavailable|out of stock|currently unavailable/i.test(availability)
    : null;

  return {
    product_id: asin,
    name: text(root.querySelector('#productTitle')) ?? text(root.querySelector('h1')) ?? document.title,
    brand: cleanBrand(text(root.querySelector('#bylineInfo'))),
    category: categoryParts.length > 0 ? categoryParts.join(' > ') : null,
    price: priceInfo.price,
    currency: priceInfo.currency,
    in_stock: inStock,
  };
}

export const marketplaceAdapter: SiteAdapter = {
  id: 'marketplace',

  bodyAllowlist: ['/(?:cart|basket|bag)(?:[/?.]|$)', '/wishlist(?:[/?.]|$)', '/registry(?:[/?.]|$)'],

  matches() {
    // Generic fallback adapter; site-specific adapters can be ordered before it.
    return true;
  },

  pageType(url: URL): string {
    const path = url.pathname.toLowerCase();
    if (extractAsin(url.href) || /^\/gp\/product\//.test(path)) return 'pdp';
    if (/^\/(s|search)\b/.test(path)) return 'search_results';
    if (/^\/(?:cart|gp\/cart|gp\/aw\/c|checkout\/cart)(?:\/|$)/.test(path)) return 'cart';
    if (path === '/' || path === '') return 'home';
    return 'other';
  },

  productIdFromElement(element: Element): string | null {
    const asinHolder = element.closest('[data-asin]');
    const href = element.closest('a[href]')?.getAttribute('href') ?? null;
    return extractAsin(asinHolder?.getAttribute('data-asin')) ?? extractAsin(href);
  },

  product(root: Document): ProductRef | null {
    return readProduct(root);
  },

  listContext(element: Element): ListContext {
    const pageType = marketplaceAdapter.pageType(new URL(location.href));
    const tiles = Array.from(document.querySelectorAll('[data-asin], a[href*="/dp/"]'));
    const index = tiles.findIndex(
      (tile) => tile === element || tile.contains(element) || element.contains(tile),
    );
    const params = new URLSearchParams(location.search);

    return {
      list_context:
        pageType === 'search_results' ? 'search_results' : pageType === 'pdp' ? 'pdp_recs' : 'other',
      rank: index >= 0 ? index + 1 : null,
      list_query: params.get('k') ?? params.get('q'),
    };
  },

  variantFromElement(element: Element): VariantContext | null {
    if (marketplaceAdapter.pageType(new URL(location.href)) !== 'pdp') return null;

    const outerContainer = element.closest(
      '#twister, #inline-twister, [data-csa-c-content-id*="twister-container"]',
    );
    const container = outerContainer ?? element.closest(VARIANT_CONTAINER_SELECTOR);

    const link = element.closest<HTMLAnchorElement>('a[href*="/dp/"]');
    const asinElement = element.closest('[data-asin]');
    const currentAsin = extractAsin(location.href);
    const targetAsin =
      extractAsin(link?.getAttribute('href') ?? '') ??
      extractAsin(asinElement?.getAttribute('data-asin') ?? '');

    const valueElement =
      element.closest(
        'a, button, li, [data-defaultasin], [class*="swatch" i], [data-asin]',
      ) ?? element;
    let newValue =
      valueElement instanceof HTMLSelectElement
        ? text(valueElement.selectedOptions[0])
        : valueOf(valueElement);
    if (!newValue && link) newValue = valueOf(link);
    if (!newValue) return null;

    // Without a known twister container, accept only short swatch-like labels
    // on a link/ASIN that differs from the current product.
    const shortLabel = newValue.length <= 30;
    const isVariantLink = Boolean(
      shortLabel && currentAsin && targetAsin && targetAsin !== currentAsin,
    );
    if (!container && !isVariantLink) return null;

    const dimensionElement = element.closest(VARIANT_ROW_SELECTOR) ?? container ?? link;
    const dimension = dimensionFrom(
      [
        dimensionElement?.id ?? '',
        dimensionElement?.getAttribute('class') ?? '',
        container?.id ?? '',
        container?.getAttribute('data-csa-c-content-id') ?? '',
      ].join(' '),
    );

    const previousValue = container
      ? cleanSelection(
          text(dimensionElement?.querySelector(VARIANT_SELECTION_SELECTOR)) ??
            text(container.querySelector(VARIANT_SELECTION_SELECTOR)),
        )
      : null;
    if (previousValue && previousValue.toLowerCase() === newValue.toLowerCase()) return null;

    const productId =
      currentAsin ?? extractAsin(document.querySelector<HTMLInputElement>('input#ASIN')?.value);
    if (!productId) return null;

    const priceInfo = parsePrice(text(document.querySelector('#corePrice_feature_div .a-offscreen, .a-price .a-offscreen')));

    return {
      product_id: productId,
      dimension,
      previous_value: previousValue,
      new_value: newValue.slice(0, 120),
      price: priceInfo.price,
      currency: priceInfo.currency,
    };
  },

  filterLabels(root: Document): string[] {
    const labels = new Set<string>();

    for (const container of Array.from(root.querySelectorAll(FILTER_CONTAINERS))) {
      const chips = container.querySelectorAll(
        'a, button, [role="button"], [aria-checked="true"], [aria-pressed="true"]',
      );
      for (const chip of Array.from(chips)) {
        const hasClearIcon = Boolean(
          chip.querySelector('.a-icon-close, [aria-label*="clear" i], [title*="clear" i]'),
        );
        const isSelected =
          chip.getAttribute('aria-checked') === 'true' ||
          chip.getAttribute('aria-pressed') === 'true';
        if (!hasClearIcon && !isSelected) continue;

        const label = normalizeFilterLabel(chip.textContent ?? '');
        if (!label) continue;
        if (/^(applied filters|clear all filters|clear all)$/i.test(label)) continue;
        labels.add(label);
      }
    }

    return Array.from(labels);
  },
};

function cleanSelection(raw: string | null): string | null {
  if (!raw) return null;
  const value = raw.split(':').pop()?.trim();
  return value || null;
}
