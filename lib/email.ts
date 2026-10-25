// Email from the factory itself, with no model: the watchdog's alerts and the planner's outbox reach the operator
// away from this Mac, and their replies reach the planner. `e9g connect email` sets it up. It goes through Resend
// with the operator's own API key (in the Keychain, lib/keychain.ts); the address, the sender and the receiving
// domain are in ~/.e9g/email.json.
//
// Replies: an email about a team has Reply-To e9g-<team>@<the account's receiving domain>. The watchdog lists what
// Resend received there and passes on only what came from the operator's address, signed by its domain (DKIM) or
// passing its DMARC policy. Resend's receiving server checks both, so a forged From fails them.
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Channel, Replies } from "./channels.ts";
import { forgetSecret, hasSecret, readSecret, storeSecret } from "./keychain.ts";
import { E9G_HOME, PACKAGE } from "./paths.ts";
import { escapeRegex, hash, readJson, writeJson } from "./util.ts";

export const EMAIL_FILE = join(E9G_HOME, "email.json");
// Resend's shared sender. Until the operator verifies a domain at Resend, it sends only to the address they signed up with.
export const DEFAULT_FROM = "E9G Factory <onboarding@resend.dev>";
export const ADDRESS = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const RESEND_KEY = /^re_\w+$/;
const KEYCHAIN = ["ca.e9g.email", "resend"] as const;
// E9G_RESEND_URL is for the tests.
const api = (): string => process.env.E9G_RESEND_URL ?? "https://api.resend.com";

export interface EmailSettings {
  provider: "resend";
  to: string;
  from: string;
  // The account's receiving domain (<id>.resend.app, or one of its own): set when replies are on.
  replyDomain?: string;
  connectedAt: string;
}

export const emailSettings = (): EmailSettings | null => readJson<EmailSettings>(EMAIL_FILE);
export const saveEmailSettings = (settings: EmailSettings): void => writeJson(EMAIL_FILE, settings);
export const readKey = (): string | null => readSecret(...KEYCHAIN);
export const hasKey = (): boolean => hasSecret(...KEYCHAIN);
export const storeKey = (key: string): boolean => RESEND_KEY.test(key) && storeSecret(...KEYCHAIN, "E9G Factory email", key);
export function forgetEmail(): void {
  forgetSecret(...KEYCHAIN);
  rmSync(EMAIL_FILE, { force: true });
}

type Answer<T> = { ok: true; body: T } | { ok: false; status: number; problem: string };
async function resend<T>(key: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer<T>> {
  let response: Response;
  try {
    response = await fetch(`${api()}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "User-Agent": `e9g/${PACKAGE.version}`, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    return { ok: false, status: 0, problem: `Resend didn't answer (${(error as Error).message})` };
  }
  const parsed = (await response.json().catch(() => ({}))) as T & { message?: string };
  if (response.ok) return { ok: true, body: parsed };
  return { ok: false, status: response.status, problem: `Resend refused it (${response.status}${parsed.message ? `: ${parsed.message}` : ""})` };
}

// What went wrong, or null when Resend accepted the email. With an id, Resend takes the same email only once in a
// day, so a send that timed out after it arrived isn't sent twice when it's tried again.
export async function sendEmail(
  settings: Pick<EmailSettings, "to" | "from">,
  key: string,
  subject: string,
  text: string,
  { replyTo, id }: { replyTo?: string | undefined; id?: string | undefined } = {}
): Promise<string | null> {
  const answer = await resend(
    key,
    "/emails",
    { from: settings.from, to: [settings.to], subject, text, ...(replyTo ? { reply_to: [replyTo] } : {}) },
    id ? { "Idempotency-Key": `e9g-${hash(id, settings.to)}` } : {}
  );
  return answer.ok ? null : answer.problem;
}

// Null when the key may read what Resend received; a key with sending access only may not.
export async function canReadReplies(key: string): Promise<string | null> {
  const answer = await resend(key, "/emails/receiving?limit=1");
  if (answer.ok) return null;
  return [401, 403].includes(answer.status) ? "this key can only send; replies need a key with full access" : answer.problem;
}

export const replyAddress = (domain: string, team: string): string => `e9g-${team}@${domain}`;

interface Received {
  id: string;
  to: unknown[];
  subject: string;
  created_at: string;
}
interface ReceivedEmail {
  from?: unknown;
  text?: unknown;
  html?: unknown;
  authentication?: { spf?: string; dkim?: string; dmarc?: string } | null;
}
const received = (item: unknown): item is Received => {
  const { id, to, created_at } = (item ?? {}) as Partial<Received>;
  return typeof id === "string" && Array.isArray(to) && typeof created_at === "string";
};

// The address in "Name <address>" or a bare one, lowercase; "" for anything else, such as a display name that holds
// an address of its own.
export function address(value: unknown): string {
  if (typeof value !== "string") return "";
  const open = value.lastIndexOf("<");
  const display = open >= 0 ? value.slice(0, open) : "";
  const inner = (open >= 0 ? value.slice(open + 1).replace(/>\s*$/, "") : value).trim().toLowerCase();
  return !display.includes("@") && /^[^\s@<>"]+@[^\s@<>"]+$/.test(inner) ? inner : "";
}
// Resend's timestamps, with or without the T and the minutes of the offset; NaN for anything else.
const time = (value: string): number => Date.parse(value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));

const htmlText = (html: string): string =>
  html
    .replace(/<(head|style|script|blockquote)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<(br|\/p|\/div|\/li)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

// What the operator wrote above the message they're answering.
export function replyText(text: string): string {
  const kept: string[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (/wrote:\s*$/.test(line)) {
      // "On <date>, <name> <address> wrote:", which mail apps wrap over two lines.
      if (!/^\s*On\b/.test(line) && /^\s*On\b/.test(kept.at(-1) ?? "")) kept.pop();
      break;
    }
    if (/^\s*(-{2,}\s*Original Message\s*-{2,}|_{20,}|From:\s.+)$/i.test(line)) break;
    if (!/^\s*>/.test(line)) kept.push(line);
  }
  return kept.join("\n").trim().slice(0, 4000);
}

// What Resend received since email was connected, newest first: up to five pages of a hundred, which outlasts a
// paused team or a burst of mail to the receiving domain.
async function listReceived(key: string, since: number): Promise<Received[] | { problem: string }> {
  const items: Received[] = [];
  let after = "";
  for (let page = 0; page < 5; page++) {
    const listed = await resend<{ data?: unknown; has_more?: boolean }>(
      key,
      `/emails/receiving?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`
    );
    if (!listed.ok) return { problem: listed.problem };
    const data = Array.isArray(listed.body.data) ? listed.body.data.filter(received) : [];
    items.push(...data);
    const last = data.at(-1);
    if (!listed.body.has_more || !last || !(time(last.created_at) >= since)) break;
    after = last.id;
  }
  return items;
}

async function readReplies(settings: EmailSettings, domain: string, key: string, seen: Set<string>): Promise<Replies> {
  const since = Date.parse(settings.connectedAt);
  const listed = await listReceived(key, since);
  if ("problem" in listed) return { replies: [], ignored: [], problem: listed.problem };
  const ours = new RegExp(`^e9g-([a-z][a-z0-9-]{0,30})@${escapeRegex(domain.toLowerCase())}$`);
  const result: Replies = { replies: [], ignored: [] };
  const fresh = listed.filter((item) => !seen.has(item.id) && time(item.created_at) >= since).sort((a, b) => time(a.created_at) - time(b.created_at));
  for (const item of fresh) {
    const team = item.to.map((to) => ours.exec(address(to))?.[1]).find(Boolean);
    if (!team) continue;
    const email = await resend<ReceivedEmail>(key, `/emails/receiving/${encodeURIComponent(item.id)}`);
    if (!email.ok) {
      result.problem = email.problem;
      continue;
    }
    const { from, text, html, authentication } = email.body;
    if (address(from) !== settings.to.toLowerCase() || !(authentication?.dkim === "pass" || authentication?.dmarc === "pass")) {
      result.ignored.push({ id: item.id, why: `an email to e9g-${team} that isn't from the operator's address, signed or passing DMARC` });
      continue;
    }
    const answer = replyText(typeof text === "string" ? text : htmlText(typeof html === "string" ? html : ""));
    if (!answer) result.ignored.push({ id: item.id, why: `an empty reply to e9g-${team}` });
    else result.replies.push({ id: item.id, team, subject: typeof item.subject === "string" ? item.subject : "", text: answer, via: "email" });
  }
  return result;
}

// The connected email, or null when email isn't connected or its key is gone.
export function mailer(): Channel | null {
  const settings = emailSettings();
  const key = settings && readKey();
  if (!settings || !key) return null;
  const domain = settings.replyDomain;
  return {
    name: "email",
    to: settings.to,
    connectedAt: settings.connectedAt,
    send: (subject, text, team, id) => sendEmail(settings, key, subject, text, { replyTo: domain && team ? replyAddress(domain, team) : undefined, id }),
    ...(domain ? { replies: (seen: Set<string>) => readReplies(settings, domain, key, seen) } : {}),
  };
}
