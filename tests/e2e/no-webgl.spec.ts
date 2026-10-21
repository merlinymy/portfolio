/**
 * A browser that can't draw 3D (plan §5.3, §9): the still image stands in and the panels work.
 * Its own file, because Playwright only allows browser launch options at a file's top level.
 */
import { expect, test } from "@playwright/test";

test.use({ launchOptions: { args: ["--disable-3d-apis"] } });

test("the still image shows and the panels work", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('.face-stage[data-face="still"] img.face-still')).toBeVisible();
  await page.getByRole("link", { name: "Contact", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Contact" })).toBeVisible();
});
