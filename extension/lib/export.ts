import type { EventEnvelope } from './schema';
import { getAllEvents } from './storage';

export type StoredEvent = EventEnvelope;

const HEADER = [
  'event_id',
  'session_id',
  'type',
  'details_json',
  'client_timestamp',
  'created_at',
];

function cell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function collectTitles(events: StoredEvent[]): Map<string, string> {
  const titles = new Map<string, string>();
  for (const event of events) {
    const productId = event.entity?.product_id;
    const name = event.payload?.product_name;
    if (!productId || typeof name !== 'string') continue;
    const trimmed = name.trim();
    if (trimmed && trimmed.length > (titles.get(productId)?.length ?? 0)) {
      titles.set(productId, trimmed);
    }
  }
  return titles;
}

export function detailsFor(event: StoredEvent, titles: Map<string, string>): Record<string, unknown> {
  const payload = event.payload ?? {};
  const page = event.page ?? {};
  const productId = event.entity?.product_id ?? null;
  const details: Record<string, unknown> = {};

  if (payload.query != null) details.query = payload.query;
  if (Array.isArray(payload.filters) && payload.filters.length > 0) {
    details.filters = payload.filters;
  }
  if (productId) {
    details.product_uuid = productId;
    let title = typeof payload.product_name === 'string' ? payload.product_name.trim() : '';
    const known = titles.get(productId);
    if (known && known.length > title.length) title = known;
    if (title) details.product_title = title;
  }
  if (page.page_type) details.page_type = page.page_type;
  if (event.type === 'dwell_time' && typeof payload.duration_ms_total === 'number') {
    details.seconds = Math.round((payload.duration_ms_total / 1000) * 1000) / 1000;
  }

  return details;
}

export function buildCsv(events: StoredEvent[]): string {
  const titles = collectTitles(events);
  const lines = [HEADER.map(cell).join(',')];

  for (const event of events) {
    lines.push(
      [
        cell(event.event_id),
        cell(event.session_id),
        cell(event.type),
        cell(JSON.stringify(detailsFor(event, titles))),
        cell(event.client_ts),
        cell(event.created_at),
      ].join(','),
    );
  }

  return lines.join('\r\n');
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function exportEventsCsv(): Promise<number> {
  const events = await getAllEvents<StoredEvent>();
  if (events.length === 0) return 0;

  const blob = new Blob([buildCsv(events)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `events-${today()}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  return events.length;
}
