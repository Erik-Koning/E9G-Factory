// Before every page: a Content Security Policy with a fresh nonce (Next puts it on its own scripts), and anyone
// without a session cookie off to sign in. The cookie is only a hint here; every page and action checks the session
// itself (server/viewer.ts).
import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";

const OPEN = [/^\/sign-in(\/|$)/, /^\/api\/auth\//];

export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  if (!OPEN.some((path) => path.test(pathname)) && !getSessionCookie(request)) {
    const to = new URL("/sign-in", request.url);
    if (pathname !== "/") to.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(to);
  }
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const dev = process.env.NODE_ENV === "development";
  const policy = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", policy);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
