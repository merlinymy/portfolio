/**
 * Browser tests for the site (plan §9), run with `npm run test:e2e`. They use the Chrome installed
 * on this Mac, against the built site in apps/site/dist, served by tools/serve.ts.
 */
import { defineConfig } from "@playwright/test";

const PORT = 4330;

export default defineConfig({
  testDir: "tests/e2e",
  use: { baseURL: `http://localhost:${PORT}`, channel: "chrome" },
  webServer: {
    command: `node tools/serve.ts ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
  },
});
