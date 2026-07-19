// Playwright E2E harness (headless Chromium) for the DopaMine SPA.
//
// A `webServer` array launches BOTH real servers before the tests run:
//  (1) the FastAPI backend via the repo venv (DOPAMINE_SRS_ENGINE=fsrs and a
//      fresh throwaway DOPAMINE_DATA_DIR under ./temp so every run starts clean),
//  (2) the Vite dev server on :5173 (which proxies /api -> :8000).
// Readiness is gated on each server's real URL (backend /api/health, frontend
// root), never a fixed sleep. Tests then run against http://localhost:5173.

import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

const PROJECT_ROOT = "~/anki-addiction";
const BACKEND_DIR = join(PROJECT_ROOT, "backend");
const VENV_PYTHON = join(PROJECT_ROOT, ".venv", "bin", "python");

// Fresh, throwaway backend state for each `playwright test` invocation.
const DATA_DIR = mkdtempSync(join(PROJECT_ROOT, "temp", "e2e-data-"));

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  // One worker: the two specs share a single real backend, so serialize them
  // to keep persisted state deterministic (no cross-test races).
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 12_000 },
  reporter: [["list"]],

  use: {
    baseURL: "http://localhost:5173",
    // Determinism: emulate reduced motion so CSS strips animations/transitions
    // and the reward overlay collapses its suspense delays.
    reducedMotion: "reduce",
    colorScheme: "dark",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: [
    {
      command: `${VENV_PYTHON} -m uvicorn app.main:app --port 8000`,
      cwd: BACKEND_DIR,
      url: "http://localhost:8000/api/health",
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        DOPAMINE_SRS_ENGINE: "fsrs",
        DOPAMINE_DATA_DIR: DATA_DIR,
      },
    },
    {
      command: "npm run dev",
      url: "http://localhost:5173",
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
