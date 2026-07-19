// The two-slot vertical-swipe feed state machine (ARCHITECTURE §6).
//
// Invariants:
//  - At most two card slots: the active card and one prefetched card.
//  - A card moves question -> answer -> grading. Grading is ONLY possible from
//    the answer phase, and only the server's answer commits a grade.
//  - Input is locked while an answer request is pending.
//  - A failed answer keeps the SAME card visible and offers a retry that reuses
//    the SAME review_id (idempotent).
//  - On success: play the reward overlay, then animate the answered card out and
//    promote the prefetched card.
//  - No speculative grading offline: a network failure surfaces as a retry, not
//    a queued grade.

import type { ApiClient } from "./api.ts";
import { ApiError, makeReviewId } from "./api.ts";
import { cache } from "./cache.ts";
import { CardComponent } from "./components/card-view.ts";
import { RewardOverlay } from "./components/reward-overlay.ts";
import { effects } from "./effects.ts";
import type { Store } from "./store.ts";
import type { CardView, Rating } from "./types.ts";

const NO_DARK_BATCH = 10; // deliberate Continue gate every N reviews

export class Feed {
  readonly el: HTMLElement;
  private slots: HTMLElement;
  private overlayHost: HTMLElement;
  private overlay = new RewardOverlay();

  private active: CardComponent | null = null;
  private prefetched: CardView | null = null;
  private prefetchedEl: HTMLElement | null = null;

  private deck: string | null = null;
  private answering = false;
  private pendingReviewId: string | null = null;
  private pendingRating: Rating | null = null;
  private reviewsSinceContinue = 0;

  constructor(
    private api: ApiClient,
    private store: Store,
  ) {
    this.el = document.createElement("main");
    this.el.className = "feed";
    this.slots = document.createElement("div");
    this.slots.className = "feed__slots";
    this.overlayHost = this.overlay.el;
    this.el.append(this.slots, this.overlayHost);
    this.wireKeyboard();
  }

  async start(deck: string | null): Promise<void> {
    this.deck = deck;
    this.store.setActiveDeck(deck);
    this.reviewsSinceContinue = 0;
    await this.loadFirstCard();
  }

  private wireKeyboard(): void {
    window.addEventListener("keydown", (e) => {
      if (this.answering) return;
      this.active?.handleKey(e);
    });
  }

  // ---- Loading & prefetch --------------------------------------------------

  private async loadFirstCard(): Promise<void> {
    this.clearSlots();
    let card: CardView | null = null;
    try {
      const res = await this.api.getNextCard(this.deck ?? undefined);
      card = res.card;
    } catch (err) {
      this.showFatal(this.describe(err));
      return;
    }
    this.store.setMock(this.api.isMock());
    if (!card) {
      this.showDone();
      return;
    }
    this.mountActive(card);
    void cache.saveActiveCard(card);
  }

  private mountActive(card: CardView): void {
    const comp = new CardComponent(card, {
      onReveal: () => this.reveal(comp),
      onGrade: (r) => void this.submitGrade(comp, r),
    });
    this.active = comp;
    comp.el.classList.add("card--active");
    this.slots.appendChild(comp.el);
    requestAnimationFrame(() => comp.focus());
  }

  private reveal(comp: CardComponent): void {
    if (comp !== this.active) return;
    comp.reveal();
  }

  /** Fetch the next card into the prefetch slot (rendered off-screen below). */
  private async prefetchNext(): Promise<void> {
    try {
      const res = await this.api.getNextCard(this.deck ?? undefined);
      this.prefetched = res.card;
      if (res.card) {
        // Render a static peek of the next card behind the active one.
        const peek = document.createElement("article");
        peek.className = "card card--prefetch";
        peek.setAttribute("aria-hidden", "true");
        const deckTag = document.createElement("div");
        deckTag.className = "card__deck";
        deckTag.textContent = res.card.deck;
        const face = document.createElement("div");
        face.className = "card__face";
        const front = document.createElement("div");
        front.className = "card__front";
        front.innerHTML = res.card.front_html;
        face.appendChild(front);
        peek.append(deckTag, face);
        this.prefetchedEl?.remove();
        this.prefetchedEl = peek;
        this.slots.insertBefore(peek, this.slots.firstChild);
      }
    } catch {
      this.prefetched = null; // best-effort; promote will refetch
    }
  }

  // ---- Grading -------------------------------------------------------------

  private async submitGrade(comp: CardComponent, rating: Rating): Promise<void> {
    if (this.answering || comp !== this.active) return;
    if (comp.getPhase() !== "answer") return;

    // Proactive session-cap stop (server also enforces via 429).
    if (this.capReached()) {
      this.showCapStop();
      return;
    }

    this.answering = true;
    comp.setLocked(true);
    comp.setError(null);

    // One review_id per (card,rating) attempt; retries reuse it (idempotent).
    if (!this.pendingReviewId) {
      this.pendingReviewId = makeReviewId();
      this.pendingRating = rating;
    }
    const reviewId = this.pendingReviewId;
    const effectiveRating = this.pendingRating ?? rating;
    const card = comp.getCard();
    const levelBefore = this.store.state?.level ?? 1;

    try {
      const res = await this.api.answer({
        review_id: reviewId,
        card_id: card.card_id,
        rating: effectiveRating,
      });
      this.store.setMock(this.api.isMock());

      // Immediate grade "juice".
      const cfg = this.store.config;
      if (cfg.sound_enabled) effects.answerTick(effectiveRating, res.state.combo);
      if (cfg.haptics_enabled) effects.gradeHaptic(effectiveRating);
      effects.burst({ rating: effectiveRating });

      // Authoritative state — server version wins in the store.
      this.store.setState(res.state);
      void cache.saveState(res.state);

      // The scheduler has now advanced, so prefetch the *next* card concurrently
      // with the reward overlay so promotion is instant (the two-slot prefetch).
      const prefetchPromise = this.prefetchNext();

      // Reward overlay consumes events in order, then we advance.
      await this.overlay.play(res.rewards, {
        config: cfg,
        levelBefore,
        levelAfter: res.state.level,
      });

      this.pendingReviewId = null;
      this.pendingRating = null;
      await prefetchPromise;
      await this.advance();
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        this.showCapStop();
        this.answering = false;
        return;
      }
      if (err instanceof ApiError && err.status === 409) {
        // Stale / non-answerable card: the grade never committed. Drop the
        // review_id and refetch the scheduler's current card.
        this.pendingReviewId = null;
        this.pendingRating = null;
        this.answering = false;
        await this.loadFirstCard();
        return;
      }
      // Keep the card visible with a retry using the SAME review_id.
      comp.setError(this.describe(err), () => {
        this.answering = false;
        void this.submitGrade(comp, effectiveRating);
      });
      this.answering = false;
    } finally {
      if (this.pendingReviewId === null) this.answering = false;
    }
  }

  private async advance(): Promise<void> {
    const outgoing = this.active;
    this.reviewsSinceContinue += 1;

    // Animate the answered card out.
    if (outgoing) {
      outgoing.el.classList.add("card--out");
      window.setTimeout(() => outgoing.el.remove(), 420);
    }
    this.active = null;

    // No-dark-pattern: after a batch, require a deliberate Continue.
    if (
      this.store.config.no_dark_pattern_mode &&
      this.reviewsSinceContinue >= NO_DARK_BATCH
    ) {
      this.reviewsSinceContinue = 0;
      this.showContinueGate();
      return;
    }

    // Promote the prefetched card, or fetch fresh if we don't have one.
    let next = this.prefetched;
    this.prefetched = null;
    this.prefetchedEl?.remove();
    this.prefetchedEl = null;

    if (next === null) {
      try {
        const res = await this.api.getNextCard(this.deck ?? undefined);
        next = res.card;
      } catch (err) {
        this.showFatal(this.describe(err));
        return;
      }
    }
    this.store.setMock(this.api.isMock());

    if (!next) {
      this.showDone();
      return;
    }
    this.mountActive(next);
    void cache.saveActiveCard(next);
    // Refresh authoritative counts so the ring/cap stay accurate.
    void this.refreshState();
  }

  private async refreshState(): Promise<void> {
    try {
      const res = await this.api.getState();
      this.store.setState(res.state);
      this.store.setConfig(res.guardrails);
      this.store.setSrs(res.srs);
      void cache.saveState(res.state);
      void cache.saveConfig(res.guardrails);
      void cache.saveSrs(res.srs);
    } catch {
      /* non-fatal */
    }
  }

  // ---- Session cap ---------------------------------------------------------

  private capReached(): boolean {
    const cfg = this.store.config;
    const st = this.store.state;
    if (cfg.session_length_cap_minutes == null || !st?.session_started_at) return false;
    const started = Date.parse(st.session_started_at);
    const elapsedMin = (Date.now() - started) / 60_000;
    return elapsedMin >= cfg.session_length_cap_minutes;
  }

  // ---- Terminal / gate screens --------------------------------------------

  private clearSlots(): void {
    this.slots.innerHTML = "";
    this.active = null;
    this.prefetched = null;
    this.prefetchedEl = null;
    // Reaching a terminal/reload screen abandons any in-flight review_id so a
    // later grade on a different card never reuses a stale idempotency key.
    this.pendingReviewId = null;
    this.pendingRating = null;
    this.answering = false;
  }

  private screen(title: string, body: string, actionLabel?: string, onAction?: () => void): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "feed-screen";
    const h = document.createElement("h2");
    h.textContent = title;
    const p = document.createElement("p");
    p.textContent = body;
    wrap.append(h, p);
    if (actionLabel && onAction) {
      const btn = document.createElement("button");
      btn.className = "primary-btn";
      btn.type = "button";
      btn.textContent = actionLabel;
      btn.addEventListener("click", onAction);
      wrap.appendChild(btn);
    }
    return wrap;
  }

  private showDone(): void {
    this.clearSlots();
    const reviewed = this.store.state?.reviews_today ?? 0;
    this.slots.appendChild(
      this.screen(
        "You're all caught up 🎉",
        `No more cards due right now. You reviewed ${reviewed} today. Come back when new cards are due — that's the honest stopping cue.`,
        "Check again",
        () => void this.loadFirstCard(),
      ),
    );
  }

  private showCapStop(): void {
    this.clearSlots();
    const cap = this.store.config.session_length_cap_minutes;
    this.slots.appendChild(
      this.screen(
        "Session complete ⏱",
        `You hit your ${cap}-minute healthy-use limit. Taking a break is good for retention. You can extend deliberately if you choose.`,
        "Extend +10 min (new session)",
        () => void this.extendSession(),
      ),
    );
  }

  private showContinueGate(): void {
    this.clearSlots();
    this.slots.appendChild(
      this.screen(
        `Nice batch — ${NO_DARK_BATCH} reviews done`,
        "No-dark-pattern mode is on, so the feed pauses instead of auto-advancing forever. Continue when you're ready.",
        "Continue",
        () => void this.advanceAfterGate(),
      ),
    );
  }

  private async advanceAfterGate(): Promise<void> {
    this.clearSlots();
    await this.loadFirstCard();
  }

  private async extendSession(): Promise<void> {
    // Explicit user action starts a new session. We nudge the stored session
    // start forward locally and refetch authoritative state.
    const st = this.store.state;
    if (st) {
      this.store.setState({ ...st, session_started_at: new Date().toISOString() });
    }
    await this.refreshState();
    await this.loadFirstCard();
  }

  private showFatal(message: string): void {
    this.clearSlots();
    this.slots.appendChild(
      this.screen("Something went wrong", message, "Try again", () =>
        void this.loadFirstCard(),
      ),
    );
  }

  private describe(err: unknown): string {
    if (err instanceof ApiError) {
      if (err.status === 409) return "This card is no longer answerable — refetching.";
      return `${err.code}: ${err.message}`;
    }
    return err instanceof Error ? err.message : "Unknown error";
  }
}
