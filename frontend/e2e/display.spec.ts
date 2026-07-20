// Client-side DISPLAY prefs E2E: adjustable card font size + per-card timer.
// Drives the real SPA + real FSRS backend (the mock-mode banner would overlap
// the HUD gear). Font size and timer are localStorage prefs, applied live to
// the mounted card.

import { test, expect, type Locator, type Page } from "@playwright/test";

function activeCard(page: Page): Locator {
  return page.locator(".card--active:not(.card--out)");
}

/** Computed font-size (px) of the active card's shadow-DOM question glyph. */
async function frontFontPx(page: Page): Promise<number> {
  // Playwright's selector engine pierces open shadow roots.
  const front = activeCard(page).locator(".card__front");
  await expect(front).toBeVisible();
  return front.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
}

test("display prefs: font size scales the card, timer shows and toggles", async ({
  page,
}) => {
  await page.goto("/");

  // Enter the deck feed via the demo deck.
  const seedBtn = page.getByRole("button", { name: /Seed demo deck/i });
  await expect(seedBtn).toBeVisible();
  await seedBtn.click();

  const front = activeCard(page).locator(".card__front");
  await expect(front).toBeVisible();
  await expect(front).not.toBeEmpty();

  // Timer is visible by default and reads an elapsed time.
  const timer = page.locator(".feed__timer");
  await expect(timer).toBeVisible();
  await expect(timer).toHaveText(/^\d+\.\d+s$|^\d+:\d{2}$/);

  // Baseline font size at the default "中".
  const medium = await frontFontPx(page);

  // Open settings from the HUD gear.
  await page.locator(".hud__gear").click();
  const sheet = page.locator(".sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(".sheet__section-title")).toContainText("表示");

  // "大" enlarges the question glyph.
  await sheet.getByRole("button", { name: "文字サイズ 大" }).click();
  await expect.poll(() => frontFontPx(page)).toBeGreaterThan(medium);

  // "小" shrinks it below the medium baseline.
  await sheet.getByRole("button", { name: "文字サイズ 小" }).click();
  await expect.poll(() => frontFontPx(page)).toBeLessThan(medium);

  // Toggle the per-card timer off -> it hides entirely.
  const timerToggle = sheet.locator(".toggle-row", { hasText: "タイマー表示" }).locator("input");
  await timerToggle.uncheck();
  await expect(timer).toBeHidden();

  // Toggle it back on -> visible again.
  await timerToggle.check();
  await expect(timer).toBeVisible();
});
