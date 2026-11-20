import type { CandidateEvent } from './schema';

const TEXT_LIMIT = 120;
const QUERY_LIMIT = 200;
const TITLE_LIMIT = 200;
const URL_LIMIT = 500;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

const SENSITIVE_KEYS = new Set([
  'password',
  'passwd',
  'pass',
  'email',
  'e-mail',
  'phone',
  'tel',
  'card',
  'cardnumber',
  'card_number',
  'cvv',
  'cvc',
  'ssn',
  'authorization',
  'cookie',
  'set-cookie',
  'token',
  'secret',
  'api_key',
  'apikey',
]);

const SENSITIVE_PARAMS = new Set([
  'token',
  'access_token',
  'id_token',
  'session',
  'sessionid',
  'session_id',
  'auth',
  'authorization',
  'sig',
  'signature',
  'key',
  'apikey',
  'api_key',
  'password',
  'pass',
  'email',
  'secret',
]);

export function redactText(value: string, limit = TEXT_LIMIT): string {
  return value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function redactUrl(raw: string | null | undefined): string {
  if (!raw) return '';

  const isAbsolute = /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//');
  if (!isAbsolute) {
    const [path, query = ''] = raw.split('?');
    const params = new URLSearchParams(query);
    for (const key of Array.from(params.keys())) {
      if (SENSITIVE_PARAMS.has(key.toLowerCase())) params.delete(key);
    }
    const rest = params.toString();
    return `${path}${rest ? `?${rest}` : ''}`.slice(0, URL_LIMIT);
  }

  try {
    const url = new URL(raw, 'https://redacted.invalid');
    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
    return url.toString().slice(0, URL_LIMIT);
  } catch {
    return raw.replace(CONTROL_CHARS, '').slice(0, URL_LIMIT);
  }
}

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    SENSITIVE_KEYS.has(normalized) ||
    /(password|passwd|card|cvv|cvc|token|secret|authorization|cookie)/.test(normalized)
  );
}

/**
 * Recursively strips sensitive keys and truncates strings. Used on every
 * payload before it leaves the page.
 */
export function redactDeep(value: unknown, key?: string): unknown {
  if (key && isSensitiveKey(key)) return undefined;

  if (typeof value === 'string') {
    if (key && /url|href/i.test(key)) return redactUrl(value);
    const limit = key && /query|search|^q$/i.test(key) ? QUERY_LIMIT : TEXT_LIMIT;
    return redactText(value, limit);
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => redactDeep(item))
      .filter((item) => item !== undefined)
      .filter((item) => !(item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 0));
  }

  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const redacted = redactDeep(childValue, childKey);
      if (redacted !== undefined) output[childKey] = redacted;
    }
    return output;
  }

  return value;
}

export function redactCandidate(event: CandidateEvent): CandidateEvent {
  return {
    ...event,
    site: {
      host: redactText(event.site.host, 200),
      url: redactUrl(event.site.url),
      path: redactText(event.site.path, URL_LIMIT),
    },
    page: {
      ...event.page,
      title: event.page.title ? redactText(event.page.title, TITLE_LIMIT) : null,
      referrer_path: event.page.referrer_path
        ? redactText(event.page.referrer_path, URL_LIMIT)
        : null,
    },
    entity: {
      product_id: event.entity.product_id ? redactText(event.entity.product_id, 128) : null,
      variant_id: event.entity.variant_id ? redactText(event.entity.variant_id, 128) : null,
    },
    payload: (redactDeep(event.payload) as Record<string, unknown>) ?? {},
  };
}

/**
 * True for inputs whose values must never be captured (passwords, payment,
 * contact and identity fields). Search inputs are not sensitive.
 */
export function isSensitiveInput(element: Element): boolean {
  const input = element.closest('input, textarea, select');
  if (!input) return false;

  if (input instanceof HTMLInputElement) {
    const type = input.type.toLowerCase();
    if (['password', 'email', 'tel', 'hidden'].includes(type)) return true;
  }

  const autocomplete = (input.getAttribute('autocomplete') ?? '').toLowerCase();
  if (/cc-|current-password|new-password|one-time-code/.test(autocomplete)) return true;

  const name = `${input.getAttribute('name') ?? ''} ${input.id}`.toLowerCase();
  return /(password|passwd|card|cvv|cvc|email|phone|ssn|token)/.test(name);
}
