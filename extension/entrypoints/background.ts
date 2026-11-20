import { browser } from 'wxt/browser';
import { redactCandidate } from '../lib/redact';
import { getSettings, hostAllowed, saveSettings } from '../lib/settings';
import { clearEvents, countEvents, saveEvent } from '../lib/storage';
import type { CandidateEvent, EventEnvelope, EventType } from '../lib/schema';

const SESSION_IDLE_MS = 30 * 60 * 1000;

interface SessionState {
  id: string;
  seq: number;
  lastActivity: number;
}

let identityChain: Promise<unknown> = Promise.resolve();

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    handleMessage(message)
      .then(sendResponse)
      .catch((error: unknown) => sendResponse({ ok: false, error: String(error) }));
    return true;
  });
});

async function handleMessage(message: unknown): Promise<Record<string, unknown>> {
  const msg = (message ?? {}) as Record<string, unknown>;

  switch (msg.kind) {
    case 'event':
      await ingest(msg.event as CandidateEvent);
      return { ok: true };

    case 'getStatus': {
      const settings = await getSettings();
      return {
        ok: true,
        settings,
        status: {
          enabled: settings.enabled,
          stored: await countEvents(),
        },
      };
    }

    case 'setEnabled':
      await saveSettings({ enabled: Boolean(msg.enabled) });
      return { ok: true };

    case 'addSite': {
      const host = String(msg.host ?? '').trim();
      const settings = await getSettings();
      if (host && !hostAllowed(host, settings.allowlist)) {
        await saveSettings({ allowlist: [...settings.allowlist, host] });
      }
      return { ok: true };
    }

    case 'clear':
      await clearEvents();
      return { ok: true };

    default:
      return { ok: false, error: `unknown message kind: ${String(msg.kind)}` };
  }
}

async function nextIdentity(): Promise<{
  session_id: string;
  visitor_id: string;
  seq: number;
}> {
  const task = identityChain.then(async () => {
    const now = Date.now();
    const stored = (await browser.storage.local.get(['session', 'visitor_id'])) as {
      session?: SessionState;
      visitor_id?: string;
    };

    let session = stored.session;
    if (!session || now - session.lastActivity > SESSION_IDLE_MS) {
      session = { id: crypto.randomUUID(), seq: 0, lastActivity: now };
    }
    session.seq += 1;
    session.lastActivity = now;

    const visitorId = stored.visitor_id ?? crypto.randomUUID();
    await browser.storage.local.set({ session, visitor_id: visitorId });

    return { session_id: session.id, visitor_id: visitorId, seq: session.seq };
  });

  identityChain = task.catch(() => undefined);
  return task;
}

async function ingest(candidate: CandidateEvent | undefined): Promise<void> {
  if (!candidate || !candidate.type || !candidate.site) return;

  const safeCandidate = redactCandidate(candidate);
  const settings = await getSettings();
  if (!settings.enabled) return;
  if (!hostAllowed(safeCandidate.site.host, settings.allowlist)) return;
  if (settings.events[safeCandidate.type as EventType] === false) return;

  const identity = await nextIdentity();
  const event: EventEnvelope = {
    schema_version: '1.0',
    extension_version: browser.runtime.getManifest().version,
    event_id: safeCandidate.event_id ?? crypto.randomUUID(),
    seq: identity.seq,
    session_id: identity.session_id,
    visitor_id: identity.visitor_id,
    parent_event_id: safeCandidate.parent_event_id ?? null,
    client_ts: safeCandidate.client_ts ?? new Date().toISOString(),
    created_at: new Date().toISOString(),
    detection: safeCandidate.detection ?? { method: 'ui', confidence: 0.6 },
    site: safeCandidate.site,
    page: safeCandidate.page,
    entity: safeCandidate.entity ?? { product_id: null, variant_id: null },
    type: safeCandidate.type,
    payload: safeCandidate.payload ?? {},
  };

  await saveEvent(event);
}
