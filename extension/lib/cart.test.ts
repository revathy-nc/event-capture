import { describe, expect, it } from 'vitest';
import { actionGroup, confirmedType, isRemovalRequest, parseCartTotals } from './cart';

describe('parseCartTotals', () => {
  it('finds totals and counts in nested JSON', () => {
    const body = JSON.stringify({
      cart: { subtotal: '$42.50', itemCount: 3, nested: { cartTotal: 42.5 } },
    });
    expect(parseCartTotals(body)).toEqual({ cart_total_after: 42.5, cart_item_count: 3 });
  });

  it('ignores HTML and malformed bodies', () => {
    expect(parseCartTotals('<html>nope</html>')).toEqual({});
    expect(parseCartTotals('{not json')).toEqual({});
    expect(parseCartTotals(null)).toEqual({});
  });
});

describe('actionGroup / confirmedType', () => {
  it('maps event types to groups', () => {
    expect(actionGroup('add_to_cart')).toBe('cart');
    expect(actionGroup('remove_from_wishlist')).toBe('wishlist');
    expect(actionGroup('search')).toBeNull();
  });

  it('maps group + removal to an event type', () => {
    expect(confirmedType('cart', false)).toBe('add_to_cart');
    expect(confirmedType('cart', true)).toBe('remove_from_cart');
    expect(confirmedType('wishlist', false)).toBe('add_to_wishlist');
    expect(confirmedType('wishlist', true)).toBe('remove_from_wishlist');
  });
});

describe('isRemovalRequest', () => {
  it('detects removal methods and paths', () => {
    expect(isRemovalRequest('DELETE', '/cart/1')).toBe(true);
    expect(isRemovalRequest('POST', '/gp/cart/remove')).toBe(true);
    expect(isRemovalRequest('POST', '/cart/add')).toBe(false);
    expect(isRemovalRequest('GET', '/cart')).toBe(false);
  });
});
