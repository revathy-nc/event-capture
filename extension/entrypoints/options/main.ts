import { browser } from 'wxt/browser';
import { getSettings, saveSettings } from '../../lib/settings';
import type { EventType } from '../../lib/schema';

const EVENT_LABELS: Record<EventType, string> = {
  search: 'search',
  autocomplete_selected: 'autocomplete_selected',
  product_clicked: 'product_clicked',
  product_viewed: 'product_viewed',
  variant_selected: 'variant_selected',
  page_viewed: 'page_viewed',
  dwell_time: 'dwell_time',
  add_to_cart: 'add_to_cart',
  remove_from_cart: 'remove_from_cart',
  add_to_wishlist: 'add_to_wishlist',
  remove_from_wishlist: 'remove_from_wishlist',
};

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

async function load(): Promise<void> {
  const settings = await getSettings();

  const allowlist = $<HTMLTextAreaElement>('allowlist');
  allowlist.value = settings.allowlist.join('\n');

  const container = $('events');
  container.innerHTML = '';
  for (const [type, label] of Object.entries(EVENT_LABELS) as [EventType, string][]) {
    const wrapper = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = settings.events[type] !== false;
    checkbox.dataset.event = type;
    wrapper.append(checkbox, document.createTextNode(label));
    container.append(wrapper);
  }
}

async function save(): Promise<void> {
  const allowlist = $<HTMLTextAreaElement>('allowlist')
    .value.split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const events = {} as Record<EventType, boolean>;
  for (const checkbox of Array.from(
    document.querySelectorAll<HTMLInputElement>('input[data-event]'),
  )) {
    events[checkbox.dataset.event as EventType] = checkbox.checked;
  }

  await saveSettings({ allowlist, events });
  $('save-status').textContent = 'Saved.';
  setTimeout(() => {
    $('save-status').textContent = '';
  }, 2000);
}

async function main(): Promise<void> {
  await load();
  $('save').addEventListener('click', () => void save());

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) void load();
  });
}

void main();
