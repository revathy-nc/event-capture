import { describe, expect, it } from 'vitest';
import { buildCsv, detailsFor, type StoredEvent } from './export';

function event(overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    schema_version: '1.0',
    extension_version: '0.3.0',
    event_id: 'evt-1',
    seq: 1,
    session_id: 'sess-1',
    visitor_id: 'vis-1',
    parent_event_id: null,
    client_ts: '2026-11-19T10:00:00.000Z',
    created_at: '2026-11-19T10:00:01.000Z',
    detection: { method: 'ui', confidence: 0.8 },
    site: { host: 'example.com', url: 'https://example.com/s', path: '/s' },
    page: { page_type: 'search_results', title: 't', referrer_path: '/', viewport: null },
    entity: { product_id: 'B0ABC12345', variant_id: null },
    type: 'search',
    payload: { query: 'green tee', filters: ['Prime'] },
    ...overrides,
  };
}

describe('detailsFor', () => {
  it('builds the compact detail object', () => {
    const details = detailsFor(event(), new Map());
    expect(details).toEqual({
      query: 'green tee',
      filters: ['Prime'],
      product_uuid: 'B0ABC12345',
      page_type: 'search_results',
    });
  });

  it('cross-fills the longest product title', () => {
    const titles = new Map([['B0ABC12345', 'Gildan Cotton T-Shirt']]);
    const details = detailsFor(event({ payload: {} }), titles);
    expect(details.product_title).toBe('Gildan Cotton T-Shirt');
  });

  it('adds seconds for dwell events', () => {
    const details = detailsFor(
      event({
        type: 'dwell_time',
        payload: { duration_ms_total: 45000, duration_ms_active: 40000 },
      }),
      new Map(),
    );
    expect(details.seconds).toBe(45);
  });
});

describe('buildCsv', () => {
  it('writes six quoted columns and escapes JSON', () => {
    const csv = buildCsv([event()]);
    const [header, row] = csv.split('\r\n');

    expect(header).toBe(
      '"event_id","session_id","type","details_json","client_timestamp","created_at"',
    );
    expect(row).toContain('"evt-1"');
    expect(row).toContain('"{""query"":""green tee""');
  });

  it('keeps one row per event', () => {
    const csv = buildCsv([event(), event({ event_id: 'evt-2' })]);
    expect(csv.split('\r\n')).toHaveLength(3);
  });
});
