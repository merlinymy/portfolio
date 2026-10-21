/**
 * The home page in a real browser (plan §9): the face loads, the six buttons open their panels,
 * and the page still works without JavaScript, without WebGL and on a phone.
 */
import { expect, test, type Page } from "@playwright/test";

const PANELS = [
  { id: "about", name: "About" },
  { id: "experience", name: "Experience" },
  { id: "projects", name: "Projects" },
  { id: "skills", name: "Skills" },
  { id: "resume", name: "Résumé" },
  { id: "contact", name: "Contact" },
];

function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return errors;
}

const button = (page: Page, name: string) => page.getByRole("link", { name, exact: true });

// On wide screens the buttons float with the face and never hold still, so Playwright's wait for
// a still target would never end; clicks skip that wait.
const click = { force: true };

test("the HTML carries every panel's text for crawlers", async ({ request }) => {
  const html = await (await request.get("/")).text();
  for (const { id } of PANELS) expect(html).toContain(`<section id="${id}"`);
});

test("the 3D face loads without errors", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/");
  await expect(page.locator('.face-stage[data-face="ready"]')).toBeAttached();
  await expect(page.locator(".face-canvas canvas")).toBeVisible();
  await page.waitForTimeout(1000);
  expect(errors).toEqual([]);
});

test("each button opens its panel, and Esc closes it", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".profile-nav.buttons-floating")).toBeAttached();
  for (const { id, name } of PANELS) {
    await button(page, name).click(click);
    const dialog = page.getByRole("dialog", { name });
    await expect(dialog).toBeVisible();
    expect(new URL(page.url()).hash).toBe(`#${id}`);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    // The address is cleared when the browser reports the panel closed, a moment later.
    await expect.poll(() => new URL(page.url()).hash).toBe("");
  }
});

test("a direct link opens its panel", async ({ page }) => {
  await page.goto("/#projects");
  await expect(page.getByRole("dialog", { name: "Projects" })).toBeVisible();
});

test("Back closes a panel, and Forward reopens it", async ({ page }) => {
  await page.goto("/");
  await button(page, "Skills").click(click);
  const dialog = page.getByRole("dialog", { name: "Skills" });
  await expect(dialog).toBeVisible();
  await page.goBack();
  await expect(dialog).toBeHidden();
  await page.goForward();
  await expect(dialog).toBeVisible();
});

test("the close button closes the panel", async ({ page }) => {
  await page.goto("/#contact");
  const dialog = page.getByRole("dialog", { name: "Contact" });
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("every panel is readable on the page", async ({ page }) => {
    await page.goto("/");
    for (const { name } of PANELS) {
      await expect(page.getByRole("heading", { level: 2, name, exact: true })).toBeVisible();
    }
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the buttons are big enough to tap, and panels fill the screen", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('.face-stage[data-face="ready"]')).toBeAttached();
    for (const { name } of PANELS) {
      const box = await button(page, name).boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await button(page, "About").tap();
    const dialog = page.getByRole("dialog", { name: "About" });
    // Measure after the panel has finished sliding in.
    await dialog.evaluate((d) => Promise.all(d.getAnimations().map((a) => a.finished)));
    const box = await dialog.boundingBox();
    expect(box).toMatchObject({ x: 0, y: 0, width: 390 });
  });
});
