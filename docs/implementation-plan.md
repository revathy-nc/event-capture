# Event Capture — Implementation Plan

## 1. Overview

A **single Manifest V3 browser extension** that captures a fixed set of
e-commerce events on allowlisted sites (own storefront and third-party
Amazon-like marketplaces), stores them locally inside the extension, and exports
them as one CSV file.

There is **no server or collector process**. The extension owns storage
(IndexedDB) and export (Blob download). Nothing needs to be started before
browsing.

### Out of scope

- Production analytics for all shoppers (an extension only sees installers).
- Automated/bulk scraping; capture is for manual, human browsing only.
- Capturing authentication data, cookies, headers, or full HTML pages.
- Centralised aggregation across machines/browsers.

---

## 2. Locked decisions

| Item | Decision |
|---|---|
| Events | `search`, `product_clicked`, `product_viewed`, `variant_selected`, `autocomplete_selected`, `page_viewed`, `dwell_time`, `add_to_cart`, `remove_from_cart`, `add_to_wishlist`, `remove_from_wishlist` |
| Dwell | Heartbeat/hybrid: 15s heartbeat + flush on hide/navigation; total, active, visible_ratio |
| Adapter | Amazon-like marketplace (ASIN / `data-asin` / `/dp/`), generic fallback |
| Runtime | Extension only — no collector, no endpoint, no background server |
| Storage | IndexedDB inside the extension; events kept until the user clears them |
| Export | One `all_events.csv` download from the popup (Blob + `<a download>`) |
| Privacy | Redaction gate before storage; no passwords/tokens/headers/full HTML |

No Parquet, no analysis CLI, no CSV-on-disk pipeline. Export is generated on
demand and saved wherever the browser puts downloads.

---

## 3. Event taxonomy and detection

Every event shares the common envelope (section 4) plus a type-specific
`payload`. `detection.method` is one of `ui`, `network`, `derived`;
`confidence` is `1.0` for exact selectors and `0.4–0.8` for heuristics.

| Event | Source of truth | Payload fields |
|---|---|---|
| `search` | Network (search API) preferred; UI/URL fallback | `query`, `normalized_query`, `result_count`, `page`, `filters[]`, `sort`, `origin` |
| `autocomplete_selected` | UI click on suggestion | `input_prefix`, `suggestion_text`, `suggestion_type`, `position`, `suggestion_id` |
| `product_clicked` | UI click on product card/link | `product_name`, `list_context`, `rank`, `list_query`, `url` |
| `product_viewed` | URL/PDP detection + DOM extraction | `product_name`, `category`, `brand`, `price`, `currency`, `in_stock`, `referrer_type`, `search_query` |
| `variant_selected` | UI click/change in variant widget, or short-label click to a different ASIN on a PDP | `dimension`, `previous_value`, `new_value`, `price`, `currency` |
| `page_viewed` | Navigation observer (full load + SPA) | `navigation_type`; referrer lives in `page.referrer_path` |
| `dwell_time` | Content-script timer + visibility + navigation hooks | `page_type`, `duration_ms_total`, `duration_ms_active`, `visible_ratio`, `heartbeat_index` |
| `add_to_cart` | Network cart confirmation; optimistic UI event | `quantity`, `unit_price`, `currency`, `cart_total_after`, `cart_item_count`, `source` |
| `remove_from_cart` | Network cart confirmation; optimistic UI event | `quantity_removed`, `remaining_qty`, `cart_total_after` |
| `add_to_wishlist` | UI click + network confirmation | `list_name`, `source` |
| `remove_from_wishlist` | UI click + network confirmation | `list_name`, `source` |

`product_id` / `variant_id` live in the envelope's `entity` block.

`search.filters` uses visible applied-filter labels when the adapter can find
them (e.g. "Prime", "Size: M"); otherwise it falls back to raw URL tokens.

### Amazon-like mapping

| Event | Detection specifics |
|---|---|
| `page_viewed` | `/dp/`, `/s`, `/cart`, `/gp/cart`, `/gp/aw/c`, `/checkout/cart`; 500ms path debounce |
| `search` | `k=`/`q=` URL, search submit, or same-host search response |
| `autocomplete_selected` | suggestion elements (`[role=option]`, `.s-suggestion`, …) |
| `product_clicked` | `[data-asin]` tiles or `/dp/` links; rank among results |
| `product_viewed` | ASIN from `/dp/`/`#ASIN`; title, brand, category, price |
| `variant_selected` | twister/variation widgets, or short-label click to a different ASIN |
| `add_to_cart` | add controls + cart API response |
| `remove_from_cart` | cart page/mini-cart remove controls + cart API response |
| wishlist | wishlist controls, toggle state, wishlist API response |

---

## 4. Data model

### Envelope

```json
{
  "schema_version": "1.0",
  "extension_version": "0.3.0",
  "event_id": "01JC4X8Z6R9K3M2P7Q1V5T0WBN",
  "seq": 42,
  "session_id": "a3f1…c9",
  "visitor_id": "7b2e…11",
  "parent_event_id": null,
  "client_ts": "2026-11-19T14:36:02.441Z",
  "created_at": "2026-11-19T14:36:02.703Z",
  "detection": { "method": "ui", "confidence": 0.7 },
  "site": { "host": "www.amazon.com", "url": "…", "path": "/s" },
  "page": {
    "page_type": "search_results",
    "title": "…",
    "referrer_path": "/",
    "viewport": { "w": 1440, "h": 900 }
  },
  "entity": { "product_id": "B0ABC123", "variant_id": null },
  "type": "search",
  "payload": {}
}
```

- `created_at` is recorded locally by the background worker at ingest time.
- `event_id` is generated client-side (content where correlation is needed,
  otherwise background); used for dedupe and parent links.
- `seq` is monotonic per session.
- `session_id` rolls over after 30 minutes idle; `visitor_id` persists.

---

## 5. Architecture

```
content script (isolated world)
  → capture-phase listeners: click, submit, keydown, change, visibilitychange
  → navigation observer (history.pushState/replaceState + popstate)
  → dwell timer (heartbeat)
  → adapter dispatch (URL → SiteAdapter)
main-world script
  → patch fetch/XHR → postMessage request metadata (+ allowlisted bodies)
service worker
  → session/visitor IDs, redaction gate, event IDs
  → writes each event to IndexedDB (archive)
popup
  → enable/pause, allow site, stored-event count
  → Export CSV, Clear events
options page
  → domain allowlist, per-event toggles
```

No network send path. The service worker only persists.

---

## 6. Repository layout

```
event_capture/
├── extension/                       # WXT + TypeScript (Manifest V3)
│   ├── wxt.config.ts
│   ├── package.json
│   ├── tsconfig.json
│   ├── entrypoints/
│   │   ├── background.ts            # IDs, redaction, IndexedDB archive
│   │   ├── content.ts               # nav, search, autocomplete, dwell, product, cart
│   │   ├── page-bridge.content.ts   # fetch/XHR metadata + allowlisted bodies
│   │   ├── popup/                   # status, Export CSV, Clear events
│   │   └── options/                 # allowlist, event toggles
│   └── lib/
│       ├── schema.ts
│       ├── settings.ts
│       ├── storage.ts               # IndexedDB event archive
│       ├── export.ts                # CSV build + Blob download (+ test)
│       ├── cart.ts                  # cart/wishlist helpers (+ test)
│       ├── redact.ts                # (+ redact.test.ts)
│       └── adapters/
│           ├── types.ts
│           ├── marketplace.ts       # Amazon-like extraction (+ tests)
│           └── index.ts
├── docs/
│   └── implementation-plan.md
└── README.md
```

The local FastAPI collector, analysis CLI, Python tests, `pyproject.toml`,
`main.py`, `uv.lock`, and `.python-version` are removed.

---

## 7. Storage and export

### Storage

- IndexedDB database `event-capture`, object store `events` (keyPath `event_id`).
- Every event is written once and kept until the user clears it.
- IndexedDB avoids localStorage's ~5 MB limit and handles large histories.
- No automatic expiry; the user controls deletion via **Clear events**.

### Export

Popup **Export CSV** produces one file, `all_events.csv`, with six columns:

| Column | Source |
|---|---|
| `event_id` | `event_id` |
| `session_id` | `session_id` |
| `type` | `type` |
| `details_json` | compact JSON of `query`, `filters`, `product_uuid`, `product_title`, `page_type`, `seconds` (dwell only) |
| `client_timestamp` | `client_ts` |
| `created_at` | `created_at` |

- `product_title` is cross-filled per `product_uuid` from any event that
  captured a title (longest wins).
- Export is generated in the popup from IndexedDB and downloaded via a Blob URL.
- Empty details keys are omitted. Raw IndexedDB records keep every field.

---

## 8. Privacy and redaction

`redact.ts` runs in the background before an event is stored:

- Drops password, email, phone, name, card input values.
- Drops auth tokens, cookies, and request/response headers.
- Strips token-like query params (`token`, `sessionid`, `auth`, `sig`, …).
- Captures no raw keystrokes outside search inputs, clipboard, or mouse movement.
- Caps allowlisted cart/wishlist response bodies (4 KB) and never stores full
  HTML pages.
- Only allowlisted hosts are captured.
- Text is truncated (~120 chars), queries (~200), URLs (~500).

Identity is limited to the generated `visitor_id`. No external transmission:
data stays in the browser profile.

---

## 9. Implementation phases

### Phase 0 — walking skeleton (done)
Extension scaffold, storage, `page_viewed`, `product_clicked`, popup/options.

### Phase 1 — search intent and dwell (done)
Redaction gate, `search`, `autocomplete_selected`, `dwell_time`, page-bridge
request metadata.

### Phase 2 — catalog engagement (done)
Marketplace adapter, `product_viewed`, `variant_selected`, click → view →
variant correlation (sessionStorage for cross-page clicks).

### Phase 3 — commerce actions (done)
Allowlisted cart/wishlist response bodies, `add_to_cart`,
`remove_from_cart`, `add_to_wishlist`, `remove_from_wishlist`, optimistic UI +
network confirmation, Amazon button-wrapper and `/gp/cart` fixes, variant
short-label fallback.

### Phase 4 — export (done)
Single six-column CSV (stable `details_json`), product-title cross-fill.

### Phase 5 — extension-only consolidation (done)
- Remove the collector server, analysis CLI, Python tooling, and all send/retry
  logic.
- Move event persistence to a permanent IndexedDB archive with local
  `created_at`.
- Add **Export CSV** and **Clear events** to the popup.
- Simplify options to allowlist + event toggles.
- Update README and this plan.

---

## 10. Testing

- `npm test` — redaction, cart helpers, adapter parsing/classification.
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`.
- `npm run build` — WXT production build.
- Manual: load unpacked, capture events, export CSV, verify columns/rows, clear
  events, confirm count returns to zero.

---

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Data lost on extension uninstall/clear | Export regularly; document this in README |
| Large histories slow export | Export builds in memory; can add date filters later |
| Third-party ToS / legal | Manual internal use only; documented policy |
| Obfuscated, changing DOM | Multiple selectors + confidence scores + short-label fallbacks |
| MV3 worker death | IndexedDB persistence; no in-memory-only state |
| SPA double-fire | 500ms path debounce |
| PII leakage | Redaction gate + tests + host allowlist |

---

## 12. Known limitations

- Browser-profile-only storage; no cross-device aggregation.
- `product_viewed` fires at page load; heavily client-rendered SPAs may need a
  retry/settle delay.
- `variant_selected` records the pre-switch ASIN plus the new variant value.
- Cart confirmation depends on cart-like request URLs; GraphQL/WebSocket-only
  sites may yield only the optimistic UI event.
- Wishlist toggles without recognizable state may be missed.
- No manual browser smoke test recorded for all phases.

---

## 13. Open items

- Date/session filter for CSV export (optional).
- Storage cap / prune-oldest option (optional).
- Own-site (Faya) adapter.
- Additional site adapters.
- Optional Playwright smoke test.
