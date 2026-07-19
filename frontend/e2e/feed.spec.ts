// Core-loop E2E: seed -> reveal -> grade -> reward -> combo reset -> persist.
// This is the must-pass spec: it drives the real backend (FSRS) and the real
// SPA end to end, asserting on real DOM/network events (no fixed sleeps).

import { test, expect, type Locator, type Page } from "@playwright/test";

const BACKEND = "http://localhost:8000";

/** The single active, non-outgoing card slot. */
function activeCard(page: Page): Locator {
  return page.locator(".card--active:not(.card--out)");
}

/** Reveal the current active card (Space) and grade it with a rating key. */
async function revealAndGrade(page: Page, key: "1" | "2" | "3" | "4"): Promise<void> {
  const card = activeCard(page);
  // Wait until a fresh card is mounted in the question phase.
  await expect(card.locator(".reveal-btn")).toBeVisible();
  await page.keyboard.press("Space");
  await expect(card.locator(".card__back")).toBeVisible();
  await page.keyboard.press(key);
}

/** Read the integer XP-into-level value out of the HUD label ("N / M XP"). */
async function xpInto(page: Page): Promise<number> {
  const text = (await page.locator(".hud__xp-label").textContent()) ?? "";
  const m = text.match(/^(\d+)\s*\//);
  return m ? Number(m[1]) : NaN;
}

test("core study loop: reveal, grade, reward, combo reset, persistence", async ({
  page,
  request,
}) => {
  await page.goto("/");

  // Seed the demo deck through the UI. The seed button also starts the feed.
  const seedBtn = page.getByRole("button", { name: /Seed demo deck/i });
  await expect(seedBtn).toBeVisible();
  await seedBtn.click();

  // First card renders with a non-empty front.
  const front = activeCard(page).locator(".card__front");
  await expect(front).toBeVisible();
  await expect(front).not.toBeEmpty();

  // HUD XP starts at 0.
  const xpLabel = page.locator(".hud__xp-label");
  await expect(xpLabel).toHaveText(/^0 \//);

  // Reveal via keyboard Space, then grade "Good" via key 3.
  await page.keyboard.press("Space");
  await expect(activeCard(page).locator(".card__back")).toBeVisible();
  await page.keyboard.press("3");

  // Reward overlay appears (the +XP floater) AND HUD XP increases from 0.
  await expect(page.locator(".reward-float--xp")).toBeVisible();
  await expect(xpLabel).not.toHaveText(/^0 \//);
  expect(await xpInto(page)).toBeGreaterThan(0);

  // Grade another "Good" to build the combo to 2 — the HUD combo indicator
  // only lights up at combo >= 2.
  await revealAndGrade(page, "3");
  const combo = page.locator(".hud__combo");
  await expect(combo).toHaveClass(/hud__combo--on/);
  await expect(combo).toContainText("COMBO");

  // Grade "Again" (key 1): combo resets to 0 and the indicator clears.
  await revealAndGrade(page, "1");
  await expect(combo).not.toHaveClass(/hud__combo--on/);
  await expect(combo).not.toContainText("COMBO");

  // Capture authoritative state, reload, and assert XP/version persisted.
  const before = await (await request.get(`${BACKEND}/api/state`)).json();
  expect(before.state.version).toBeGreaterThan(0);
  expect(before.state.total_xp).toBeGreaterThan(0);

  await page.reload();

  const after = await (await request.get(`${BACKEND}/api/state`)).json();
  expect(after.state.version).toBe(before.state.version);
  expect(after.state.total_xp).toBe(before.state.total_xp);

  // The reloaded UI reflects the persisted XP once we re-enter a deck.
  const deckCard = page.locator(".deck-card").first();
  await expect(deckCard).toBeVisible();
  await deckCard.click();
  await expect(page.locator(".hud__xp-label")).not.toHaveText(/^0 \//);
});
