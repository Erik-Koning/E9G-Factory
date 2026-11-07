import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);
// As CloudFront sends them in production: the viewer's IP address, and the secret only the CDN knows (the app refuses
// requests without it). Contexts the tests make themselves set the same (helpers.ts).
export const ORIGIN_SECRET = process.env.E2E_ORIGIN_SECRET ?? "e2e-origin-secret-only-for-the-tests-0123456789";
export const DEFAULT_IP = "198.51.100.7";

// npm run test:e2e builds the app, then runs these against a local MongoDB (tests/e2e/global-setup.ts).
export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  // One story, in order: the admin invites the contributor who then signs in, and so on.
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    extraHTTPHeaders: { "x-a6g-viewer-ip": DEFAULT_IP, "x-a6g-origin": ORIGIN_SECRET },
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
