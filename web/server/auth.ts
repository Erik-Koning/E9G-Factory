// Accounts and sign-in (Better Auth, on the app's own database). Invite only: nobody signs up.
//
// Everyone signs in with a passkey or a magic link by email. Admins sign in with two factors, by design:
//   - a password and an authenticator code (or one of their backup codes), enrolled by `npm run create-admin` on the
//     operator's own machine, so an admin account never exists without its authenticator; or
//   - a passkey whose authenticator verified the person (a PIN or biometrics: something they have and something they
//     know or are). A passkey that didn't verify them gives no second factor.
//   - never a magic link: none is sent to an admin, and a session from one is refused for an admin.
// Each session records whether it began with a second factor (session.secondFactor, set here as it's made and never
// by the client). Every admin page and server action checks it on the server (viewer.ts, access.ts), and over HTTP an
// admin session without it can only sign out or sign in again (the guard below), so it can't enrol a passkey or new
// backup codes to raise itself. Better Auth's own admin endpoints aren't served over HTTP at all: the app calls them
// from its server actions, after its own checks.
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { admin, magicLink, twoFactor } from "better-auth/plugins";
import { config } from "./config.ts";
import { mongo } from "./db.ts";
import { sendMail } from "./mail.ts";

export const isAdminRole = (role: unknown): boolean => typeof role === "string" && role.split(",").includes("admin");

// The paths whose new session began with a second factor (a passkey only when it verified the person).
const SECOND_FACTOR = new Set(["/two-factor/verify-totp", "/two-factor/verify-backup-code"]);
const PASSKEY_SIGN_IN = "/passkey/verify-authentication";

// Whether a passkey assertion says the authenticator verified the person: the UV bit (0x04) of the flags byte that
// follows the 32-byte RP ID hash in authenticatorData. By the time a session is made, the passkey plugin has verified
// the signature over these bytes.
export function userVerified(response: unknown): boolean {
  const data = (response as { response?: { authenticatorData?: unknown } } | null)?.response?.authenticatorData;
  if (typeof data !== "string") return false;
  const bytes = Buffer.from(data, "base64url");
  return bytes.length > 32 && ((bytes[32] ?? 0) & 0x04) !== 0;
}

// What an admin session without its second factor may still do over HTTP: look at itself, sign out, sign in again.
const OPEN_WITHOUT_SECOND_FACTOR = new Set(["/get-session", "/sign-out", "/ok", "/error", "/passkey/generate-authenticate-options", PASSKEY_SIGN_IN]);
const openWithoutSecondFactor = (path: string): boolean =>
  OPEN_WITHOUT_SECOND_FACTOR.has(path) || path.startsWith("/sign-in/") || path.startsWith("/two-factor/verify-");
// Never over HTTP, for anyone: the admin plugin's endpoints (the app calls them from its own server actions), and
// turning the authenticator on or off (create-admin enrols it).
const SERVER_ONLY = (path: string): boolean => path.startsWith("/admin/") || path === "/two-factor/enable" || path === "/two-factor/disable";

function makeAuth() {
  const { baseURL, secret, authDatabase } = config();
  const client = mongo();
  return betterAuth({
    appName: "E9G",
    baseURL,
    basePath: "/api/auth",
    secret,
    database: mongodbAdapter(client.db(authDatabase), { client }),
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12 },
    session: {
      additionalFields: { secondFactor: { type: "boolean", required: false, defaultValue: false, input: false } },
    },
    // Kept in the database, so the limits hold across serverless instances.
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-in/magic-link": { window: 60, max: 5 },
        "/two-factor/*": { window: 60, max: 5 },
        "/passkey/verify-authentication": { window: 60, max: 10 },
      },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session, ctx) => {
            const path = ctx?.path ?? "";
            if (path === "/magic-link/verify") {
              const user = await ctx?.context.internalAdapter.findUserById(session.userId);
              // Admins never sign in by a link: no session from one.
              if (isAdminRole((user as { role?: unknown } | null)?.role)) return false;
            }
            const secondFactor = SECOND_FACTOR.has(path) || (path === PASSKEY_SIGN_IN && userVerified((ctx?.body as { response?: unknown })?.response));
            return { data: { ...session, secondFactor } };
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Only requests over HTTP: the app's own server code calls the API after its own checks.
        if (!ctx.request) return;
        if (SERVER_ONLY(ctx.path)) throw new APIError("FORBIDDEN", { message: "Not available." });
        if (openWithoutSecondFactor(ctx.path)) return;
        const current = await getSessionFromCtx(ctx);
        if (current && isAdminRole(current.user.role) && current.session.secondFactor !== true)
          throw new APIError("FORBIDDEN", { message: "Sign in again with your authenticator or a passkey first." });
      }),
    },
    plugins: [
      admin({ defaultRole: "user", adminRoles: ["admin"] }),
      twoFactor({ issuer: "E9G", backupCodeOptions: { amount: 10, length: 10 } }),
      passkey({ rpID: new URL(baseURL).hostname, rpName: "E9G", origin: baseURL }),
      magicLink({
        disableSignUp: true,
        expiresIn: 15 * 60,
        storeToken: "hashed",
        sendMagicLink: async ({ email, url, metadata }, ctx) => {
          const found = await ctx?.context.internalAdapter.findUserByEmail(email);
          const user = found?.user as { role?: unknown; banned?: unknown } | undefined;
          // Nobody unknown gets an email, and no admin a link; the answer to the browser is the same either way.
          if (!user || user.banned === true || isAdminRole(user.role)) return;
          const invitation = typeof metadata?.["team"] === "string" ? String(metadata["team"]) : null;
          await sendMail(
            invitation
              ? {
                  to: email,
                  subject: `You're invited to follow ${invitation} on E9G`,
                  text: `You've been invited to follow the team ${invitation} on E9G: send it requests and see how they're going.\n\nSign in with this link within 15 minutes: ${url}\n\nLater, sign in at ${baseURL}/sign-in with this address, and add a passkey from your account page.`,
                  link: url,
                }
              : {
                  to: email,
                  subject: "Your E9G sign-in link",
                  text: `Sign in to E9G with this link within 15 minutes: ${url}\n\nIf you didn't ask for it, ignore this email.`,
                  link: url,
                }
          );
        },
      }),
      // Last, so cookies set by auth.api calls in server actions reach the browser.
      nextCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof makeAuth>;

const cache = globalThis as typeof globalThis & { e9gWebAuth?: Auth };
export function auth(): Auth {
  cache.e9gWebAuth ??= makeAuth();
  return cache.e9gWebAuth;
}
