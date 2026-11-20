import { describe, expect, it } from 'vitest';
import { isSensitiveKey, redactCandidate, redactDeep, redactText, redactUrl } from './redact';
import type { CandidateEvent } from './schema';

function candidate(overrides: Partial<CandidateEvent> = {}): CandidateEvent {
  return {
    type: 'search',
    detection: { method: 'ui', confidence: 0.8 },
    site: {
      host: 'www.amazon.com',
      url: 'https://www.amazon.com/s?k=green+tee&token=abc',
      path: '/s',
    },
    page: {
      page_type: 'search_results',
      title: '  green   tee  ',
      referrer_path: '/',
      viewport: { w: 1440, h: 900 },
    },
    entity: { product_id: null, variant_id: null },
    payload: { query: 'green tee' },
    ...overrides,
  };
}

describe('redactText', () => {
  it('collapses whitespace, strips control chars, and truncates', () => {
    expect(redactText('  a\n\tb  ', 10)).toBe('a b');
    expect(redactText('x'.repeat(300), 20)).toHaveLength(20);
  });
});

describe('redactUrl', () => {
  it('removes sensitive query params', () => {
    const url = redactUrl('https://example.com/s?k=tee&token=secret&sessionid=1&design=ok');
    expect(url).toContain('k=tee');
    expect(url).toContain('design=ok');
    expect(url).not.toContain('token=secret');
    expect(url).not.toContain('sessionid=1');
  });

  it('keeps relative paths relative and still strips tokens', () => {
    const url = redactUrl('/dp/B0ABC?auth=zzz&ok=1');
    expect(url.startsWith('/dp/B0ABC')).toBe(true);
    expect(url).not.toContain('auth=zzz');
    expect(url).toContain('ok=1');
  });
});

describe('redactDeep', () => {
  it('drops sensitive keys recursively', () => {
    const result = redactDeep({
      query: 'green tee',
      password: 'hunter2',
      nested: { email: 'user@example.com', keep: 'yes' },
      list: [{ token: 'abc' }, 'value'],
    }) as Record<string, unknown>;

    expect(result.password).toBeUndefined();
    expect(result.nested).toEqual({ keep: 'yes' });
    expect(result.list).toEqual(['value']);
  });

  it('detects sensitive keys', () => {
    expect(isSensitiveKey('password')).toBe(true);
    expect(isSensitiveKey('cardNumber')).toBe(true);
    expect(isSensitiveKey('query')).toBe(false);
  });
});

describe('redactCandidate', () => {
  it('sanitizes site, page, and payload', () => {
    const result = redactCandidate(candidate());
    expect(result.site.url).not.toContain('token=secret');
    expect(result.page.title).toBe('green tee');
    expect(result.payload).toEqual({ query: 'green tee' });
  });

  it('rewrites url payload fields', () => {
    const result = redactCandidate(
      candidate({ payload: { url: 'https://example.com/dp/123?auth=zzz&ok=1' } }),
    );
    expect(result.payload.url).toContain('ok=1');
    expect(result.payload.url).not.toContain('auth=zzz');
  });
});
