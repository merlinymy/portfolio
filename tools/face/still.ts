/**
 * Renders the face's two still images from the built site, using the Chrome installed on this Mac:
 *
 *   apps/site/public/face/still.jpg    shown instead of the 3D face where a browser can't draw it
 *   apps/site/public/face/preview.jpg  the 1200 × 630 picture in link previews (LinkedIn, Slack…)
 *
 * Run `npm run build`, then `npm run face:still`, after anything that changes how the face looks;
 * then build again so the new images are in the site. The page's ?still mode holds the neutral
 * scanned face with no intro, so the pictures don't catch a blink.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { serveSite } from "../serve.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = join(ROOT, "apps/site/public/face");
const PORT = 4329;
const URL = `http://localhost:${PORT}/?still`;

if (!existsSync(join(ROOT, "apps/site/dist/index.html"))) {
  throw new Error("No built site in apps/site/dist. Run `npm run build` first.");
}
const server = await serveSite(PORT);

try {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const shoot = async (viewport: { width: number; height: number }, scale: number, hide: string, path: string) => {
      const page = await browser.newPage({ viewport, deviceScaleFactor: scale });
      await page.goto(URL);
      await page.locator('.face-stage[data-face="ready"]').waitFor({ state: "attached" });
      await page.addStyleTag({ content: `${hide} { visibility: hidden !important; }` });
      // Give the clip time to settle into the held neutral face.
      await page.waitForTimeout(1500);
      await page.screenshot({ path, type: "jpeg", quality: 82 });
      await page.close();
      console.log(`  ${path.slice(ROOT.length + 1)}`);
    };
    // The fallback image: the face alone, framed as the live face is on a wide screen.
    await shoot({ width: 900, height: 900 }, 1.5, ".hero, .profile-nav", join(OUT, "still.jpg"));
    // The link preview: the first screen with the name, without the buttons.
    await shoot({ width: 1200, height: 630 }, 1, ".profile-nav", join(OUT, "preview.jpg"));
  } finally {
    await browser.close();
  }
} finally {
  server.close();
}
