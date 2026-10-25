// The ways the factory reaches the operator away from this Mac, each set up with `e9g connect`. The watchdog sends
// its alerts and the planner's outbox through every connected one, and gives the planner the operator's replies
// from those that take them.
import { join } from "node:path";
import { emailSettings, hasKey, mailer } from "./email.ts";
import { PLANNER_TAG } from "./labels.ts";
import { E9G_HOME } from "./paths.ts";
import { readJson, writeJson } from "./util.ts";

// A reply for one team's planner, which its channel has checked came from the operator.
export interface Reply {
  id: string;
  team: string;
  subject: string;
  text: string;
  via: string;
}
export interface Replies {
  replies: Reply[];
  // What the channel read and won't pass on (not from the operator, or empty), so it isn't read again.
  ignored: { id: string; why: string }[];
  problem?: string;
}

export interface Channel {
  name: string;
  to: string;
  connectedAt: string;
  // What went wrong, or null when it went. Sent for a team, the operator's answer reaches that team's planner; with
  // an id, a retry of the same message isn't delivered twice where the channel can tell.
  send(subject: string, text: string, team?: string, id?: string): Promise<string | null>;
  // The operator's replies, leaving out the ids in seen. Only channels that take replies have it.
  replies?(seen: Set<string>): Promise<Replies>;
}

export const channels = (): Channel[] => [mailer()].filter((channel) => channel !== null);

// How each channel's last send went, written by the watchdog: the planner is told a channel works only while it does.
const SENDS = join(E9G_HOME, "channel-sends.json");
type LastSend = { ok: boolean; at: string; problem?: string };
const lastSends = (): Record<string, LastSend> => {
  try {
    return readJson<Record<string, LastSend>>(SENDS, {});
  } catch {
    return {};
  }
};
export function recordSend(name: string, problem: string | null): void {
  writeJson(SENDS, { ...lastSends(), [name]: { ok: !problem, at: new Date().toISOString(), ...(problem ? { problem } : {}) } });
}
export const failingSend = (name: string): string | null => {
  const last = lastSends()[name];
  return last && !last.ok ? (last.problem ?? "it failed") : null;
};

// For the planner's context: the channels that work, and those that are connected but don't (a key gone from the
// Keychain, or a last send that failed). It reads no secrets.
export function reachSummary(): { working: string[]; failing: string[] } {
  const summary = { working: [] as string[], failing: [] as string[] };
  let email: ReturnType<typeof emailSettings> = null;
  try {
    email = emailSettings();
  } catch {
    summary.failing.push("email (~/.e9g/email.json doesn't read)");
  }
  if (email) {
    const problem = hasKey() ? failingSend("email") : "its key isn't in the Keychain";
    if (problem) summary.failing.push(`email (${problem})`);
    else summary.working.push(`email to ${email.to}${email.replyDomain ? ", with replies" : ""}`);
  }
  return summary;
}

// A draft from the planner's outbox (<date>-<topic>.md) as a message: a first line of "Subject: …" or "# …" is its
// subject, otherwise the topic; either way labelled as the planner's and under the team's title, as its own emails
// are ("[E9G-Planner] [<title>] …"), whether or not the draft already says so.
export function outboxMessage(title: string, file: string, markdown: string): { subject: string; text: string } {
  const lines = markdown.replace(/^\s*\n/, "").split("\n");
  const heading = /^(?:subject:\s*|#\s+)(.+)$/i.exec(lines[0] ?? "")?.[1]?.trim();
  const topic = file
    .replace(/\.md$/, "")
    .replace(/^\d{4}-\d{2}-\d{2}(?:[-T]\d{2}-?\d{2})?-/, "")
    .replaceAll("-", " ");
  let subject = heading ?? topic;
  for (const prefix of [PLANNER_TAG, `[${title}]`]) if (subject.startsWith(prefix)) subject = subject.slice(prefix.length).trim();
  return {
    subject: `${PLANNER_TAG} [${title}] ${subject}`,
    text: `${(heading ? lines.slice(1) : lines).join("\n").trim()}\n`,
  };
}
