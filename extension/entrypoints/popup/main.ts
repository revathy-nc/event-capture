import { browser } from 'wxt/browser';
import { exportEventsCsv } from '../../lib/export';
import { hostAllowed } from '../../lib/settings';
import type { Settings } from '../../lib/schema';

interface StatusResponse {
  settings?: Settings;
  status?: {
    enabled: boolean;
    stored: number;
  };
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let settings: Settings | null = null;
let currentHost: string | null = null;
let clearArmed = false;
let clearTimer: ReturnType<typeof setTimeout> | null = null;

async function send(message: Record<string, unknown>): Promise<StatusResponse> {
  return (await browser.runtime.sendMessage(message)) as StatusResponse;
}

async function loadCurrentHost(): Promise<void> {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    currentHost = tab?.url ? new URL(tab.url).hostname : null;
  } catch {
    currentHost = null;
  }
  $('host').textContent = currentHost ?? 'unavailable';
}

async function refresh(): Promise<void> {
  const response = await send({ kind: 'getStatus' });
  settings = response.settings ?? null;
  const status = response.status;

  $('state').textContent = status?.enabled ? 'capturing' : 'paused';
  $('state').classList.toggle('muted', !status?.enabled);
  const toggle = $<HTMLButtonElement>('toggle');
  toggle.textContent = status?.enabled ? 'Pause' : 'Enable';
  toggle.classList.toggle('primary', !status?.enabled);
  toggle.classList.toggle('danger', Boolean(status?.enabled));

  $('stored').textContent = String(status?.stored ?? 0);

  const allowButton = $<HTMLButtonElement>('allow');
  if (settings && currentHost) {
    const allowed = hostAllowed(currentHost, settings.allowlist);
    allowButton.disabled = allowed;
    allowButton.textContent = allowed ? 'Site allowed' : 'Allow site';
  }
}

async function main(): Promise<void> {
  $('version').textContent = `v${browser.runtime.getManifest().version}`;
  await loadCurrentHost();
  await refresh();

  $<HTMLButtonElement>('toggle').addEventListener('click', async () => {
    await send({ kind: 'setEnabled', enabled: !settings?.enabled });
    await refresh();
  });

  $<HTMLButtonElement>('allow').addEventListener('click', async () => {
    if (!currentHost) return;
    await send({ kind: 'addSite', host: currentHost });
    await refresh();
  });

  $<HTMLButtonElement>('export').addEventListener('click', async () => {
    try {
      const count = await exportEventsCsv();
      $('message').textContent = count > 0 ? `Exported ${count} events.` : 'No events to export.';
    } catch (error) {
      $('message').textContent = `Export failed: ${String(error)}`;
    }
  });

  $<HTMLButtonElement>('clear').addEventListener('click', async () => {
    const button = $<HTMLButtonElement>('clear');
    if (!clearArmed) {
      clearArmed = true;
      button.textContent = 'Confirm';
      $('message').textContent = 'Click Confirm to delete all events.';
      clearTimer = setTimeout(() => {
        clearArmed = false;
        button.textContent = 'Clear';
        $('message').textContent = '';
      }, 3000);
      return;
    }

    if (clearTimer) clearTimeout(clearTimer);
    clearArmed = false;
    button.textContent = 'Clear';
    await send({ kind: 'clear' });
    $('message').textContent = 'Cleared.';
    await refresh();
  });

  $('options').addEventListener('click', (event) => {
    event.preventDefault();
    void browser.runtime.openOptionsPage();
  });

  setInterval(() => void refresh(), 1500);
}

void main();
