// Media + note-type CSS E2E: import an .apkg whose cards carry an <img> and a
// custom note-type stylesheet, study one, and assert that BOTH survive the round
// trip through the Shadow-DOM isolated renderer:
//   (a) the card image loads from /api/media/<name> (200 + naturalWidth > 0),
//   (b) the note-type CSS actually applies inside the shadow root — the `.word`
//       element computes to the styled cyan (#7cf === rgb(119, 204, 255)), which
//       is a color the DopaMine app chrome never uses, proving isolation worked.
//
// Like import.spec.ts this is allowed to FAIL LOUDLY if the backend media
// endpoint / css field isn't merged yet (image never loads, or css never
// applies). feed.spec.ts remains the must-pass core-loop spec and does not
// depend on media at all.

import { test, expect } from "@playwright/test";

const FIXTURE =
  "~/anki-addiction/backend/tests/fixtures/media_css.apkg";

// The fixture's own deck name (imported verbatim, no prefix) and the styled
// cyan the note-type CSS paints `.word` with.
const DECK = "Media::Styled";
const STYLED_CYAN = "rgb(119, 204, 255)"; // #7cf

test("imported card renders its media image and note-type CSS in a shadow root", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Seed demo deck/i })).toBeVisible();

  // Watch for the backend media request while we import + study.
  const mediaResponse = page.waitForResponse(
    (res) => res.url().includes("/api/media/dot.png"),
    { timeout: 30_000 },
  );

  // Import the fixture through the UI import input.
  await page.locator("input.import-input").setInputFiles(FIXTURE);

  const toast = page.locator(".toast--success");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText(new RegExp(`Imported \\d+ cards into ${DECK}`));

  // Enter the imported deck and mount its first card.
  const deckCard = page.locator(".deck-card", { hasText: DECK });
  await expect(deckCard).toBeVisible();
  await deckCard.click();

  const active = page.locator(".card--active:not(.card--out)");
  const face = active.locator(".card__face");
  await expect(face).toBeVisible();

  // (a) The image request to /api/media/dot.png returned 200 …
  const res = await mediaResponse;
  expect(res.status()).toBe(200);

  // … and the <img> inside the shadow root actually decoded (naturalWidth > 0).
  await expect
    .poll(
      () =>
        face.evaluate((host) => {
          const img = host.shadowRoot?.querySelector("img") as
            | HTMLImageElement
            | null;
          return img ? img.naturalWidth : 0;
        }),
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);

  // (b) The note-type CSS applied inside the shadow: `.word` computes to the
  // styled cyan (not the app default). Reaching into element.shadowRoot proves
  // the content lives in an isolated shadow tree, not the light DOM.
  const wordColor = await face.evaluate((host) => {
    const word = host.shadowRoot?.querySelector(".word");
    return word ? getComputedStyle(word).color : null;
  });
  expect(wordColor).toBe(STYLED_CYAN);

  // Sanity: the front lives in the shadow tree, so it must NOT be a light-DOM
  // child of the face host — confirming isolation rather than a plain innerHTML.
  const lightFront = await face.evaluate(
    (host) => host.querySelector(".card__front") !== null,
  );
  expect(lightFront).toBe(false);
});
