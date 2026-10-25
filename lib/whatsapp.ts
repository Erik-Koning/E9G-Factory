// WhatsApp from the factory, through the operator's own WhatsApp Business number on Meta's Cloud API, so the
// watchdog's alerts and the planner's outbox reach their phone. `e9g connect whatsapp` sets it up. The access token
// is in the Keychain (lib/keychain.ts); the number's ids and the operator's number are in ~/.e9g/whatsapp.json.
//
// A business may message someone first only with a template Meta has approved: free text more than 24 hours after
// their last message fails later, in a webhook the factory can't see. So every message goes through one utility
// template, e9g_update, which connect creates on the account. Replies aren't read: they arrive only at the number's
// webhook, a public server that belongs to whatever else uses the number.
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Channel } from "./channels.ts";
import { forgetSecret, hasSecret, readSecret, storeSecret } from "./keychain.ts";
import { PLANNER_LABEL, PLANNER_TAG } from "./labels.ts";
import { E9G_HOME, PACKAGE } from "./paths.ts";
import { readJson, writeJson } from "./util.ts";

export const WHATSAPP_FILE = join(E9G_HOME, "whatsapp.json");
export const TEMPLATE = "e9g_update";
const LANGUAGE = "en";
// Meta refuses a template that starts or ends with a parameter.
export const TEMPLATE_BODY = "E9G Factory has an update about {{1}}:\n\n{{2}}\n\nOpen T3 Code on your Mac for the details.";
const KEYCHAIN = ["ca.e9g.whatsapp", "meta"] as const;
// Graph API v25.0 (February 2026) is supported until July 2028. E9G_GRAPH_URL is for the tests.
const api = (): string => process.env.E9G_GRAPH_URL ?? "https://graph.facebook.com/v25.0";

export interface WhatsAppSettings {
  provider: "meta";
  phoneNumberId: string;
  accountId: string;
  // The operator's number: digits only, with its country code.
  to: string;
  connectedAt: string;
}

export const whatsappSettings = (): WhatsAppSettings | null => readJson<WhatsAppSettings>(WHATSAPP_FILE);
export const saveWhatsAppSettings = (settings: WhatsAppSettings): void => writeJson(WHATSAPP_FILE, settings);
export const readToken = (): string | null => readSecret(...KEYCHAIN);
export const hasToken = (): boolean => hasSecret(...KEYCHAIN);
export const storeToken = (token: string): boolean => storeSecret(...KEYCHAIN, "E9G Factory WhatsApp", token);
export function forgetWhatsApp(): void {
  forgetSecret(...KEYCHAIN);
  rmSync(WHATSAPP_FILE, { force: true });
}

interface GraphError {
  error?: { message?: string; code?: number; error_user_msg?: string; error_data?: { details?: string } };
}
type Answer<T> = { ok: true; body: T } | { ok: false; status: number; problem: string };
async function graph<T>(token: string, path: string, body?: unknown): Promise<Answer<T>> {
  let response: Response;
  try {
    response = await fetch(`${api()}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": `e9g/${PACKAGE.version}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    return { ok: false, status: 0, problem: `Meta didn't answer (${(error as Error).message})` };
  }
  const parsed = (await response.json().catch(() => ({}))) as T & GraphError;
  if (response.ok) return { ok: true, body: parsed };
  const { message, code, error_user_msg, error_data } = parsed.error ?? {};
  const said = error_user_msg ?? error_data?.details ?? message;
  return { ok: false, status: response.status, problem: `Meta refused it (${response.status}${code ? `, code ${code}` : ""}${said ? `: ${said}` : ""})` };
}

// The business number as WhatsApp shows it, which also proves the id and the token.
export async function businessNumber(phoneNumberId: string, token: string): Promise<{ name: string } | { problem: string }> {
  const answer = await graph<{ verified_name?: string; display_phone_number?: string }>(
    token,
    `/${phoneNumberId}?fields=display_phone_number,verified_name`
  );
  if (!answer.ok) return { problem: answer.problem };
  return { name: `${answer.body.verified_name ?? "your business"} (${answer.body.display_phone_number ?? phoneNumberId})` };
}

// The template's status on the account (APPROVED, PENDING, REJECTED, …), creating it when it isn't there.
export async function ensureTemplate(accountId: string, token: string): Promise<{ status: string; reason?: string } | { problem: string }> {
  type Template = { name: string; language: string; status: string; rejected_reason?: string };
  const found = await graph<{ data?: Template[] }>(token, `/${accountId}/message_templates?name=${TEMPLATE}&fields=name,language,status,rejected_reason`);
  if (!found.ok) return { problem: found.problem };
  const template = found.body.data?.find((t) => t.name === TEMPLATE && t.language === LANGUAGE);
  if (template)
    return { status: template.status, ...(template.rejected_reason && template.rejected_reason !== "NONE" ? { reason: template.rejected_reason } : {}) };
  const made = await graph<{ status?: string }>(token, `/${accountId}/message_templates`, {
    name: TEMPLATE,
    language: LANGUAGE,
    category: "UTILITY",
    components: [
      {
        type: "BODY",
        text: TEMPLATE_BODY,
        example: { body_text: [["My app", "The planner is waiting for your answer: Postgres or SQLite for the job queue?"]] },
      },
    ],
  });
  return made.ok ? { status: made.body.status ?? "PENDING" } : { problem: made.problem };
}

// A template parameter: one line, with no tabs or runs of spaces, which WhatsApp refuses in one.
const parameter = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

// A message as the template's two parameters: what it's about (the team's title from "[title] …", after the planner's
// label when the planner wrote it, "[E9G-Planner] [title] …", so the parameter starts with the label too and the
// approved template stays as it is), and the subject with the text after it, leaving out a paragraph that repeats
// the subject and the watchdog's sign-off.
export function whatsappMessage(subject: string, text: string): [string, string] {
  const planner = subject.startsWith(PLANNER_TAG);
  const rest = planner ? subject.slice(PLANNER_TAG.length).trim() : subject;
  const title = /^\[([^\]]+)\]/.exec(rest)?.[1];
  const headline = rest.replace(/^\[[^\]]+\]\s*/, "").trim();
  const body = text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph && paragraph !== headline && !paragraph.startsWith("Sent by the E9G Factory watchdog"))
    .join(" ");
  const message = body ? `${headline}${/[.!?:]$/.test(headline) ? "" : "."} ${body}` : headline;
  const about = !title || title === "E9G Factory" ? "your teams" : title;
  return [parameter(planner ? `${PLANNER_LABEL} · ${about}` : about, 60), parameter(message, 700)];
}

// What went wrong, or null when Meta accepted the message. Accepted isn't delivered: a number that isn't on
// WhatsApp fails later, in the webhook.
export async function sendWhatsApp(
  settings: Pick<WhatsAppSettings, "phoneNumberId" | "to">,
  token: string,
  subject: string,
  text: string
): Promise<string | null> {
  const [about, message] = whatsappMessage(subject, text);
  const answer = await graph(token, `/${settings.phoneNumberId}/messages`, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: settings.to,
    type: "template",
    template: {
      name: TEMPLATE,
      language: { code: LANGUAGE },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: about },
            { type: "text", text: message },
          ],
        },
      ],
    },
  });
  return answer.ok ? null : answer.problem;
}

// The connected WhatsApp, or null when it isn't connected or its token is gone. It sends; it takes no replies.
export function whatsappChannel(): Channel | null {
  const settings = whatsappSettings();
  const token = settings && readToken();
  if (!settings || !token) return null;
  return {
    name: "whatsapp",
    to: `+${settings.to}`,
    connectedAt: settings.connectedAt,
    send: (subject, text) => sendWhatsApp(settings, token, subject, text),
  };
}
