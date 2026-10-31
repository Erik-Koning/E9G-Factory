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

// How long every sign-in-link answer takes, sent or not; the names of teams, as the factory makes them.
const SEND_TIME_MS = 1500;
const TEAM_NAME = /^[a-z][a-z0-9-]{0,30}$/;

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
        // A person's or a passkey's name is shown to the admin: short, whatever the endpoint lets through.
        const name = (ctx.body as { name?: unknown } | undefined)?.name;
        if (typeof name === "string" && name.length > 120) throw new APIError("BAD_REQUEST", { message: "Keep the name under 120 characters." });
        if (openWithoutSecondFactor(ctx.path)) return;
        const current = await getSessionFromCtx(ctx);
        if (current && isAdminRole(current.user.role) && current.session.secondFactor !== true)
          throw new APIError("FORBIDDEN", { message: "Sign in again with your authenticator or a passkey first." });
        // A new passkey for an admin needs a sign-in from the last ten minutes, so a stolen session can't make itself last.
        if (current && isAdminRole(current.user.role) && ctx.path.startsWith("/passkey/generate-register-options"))
          if (Date.now() - new Date(current.session.createdAt).getTime() > 10 * 60_000)
            throw new APIError("FORBIDDEN", { message: "Sign in again, then add the passkey within ten minutes." });
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
          // Every answer takes the same time, so it doesn't say whether the address was invited.
          const started = Date.now();
          try {
            await sendLink(email, url, metadata, ctx);
          } finally {
            await new Promise((done) => setTimeout(done, Math.max(0, SEND_TIME_MS - (Date.now() - started))));
          }
        },
      }),
      // Last, so cookies set by auth.api calls in server actions reach the browser.
      nextCookies(),
    ],
  });

  // Nobody unknown gets an email, nor a banned person, nor an admin a link, nor anyone a second within a minute. Only
  // the app's own invite (a server call, never a request over HTTP) makes it an invitation, naming a real team.
  async function sendLink(
    email: string,
    url: string,
    metadata: Record<string, unknown> | undefined,
    ctx: { request?: Request; context: { internalAdapter: { findUserByEmail(email: string): Promise<{ user: unknown } | null> } } } | undefined
  ): Promise<void> {
    const found = await ctx?.context.internalAdapter.findUserByEmail(email);
    const user = found?.user as { role?: unknown; banned?: unknown } | undefined;
    if (!user || user.banned === true || isAdminRole(user.role)) return;
    const renewed = await client
      .db(authDatabase)
      .collection<{ _id: string; at: Date }>("magic_link_sends")
      .findOneAndUpdate({ _id: email.toLowerCase(), at: { $lt: new Date(Date.now() - 60_000) } }, { $set: { at: new Date() } })
      .catch(() => null);
    if (!renewed) {
      const fresh = await client
        .db(authDatabase)
        .collection<{ _id: string; at: Date }>("magic_link_sends")
        .insertOne({ _id: email.toLowerCase(), at: new Date() })
        .then(
          () => true,
          () => false
        );
      if (!fresh) return;
    }
    const team = metadata?.["team"];
    const invitation = !ctx?.request && typeof team === "string" && TEAM_NAME.test(team) ? team : null;
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
  }
}

export type Auth = ReturnType<typeof makeAuth>;

const cache = globalThis as typeof globalThis & { e9gWebAuth?: Auth };
export function auth(): Auth {
  cache.e9gWebAuth ??= makeAuth();
  return cache.e9gWebAuth;
}
