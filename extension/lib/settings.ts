import { browser } from 'wxt/browser';
import type { EventType, Settings } from './schema';

const ALL_EVENTS: EventType[] = [
  'search',
  'autocomplete_selected',
  'product_clicked',
  'product_viewed',
  'variant_selected',
  'page_viewed',
  'dwell_time',
  'add_to_cart',
  'remove_from_cart',
  'add_to_wishlist',
  'remove_from_wishlist',
];

const DEFAULT_EVENTS = Object.fromEntries(
  ALL_EVENTS.map((type) => [type, true]),
) as Record<EventType, boolean>;

function normalizeSettings(raw: Partial<Settings> | undefined): Settings {
  return {
    enabled: Boolean(raw?.enabled),
    allowlist: Array.isArray(raw?.allowlist) ? raw.allowlist : [],
    events: {
      ...DEFAULT_EVENTS,
      ...(raw?.events ?? {}),
    },
  };
}

export async function getSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get('settings');
  return normalizeSettings(stored.settings as Partial<Settings> | undefined);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next = normalizeSettings({ ...current, ...patch });
  await browser.storage.local.set({ settings: next });
  return next;
}

function normalizePattern(pattern: string): string {
  return pattern
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
}

export function hostAllowed(host: string, allowlist: string[]): boolean {
  if (!host) return false;
  const target = host.toLowerCase();
  return allowlist.some((raw) => {
    const pattern = normalizePattern(raw);
    if (!pattern) return false;
    if (pattern === '*') return true;
    if (pattern.startsWith('*.')) {
      const base = pattern.slice(2);
      return target === base || target.endsWith(`.${base}`);
    }
    return target === pattern || target.endsWith(`.${pattern}`);
  });
}
