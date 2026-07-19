// "Sync & finish" study flow E2E (MOCK path, ?mock=1).
//
// The mock backend reports logged_in:false until a mock login flips it to true
// (see mock.ts `syncStatus`/`syncLogin`). So we: open the sync panel, log in,
// close it, pick a deck, study one card, then tap "☁ 同期して終了" and assert the
// calm "完了" finish screen appears. sendBeacon-based leave-sync is deliberately
// suppressed in mock mode, so this spec only exercises the manual button.

import { test, expect, type Locator, type Page } from "@playwright/test";

function activeCard(page: Page): Locator {
  return page.locator(".card--active:not(.card--out)");
}

test("mock: log in, study a card, then '同期して終了' shows the 完了 screen", async ({
  page,
}) => {
  await page.goto("/?mock=1");

  // Log in through the sync panel so the mock reports logged_in:true.
  await page.getByRole("button", { name: /AnkiWeb Sync/i }).click();
  const sheet = page.locator(".sync-sheet");
  await expect(sheet).toBeVisible();
  await sheet.locator('input[name="anki-username"]').fill("demo@example.com");
  await sheet.locator('input[name="anki-password"]').fill("hunter2");
  await sheet.getByRole("button", { name: /^Log in$/ }).click();
  await expect(sheet.locator(".sync-note--ok")).toContainText(/Synced as/);

  // Close the panel and enter the deck feed.
  await sheet.getByRole("button", { name: /^Done$/ }).click();
  const deckCard = page.locator(".deck-card").first();
  await expect(deckCard).toBeVisible();
  await deckCard.click();

  // The sync-finish button is now available (logged in on the mock engine).
  const finishBtn = page.getByRole("button", { name: /同期して終了/ });
  await expect(finishBtn).toBeVisible();

  // Study exactly one card: reveal (Space) -> grade Good (3).
  const front = activeCard(page).locator(".card__front");
  await expect(front).toBeVisible();
  await expect(front).not.toBeEmpty();
  await page.keyboard.press("Space");
  await expect(activeCard(page).locator(".card__back")).toBeVisible();
  await page.keyboard.press("3");
  // Wait for the reward to confirm the review committed (session count -> 1).
  await expect(page.locator(".reward-float--xp")).toBeVisible();

  // Tap "☁ 同期して終了" -> the calm 完了 finish screen.
  await finishBtn.click();
  const finish = page.locator(".finish-sheet");
  await expect(finish).toBeVisible();
  await expect(finish).toContainText("完了");
  await expect(finish).toContainText("同期しました。タブを閉じてOKです。");
  await expect(finish.locator(".finish-summary")).toContainText(/このセッションの学習: \d+枚/);

  // "続ける" dismisses and keeps the user studying.
  await finish.getByRole("button", { name: /^続ける$/ }).click();
  await expect(finish).toHaveCount(0);
  await expect(activeCard(page)).toBeVisible();
});
