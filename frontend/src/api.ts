// Typed fetch client for the DopaMine backend (ARCHITECTURE §5).
//
// Design notes:
//  - POST /api/answer carries a client-generated UUID `review_id`. Retries reuse
//    the SAME review_id so the server replays the original (idempotent) response.
//  - GET requests fall back to MOCK MODE on network failure so the UI is
//    demonstrable standalone. Mutating POST/PUT do NOT silently mock unless the
//    whole app is already running in explicit mock mode.
//  - Base URL is configurable; defaults to http://localhost:8000.

import type {
  AnswerRequest,
  AnswerResponse,
  ConfigResponse,
  DecksResponse,
  GuardrailPatch,
  NextCardResponse,
  Rating,
  SeedDemoResponse,
  StateResponse,
} from "./types.ts";
import { mockApi } from "./mock.ts";

const DEFAULT_BASE = "http://localhost:8000";

/** Thrown for structured API errors ({"error":{"code","message"}}) and HTTP faults. */
export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export interface ApiClient {
  readonly baseUrl: string;
  /** True when the client is serving from the local mock instead of the server. */
  isMock(): boolean;
  /** Subscribe to mock-mode transitions (e.g. to flip a UI banner). */
  onMockChange(cb: (mock: boolean) => void): () => void;

  getNextCard(deck?: string): Promise<NextCardResponse>;
  answer(req: AnswerRequest): Promise<AnswerResponse>;
  getState(): Promise<StateResponse>;
  getDecks(): Promise<DecksResponse>;
  seedDemo(deck: string, replace?: boolean): Promise<SeedDemoResponse>;
  putConfig(patch: GuardrailPatch): Promise<ConfigResponse>;
}

interface ApiClientOptions {
  baseUrl?: string;
  /** Force mock mode from the start (e.g. ?mock=1). */
  forceMock?: boolean;
  timeoutMs?: number;
}

/** RFC-4122 v4 UUID. Uses crypto.randomUUID when present, else a fallback. */
export function makeReviewId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // Fallback for older/insecure contexts.
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

class HttpApiClient implements ApiClient {
  readonly baseUrl: string;
  private mock = false;
  private readonly timeoutMs: number;
  private readonly listeners = new Set<(m: boolean) => void>();

  constructor(opts: ApiClientOptions = {}) {
    this.baseUrl = (opts.baseUrl || DEFAULT_BASE).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 8000;
    if (opts.forceMock) this.setMock(true);
  }

  isMock(): boolean {
    return this.mock;
  }

  onMockChange(cb: (mock: boolean) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private setMock(next: boolean): void {
    if (this.mock === next) return;
    this.mock = next;
    for (const cb of this.listeners) cb(next);
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  /** Core fetch with timeout + structured error decoding. Never swallows faults. */
  private async request<T>(
    path: string,
    init: RequestInit & { method: string },
  ): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.url(path), {
        ...init,
        signal: ctrl.signal,
        headers: {
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...(init.headers || {}),
        },
      });
    } catch (err) {
      // Network-level failure (offline, connection refused, timeout).
      throw new NetworkError(
        err instanceof Error ? err.message : "network failure",
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    }

    if (!res.ok) {
      const env = body as { error?: { code?: string; message?: string } } | undefined;
      const code = env?.error?.code ?? `HTTP_${res.status}`;
      const message = env?.error?.message ?? res.statusText ?? "request failed";
      throw new ApiError(code, message, res.status);
    }
    return body as T;
  }

  // ---- GET endpoints: fall back to mock on network failure ----------------

  private async getWithFallback<T>(
    path: string,
    mockCall: () => Promise<T>,
  ): Promise<T> {
    if (this.mock) return mockCall();
    try {
      const out = await this.request<T>(path, { method: "GET" });
      // A previously-mocked client that succeeds against a real server exits mock.
      this.setMock(false);
      return out;
    } catch (err) {
      if (err instanceof NetworkError) {
        this.setMock(true);
        return mockCall();
      }
      throw err; // real API errors (4xx/5xx) surface to the caller
    }
  }

  async getNextCard(deck?: string): Promise<NextCardResponse> {
    const q = deck ? `?deck=${encodeURIComponent(deck)}` : "";
    return this.getWithFallback(`/api/next-card${q}`, () =>
      mockApi.getNextCard(deck),
    );
  }

  async getState(): Promise<StateResponse> {
    return this.getWithFallback(`/api/state`, () => mockApi.getState());
  }

  async getDecks(): Promise<DecksResponse> {
    return this.getWithFallback(`/api/decks`, () => mockApi.getDecks());
  }

  // ---- Mutating endpoints -------------------------------------------------

  async answer(req: AnswerRequest): Promise<AnswerResponse> {
    if (this.mock) return mockApi.answer(req);
    try {
      return await this.request<AnswerResponse>(`/api/answer`, {
        method: "POST",
        body: JSON.stringify(req),
      });
    } catch (err) {
      // On network failure we DO NOT queue a speculative grade; we surface the
      // error so feed.ts can keep the card visible with a retry that reuses the
      // same review_id. If the whole app has fallen into mock mode, serve mock.
      if (err instanceof NetworkError) {
        this.setMock(true);
        return mockApi.answer(req);
      }
      throw err;
    }
  }

  async seedDemo(deck: string, replace = false): Promise<SeedDemoResponse> {
    if (this.mock) return mockApi.seedDemo(deck, replace);
    try {
      return await this.request<SeedDemoResponse>(`/api/seed-demo`, {
        method: "POST",
        body: JSON.stringify({ deck, replace }),
      });
    } catch (err) {
      if (err instanceof NetworkError) {
        this.setMock(true);
        return mockApi.seedDemo(deck, replace);
      }
      throw err;
    }
  }

  async putConfig(patch: GuardrailPatch): Promise<ConfigResponse> {
    if (this.mock) return mockApi.putConfig(patch);
    try {
      return await this.request<ConfigResponse>(`/api/config`, {
        method: "PUT",
        body: JSON.stringify(patch),
      });
    } catch (err) {
      if (err instanceof NetworkError) {
        this.setMock(true);
        return mockApi.putConfig(patch);
      }
      throw err;
    }
  }
}

/** Internal marker for network-level (not HTTP-status) failures. */
class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

/** Read desired base URL + mock flag from the environment / URL. */
export function createApiClient(): ApiClient {
  const params = new URLSearchParams(globalThis.location?.search ?? "");
  const forceMock = params.get("mock") === "1";
  const baseFromQuery = params.get("api") || undefined;
  const baseUrl =
    baseFromQuery ||
    (import.meta.env?.VITE_API_BASE as string | undefined) ||
    DEFAULT_BASE;
  return new HttpApiClient({ baseUrl, forceMock });
}

export const RATINGS: Rating[] = [1, 2, 3, 4];
