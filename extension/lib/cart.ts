import type { EventType } from './schema';

export type ActionGroup = 'cart' | 'wishlist';

const TOTAL_KEYS = /^(cart[_-]?total|subtotal|order[_-]?total|total)$/i;
const COUNT_KEYS = /^(cart[_-]?(quantity|count)|item[_-]?count|items?|count)$/i;

function findNumber(value: unknown, keys: RegExp, depth = 0): number | null {
  if (!value || typeof value !== 'object' || depth > 4) return null;

  for (const [key, child] of Object.entries(value)) {
    if (!keys.test(key)) continue;
    if (typeof child === 'number' && Number.isFinite(child)) return child;
    if (typeof child === 'string') {
      const parsed = Number.parseFloat(child.replace(/[^0-9.]/g, ''));
      if (Number.isFinite(parsed)) return parsed;
    }
  }

  for (const child of Object.values(value)) {
    const found = findNumber(child, keys, depth + 1);
    if (found !== null) return found;
  }

  return null;
}

/** Best-effort extraction of cart totals from a JSON response body. */
export function parseCartTotals(body: unknown): {
  cart_total_after?: number;
  cart_item_count?: number;
} {
  if (typeof body !== 'string') return {};
  const trimmed = body.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {};
  }

  const result: { cart_total_after?: number; cart_item_count?: number } = {};
  const total = findNumber(parsed, TOTAL_KEYS);
  const count = findNumber(parsed, COUNT_KEYS);
  if (total !== null) result.cart_total_after = total;
  if (count !== null) result.cart_item_count = count;
  return result;
}

export function actionGroup(type: EventType): ActionGroup | null {
  if (type === 'add_to_cart' || type === 'remove_from_cart') return 'cart';
  if (type === 'add_to_wishlist' || type === 'remove_from_wishlist') return 'wishlist';
  return null;
}

export function confirmedType(group: ActionGroup, removal: boolean): EventType {
  if (group === 'cart') return removal ? 'remove_from_cart' : 'add_to_cart';
  return removal ? 'remove_from_wishlist' : 'add_to_wishlist';
}

export function isRemovalRequest(method: string, url: string): boolean {
  if (method.toUpperCase() === 'DELETE') return true;
  return /remove|delete|trash|decrement|quantity=0|qty=0/.test(url.toLowerCase());
}
