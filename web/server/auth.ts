// Accounts and sign-in (Better Auth, on the app's own database). Invite only: nobody signs up.
//
// Everyone signs in with a passkey or a magic link by email. Admins sign in with two factors, by design:
//   - a password and an authenticator code (or one of their backup codes), enrolled by `npm run create-admin` on the
//     operator's own machine, so an admin account never exists without its authenticator; or
//   - a passkey whose authenticator verified the person (a PIN or biometrics: something they have and something they
//     know or are). A passkey that didn't verify them gives no second factor.
//   - never a magic link: none is sent to an admin, and a session from one is refused for an admin.
// Anyone else may turn on an authenticator too (from the account page); from then on their sessions need its code as
// well, whichever way they signed in.
// Each session records whether it began with a second factor (session.secondFactor, set here as it's made and never
// by the client; a code entered later sets it, second-factor/actions.ts). Every page and server action checks it on
// the server (viewer.ts, access.ts), and over HTTP a session without it can only sign out or sign in again (the guard
// below), so it can't enrol a passkey or new backup codes to raise itself.
//
// Every session also records its IP address, as the CDN in front of the app reports it (CLIENT_IP_HEADER, trusted
// because the app refuses requests without the CDN's ORIGIN_SECRET, proxy.ts). A session used from an address its
// person hasn't confirmed can do nothing until they confirm it from an email (known-ips.ts); an email sign-in link
// confirms the address it's opened from. Sign-ins, failures, sign-outs and changes to passkeys and backup codes go to
// the audit log (audit.ts).
//
// Better Auth's own admin endpoints aren't served over HTTP at all: the app calls them from its server actions, after
// its own checks.
import { getIP } from "@better-auth/core/utils/ip";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { admin, magicLink, twoFactor } from "better-auth/plugins";
import { audit } from "./audit.ts";
import { ensureAuthIndexes } from "./auth-indexes.ts";
import { config } from "./config.ts";
import { mongo } from "./db.ts";
import { originAllowed } from "./origin-check.ts";
import { challenge, isKnownIp, rememberIp } from "./known-ips.ts";
import { sendMail } from "./mail.ts";

// How long every sign-in-link answer takes, sent or not; the names of teams, as the factory makes them.
const SEND_TIME_MS = 1500;
const TEAM_NAME = /^[a-z][a-z0-9-]{0,30}$/;

export const isAdminRole = (role: unknown): boolean => typeof role === "string" && role.split(",").includes("admin");

// The paths whose new session began with a second factor (a passkey only when it verified the person).
const SECOND_FACTOR = new Set(["/two-factor/verify-totp", "/two-factor/verify-backup-code"]);
const PASSKEY_SIGN_IN = "/passkey/verify-authentication";
// A password sign-in for someone with an authenticator makes a session the two-factor plugin deletes at once, while
// it waits for the code: a placeholder, which nothing here records or asks about. The code's own session is the one.
const PASSWORD_SIGN_IN = "/sign-in/email";

// Whether a passkey assertion says the authenticator verified the person: the UV bit (0x04) of the flags byte that
// follows the 32-byte RP ID hash in authenticatorData. By the time a session is made, the passkey plugin has verified
// the signature over these bytes.
export function userVerified(response: unknown): boolean {
  const data = (response as { response?: { authenticatorData?: unknown } } | null)?.response?.authenticatorData;
  if (typeof data !== "string") return false;
  const bytes = Buffer.from(data, "base64url");
  return bytes.length > 32 && ((bytes[32] ?? 0) & 0x04) !== 0;
}

// How each path signs someone in, for the audit log.
const SIGN_IN_METHOD: Record<string, string> = {
  [PASSWORD_SIGN_IN]: "password",
  "/two-factor/verify-totp": "password and authenticator",
  "/two-factor/verify-backup-code": "password and backup code",
  [PASSKEY_SIGN_IN]: "passkey",
  "/magic-link/verify": "email link",
};

// How a session someone ended was ended, for the audit log.
const SESSION_ENDED_BY: Record<string, string> = {
  "/sign-out": "signed out",
  "/revoke-session": "ended from the account page",
  "/revoke-other-sessions": "ended from another session's account page",
  "/revoke-sessions": "every session ended",
  "/admin/ban-user": "banned by an admin",
  "/admin/revoke-user-session": "ended by an admin",
  "/admin/revoke-user-sessions": "ended by an admin",
};

// What a session that still owes a second factor or an IP confirmation may do over HTTP: look at itself, sign out,
// sign in again.
const OPEN_WHILE_PENDING = new Set([
  "/get-session",
  "/sign-out",
  "/ok",
  "/error",
  "/passkey/generate-authenticate-options",
  PASSKEY_SIGN_IN,
  // A new sign-in link, opened in a browser whose session is waiting: it makes a new session, at the address it's opened.
  "/magic-link/verify",
]);
const openWhilePending = (path: string): boolean => OPEN_WHILE_PENDING.has(path) || path.startsWith("/sign-in/") || path.startsWith("/two-factor/verify-");
// Never over HTTP, for anyone: the admin plugin's endpoints (the app calls them from its own server actions); turning
// the authenticator on or off, reading its secret, and making new backup codes (the account page does them, each with
// a current code, so a stolen session can't copy or replace the second factor).
const SERVER_ONLY = (path: string): boolean =>
  path.startsWith("/admin/") ||
  ["/two-factor/enable", "/two-factor/disable", "/two-factor/get-totp-uri", "/two-factor/generate-backup-codes"].includes(path);

function makeAuth() {
  const { baseURL, secret, authDatabase } = config();
  const client = mongo();
  void ensureAuthIndexes(client.db(authDatabase));
  return betterAuth({
    appName: "Anything Factory",
    baseURL,
    basePath: "/api/auth",
    secret,
    database: mongodbAdapter(client.db(authDatabase), { client }),
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12 },
    // The viewer's address, from the one header the CDN sets (and nobody else can, proxy.ts): sessions record it, rate
    // limits count by it, and the new-IP check compares it. IPv6 by its /64.
    advanced: { ipAddress: { ipAddressHeaders: [config().ipHeader], ipv6Subnet: 64 } },
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
          // A new session from an address its person hasn't confirmed: they're asked by email. An email link's own
          // session confirms where it was opened. Only sessions made by a request over HTTP: the ones the app's own
          // server code makes (create-admin's, the one Better Auth swaps in when an authenticator is turned on, from a
          // session already at a confirmed address) are asked about where they're used, like any other.
          after: async (session, ctx) => {
            if (!ctx?.request) return;
            const ip = (session as { ipAddress?: string | null }).ipAddress || null;
            if (ctx.path === "/magic-link/verify") return rememberIp(session.userId, ip, "email link");
            if (await isKnownIp(session.userId, ip)) return;
            const user = await ctx.context.internalAdapter.findUserById(session.userId);
            if ((user as { twoFactorEnabled?: boolean } | null)?.twoFactorEnabled && ctx.path === PASSWORD_SIGN_IN) return;
            if (user)
              await challenge({
                userId: user.id,
                email: user.email,
                ip,
                userAgent: (session as { userAgent?: string | null }).userAgent ?? null,
                sessionId: session.id,
              });
          },
        },
        // Sessions someone ended: signing out, ending one or the others from the account page, a ban. Not the ones
        // Better Auth swaps or clears itself, nor create-admin's; "it wasn't me" records its own (ip.denied).
        delete: {
          after: async (session, ctx) => {
            const how = ctx?.path ? SESSION_ENDED_BY[ctx.path] : undefined;
            if (!ctx || !how) return;
            const user = await ctx.context.internalAdapter.findUserById(session.userId).catch(() => null);
            const from = ctx.request?.headers ?? ctx.headers;
            await audit({
              action: ctx.path === "/sign-out" ? "sign-out" : "session.ended",
              outcome: "ok",
              userId: session.userId,
              email: user?.email ?? null,
              ip: from ? getIP(from, ctx.context.options) : null,
              userAgent: from?.get("user-agent") ?? null,
              sessionId: session.id,
              detail: how,
            });
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Only requests over HTTP: the app's own server code calls the API after its own checks.
        if (!ctx.request) return;
        // Through the CDN only, here as well as in proxy.ts, so the viewer-IP header can't come from anyone else.
        if (!originAllowed(ctx.request.headers, config().originSecret)) throw new APIError("FORBIDDEN", { message: "Not here." });
        if (SERVER_ONLY(ctx.path)) throw new APIError("FORBIDDEN", { message: "Not available." });
        // No device is trusted to skip the second factor: every sign-in asks for it.
        if ((ctx.body as { trustDevice?: unknown } | undefined)?.trustDevice)
          throw new APIError("BAD_REQUEST", { message: "Devices aren't trusted here." });
        // A session never checks codes over HTTP (the second-factor page does, counting each try, code-attempts.ts):
        // only a password's second step, which has no session yet, uses Better Auth's verify endpoints.
        if (ctx.path.startsWith("/two-factor/") && (await getSessionFromCtx(ctx)))
          throw new APIError("FORBIDDEN", { message: "Enter your code on the second-factor page." });
        // A person's or a passkey's name is shown to the admin: short, whatever the endpoint lets through.
        const name = (ctx.body as { name?: unknown } | undefined)?.name;
        if (typeof name === "string" && name.length > 120) throw new APIError("BAD_REQUEST", { message: "Keep the name under 120 characters." });
        if (openWhilePending(ctx.path)) return;
        const current = await getSessionFromCtx(ctx);
        if (current && (isAdminRole(current.user.role) || current.user.twoFactorEnabled === true) && current.session.secondFactor !== true)
          throw new APIError("FORBIDDEN", { message: "Enter your authenticator's code first." });
        if (current && !(await isKnownIp(current.user.id, getIP(ctx.request, ctx.context.options))))
          throw new APIError("FORBIDDEN", { message: "Confirm this sign-in from the email we sent first." });
        // A new passkey for an admin needs a sign-in from the last ten minutes, so a stolen session can't make itself last.
        if (current && isAdminRole(current.user.role) && ctx.path.startsWith("/passkey/generate-register-options"))
          if (Date.now() - new Date(current.session.createdAt).getTime() > 10 * 60_000)
            throw new APIError("FORBIDDEN", { message: "Sign in again, then add the passkey within ten minutes." });
      }),
      // The audit log, for what's done over HTTP; the app's server actions record their own.
      after: createAuthMiddleware(async (ctx) => {
        if (!ctx.request) return;
        const returned = ctx.context.returned;
        const failed = returned instanceof APIError;
        const fresh = ctx.context.newSession;
        const from = { ip: getIP(ctx.request, ctx.context.options), userAgent: ctx.request.headers.get("user-agent") };
        const body = (ctx.body ?? {}) as { email?: unknown; name?: unknown };
        const typed = typeof body.email === "string" ? body.email : null;
        const method = SIGN_IN_METHOD[ctx.path];
        // The placeholder session of a password that still needs its code: the code's step records the sign-in.
        if (ctx.path === PASSWORD_SIGN_IN && fresh?.user.twoFactorEnabled) return;
        if (method && fresh) {
          const verified = ctx.path === PASSKEY_SIGN_IN && (fresh.session as { secondFactor?: boolean }).secondFactor === true;
          await audit({
            action: "sign-in",
            outcome: "ok",
            userId: fresh.user.id,
            email: fresh.user.email,
            ...from,
            sessionId: fresh.session.id,
            detail: verified ? `${method}, verified with a PIN or biometrics` : method,
          });
        } else if (method && failed) {
          const pending = ctx.path.startsWith("/two-factor/") ? await twoFactorUser(ctx) : null;
          await audit({
            action: "sign-in",
            outcome: "failed",
            userId: pending?.id ?? null,
            email: pending?.email ?? typed,
            ...from,
            detail: `${method}: ${returned.message || returned.status}`,
          });
        } else if (ctx.path === "/sign-in/magic-link") {
          // Asked for: whether one went is the sender's to know (sendLink), not the log's to say to whoever reads it.
          await audit({ action: "sign-in-link", outcome: failed ? "failed" : "ok", userId: null, email: typed, ...from });
        } else if (!failed && ["/passkey/verify-registration", "/passkey/delete-passkey", "/two-factor/generate-backup-codes"].includes(ctx.path)) {
          const current = ctx.context.session ?? (await getSessionFromCtx(ctx).catch(() => null));
          await audit({
            action:
              ctx.path === "/passkey/verify-registration"
                ? "passkey.added"
                : ctx.path === "/passkey/delete-passkey"
                  ? "passkey.removed"
                  : "backup-codes.new",
            outcome: "ok",
            userId: current?.user.id ?? null,
            email: current?.user.email ?? null,
            ...from,
            sessionId: current?.session.id ?? null,
            target: typeof body.name === "string" ? body.name : null,
          });
        }
      }),
    },
    plugins: [
      admin({ defaultRole: "user", adminRoles: ["admin"] }),
      // Passwordless: members turn one on without a password they don't have. Turning it on or off is never over HTTP
      // (the guard above); the account page's server actions do it, the latter only with a current code.
      twoFactor({ issuer: "Anything Factory", allowPasswordless: true, backupCodeOptions: { amount: 10, length: 10 } }),
      passkey({ rpID: new URL(baseURL).hostname, rpName: "Anything Factory", origin: baseURL }),
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
            subject: `You're invited to follow ${invitation} on Anything Factory`,
            text: `You've been invited to follow the team ${invitation} on Anything Factory: send it requests and see how they're going.\n\nSign in with this link within 15 minutes: ${url}\n\nLater, sign in at ${baseURL}/sign-in with this address, and add a passkey from your account page.`,
            link: url,
          }
        : {
            to: email,
            subject: "Your Anything Factory sign-in link",
            text: `Sign in to Anything Factory with this link within 15 minutes: ${url}\n\nIf you didn't ask for it, ignore this email.`,
            link: url,
          }
    );
  }
}

// Who a sign-in's second step is for: the person the two-factor cookie names, while it's still good.
async function twoFactorUser(ctx: {
  context: {
    createAuthCookie(name: string): { name: string };
    secret: string;
    internalAdapter: {
      findVerificationValue(id: string): Promise<{ value: string } | null>;
      findUserById(id: string): Promise<{ id: string; email: string } | null>;
    };
  };
  getSignedCookie(name: string, secret: string): Promise<string | null | false>;
}): Promise<{ id: string; email: string } | null> {
  try {
    const signed = await ctx.getSignedCookie(ctx.context.createAuthCookie("two_factor").name, ctx.context.secret);
    if (!signed) return null;
    const pending = await ctx.context.internalAdapter.findVerificationValue(signed);
    return pending ? await ctx.context.internalAdapter.findUserById(pending.value) : null;
  } catch {
    return null;
  }
}

export type Auth = ReturnType<typeof makeAuth>;

const cache = globalThis as typeof globalThis & { a6gWebAuth?: Auth };
export function auth(): Auth {
  cache.a6gWebAuth ??= makeAuth();
  return cache.a6gWebAuth;
}

// The viewer's IP address for a request, exactly as sessions and rate limits read it.
export const clientIp = (headers: Headers): string | null => getIP(headers, auth().options);
