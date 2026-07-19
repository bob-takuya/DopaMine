// AnkiWeb sync E2E.
//
// Two paths:
//  (1) MOCK path (?mock=1): the local fake backend serves the happy path, so we
//      can drive login -> "synced" state -> "Sync now" -> success toast without
//      touching real AnkiWeb.
//  (2) REAL path (no ?mock): the Playwright backend runs the FSRS engine, under
//      which every /api/sync* route returns 501 SYNC_UNSUPPORTED. Opening the
//      panel must show the informational "needs Anki engine" note, not the form
//      and not a scary error.

import { test, expect } from "@playwright/test";

test("mock: log in, reach synced state, and sync now shows a success toast", async ({
  page,
}) => {
  await page.goto("/?mock=1");

  // Open the sync panel from the deck picker.
  await page.getByRole("button", { name: /AnkiWeb Sync/i }).click();
  const sheet = page.locator(".sync-sheet");
  await expect(sheet).toBeVisible();

  // Logged-out: the login form is shown (mock status -> logged_in:false).
  const user = sheet.locator('input[name="anki-username"]');
  const pass = sheet.locator('input[name="anki-password"]');
  await expect(user).toBeVisible();
  await expect(pass).toHaveAttribute("type", "password");

  // Log in with dummy creds (the mock accepts anything).
  await user.fill("demo@example.com");
  await pass.fill("hunter2");
  await sheet.getByRole("button", { name: /^Log in$/ }).click();

  // Logged-in state: identity line + Sync now + Log out. Password field cleared.
  await expect(sheet.locator(".sync-note--ok")).toContainText(/Synced as/);
  await expect(sheet.locator(".sync-note--ok")).toContainText(/AnkiWeb \(mock\)/);
  const syncNow = sheet.getByRole("button", { name: /^Sync now$/ });
  await expect(syncNow).toBeVisible();
  await expect(sheet.getByRole("button", { name: /^Log out$/ })).toBeVisible();

  // Sync now -> success toast (mock returns status:"ok").
  await syncNow.click();
  const toast = page.locator(".toast--success");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText(/Sync complete/i);
});

test("mock: full-sync download bootstrap confirms, toasts, and reloads decks", async ({
  page,
}) => {
  // Auto-accept the destructive confirm() dialog before it appears.
  page.on("dialog", (d) => void d.accept());

  await page.goto("/?mock=1");

  await page.getByRole("button", { name: /AnkiWeb Sync/i }).click();
  const sheet = page.locator(".sync-sheet");
  await expect(sheet).toBeVisible();

  // Log in (mock accepts anything) to reach the logged-in view.
  await sheet.locator('input[name="anki-username"]').fill("demo@example.com");
  await sheet.locator('input[name="anki-password"]').fill("hunter2");
  await sheet.getByRole("button", { name: /^Log in$/ }).click();
  await expect(sheet.locator(".sync-note--ok")).toContainText(/Synced as/);

  // Open the Advanced / bootstrap area and trigger a full download.
  await sheet.getByText("Advanced / bootstrap").click();
  const download = sheet.getByRole("button", {
    name: /AnkiWebから取り込む/,
  });
  await expect(download).toBeVisible();
  await download.click();

  // Success toast for the download bootstrap.
  const toast = page.locator(".toast--success");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText(/AnkiWebから取り込みました/);
});

test("real backend (fsrs): sync panel shows the 'needs Anki engine' 501 note", async ({
  page,
}) => {
  // No ?mock — hits the real backend. GET /api/sync/status 501s under FSRS.
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Seed demo deck/i })).toBeVisible();

  await page.getByRole("button", { name: /AnkiWeb Sync/i }).click();
  const sheet = page.locator(".sync-sheet");
  await expect(sheet).toBeVisible();

  // The 501 note replaces the form: no login inputs, an informational note.
  const info = sheet.locator(".sync-note--info");
  await expect(info).toBeVisible();
  await expect(info).toContainText(/needs the Anki engine/i);
  await expect(info).toContainText(/DOPAMINE_SRS_ENGINE=anki/);
  await expect(sheet.locator('input[name="anki-username"]')).toHaveCount(0);
});
