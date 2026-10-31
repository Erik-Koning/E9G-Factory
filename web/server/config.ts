// The app's settings, from its environment (never a team's): read when first needed, so a build needs none of them.

export interface WebConfig {
  mongoUri: string;
  // The task graphs (the factory's tasks, requests, stakeholders, cycles, counters and teams) and the app's accounts.
  e9gDatabase: string;
  authDatabase: string;
  secret: string;
  // Where the app is served from (https://e9g.example.com): links in emails, passkeys' relying party and origin.
  baseURL: string;
  resendKey: string | null;
  mailFrom: string;
  // Sign-in links and invitations go to the server's console instead of by email (development and tests only).
  mailLog: boolean;
}

const DATABASE = /^[\w-]{1,60}$/;

export function readConfig(env: NodeJS.ProcessEnv = process.env): WebConfig {
  const problems: string[] = [];
  const mongoUri = env.MONGODB_URI ?? "";
  if (!/^mongodb(\+srv)?:\/\/\S+$/.test(mongoUri)) problems.push("MONGODB_URI: the connection string (mongodb+srv://…)");
  const e9gDatabase = env.E9G_DATABASE || "e9g";
  const authDatabase = env.AUTH_DATABASE || "e9g_web";
  if (!DATABASE.test(e9gDatabase)) problems.push("E9G_DATABASE: letters, digits, _ and -");
  if (!DATABASE.test(authDatabase)) problems.push("AUTH_DATABASE: letters, digits, _ and -");
  if (e9gDatabase === authDatabase) problems.push("AUTH_DATABASE: the accounts' own database, not the task graphs'");
  const secret = env.BETTER_AUTH_SECRET ?? "";
  if (secret.length < 32) problems.push("BETTER_AUTH_SECRET: at least 32 random characters (openssl rand -base64 32)");
  const baseURL = (env.BETTER_AUTH_URL ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\/[^/\s]+$/.test(baseURL)) problems.push("BETTER_AUTH_URL: the app's address, such as https://e9g.example.com");
  const production = env.NODE_ENV === "production";
  if (production && baseURL.startsWith("http://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(baseURL))
    problems.push("BETTER_AUTH_URL: https in production");
  const resendKey = env.RESEND_API_KEY || null;
  // Never on a Vercel production deployment, whatever it says: links in its logs would sign anyone in.
  const mailLog = !resendKey && env.VERCEL_ENV !== "production" && (env.MAIL_LOG === "1" || (!production && env.MAIL_LOG !== "0"));
  if (problems.length) throw new Error(`The web app's environment isn't set:\n- ${problems.join("\n- ")}`);
  return { mongoUri, e9gDatabase, authDatabase, secret, baseURL, resendKey, mailFrom: env.MAIL_FROM || "E9G <e9g@localhost>", mailLog };
}

let cached: WebConfig | null = null;
export const config = (): WebConfig => (cached ??= readConfig());
