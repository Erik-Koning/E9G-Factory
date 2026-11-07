// The app's settings, from its environment (never a team's): read when first needed, so a build needs none of them.

export interface WebConfig {
  mongoUri: string;
  // The task graphs (the factory's tasks, requests, stakeholders, cycles, counters and teams) and the app's accounts.
  a6gDatabase: string;
  authDatabase: string;
  secret: string;
  // Where the app is served from (https://a6g.example.com): links in emails, passkeys' relying party and origin.
  baseURL: string;
  resendKey: string | null;
  // Amazon SES, with an IAM user's key that may only send as the sender (sst.config.ts makes both).
  ses: { region: string; accessKeyId: string; secretAccessKey: string } | null;
  mailFrom: string;
  // Sign-in links and invitations go to the server's console instead of by email: only where the app's own address is
  // this machine (development, tests), never where a log could hand someone a link.
  mailLog: boolean;
  // The one request header that carries the viewer's IP address, set by the CDN in front of the app (CloudFront's
  // function sets x-a6g-viewer-ip) and trusted only with the origin secret below. Sessions, rate limits, the new-IP
  // check and the audit log all read it.
  ipHeader: string;
  // A secret only the CDN sends (x-a6g-origin): with it set, a request without it is refused, so nobody reaches the
  // app around the CDN or sets the IP header themselves. Null where nothing sits in front (development, tests).
  originSecret: string | null;
  // How long the audit log keeps an event, in days.
  auditDays: number;
  // How often the notifier looks for what to email (seconds; 0: never), and the time zone of the daily digest for
  // someone who hasn't chosen theirs.
  notifyEverySeconds: number;
  notifyTimeZone: string;
}

const DATABASE = /^[\w-]{1,60}$/;

export function readConfig(env: NodeJS.ProcessEnv = process.env): WebConfig {
  const problems: string[] = [];
  const mongoUri = env.MONGODB_URI ?? "";
  if (!/^mongodb(\+srv)?:\/\/\S+$/.test(mongoUri)) problems.push("MONGODB_URI: the connection string (mongodb+srv://…)");
  const a6gDatabase = env.A6G_DATABASE || "a6g";
  const authDatabase = env.AUTH_DATABASE || "a6g_web";
  if (!DATABASE.test(a6gDatabase)) problems.push("A6G_DATABASE: letters, digits, _ and -");
  if (!DATABASE.test(authDatabase)) problems.push("AUTH_DATABASE: letters, digits, _ and -");
  if (a6gDatabase === authDatabase) problems.push("AUTH_DATABASE: the accounts' own database, not the task graphs'");
  const secret = env.BETTER_AUTH_SECRET ?? "";
  if (secret.length < 32) problems.push("BETTER_AUTH_SECRET: at least 32 random characters (openssl rand -base64 32)");
  const baseURL = (env.BETTER_AUTH_URL ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\/[^/\s]+$/.test(baseURL)) problems.push("BETTER_AUTH_URL: the app's address, such as https://a6g.example.com");
  const production = env.NODE_ENV === "production";
  if (production && baseURL.startsWith("http://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(baseURL))
    problems.push("BETTER_AUTH_URL: https in production");
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(baseURL);
  const resendKey = env.RESEND_API_KEY || null;
  const sesSet = [env.SES_REGION, env.SES_ACCESS_KEY_ID, env.SES_SECRET_ACCESS_KEY].filter(Boolean).length;
  if (sesSet && sesSet < 3) problems.push("SES_REGION, SES_ACCESS_KEY_ID and SES_SECRET_ACCESS_KEY: all three, or none");
  const ses =
    sesSet === 3 ? { region: env.SES_REGION ?? "", accessKeyId: env.SES_ACCESS_KEY_ID ?? "", secretAccessKey: env.SES_SECRET_ACCESS_KEY ?? "" } : null;
  const mailLog = !resendKey && !ses && local && (env.MAIL_LOG === "1" || (!production && env.MAIL_LOG !== "0"));
  const ipHeader = (env.CLIENT_IP_HEADER || "x-forwarded-for").toLowerCase();
  if (!/^[a-z0-9-]{1,64}$/.test(ipHeader)) problems.push("CLIENT_IP_HEADER: a header name, such as x-a6g-viewer-ip");
  const originSecret = env.ORIGIN_SECRET || null;
  if (originSecret !== null && originSecret.length < 32) problems.push("ORIGIN_SECRET: at least 32 random characters, the same as the CDN sends");
  // Served anywhere but this machine, the app is behind the CDN and sends real email: without its secret anyone could
  // say what IP they come from, and without email nobody could sign in.
  if (production && !local) {
    if (!originSecret) problems.push("ORIGIN_SECRET: the secret the CDN sends, required where the app is served for real");
    if (!env.CLIENT_IP_HEADER) problems.push("CLIENT_IP_HEADER: the header the CDN sets the viewer's address in (x-a6g-viewer-ip)");
    if (!resendKey && !ses) problems.push("RESEND_API_KEY, or SES_REGION with its key: email for sign-in links and confirmations");
  }
  const auditDays = Number(env.AUDIT_RETENTION_DAYS || 400);
  if (!Number.isInteger(auditDays) || auditDays < 30) problems.push("AUDIT_RETENTION_DAYS: a whole number of days, 30 or more");
  const notifyEverySeconds = Number(env.NOTIFY_EVERY_SECONDS || 60);
  if (!Number.isInteger(notifyEverySeconds) || notifyEverySeconds < 0)
    problems.push("NOTIFY_EVERY_SECONDS: a whole number of seconds, or 0 for no notifications");
  const notifyTimeZone = env.NOTIFY_TIME_ZONE || "UTC";
  if (notifyTimeZone !== "UTC" && !Intl.supportedValuesOf("timeZone").includes(notifyTimeZone))
    problems.push("NOTIFY_TIME_ZONE: a time zone such as America/Toronto");
  if (problems.length) throw new Error(`The web app's environment isn't set:\n- ${problems.join("\n- ")}`);
  return {
    mongoUri,
    a6gDatabase,
    authDatabase,
    secret,
    baseURL,
    resendKey,
    ses,
    mailFrom: env.MAIL_FROM || "Anything Factory <a6g@localhost>",
    mailLog,
    ipHeader,
    originSecret,
    auditDays,
    notifyEverySeconds,
    notifyTimeZone,
  };
}

let cached: WebConfig | null = null;
export const config = (): WebConfig => (cached ??= readConfig());
