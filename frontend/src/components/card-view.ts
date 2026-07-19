// Renders a single feed card: front_html, tap/swipe-up to reveal back_html, then
// the four grade buttons. Keyboard: Space reveals, 1-4 grade (ARCHITECTURE §6).
//
// The component is a dumb view: it emits intent (reveal / grade) via callbacks
// and never talks to the API or mutates game state itself.

import { RATING_LABEL, type CardView, type Rating } from "../types.ts";

type Phase = "question" | "answer";

export interface CardCallbacks {
  onReveal: () => void;
  onGrade: (rating: Rating) => void;
}

const RATING_ORDER: Rating[] = [1, 2, 3, 4];

export class CardComponent {
  readonly el: HTMLElement;
  private card: CardView;
  private phase: Phase = "question";
  private locked = false;
  private cb: CardCallbacks;
  private pointerStartY: number | null = null;

  constructor(card: CardView, cb: CardCallbacks) {
    this.card = card;
    this.cb = cb;
    this.el = document.createElement("article");
    this.el.className = "card";
    this.el.tabIndex = 0;
    this.el.setAttribute("role", "group");
    this.el.setAttribute("aria-label", `Card in ${card.deck}`);
    this.render();
    this.wireGestures();
  }

  getCard(): CardView {
    return this.card;
  }

  getPhase(): Phase {
    return this.phase;
  }

  /** Lock input while an answer request is pending. */
  setLocked(locked: boolean): void {
    this.locked = locked;
    this.el.classList.toggle("card--locked", locked);
    for (const b of Array.from(this.el.querySelectorAll<HTMLButtonElement>(".grade-btn"))) {
      b.disabled = locked;
    }
  }

  /** Show a retry affordance after a failed answer (same review_id upstream). */
  setError(message: string | null, onRetry?: () => void): void {
    const existing = this.el.querySelector(".card__error");
    if (existing) existing.remove();
    if (!message) return;
    const box = document.createElement("div");
    box.className = "card__error";
    const span = document.createElement("span");
    span.textContent = message;
    const retry = document.createElement("button");
    retry.className = "retry-btn";
    retry.textContent = "Retry";
    retry.addEventListener("click", (e) => {
      e.stopPropagation();
      onRetry?.();
    });
    box.append(span, retry);
    this.el.appendChild(box);
  }

  reveal(): void {
    if (this.phase === "answer" || this.locked) return;
    this.phase = "answer";
    this.el.classList.add("card--revealed");
    this.render();
  }

  grade(rating: Rating): void {
    if (this.phase !== "answer" || this.locked) return;
    this.cb.onGrade(rating);
  }

  /** Route a keyboard event (delegated from the feed for the active card). */
  handleKey(e: KeyboardEvent): void {
    if (this.locked) return;
    if (e.code === "Space" || e.key === " ") {
      e.preventDefault();
      if (this.phase === "question") this.cb.onReveal();
      return;
    }
    if (this.phase === "answer" && e.key >= "1" && e.key <= "4") {
      e.preventDefault();
      this.cb.onGrade(Number(e.key) as Rating);
    }
  }

  focus(): void {
    this.el.focus({ preventScroll: true });
  }

  private wireGestures(): void {
    // Tap anywhere on the question to reveal.
    this.el.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest("button")) return; // buttons handle themselves
      if (this.phase === "question" && !this.locked) this.cb.onReveal();
    });

    // Pointer swipe-up to reveal (question phase only).
    this.el.addEventListener("pointerdown", (e) => {
      this.pointerStartY = e.clientY;
    });
    this.el.addEventListener("pointerup", (e) => {
      if (this.pointerStartY === null) return;
      const dy = this.pointerStartY - e.clientY;
      this.pointerStartY = null;
      if (this.phase === "question" && !this.locked && dy > 60) {
        this.cb.onReveal();
      }
    });
  }

  private render(): void {
    this.el.innerHTML = "";

    const deckTag = document.createElement("div");
    deckTag.className = "card__deck";
    deckTag.textContent = this.card.deck;
    this.el.appendChild(deckTag);

    const face = document.createElement("div");
    face.className = "card__face";

    const front = document.createElement("div");
    front.className = "card__front";
    front.innerHTML = this.card.front_html;
    face.appendChild(front);

    if (this.phase === "answer") {
      const divider = document.createElement("hr");
      divider.className = "card__divider";
      face.appendChild(divider);

      const back = document.createElement("div");
      back.className = "card__back";
      back.innerHTML = this.card.back_html;
      face.appendChild(back);
    }
    this.el.appendChild(face);

    if (this.card.tags.length) {
      const tags = document.createElement("div");
      tags.className = "card__tags";
      for (const t of this.card.tags) {
        const chip = document.createElement("span");
        chip.className = "tag-chip";
        chip.textContent = `#${t}`;
        tags.appendChild(chip);
      }
      this.el.appendChild(tags);
    }

    const footer = document.createElement("div");
    footer.className = "card__footer";

    if (this.phase === "question") {
      const hint = document.createElement("button");
      hint.className = "reveal-btn";
      hint.type = "button";
      hint.textContent = "Tap / swipe up to reveal  (Space)";
      hint.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!this.locked) this.cb.onReveal();
      });
      footer.appendChild(hint);
    } else {
      const grades = document.createElement("div");
      grades.className = "grade-row";
      for (const r of RATING_ORDER) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `grade-btn grade-btn--${r}`;
        btn.disabled = this.locked;
        btn.dataset.rating = String(r);
        const label = document.createElement("span");
        label.className = "grade-btn__label";
        label.textContent = RATING_LABEL[r];
        const key = document.createElement("span");
        key.className = "grade-btn__key";
        key.textContent = String(r);
        btn.append(label, key);
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.grade(r);
        });
        grades.appendChild(btn);
      }
      footer.appendChild(grades);
    }
    this.el.appendChild(footer);
  }
}
