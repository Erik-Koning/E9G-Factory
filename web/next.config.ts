// The app imports the factory's own task code from ../lib/tasks (no copies), so Turbopack's root and the output
// tracing both reach the repository's root; on Vercel the project's root is web/ with "include files outside the root
// directory" on.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const repository = join(dirname(fileURLToPath(import.meta.url)), "..");

const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  turbopack: { root: repository },
  outputFileTracingRoot: repository,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default config;
