// @ts-check
import { defineConfig } from 'astro/config';

import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  // Canonical URLs, the sitemap, /llms.txt and /profile.md are all built from this.
  site: 'https://merlinyang.com',
  integrations: [react(), sitemap()]
});