# event_capture

A single Manifest V3 browser extension that captures e-commerce events on
allowlisted sites, stores them locally in the browser, and exports them as one
CSV file. There is no server or collector process to start.

Design: [`docs/implementation-plan.md`](docs/implementation-plan.md).

## Requirements

- Node.js 20+ and npm
- Chrome / Chromium / Brave (any Chromium-based browser)

## Build and load

```bash
cd extension
npm install
npm run build        # → extension/.output/chrome-mv3
```

In your browser: `brave://extensions` (or `chrome://extensions`) → enable
**Developer mode** → **Load unpacked** → select:

```
extension/.output/chrome-mv3
```

After rebuilding, click the reload icon on the extension card.

For development with hot reload:

```bash
cd extension
npm run dev          # load extension/.output/chrome-mv3-dev
```

## Use

1. Open a shopping site.
2. Click the Event Capture icon → **Allow site** → **Enable**.
3. Browse normally: search, open products, change variants, add/remove cart items.
4. The popup shows **Stored events**.

### Export

Click **Export CSV** in the popup. One file is downloaded, e.g.
`events-2026-11-19.csv`, with these columns:

```
event_id, session_id, type, details_json, client_timestamp, created_at
```

`details_json` contains whichever apply: `query`, `filters`, `product_uuid`,
`product_title`, `page_type`, `seconds` (dwell only).

### Clear

Click **Clear** in the popup (with confirmation) to delete all stored events.

## Options

- **Allowed sites** — one host per line; exact hosts also match subdomains;
  `*` captures everything (not recommended).
- **Events** — per-event toggles.

## Where data lives

Events are stored in the extension's IndexedDB inside your browser profile.
They are not sent anywhere. Removing the extension or clearing its data deletes
them.

## Tests

```bash
cd extension
npm test
npx tsc --noEmit
```

## Layout

```
extension/     # WXT + TypeScript extension
docs/          # implementation plan
```

## Privacy

- No passwords, tokens, cookies, request headers, or full HTML pages.
- Cart/wishlist response bodies are capped at 4 KB.
- Only allowlisted hosts are captured.
- Intended for manual, internal analysis; respect target-site terms of service.
