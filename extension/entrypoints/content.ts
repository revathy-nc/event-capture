import { browser } from 'wxt/browser';
import { resolveAdapter } from '../lib/adapters';
import { dimensionFrom, extractAsin } from '../lib/adapters/marketplace';
import { actionGroup, confirmedType, isRemovalRequest, parseCartTotals } from '../lib/cart';
import { isSensitiveInput } from '../lib/redact';
import { getSettings, hostAllowed } from '../lib/settings';
import type {
  CandidateEvent,
  DetectionMethod,
  EventType,
  PageInfo,
  SiteInfo,
  Settings,
} from '../lib/schema';

const PAGE_VIEW_DEBOUNCE_MS = 500;
const SEARCH_DEDUPE_MS = 3000;
const CORRELATION_WINDOW_MS = 30_000;
const CONFIRM_WINDOW_MS = 15_000;
const CART_CLICK_DEDUPE_MS = 1500;
const LAST_CLICK_KEY = 'ec:lastProductClick';
const HEARTBEAT_MS = 15_000;
const MIN_DWELL_MS = 500;
const URL_LIMIT = 500;

const CART_SIGNAL_SELECTOR =
  'button, a, input[type="submit"], input[type="button"], [role="button"], [data-action], [data-testid]';
const CART_CONTAINER_SELECTOR =
  '[data-cart], .cart, .mini-cart, .cart-drawer, .cart-flyout, .cart-preview, [id*="mini-cart" i], [class*="mini-cart" i], [aria-label*="mini cart" i]';
const ADD_TO_CART_SIGNAL = /add\s*to\s*(cart|bag|basket)|addtocart/i;
const WISHLIST_ADD_SIGNAL =
  /add\s*to\s*(wish|list|registry)|save\s*for\s*later|add\s*to\s*list/i;
const WISHLIST_REMOVE_SIGNAL =
  /remove\s*from\s*(wish|list)|wishlist.*remove|remove.*wishlist|delete.*wishlist/i;
const REMOVE_SIGNAL = /remove|delete|trash|decrement/i;

const SEARCH_INPUT_SELECTOR =
  'input[name="k"], input[name="q"], input[name="search"], input[type="search"], input[placeholder*="Search" i], input[aria-label*="Search" i]';
const SUGGESTION_SELECTOR =
  '[role="option"], [role="listbox"] li, .s-suggestion, .autocomplete-suggestion, [data-suggestion]';

let settings: Settings | null = null;
let wasCapturing = false;
let lastPath: string | null = null;
let pageViewTimer: ReturnType<typeof setTimeout> | null = null;
let lastSearch: { query: string; at: number } | null = null;
let lastProductView: { product_id: string; event_id: string; at: number } | null = null;
let lastViewKey: { key: string; at: number } | null = null;
let lastVariant: { key: string; at: number } | null = null;
let lastCartClick: { key: string; at: number } | null = null;
let pendingActions: PendingAction[] = [];

interface ActionMatch {
  type: EventType;
  product_id: string | null;
  variant_id: string | null;
  quantity: number;
  source: string;
}

interface PendingAction extends ActionMatch {
  event_id: string;
  at: number;
}

interface DwellState {
  startedAt: number;
  activeMs: number;
  visibleSince: number | null;
  heartbeatIndex: number;
  timer: ReturnType<typeof setInterval> | null;
}

let dwell: DwellState | null = null;

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  runAt: 'document_idle',
  main() {
    void init();
  },
});

async function init(): Promise<void> {
  settings = await getSettings();
  installNavigationObserver();
  installClickObserver();
  installVariantObserver();
  installCartObserver();
  installSearchObserver();
  installAutocompleteObserver();
  installNetworkObserver();
  installDwellLifecycle();
  publishBridgeConfig();

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    void getSettings().then((next) => {
      settings = next;

      const dwellCapturing = canCapture('dwell_time');
      if (dwellCapturing && !dwell) startDwell();
      if (!dwellCapturing && dwell) stopDwell();

      const capturing = canCapture('page_viewed');
      if (capturing && !wasCapturing) emitPageView('initial');
      wasCapturing = capturing;
    });
  });

  wasCapturing = canCapture('page_viewed');
  if (wasCapturing) {
    emitPageView('initial');
    if (canCapture('dwell_time')) startDwell();
  }
}

function canCapture(type: EventType): boolean {
  if (!settings?.enabled) return false;
  if (settings.events[type] === false) return false;
  return hostAllowed(location.hostname, settings.allowlist);
}

function publishBridgeConfig(): void {
  const { bodyAllowlist } = resolveAdapter();
  window.postMessage(
    { source: 'event-capture-content', kind: 'config', bodyAllowlist },
    location.origin,
  );
}

/* -------------------------------------------------------------------------- */
/* Navigation                                                                  */
/* -------------------------------------------------------------------------- */

function installNavigationObserver(): void {
  const wrap =
    (original: History['pushState'] | History['replaceState']) =>
    function (this: History, ...args: Parameters<History['pushState']>) {
      const result = original.apply(this, args);
      schedulePageView('spa');
      return result;
    };

  history.pushState = wrap(history.pushState);
  history.replaceState = wrap(history.replaceState);
  window.addEventListener('popstate', () => schedulePageView('back_forward'));
}

function schedulePageView(navigationType: 'spa' | 'back_forward'): void {
  if (pageViewTimer) clearTimeout(pageViewTimer);
  emitDwell(true);
  stopDwell();
  pageViewTimer = setTimeout(() => {
    emitPageView(navigationType);
    if (canCapture('dwell_time')) startDwell();
  }, PAGE_VIEW_DEBOUNCE_MS);
}

function emitPageView(navigationType: 'initial' | 'spa' | 'back_forward'): void {
  if (!canCapture('page_viewed')) return;

  const referrerPath =
    navigationType === 'initial'
      ? document.referrer
        ? safePath(document.referrer)
        : null
      : lastPath;

  send({
    type: 'page_viewed',
    detection: { method: 'derived', confidence: 1 },
    site: currentSite(),
    page: currentPage(referrerPath),
    entity: entityInfo(),
    payload: { navigation_type: navigationType },
  });

  emitSearchFromUrl();
  emitProductView();
  lastPath = location.pathname;
}

/* -------------------------------------------------------------------------- */
/* Dwell time                                                                  */
/* -------------------------------------------------------------------------- */

function installDwellLifecycle(): void {
  document.addEventListener('visibilitychange', () => {
    if (!dwell) return;
    const now = Date.now();
    if (document.visibilityState === 'hidden') {
      if (dwell.visibleSince !== null) {
        dwell.activeMs += now - dwell.visibleSince;
        dwell.visibleSince = null;
      }
      emitDwell(false);
    } else {
      dwell.visibleSince = now;
    }
  });

  window.addEventListener('pagehide', () => emitDwell(true));
}

function startDwell(): void {
  if (dwell) return;
  const now = Date.now();
  dwell = {
    startedAt: now,
    activeMs: 0,
    visibleSince: document.visibilityState === 'visible' ? now : null,
    heartbeatIndex: 0,
    timer: null,
  };
  dwell.timer = setInterval(() => emitDwell(false), HEARTBEAT_MS);
}

function stopDwell(): void {
  if (!dwell) return;
  if (dwell.timer !== null) clearInterval(dwell.timer);
  dwell = null;
}

function emitDwell(final: boolean): void {
  if (!dwell) return;
  if (!canCapture('dwell_time')) {
    stopDwell();
    return;
  }
  // While the tab is hidden there is nothing new to measure; visibilitychange
  // already flushed the active time.
  if (!final && document.visibilityState === 'hidden') return;

  const now = Date.now();
  const total = now - dwell.startedAt;
  const active = dwell.activeMs + (dwell.visibleSince !== null ? now - dwell.visibleSince : 0);
  if (total < MIN_DWELL_MS) return;

  send({
    type: 'dwell_time',
    detection: { method: 'derived', confidence: 1 },
    site: currentSite(),
    page: currentPage(),
    entity: entityInfo(),
    payload: {
      page_type: pageType(),
      duration_ms_total: total,
      duration_ms_active: Math.min(active, total),
      visible_ratio: Number((total > 0 ? Math.min(1, active / total) : 0).toFixed(3)),
      heartbeat_index: dwell.heartbeatIndex,
    },
  });

  dwell.heartbeatIndex += 1;
  dwell.activeMs = active;
  if (dwell.visibleSince !== null) dwell.visibleSince = now;
  if (final) stopDwell();
}

/* -------------------------------------------------------------------------- */
/* Cart and wishlist                                                           */
/* -------------------------------------------------------------------------- */

function installCartObserver(): void {
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const action = classifyAction(target);
      if (!action) return;
      if (!canCapture(action.type)) return;

      const key = `${action.type}|${action.product_id ?? ''}|${location.pathname}`;
      const now = Date.now();
      if (lastCartClick && lastCartClick.key === key && now - lastCartClick.at < CART_CLICK_DEDUPE_MS) {
        return;
      }
      lastCartClick = { key, at: now };

      const eventId = send({
        type: action.type,
        detection: { method: 'ui', confidence: 0.6 },
        site: currentSite(),
        page: currentPage(),
        entity: { product_id: action.product_id, variant_id: action.variant_id },
        payload: actionPayload(action),
      });

      pendingActions = pendingActions.filter((pending) => now - pending.at < CONFIRM_WINDOW_MS);
      pendingActions.push({ ...action, event_id: eventId, at: now });
    },
    true,
  );
}

function classifyAction(target: Element): ActionMatch | null {
  const direct = target.closest<HTMLElement>(CART_SIGNAL_SELECTOR);
  // Amazon-style buttons hide the real input as a sibling of the visible text
  // span, so fall back to the button wrapper and read its descendants.
  const wrapper = direct
    ? null
    : target.closest<HTMLElement>('.a-button, .a-button-inner, [data-action]');
  const control = direct ?? wrapper;
  if (!control) return null;

  const nested = control.querySelector<HTMLElement>(
    'input[type="submit"], input[type="button"], button, [data-action]',
  );
  const signalElements = nested && nested !== control ? [control, nested] : [control];

  const visibleText = (control.textContent ?? '').replace(/\s+/g, ' ').trim();
  const textSignal = visibleText.length <= 80 ? visibleText : '';

  const signal = [
    ...signalElements.flatMap((element) => [
      element.id,
      element.getAttribute('name') ?? '',
      element.getAttribute('value') ?? '',
      element.getAttribute('aria-label') ?? '',
      element.getAttribute('title') ?? '',
      element.getAttribute('data-action') ?? '',
      element.getAttribute('data-testid') ?? '',
      element.className,
    ]),
    textSignal,
  ].join(' ');

  const currentType = pageType();
  const onWishlistPage = /wishlist|registry|saved/i.test(location.pathname);
  const nestedLink = control.querySelector<HTMLAnchorElement>('a[href*="/dp/"]');
  const productId =
    resolveAdapter().productIdFromElement(control) ??
    extractAsin(nestedLink?.getAttribute('href') ?? '') ??
    extractAsin(location.href);
  const quantity = readQuantity(control);
  const source = onWishlistPage
    ? 'wishlist'
    : currentType === 'cart'
      ? 'cart'
      : currentType === 'pdp'
        ? 'pdp'
        : 'other';

  if (
    WISHLIST_ADD_SIGNAL.test(signal) ||
    WISHLIST_REMOVE_SIGNAL.test(signal) ||
    (onWishlistPage && REMOVE_SIGNAL.test(signal))
  ) {
    const removing =
      WISHLIST_REMOVE_SIGNAL.test(signal) ||
      isSelectedToggle(control) ||
      (onWishlistPage && REMOVE_SIGNAL.test(signal));
    return {
      type: removing ? 'remove_from_wishlist' : 'add_to_wishlist',
      product_id: productId,
      variant_id: null,
      quantity: 1,
      source,
    };
  }

  if (ADD_TO_CART_SIGNAL.test(signal)) {
    return {
      type: 'add_to_cart',
      product_id: productId,
      variant_id: null,
      quantity,
      source,
    };
  }

  const inCartContainer =
    currentType === 'cart' || Boolean(control.parentElement?.closest(CART_CONTAINER_SELECTOR));
  if (inCartContainer && REMOVE_SIGNAL.test(signal)) {
    return {
      type: 'remove_from_cart',
      product_id: productId,
      variant_id: null,
      quantity,
      source,
    };
  }

  return null;
}

/** True when a wishlist/favorite toggle already reflects the "added" state. */
function isSelectedToggle(control: Element): boolean {
  const selected = control.getAttribute('data-selected');
  return (
    control.getAttribute('aria-pressed') === 'true' ||
    control.getAttribute('aria-checked') === 'true' ||
    (selected !== null && selected.toLowerCase() !== 'false') ||
    ['checked', 'selected'].includes((control.getAttribute('data-state') ?? '').toLowerCase())
  );
}

function readQuantity(control: Element): number {
  const scope = control.closest('form') ?? control.parentElement ?? document;
  const input = scope.querySelector<HTMLInputElement | HTMLSelectElement>(
    'input[name*="quantity" i], input[id*="quantity" i], select[name*="quantity" i]',
  );
  const quantity = Number.parseInt(input?.value ?? '', 10);
  return Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
}

function actionPayload(action: ActionMatch): Record<string, unknown> {
  if (action.type === 'add_to_cart') {
    return {
      quantity: action.quantity,
      unit_price: null,
      currency: null,
      cart_total_after: null,
      cart_item_count: null,
      source: action.source,
    };
  }
  if (action.type === 'remove_from_cart') {
    return {
      quantity_removed: action.quantity,
      remaining_qty: null,
      cart_total_after: null,
    };
  }
  return { list_name: 'wishlist', source: action.source };
}

function confirmCartAction(data: NetworkMessage, method: string): void {
  if (typeof data.url !== 'string') return;

  let url: URL;
  try {
    url = new URL(data.url, location.href);
  } catch {
    return;
  }
  if (url.hostname !== location.hostname) return;

  const haystack = `${url.pathname}${url.search}`.toLowerCase();
  const group = /(?:^|[/?&_.-])(wishlist|registry|saved)(?:[/?&_.=-]|$)/.test(haystack)
    ? 'wishlist'
    : /(?:^|[/?&_.-])(cart|basket|bag)(?:[/?&_.=-]|$)/.test(haystack)
      ? 'cart'
      : null;
  if (!group) return;

  const desiredType = confirmedType(group, isRemovalRequest(method, haystack));
  const now = Date.now();
  pendingActions = pendingActions.filter((pending) => now - pending.at < CONFIRM_WINDOW_MS);

  let index = pendingActions.findIndex((pending) => pending.type === desiredType);
  if (index < 0) {
    index = pendingActions.findIndex((pending) => actionGroup(pending.type) === group);
  }
  if (index < 0) return;

  const [action] = pendingActions.splice(index, 1);
  if (!action) return;

  const totals = group === 'cart' ? parseCartTotals(data.body) : {};
  send({
    type: action.type,
    parent_event_id: action.event_id,
    detection: { method: 'network', confidence: 0.9 },
    site: currentSite(),
    page: currentPage(),
    entity: { product_id: action.product_id, variant_id: action.variant_id },
    payload: { ...actionPayload(action), ...totals },
  });
}

/* -------------------------------------------------------------------------- */
/* Search                                                                      */
/* -------------------------------------------------------------------------- */

function installSearchObserver(): void {
  document.addEventListener(
    'submit',
    (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      if (!isSearchForm(form)) return;
      const input = findSearchInput(form);
      if (input && !isSensitiveInput(input)) emitSearch(input.value, 'header', 'ui', 0.8);
    },
    true,
  );

  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Enter') return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const input = target.closest(SEARCH_INPUT_SELECTOR);
      if (!input || isSensitiveInput(input)) return;
      emitSearch((input as HTMLInputElement).value, 'header', 'ui', 0.8);
    },
    true,
  );
}

function isSearchForm(form: HTMLFormElement): boolean {
  if (form.querySelector(SEARCH_INPUT_SELECTOR)) return true;
  const haystack = `${form.getAttribute('role') ?? ''} ${form.id} ${form.className} ${form.getAttribute('action') ?? ''}`;
  return /search/i.test(haystack);
}

function findSearchInput(root: ParentNode = document): HTMLInputElement | null {
  return root.querySelector<HTMLInputElement>(SEARCH_INPUT_SELECTOR);
}

function emitSearchFromUrl(): void {
  if (!canCapture('search')) return;
  const params = new URLSearchParams(location.search);
  const query = params.get('k') ?? params.get('q') ?? params.get('query') ?? params.get('search');
  if (!query) return;
  emitSearch(query, 'url', 'derived', 0.8);
}

function emitSearch(
  rawQuery: string | null | undefined,
  origin: 'header' | 'search_page' | 'url',
  method: DetectionMethod,
  confidence: number,
): void {
  if (!canCapture('search')) return;
  const query = (rawQuery ?? '').replace(/\s+/g, ' ').trim();
  if (!query) return;

  const normalized = query.toLowerCase();
  if (
    lastSearch &&
    lastSearch.query === normalized &&
    Date.now() - lastSearch.at < SEARCH_DEDUPE_MS
  ) {
    return;
  }
  lastSearch = { query: normalized, at: Date.now() };

  const params = new URLSearchParams(location.search);
  const rawPage = Number.parseInt(params.get('page') ?? '', 10);
  const rawFilters = params.get('rh') ?? params.get('filter') ?? '';
  const urlFilters = rawFilters ? rawFilters.split(',').filter(Boolean) : [];
  const filterLabels = resolveAdapter().filterLabels(document);
  const resultCount = countResults();

  send({
    type: 'search',
    detection: { method, confidence },
    site: currentSite(),
    page: currentPage(),
    entity: entityInfo(),
    payload: {
      query,
      normalized_query: normalized,
      result_count: resultCount,
      page: Number.isFinite(rawPage) && rawPage > 0 ? rawPage : null,
      filters: filterLabels.length > 0 ? filterLabels : urlFilters,
      sort: params.get('s') ?? params.get('sort') ?? null,
      origin,
    },
  });
}

function countResults(): number | null {
  const count = document.querySelectorAll(
    '[data-component-type="s-search-result"], [data-asin].s-result-item',
  ).length;
  return count > 0 ? count : null;
}

/* -------------------------------------------------------------------------- */
/* Autocomplete                                                                */
/* -------------------------------------------------------------------------- */

function installAutocompleteObserver(): void {
  document.addEventListener(
    'click',
    (event) => {
      if (!canCapture('autocomplete_selected')) return;
      const target = event.target;
      if (!(target instanceof Element)) return;

      const item = target.closest(SUGGESTION_SELECTOR);
      if (!item) return;

      const input = findSearchInput();
      const text = (item.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!text) return;

      const siblings = item.parentElement
        ? Array.from(item.parentElement.querySelectorAll(SUGGESTION_SELECTOR))
        : [item];

      send({
        type: 'autocomplete_selected',
        detection: { method: 'ui', confidence: 0.6 },
        site: currentSite(),
        page: currentPage(),
        entity: entityInfo(),
        payload: {
          input_prefix: input?.value ?? '',
          suggestion_text: text.slice(0, 160),
          suggestion_type: suggestionType(item),
          position: Math.max(0, siblings.indexOf(item)),
          suggestion_id: item.getAttribute('data-suggestion-id'),
        },
      });
    },
    true,
  );
}

function suggestionType(item: Element): 'query' | 'product' | 'collection' {
  if (item.hasAttribute('data-asin') || item.querySelector('img')) return 'product';
  const href = item.querySelector('a')?.getAttribute('href') ?? '';
  if (/\/b\?|node=|category/i.test(href)) return 'collection';
  return 'query';
}

/* -------------------------------------------------------------------------- */
/* Product clicks                                                              */
/* -------------------------------------------------------------------------- */

function installClickObserver(): void {
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!canCapture('product_clicked')) return;
      if (target.closest(SUGGESTION_SELECTOR)) return;
      if (classifyAction(target)) return;
      // Swatch clicks are variant selections, not product navigation.
      if (resolveAdapter().variantFromElement(target)) return;

      const link = target.closest<HTMLAnchorElement>(
        'a[href*="/dp/"], a[href*="/gp/product/"], a[href*="/product/"], [data-asin]',
      );
      if (!link) return;

      const adapter = resolveAdapter();
      const productId = adapter.productIdFromElement(link);
      if (!productId) return;
      const context = adapter.listContext(link);
      const productName = extractName(link);

      // On a PDP, a click on a short-labeled element pointing at a different
      // ASIN is a variant selection (Amazon swatches have no href).
      const currentAsin = extractAsin(location.href);
      if (
        canCapture('variant_selected') &&
        pageType() === 'pdp' &&
        currentAsin &&
        productId !== currentAsin &&
        productName &&
        productName.length <= 30
      ) {
        const dimension = variantDimension(link);
        const key = `${currentAsin}|${dimension}|${productName}`;
        const now = Date.now();
        if (!lastVariant || lastVariant.key !== key || now - lastVariant.at >= 2000) {
          lastVariant = { key, at: now };
          send({
            type: 'variant_selected',
            detection: { method: 'ui', confidence: 0.6 },
            site: currentSite(),
            page: currentPage(),
            entity: { product_id: currentAsin, variant_id: null },
            payload: {
              dimension,
              previous_value: null,
              new_value: productName,
              price: null,
              currency: null,
            },
          });
        }
        return;
      }

      const eventId = send({
        type: 'product_clicked',
        detection: { method: 'ui', confidence: 0.7 },
        site: currentSite(),
        page: currentPage(),
        entity: { product_id: productId, variant_id: null },
        payload: {
          product_name: productName,
          list_context: context.list_context,
          rank: context.rank,
          list_query: context.list_query,
          url: absoluteUrl(link.getAttribute('href')),
        },
      });

      rememberProductClick({ product_id: productId, event_id: eventId, at: Date.now() });
    },
    true,
  );
}

function installVariantObserver(): void {
  const handler = (event: Event) => {
    if (!canCapture('variant_selected')) return;
    const target = event.target;
    if (!(target instanceof Element)) return;

    const variant = resolveAdapter().variantFromElement(target);
    if (!variant) return;

    const key = `${variant.product_id}|${variant.dimension}|${variant.new_value}`;
    const now = Date.now();
    if (lastVariant && lastVariant.key === key && now - lastVariant.at < 2000) return;
    lastVariant = { key, at: now };

    const parent =
      lastProductView &&
      lastProductView.product_id === variant.product_id &&
      now - lastProductView.at < CORRELATION_WINDOW_MS
        ? lastProductView.event_id
        : null;

    send({
      type: 'variant_selected',
      parent_event_id: parent,
      detection: { method: 'ui', confidence: 0.7 },
      site: currentSite(),
      page: currentPage(),
      entity: { product_id: variant.product_id, variant_id: null },
      payload: {
        dimension: variant.dimension,
        previous_value: variant.previous_value,
        new_value: variant.new_value,
        price: variant.price,
        currency: variant.currency,
      },
    });
  };

  document.addEventListener('click', handler, true);
  document.addEventListener('change', handler, true);
}

/* -------------------------------------------------------------------------- */
/* Product view                                                                */
/* -------------------------------------------------------------------------- */

function emitProductView(): void {
  if (!canCapture('product_viewed')) return;

  const product = resolveAdapter().product(document);
  if (!product) return;

  const key = `${product.product_id}|${location.pathname}`;
  const now = Date.now();
  if (lastViewKey && lastViewKey.key === key && now - lastViewKey.at < 3000) return;
  lastViewKey = { key, at: now };

  const click = readProductClick();
  const parent = click && click.product_id === product.product_id ? click.event_id : null;
  const params = new URLSearchParams(location.search);
  const searchQuery = params.get('k') ?? params.get('q');

  const eventId = send({
    type: 'product_viewed',
    parent_event_id: parent,
    detection: { method: 'derived', confidence: 0.9 },
    site: currentSite(),
    page: currentPage(),
    entity: { product_id: product.product_id, variant_id: null },
    payload: {
      product_name: product.name,
      category: product.category,
      brand: product.brand,
      price: product.price,
      currency: product.currency,
      in_stock: product.in_stock,
      referrer_type: referrerType(),
      search_query: searchQuery,
    },
  });

  lastProductView = { product_id: product.product_id, event_id: eventId, at: now };
}

function referrerType(): string {
  if (lastPath) {
    const previous = resolveAdapter().pageType(new URL(lastPath, location.origin));
    if (previous === 'search_results') return 'search_results';
    if (previous === 'pdp') return 'pdp_recs';
  }
  if (/\/s\?|\/search/.test(document.referrer)) return 'search_results';
  if (document.referrer) return 'external';
  return 'direct';
}

/* -------------------------------------------------------------------------- */
/* Network (page bridge)                                                       */
/* -------------------------------------------------------------------------- */

function installNetworkObserver(): void {
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'event-capture-page-bridge' || data.kind !== 'network') return;
    handleNetwork(data);
  });
}

interface NetworkMessage {
  url?: unknown;
  method?: unknown;
  status?: unknown;
  body?: unknown;
}

function handleNetwork(data: NetworkMessage): void {
  if (typeof data.url !== 'string') return;
  if (typeof data.status !== 'number' || data.status < 200 || data.status >= 300) return;

  const method = String(data.method ?? 'GET').toUpperCase();
  if (method === 'GET') {
    handleSearchResponse(data);
  } else {
    confirmCartAction(data, method);
  }
}

function handleSearchResponse(data: NetworkMessage): void {
  let url: URL;
  try {
    url = new URL(String(data.url), location.href);
  } catch {
    return;
  }

  if (url.hostname !== location.hostname) return;
  if (/suggest|autocomplete/i.test(url.pathname)) return;

  const query =
    url.searchParams.get('k') ??
    url.searchParams.get('q') ??
    url.searchParams.get('query') ??
    url.searchParams.get('search');
  if (!query) return;

  const origin = /search|^\/s/.test(url.pathname) ? 'search_page' : 'header';
  emitSearch(query, origin, 'network', 0.6);
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function send(candidate: CandidateEvent): string {
  const eventId = candidate.event_id ?? crypto.randomUUID();
  const payload: CandidateEvent = {
    ...candidate,
    event_id: eventId,
    client_ts: new Date().toISOString(),
  };
  void browser.runtime.sendMessage({ kind: 'event', event: payload }).catch(() => undefined);
  return eventId;
}

function currentSite(): SiteInfo {
  return {
    host: location.hostname,
    url: location.href,
    path: location.pathname,
  };
}

function currentPage(referrerPath?: string | null): PageInfo {
  const referrer =
    referrerPath !== undefined
      ? referrerPath
      : document.referrer
        ? safePath(document.referrer)
        : null;
  return {
    page_type: pageType(),
    title: document.title ? document.title.slice(0, 200) : null,
    referrer_path: referrer,
    viewport: { w: window.innerWidth, h: window.innerHeight },
  };
}

function entityInfo(): { product_id: string | null; variant_id: string | null } {
  return { product_id: extractAsin(location.href), variant_id: null };
}

function pageType(): string {
  const url = new URL(location.href);
  return resolveAdapter(url).pageType(url);
}

function extractName(element: Element): string | null {
  const ariaLabel = element.getAttribute('aria-label');
  const imageAlt = element.querySelector('img')?.getAttribute('alt');
  const text = element.textContent;
  const value = (ariaLabel || imageAlt || text || '').trim().replace(/\s+/g, ' ');
  return value || null;
}

function variantDimension(element: Element): string {
  const near = element.closest(
    '[id*="color" i], [id*="size" i], [id*="style" i], [class*="color" i], [class*="size" i]',
  );
  return dimensionFrom(
    [
      element.id,
      element.getAttribute('class') ?? '',
      near?.id ?? '',
      near?.getAttribute('class') ?? '',
    ].join(' '),
  );
}

function safePath(raw: string): string {
  try {
    const url = new URL(raw, location.href);
    return url.pathname.slice(0, URL_LIMIT);
  } catch {
    return raw.slice(0, URL_LIMIT);
  }
}

function absoluteUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    return new URL(raw, location.href).toString();
  } catch {
    return raw;
  }
}

interface RememberedClick {
  product_id: string;
  event_id: string;
  at: number;
}

function rememberProductClick(value: RememberedClick): void {
  try {
    sessionStorage.setItem(LAST_CLICK_KEY, JSON.stringify(value));
  } catch {
    // Storage can be unavailable (private mode / disabled); in-memory state still works.
  }
}

function readProductClick(): RememberedClick | null {
  const now = Date.now();
  try {
    const raw = sessionStorage.getItem(LAST_CLICK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RememberedClick;
    if (
      parsed &&
      typeof parsed.product_id === 'string' &&
      typeof parsed.event_id === 'string' &&
      typeof parsed.at === 'number' &&
      now - parsed.at < CORRELATION_WINDOW_MS
    ) {
      return parsed;
    }
  } catch {
    // Corrupt or unavailable storage; treat as no recent click.
  }

  return null;
}
