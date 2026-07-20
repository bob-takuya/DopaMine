import { animate } from "motion/mini";

export { animate };

export const SPRING = { stiffness: 220, damping: 26 } as const;
export const SPRING_SOFT = { stiffness: 180, damping: 24 } as const;
export const EASE_OUT = "cubic-bezier(0.22,1,0.36,1)" as const;

export interface EnterOptions {
  delay?: number;
  soft?: boolean;
}

export interface CountUpOptions {
  duration?: number;
  decimals?: number;
  locale?: string | string[];
  format?: (value: number) => string;
}

export interface BloomOptions {
  color?: string;
  size?: number;
  intensity?: number;
}

const EASE_OUT_ARRAY = [0.22, 1, 0.36, 1] as const;

export function reduceMotion(): boolean {
  return typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function enter(el: Element, opts: EnterOptions = {}) {
  if (reduceMotion()) {
    return animate(el, { opacity: [0, 1] }, {
      duration: 0.12,
      delay: opts.delay,
      ease: EASE_OUT_ARRAY,
    });
  }

  return animate(
    el,
    { transform: ["translateY(12px) scale(0.985)", "translateY(0) scale(1)"], opacity: [0, 1] },
    { delay: opts.delay, type: "spring", ...(opts.soft ? SPRING_SOFT : SPRING) },
  );
}

export async function exit(el: Element): Promise<void> {
  const controls = animate(
    el,
    reduceMotion()
      ? { opacity: [1, 0] }
      : { transform: ["translateY(0)", "translateY(-8px)"], opacity: [1, 0] },
    { duration: reduceMotion() ? 0.12 : 0.16, ease: EASE_OUT_ARRAY },
  );
  await controls;
}

export function press(el: Element): void {
  if (reduceMotion()) return;
  animate(el, { transform: ["scale(0.96)", "scale(1)"] }, { type: "spring", ...SPRING });
}

export function countUp(
  el: HTMLElement,
  from: number,
  to: number,
  opts: CountUpOptions = {},
): () => void {
  let frame = 0;
  let stopped = false;
  const decimals = opts.decimals ?? (Number.isInteger(to) ? 0 : 1);
  const formatter = new Intl.NumberFormat(opts.locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  const render = (value: number): void => {
    el.textContent = opts.format ? opts.format(value) : formatter.format(value);
  };

  if (reduceMotion() || from === to) {
    render(to);
    return () => undefined;
  }

  const duration = Math.max(0, opts.duration ?? 520);
  const started = performance.now();
  render(from);
  const tick = (now: number): void => {
    if (stopped) return;
    const progress = duration === 0 ? 1 : Math.min(1, (now - started) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    render(from + (to - from) * eased);
    if (progress < 1) frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  return () => {
    stopped = true;
    cancelAnimationFrame(frame);
  };
}

function fxLayer(): HTMLElement {
  const existing = document.getElementById("fx-layer");
  if (existing) return existing;
  const layer = document.createElement("div");
  layer.id = "fx-layer";
  layer.setAttribute("aria-hidden", "true");
  document.body.append(layer);
  return layer;
}

export function bloom(x: number, y: number, opts: BloomOptions = {}): void {
  if (reduceMotion() || typeof document === "undefined") return;

  const glow = document.createElement("div");
  const size = Math.max(1, opts.size ?? 180);
  const intensity = Math.max(0, Math.min(1, opts.intensity ?? 0.5));
  glow.className = "bloom";
  glow.style.left = `${x}px`;
  glow.style.top = `${y}px`;
  glow.style.width = `${size}px`;
  glow.style.height = `${size}px`;
  glow.style.setProperty("--bloom-color", opts.color ?? "var(--accent-dim)");
  fxLayer().append(glow);

  const controls = animate(
    glow,
    { transform: ["translate(-50%, -50%) scale(0.6)", "translate(-50%, -50%) scale(1)", "translate(-50%, -50%) scale(1.4)"], opacity: [0, intensity, 0] },
    { duration: 0.52, times: [0, 0.36, 1], ease: EASE_OUT_ARRAY },
  );
  void controls.then(() => glow.remove()).catch(() => glow.remove());
}

export function viewTransition(fn: () => void | Promise<void>): ViewTransition | void | Promise<void> {
  if (!reduceMotion() && document.startViewTransition) return document.startViewTransition(fn);
  return fn();
}
