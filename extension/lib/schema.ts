export type EventType =
  | 'search'
  | 'autocomplete_selected'
  | 'product_clicked'
  | 'product_viewed'
  | 'variant_selected'
  | 'page_viewed'
  | 'dwell_time'
  | 'add_to_cart'
  | 'remove_from_cart'
  | 'add_to_wishlist'
  | 'remove_from_wishlist';

export type DetectionMethod = 'ui' | 'network' | 'derived';

export interface Detection {
  method: DetectionMethod;
  confidence: number;
}

export interface SiteInfo {
  host: string;
  url: string;
  path: string;
}

export interface PageInfo {
  page_type: string;
  title: string | null;
  referrer_path: string | null;
  viewport: { w: number; h: number } | null;
}

export interface EntityInfo {
  product_id: string | null;
  variant_id: string | null;
}

export interface CandidateEvent {
  event_id?: string;
  extension_version?: string;
  type: EventType;
  detection: Detection;
  site: SiteInfo;
  page: PageInfo;
  entity: EntityInfo;
  payload: Record<string, unknown>;
  parent_event_id?: string | null;
  client_ts?: string;
}

export interface EventEnvelope extends CandidateEvent {
  schema_version: '1.0';
  event_id: string;
  seq: number;
  session_id: string;
  visitor_id: string;
  parent_event_id: string | null;
  client_ts: string;
  created_at: string;
}

export interface Settings {
  enabled: boolean;
  /** Host patterns: exact host, `*.example.com`, or `*` for everything. */
  allowlist: string[];
  events: Record<EventType, boolean>;
}
