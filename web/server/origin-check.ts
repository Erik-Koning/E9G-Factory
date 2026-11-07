// Whether a request came through the CDN: it carries the secret only the CDN sends (x-a6g-origin), compared in
// constant time. With no secret set (development, tests, a host with nothing in front), every request is let through.
// Pure, so the proxy and the unit tests share it.
import { timingSafeEqual } from "node:crypto";

export const ORIGIN_HEADER = "x-a6g-origin";

export function originAllowed(headers: Headers, secret: string | null | undefined): boolean {
  if (!secret) return true;
  const sent = Buffer.from(headers.get(ORIGIN_HEADER) ?? "");
  const want = Buffer.from(secret);
  return sent.length === want.length && timingSafeEqual(sent, want);
}
