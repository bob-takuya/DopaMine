// Import E2E: upload a real .apkg through the UI, then study an imported card.
//
// This spec is intentionally allowed to FAIL LOUDLY if the backend import is
// not available (endpoint 501s / deck never appears): it asserts the success
// toast and the deck's presence in /api/decks. feed.spec.ts is the must-pass
// core-loop spec and does not depend on import.

import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";

const BACKEND = "http://localhost:8000";
const FIXTURE = fileURLToPath(
  new URL("../../backend/tests/fixtures/jlpt_n5.apkg", import.meta.url),
);

test("import an .apkg deck and study an imported card", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Seed demo deck/i })).toBeVisible();

  // Upload the fixture through the import input.
  await page.locator("input.import-input").setInputFiles(FIXTURE);

  // Success toast: "Imported N cards into Imported::JLPT N5".
  const toast = page.locator(".toast--success");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText(/Imported \d+ cards into Imported::JLPT N5/);

  // GET /api/decks now includes the imported deck with 12 cards.
  const decksRes = await request.get(`${BACKEND}/api/decks`);
  expect(decksRes.ok()).toBeTruthy();
  const decks = (await decksRes.json()).decks as Array<{
    name: string;
    due_count: number;
    total_count: number;
  }>;
  const imported = decks.find((d) => /Imported::JLPT N5/.test(d.name));
  expect(imported, "imported deck should appear in /api/decks").toBeTruthy();
  expect(imported!.total_count).toBe(12);

  // Study one imported card in the UI: the new deck now shows in the picker.
  const deckCard = page.locator(".deck-card", { hasText: "Imported::JLPT N5" });
  await expect(deckCard).toBeVisible();
  await deckCard.click();

  const active = page.locator(".card--active:not(.card--out)");
  await expect(active.locator(".card__front")).toBeVisible();
  await expect(active.locator(".card__front")).not.toBeEmpty();
  await page.keyboard.press("Space");
  await expect(active.locator(".card__back")).toBeVisible();
  await page.keyboard.press("3");
  await expect(page.locator(".reward-float--xp")).toBeVisible();
});
