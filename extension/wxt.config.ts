import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'Event Capture',
    description: 'Capture e-commerce analytics events and export them as CSV.',
    version: '0.3.2',
    permissions: ['storage', 'tabs'],
    host_permissions: ['http://*/*', 'https://*/*'],
  },
});
