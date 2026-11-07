// What each person is emailed about, and when: for each kind of event (events.ts), at once, in a daily digest, or not
// at all; the hour of their digest in their time zone; teams they'd rather not hear about; and, for admins, whether the
// digest also says what still waits on them. Their choices are in the accounts database (notification_prefs); until
// they make any, the defaults for their role on each team apply. The emails are written here too (pure), and the
// notifier (notifier.ts) sends them.
import { authDb } from "./db.ts";
import type { TeamRole } from "./access.ts";
import { EVENT_KINDS, type EventKind, type TeamEvent } from "./events.ts";

export const MODES = ["now", "digest", "off"] as const;
export type Mode = (typeof MODES)[number];
export const isMode = (value: unknown): value is Mode => typeof value === "string" && (MODES as readonly string[]).includes(value);
export const MODE_LABEL: Record<Mode, string> = { now: "At once", digest: "In the daily digest", off: "Don't email" };

export const KIND_TEXT: Record<EventKind, { label: string; hint: string }> = {
  question: { label: "Questions for you", hint: "The team raised something to you: a decision, or work only you can unblock." },
  blocked: { label: "Blocked work", hint: "A task stopped on something the team sorts out itself." },
  journey: { label: "Journeys done", hint: "A journey's tasks are built and verified." },
  team: { label: "A team pauses or finishes", hint: "It stopped, or reached its finish line." },
  merged: { label: "Work merged", hint: "Each task the merge queue lands." },
  request: { label: "Your requests", hint: "The planner takes up or turns down a request you sent." },
};

// What each role hears of until they choose: admins what needs them at once and the rest in the digest; members and
// contributors what they'd follow on the overview.
const DEFAULTS: Record<"admin" | TeamRole, Record<EventKind, Mode>> = {
  admin: { question: "now", blocked: "digest", journey: "now", team: "now", merged: "digest", request: "now" },
  member: { question: "off", blocked: "digest", journey: "now", team: "now", merged: "off", request: "now" },
  contributor: { question: "off", blocked: "off", journey: "digest", team: "off", merged: "off", request: "now" },
};

export interface Prefs {
  _id: string;
  modes: Record<EventKind, Mode>;
  // The digest also lists what still waits on them (admins).
  reminder: boolean;
  digestHour: number;
  timeZone: string;
  // Teams they don't want email about.
  muted: string[];
  updatedAt: Date;
}

// A person's settings: theirs, or the defaults for `role` (their role where it's widest).
export function prefsOr(saved: Prefs | null, userId: string, role: "admin" | TeamRole, timeZone: string): Prefs {
  return saved ?? { _id: userId, modes: { ...DEFAULTS[role] }, reminder: role === "admin", digestHour: 8, timeZone, muted: [], updatedAt: new Date(0) };
}
// The mode for `kind` on a team where they're `role`: their choice once they've saved one, the role's default before.
export const modeFor = (saved: Prefs | null, kind: EventKind, role: "admin" | TeamRole): Mode => saved?.modes[kind] ?? DEFAULTS[role][kind];

const prefs = () => authDb().collection<Prefs>("notification_prefs");
export const savedPrefs = (userId: string): Promise<Prefs | null> => prefs().findOne({ _id: userId });
export const allSavedPrefs = async (): Promise<Map<string, Prefs>> => new Map((await prefs().find({}).toArray()).map((p) => [p._id, p]));
export async function savePrefs(next: Omit<Prefs, "updatedAt">): Promise<void> {
  await prefs().replaceOne({ _id: next._id }, { ...next, updatedAt: new Date() }, { upsert: true });
}

// --- Time zones and the digest's hour ------------------------------------------------------------------------------

export const timeZones = (): string[] => ["UTC", ...Intl.supportedValuesOf("timeZone").filter((z) => z !== "UTC")];
export const isTimeZone = (value: unknown): value is string => typeof value === "string" && timeZones().includes(value);

// Today's digest moment for a person: `hour`:00 on the date it is now in `timeZone`, as an instant.
export function digestMoment(now: Date, timeZone: string, hour: number): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" })
      .formatToParts(now)
      .map((p) => [p.type, Number(p.value)])
  ) as Record<string, number>;
  const y = parts["year"] ?? 1970;
  const m = (parts["month"] ?? 1) - 1;
  const d = parts["day"] ?? 1;
  // How far the zone's wall clock is from UTC now, to the minute.
  const offset = Date.UTC(y, m, d, parts["hour"] ?? 0, parts["minute"] ?? 0) - Math.floor(now.getTime() / 60_000) * 60_000;
  return new Date(Date.UTC(y, m, d, hour) - offset);
}
// The next digest after `now` (for the settings page).
export function nextDigest(now: Date, timeZone: string, hour: number): Date {
  const today = digestMoment(now, timeZone, hour);
  return today > now ? today : digestMoment(new Date(now.getTime() + 86_400_000), timeZone, hour);
}

// --- The emails ----------------------------------------------------------------------------------------------------

export interface Mail {
  subject: string;
  text: string;
  link: string;
}
type Titles = ReadonlyMap<string, string>;

const SUBJECT: Record<EventKind, (e: TeamEvent) => string> = {
  question: (e) => `Question for you: ${e.title}`,
  blocked: (e) => `Blocked: ${e.title}`,
  journey: (e) => e.title,
  team: (e) => e.title,
  merged: (e) => `Merged: ${e.title}`,
  request: (e) => e.title,
};

const footer = (base: string): string => `You get this because of your notification settings: ${base}/account/notifications`;
const teamOf = (titles: Titles, team: string): string => titles.get(team) || team;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function grouped(events: TeamEvent[], titles: Titles, base: string): string[] {
  const teams = [...new Set(events.map((e) => e.team))];
  return teams.flatMap((team) => [
    ...(teams.length > 1 ? [`${teamOf(titles, team)}:`] : []),
    ...events.filter((e) => e.team === team).map((e) => `- ${SUBJECT[e.kind](e)}\n  ${base}${e.path}`),
    "",
  ]);
}

// What goes at once: one event as its own email, several (from one run of the notifier) together.
export function nowMail(events: TeamEvent[], titles: Titles, base: string): Mail {
  const [first] = events;
  if (!first) throw new Error("nothing to send");
  const where = [...new Set(events.map((e) => teamOf(titles, e.team)))];
  if (events.length === 1) {
    const link = `${base}${first.path}`;
    const action = first.kind === "question" ? "Answer it" : "See it";
    return {
      subject: `[${where[0]}] ${SUBJECT[first.kind](first)}`,
      text: [SUBJECT[first.kind](first), first.detail, `${action}: ${link}`, footer(base)].filter(Boolean).join("\n\n"),
      link,
    };
  }
  const questions = events.filter((e) => e.kind === "question").length;
  const link = questions ? `${base}/inbox` : `${base}/`;
  const what = questions === events.length ? plural(questions, "question") + " for you" : plural(events.length, "update");
  return {
    subject: `[${where.join(", ")}] ${what}`,
    text: [
      `${what[0]?.toUpperCase()}${what.slice(1)}:`,
      grouped(events, titles, base).join("\n").trim(),
      questions ? `Answer them: ${link}` : "",
      footer(base),
    ]
      .filter(Boolean)
      .join("\n\n"),
    link,
  };
}

export interface StillWaiting {
  team: string;
  items: { id: string; title: string; status: string; since: string }[];
}

// The daily digest: what still waits on them (when they asked for that), then what happened since the last one.
export function digestMail(events: TeamEvent[], waiting: StillWaiting[], titles: Titles, base: string, day: string): Mail {
  const open = waiting.reduce((n, w) => n + w.items.length, 0);
  const subject = [open ? `${open} waiting on you` : "", events.length ? plural(events.length, "update") : ""].filter(Boolean).join(", ");
  const parts: string[] = [`Your Anything Factory digest for ${day}.`];
  if (open) {
    parts.push(
      [
        "Waiting on you:",
        ...waiting.flatMap((w) => [
          ...(waiting.length > 1 ? [`${teamOf(titles, w.team)}:`] : []),
          ...w.items.map((i) => `- #${i.id} ${i.title} (${i.status === "question" ? "a question" : "blocked"}, since ${i.since.slice(0, 10)})`),
        ]),
        `Answer them: ${base}/inbox`,
      ].join("\n")
    );
  }
  if (events.length) parts.push(["Since your last digest:", ...grouped(events, titles, base)].join("\n").trim());
  parts.push(footer(base));
  return { subject: `[Anything Factory] ${subject || "Your digest"}`, text: parts.join("\n\n"), link: open ? `${base}/inbox` : `${base}/` };
}

// The test email from the settings page: what they'll get, to the address they'll get it at.
export function testMail(name: string, summary: string[], base: string): Mail {
  return {
    subject: "[Anything Factory] Test email: your notifications reach you",
    text: [
      `Hello ${name}, this is the test email you asked for. Notifications will come to this address.`,
      ["What you get:", ...summary].join("\n"),
      footer(base),
    ].join("\n\n"),
    link: `${base}/account/notifications`,
  };
}

// The settings in words, a line each, for the page and the test email.
export function summaryOf(p: Prefs, kinds: readonly EventKind[], hourText: string): string[] {
  const at = kinds.filter((k) => p.modes[k] === "now").map((k) => KIND_TEXT[k].label.toLowerCase());
  const digest = kinds.filter((k) => p.modes[k] === "digest").map((k) => KIND_TEXT[k].label.toLowerCase());
  return [
    at.length ? `- At once: ${at.join(", ")}.` : "- Nothing at once.",
    digest.length || p.reminder
      ? `- Daily at ${hourText} (${p.timeZone}): ${[...digest, ...(p.reminder ? ["what still waits on you"] : [])].join(", ")}.`
      : "- No daily digest.",
    ...(p.muted.length ? [`- Nothing about: ${p.muted.join(", ")}.`] : []),
  ];
}

export const kindsIn = (abilityOn: (kind: EventKind) => boolean): EventKind[] => EVENT_KINDS.filter(abilityOn);
export const hourLabel = (hour: number): string => `${String(hour).padStart(2, "0")}:00`;

// --- Whose settings, and test emails -------------------------------------------------------------------------------

// The role a person's settings default to: the one that hears the most of their roles.
export const widestRole = (viewer: { admin: boolean; teams: Readonly<Record<string, TeamRole>> }): "admin" | TeamRole =>
  viewer.admin ? "admin" : Object.values(viewer.teams).includes("member") ? "member" : "contributor";

interface HourCount {
  _id: string;
  n: number;
  expiresAt: Date;
}
// Counts one more test email from `userId` this hour; false past `limit`.
export async function takeTestAllowance(userId: string, limit: number, now = new Date()): Promise<boolean> {
  const counts = authDb().collection<HourCount>("notification_tests");
  await counts.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {});
  const hour = now.toISOString().slice(0, 13);
  const row = await counts.findOneAndUpdate(
    { _id: `${userId}:${hour}` },
    { $inc: { n: 1 }, $setOnInsert: { expiresAt: new Date(now.getTime() + 2 * 3_600_000) } },
    { upsert: true, returnDocument: "after" }
  );
  return (row?.n ?? 1) <= limit;
}
