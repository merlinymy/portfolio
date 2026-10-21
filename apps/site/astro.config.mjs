// @ts-check
import { defineConfig } from 'astro/config';

import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  // Canonical URLs, the sitemap, /llms.txt and /profile.md are all built from this.
  site: 'https://merlinyang.com',
  integrations: [react(), sitemap()],
  vite: {
    server: {
      // `npm run dev` only: the lab's "Say" box reaches the model server on this Mac (npm run voice)
      // through here, so phones on the same Wi-Fi work too. The model server itself stays private
      // to this Mac, and the built site has no such route.
      proxy: {
        '/models': { target: 'http://127.0.0.1:8790', rewrite: (path) => path.replace(/^\/models/, '') },
      },
    },
  },
});