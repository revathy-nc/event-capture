import { marketplaceAdapter } from './marketplace';
import type { SiteAdapter } from './types';

const ADAPTERS: SiteAdapter[] = [marketplaceAdapter];

export function resolveAdapter(url: URL = new URL(location.href)): SiteAdapter {
  return ADAPTERS.find((adapter) => adapter.matches(url)) ?? marketplaceAdapter;
}
