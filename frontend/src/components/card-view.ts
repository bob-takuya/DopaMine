// Renders a single feed card: front_html, tap/swipe-up to reveal back_html, then
// the four grade buttons. Keyboard: Space reveals, 1-4 grade (ARCHITECTURE §6).
//
// The component is a dumb view: it emits intent (reveal / grade) via callbacks
// and never talks to the API or mutates game state itself.

import { animate, bloom, enter, press, reduceMotion, SPRING } from "../motion.ts";
import { FONT_SCALE_MULTIPLIER, prefs } from "../prefs.ts";
import { RATING_LABEL, type CardView, type Rating } from "../types.ts";

type Phase = "question" | "answer";

export interface CardCallbacks {
  onReveal: () => void;
  onGrade: (rating: Rating) => void;
}

const RATING_ORDER: Rating[] = [1, 2, 3, 4];

// Base styling injected INTO the card's shadow root so plain cards (css === "")
// still look like DopaMine cards. Custom properties (var(--...)) inherit across
// the shadow boundary from :root, so the neon palette carries through. The note
// type's own CSS is appended AFTER this block so it can override any of it
// (e.g. a `.card` background, `.word` color, or `img` max-width).
const SHADOW_BASE_CSS = `
  :host { display: flex; flex: 1; min-width: 0; }
  .card {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 14px;
    text-align: center;
    color: inherit;
  }
  /* --card-scale (from the user's 文字サイズ pref) scales BOTH faces together.
     It inherits across the shadow boundary from the light-DOM .card article. */
  .card__front { font-size: calc(clamp(40px, 14vw, 88px) * var(--card-scale, 1)); font-weight: 900; line-height: 1.05; }
  .card__divider { width: 44%; border: none; border-top: 2px dashed #3a3a5c; margin: 6px 0; }
  .card__back { font-size: calc(clamp(24px, 7vw, 40px) * var(--card-scale, 1)); font-weight: 700; color: var(--neon-lime, #c6ff4a); }
  img { max-width: 100%; height: auto; }
  @keyframes pop { from { transform: scale(0.9); opacity: 0; } to { transform: scale(1); opacity: 1; } }
`;

/** Build the inner face markup (front, optional divider + back) as an HTML string. */
function faceInnerHtml(card: CardView, phase: Phase): string {
  let html = `<div class="card__front">${card.front_html}</div>`;
  if (phase === "answer") {
    html += `<hr class="card__divider" /><div class="card__back">${card.back_html}</div>`;
  }
  return html;
}

export class CardComponent {
  readonly el: HTMLElement;
  private card: CardView;
  private phase: Phase = "question";
  private locked = false;
  private cb: CardCallbacks;
  private pointerStartY: number | null = null;
  private faceEl: HTMLElement | null = null;

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
    this.refreshFontScale();
  }

  /** Play the quiet-luxury card-enter (translateY 12→0, scale .985→1, fade, SPRING). */
  playEnter(): void {
    enter(this.el);
  }

  /**
   * Apply the saved 文字サイズ (card font-scale) preference by setting the
   * `--card-scale` custom property on the light-DOM card element. Because custom
   * properties inherit through the shadow boundary, the shadow `.card__front` /
   * `.card__back` pick it up and scale together. Safe to call any time (mount or
   * a live settings change on the currently-mounted card).
   */
  refreshFontScale(): void {
    const scale = FONT_SCALE_MULTIPLIER[prefs.get("cardFontScale")];
    this.el.style.setProperty("--card-scale", String(scale));
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
    this.animateReveal();
  }

  /**
   * Reveal choreography inside the shadow root: the back content rises 8px and
   * fades in on the shared SPRING, and the hairline divider draws (scaleX 0→1,
   * ~200ms). Reduced-motion → no-op (the styles already show both instantly).
   */
  private animateReveal(): void {
    if (reduceMotion()) return;
    const root = this.faceEl?.shadowRoot;
    if (!root) return;
    const divider = root.querySelector<HTMLElement>(".card__divider");
    if (divider) {
      divider.style.transformOrigin = "center";
      animate(divider, { transform: ["scaleX(0)", "scaleX(1)"] }, { duration: 0.2, ease: [0.22, 1, 0.36, 1] });
    }
    const back = root.querySelector<HTMLElement>(".card__back");
    if (back) {
      animate(
        back,
        { opacity: [0, 1], transform: ["translateY(8px)", "translateY(0)"] },
        { type: "spring", ...SPRING },
      );
    }
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

  /**
   * Render the card's Anki HTML into `face` with STYLE ISOLATION.
   *
   * The note type's CSS targets bare selectors (`.card`, `img`, `.word`, ...) and
   * must not leak into the DopaMine app chrome — and the app's own CSS must not
   * fight it. So the answer/question HTML lives in a Shadow DOM: the note CSS is
   * scoped to the shadow tree, and only inheritable properties / custom props
   * cross the boundary. The grade buttons, deck tag, and tags stay in the LIGHT
   * DOM (built by render()) so the app styles them normally. Images inside the
   * shadow load from /api/media/... like any other <img>.
   *
   * Defensive: if attachShadow is unavailable or throws, fall back to the prior
   * plain-innerHTML rendering so the card still shows (without CSS isolation).
   */
  private renderFace(face: HTMLElement): void {
    const inner = faceInnerHtml(this.card, this.phase);
    try {
      const root = face.shadowRoot ?? face.attachShadow({ mode: "open" });
      root.innerHTML = `<style>${SHADOW_BASE_CSS}\n${this.card.css ?? ""}</style><div class="card">${inner}</div>`;
    } catch {
      // Shadow DOM unsupported/blocked: previous behavior (no isolation).
      face.innerHTML = inner;
    }
  }

  private render(): void {
    this.el.innerHTML = "";

    const deckTag = document.createElement("div");
    deckTag.className = "card__deck";
    deckTag.textContent = this.card.deck;
    this.el.appendChild(deckTag);

    const face = document.createElement("div");
    face.className = "card__face";
    this.renderFace(face);
    this.faceEl = face;
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
          // Quiet-luxury grade press: spring scale + a single faint accent
          // ripple blooming from the touch point (both degrade under reduced motion).
          press(btn);
          bloom(e.clientX, e.clientY, { size: 120, intensity: 0.4 });
          this.grade(r);
        });
        grades.appendChild(btn);
      }
      footer.appendChild(grades);
    }
    this.el.appendChild(footer);
  }
}
