"use client";
// Better Auth in the browser: sign-in (magic link, passkey, password and authenticator code), passkeys, sessions.
import { passkeyClient } from "@better-auth/passkey/client";
import { magicLinkClient, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [magicLinkClient(), twoFactorClient(), passkeyClient()],
});

// What went wrong, in words, from a Better Auth error.
export const problemOf = (error: { message?: string | undefined; status?: number } | null | undefined, fallback: string): string =>
  error?.status === 429 ? "Too many tries; wait a minute and try again." : error?.message || fallback;
