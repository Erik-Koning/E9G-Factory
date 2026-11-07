// The notifier. While the app runs (instrumentation.ts starts it), every NOTIFY_EVERY_SECONDS and one container at a time
// (a lease in the accounts database), it reads each team's graph for what's happened since it last looked (events.ts),
// queues an email for each person and event their settings ask for (notifications.ts), sends what goes at once, and
// each person's daily digest once its hour has come. A queued email's id is the person and the event, so each goes
// once however often the graph is read; a team it sees for the first time has no news yet.
import { randomUUID } from "node:crypto";
import type { Task } from "../../lib/tasks/model.ts";
import { can, type TeamRole, type Viewer } from "./access.ts";
import { isAdminRole } from "./auth.ts";
import { config } from "./config.ts";
import { authDb } from "./db.ts";
import { AUDIENCE, eventsOf, stateEvent, type TeamEvent } from "./events.ts";
import { allTeams, storeFor } from "./factory.ts";
import { inbox } from "./inbox.ts";
import { sendMail } from "./mail.ts";
import {
  allSavedPrefs,
  digestMail,
  digestMoment,
  type Mode,
  modeFor,
  nowMail,
  type Prefs,
  prefsOr,
  type StillWaiting,
  widestRole,
} from "./notifications.ts";
import { type Membership, memberships } from "./people.ts";

// Events are read again this far back, for a graph written late or a clock that's off; the queue's ids keep each once.
const OVERLAP_MS = 30 * 60_000;
// A container holds the lease this long past its last run; another takes over once it lapses.
const LEASE_MS = 3 * 60_000;
// An email that fails this often is given up on.
const ATTEMPTS = 5;
const KEEP_DAYS = 30;

export interface Queued extends Omit<TeamEvent, "id"> {
  _id: string;
  userId: string;
  eventId: string;
  mode: Exclude<Mode, "off">;
  createdAt: Date;
  sentAt: Date | null;
  attempts: number;
  error: string | null;
}
interface Mark {
  _id: string;
  holder?: string;
  until?: Date;
  // A team's cursor: when the notifier first saw it (nothing before is news) and how far it has read.
  from?: string;
  through?: string;
  state?: string | null;
  at?: Date;
  error?: string | null;
}

export const queue = () => authDb().collection<Queued>("notification_queue");
const marks = () => authDb().collection<Mark>("notifier");
const holder = randomUUID();

export async function ensureIndexes(): Promise<void> {
  await queue().createIndex({ mode: 1, sentAt: 1, at: 1 });
  await queue().createIndex({ userId: 1, sentAt: 1 });
  await queue().createIndex({ createdAt: 1 }, { expireAfterSeconds: KEEP_DAYS * 86_400 });
}

const duplicate = (error: unknown): boolean => (error as { code?: number }).code === 11000;

// The lease: this container's, renewed, unless another holds one that hasn't lapsed.
async function lease(now: Date): Promise<boolean> {
  try {
    const got = await marks().findOneAndUpdate(
      { _id: "lease", $or: [{ until: { $lt: now } }, { holder }] },
      { $set: { holder, until: new Date(now.getTime() + LEASE_MS) } },
      { upsert: true, returnDocument: "after" }
    );
    return got?.holder === holder;
  } catch (error) {
    if (duplicate(error)) return false;
    throw error;
  }
}

interface Person {
  userId: string;
  email: string;
  name: string;
  admin: boolean;
}

// Everyone who signs in and isn't banned, from the accounts (Better Auth's user collection).
async function people(): Promise<Person[]> {
  const rows = await authDb()
    .collection<{ _id: unknown; email: string; name: string; role?: string; banned?: boolean }>("user")
    .find({ banned: { $ne: true } }, { projection: { email: 1, name: 1, role: 1 } })
    .toArray();
  return rows.map((r) => ({ userId: String(r._id), email: r.email, name: r.name, admin: isAdminRole(r.role) }));
}

// The person as the access rules see them, signed in fully: what they could open in the app is what they hear about.
const viewerOf = (person: Person, rows: Membership[]): Viewer => ({
  userId: person.userId,
  admin: person.admin,
  secondFactor: true,
  twoFactor: true,
  ipConfirmed: true,
  teams: Object.fromEntries(rows.filter((m) => m.userId === person.userId).map((m) => [m.team, m.role])),
});
const roleOn = (viewer: Viewer, team: string): "admin" | TeamRole | null => (viewer.admin ? "admin" : (viewer.teams[team] ?? null));

export interface Run {
  skipped: boolean;
  queued: number;
  sent: number;
  digests: number;
}

export async function notifyOnce(now = new Date()): Promise<Run> {
  if (!(await lease(now))) return { skipped: true, queued: 0, sent: 0, digests: 0 };
  const settings = config();
  const [teams, everyone, rows, saved] = await Promise.all([allTeams(), people(), memberships(), allSavedPrefs()]);
  const titles = new Map(teams.map((t) => [t.name, t.title || t.name]));
  const viewers = new Map(everyone.map((p) => [p.userId, viewerOf(p, rows)]));
  const graphs = new Map<string, Task[]>();
  let queued = 0;
  for (const team of teams) {
    const store = storeFor(team.name);
    const [tasks, requests, stakeholders] = await Promise.all([store.tasks.all(), store.requests.all(), store.stakeholders.all()]);
    graphs.set(team.name, tasks);
    const cursorId = `team:${team.name}`;
    const state = team.status?.state ?? null;
    const cursor = await marks().findOne({ _id: cursorId });
    if (!cursor?.through) {
      await marks().updateOne({ _id: cursorId }, { $set: { from: now.toISOString(), through: now.toISOString(), state } }, { upsert: true });
      continue;
    }
    const since = [new Date(Date.parse(cursor.through) - OVERLAP_MS).toISOString(), cursor.from ?? ""].sort().at(-1) ?? cursor.through;
    const changed = stateEvent(team.name, titles.get(team.name) ?? team.name, team.status, cursor.state ?? null);
    const events = [...eventsOf(team.name, tasks, requests, since), ...(changed ? [changed] : [])];
    const owners = new Map(stakeholders.map((s) => [s.id, s.userId ?? null]));
    const docs: Queued[] = [];
    for (const person of everyone) {
      const viewer = viewers.get(person.userId);
      const role = viewer ? roleOn(viewer, team.name) : null;
      if (!viewer || !role) continue;
      const mine = saved.get(person.userId) ?? null;
      if (mine?.muted.includes(team.name)) continue;
      for (const { id, ...event } of events) {
        if (!can(viewer, AUDIENCE[event.kind], team.name)) continue;
        if (event.kind === "request" && (!event.to || owners.get(event.to) !== person.userId)) continue;
        const mode = modeFor(mine, event.kind, role);
        if (mode === "off") continue;
        docs.push({
          ...event,
          _id: `${person.userId}|${id}`,
          userId: person.userId,
          eventId: id,
          mode,
          createdAt: now,
          sentAt: null,
          attempts: 0,
          error: null,
        });
      }
    }
    queued += await insertNew(docs);
    await marks().updateOne({ _id: cursorId }, { $set: { through: now.toISOString(), state } });
  }
  const sent = await sendNow(now, everyone, titles, settings.baseURL);
  const digests = await sendDigests(now, everyone, viewers, saved, graphs, titles, settings);
  return { skipped: false, queued, sent, digests };
}

// Queues what isn't queued yet; resolves to how many were new.
async function insertNew(docs: Queued[]): Promise<number> {
  if (!docs.length) return 0;
  try {
    return (await queue().insertMany(docs, { ordered: false })).insertedCount;
  } catch (error) {
    const result = error as { code?: number; insertedCount?: number; writeErrors?: { code?: number }[] };
    const errors = Array.isArray(result.writeErrors) ? result.writeErrors : [];
    if (duplicate(error) || (errors.length && errors.every((e) => e.code === 11000))) return result.insertedCount ?? 0;
    throw error;
  }
}

const eventOf = (q: Queued): TeamEvent => ({ id: q.eventId, kind: q.kind, team: q.team, at: q.at, title: q.title, detail: q.detail, path: q.path });

// What goes at once: one email per person, with everything new for them since the last run.
async function sendNow(now: Date, everyone: Person[], titles: ReadonlyMap<string, string>, base: string): Promise<number> {
  const due = await queue()
    .find({ mode: "now", sentAt: null, attempts: { $lt: ATTEMPTS } })
    .sort({ at: 1 })
    .limit(1000)
    .toArray();
  const byPerson = new Map(everyone.map((p) => [p.userId, p]));
  const groups = new Map<string, Queued[]>();
  for (const q of due) groups.set(q.userId, [...(groups.get(q.userId) ?? []), q]);
  let sent = 0;
  for (const [userId, items] of groups) {
    const ids = items.map((q) => q._id);
    const person = byPerson.get(userId);
    if (!person) {
      await queue().updateMany({ _id: { $in: ids } }, { $set: { sentAt: now, error: "nobody to send it to: the account is gone or banned" } });
      continue;
    }
    try {
      await sendMail({ to: person.email, ...nowMail(items.map(eventOf), titles, base) });
      await queue().updateMany({ _id: { $in: ids } }, { $set: { sentAt: now, error: null } });
      sent++;
    } catch (error) {
      await queue().updateMany({ _id: { $in: ids } }, { $inc: { attempts: 1 }, $set: { error: (error as Error).message.slice(0, 300) } });
      console.error(`[notify] couldn't email ${userId}: ${(error as Error).message}`);
    }
  }
  return sent;
}

// Each person's daily digest, once its hour has come in their time zone: what queued for it, and (when they asked)
// what still waits on them. Nothing to say, no email; a failed send waits for tomorrow's, with the same items.
async function sendDigests(
  now: Date,
  everyone: Person[],
  viewers: ReadonlyMap<string, Viewer>,
  saved: ReadonlyMap<string, Prefs>,
  graphs: ReadonlyMap<string, Task[]>,
  titles: ReadonlyMap<string, string>,
  settings: { baseURL: string; notifyTimeZone: string }
): Promise<number> {
  let sent = 0;
  for (const person of everyone) {
    const viewer = viewers.get(person.userId);
    if (!viewer) continue;
    const prefs = prefsOr(saved.get(person.userId) ?? null, person.userId, widestRole(viewer), settings.notifyTimeZone);
    const moment = digestMoment(now, prefs.timeZone, prefs.digestHour);
    if (now < moment) continue;
    const markId = `digest:${person.userId}`;
    const mark = await marks().findOne({ _id: markId });
    if (mark?.at && mark.at >= moment) continue;
    const items = await queue()
      .find({ userId: person.userId, mode: "digest", sentAt: null, attempts: { $lt: ATTEMPTS } })
      .sort({ at: 1 })
      .toArray();
    const waiting: StillWaiting[] = prefs.reminder
      ? [...graphs]
          .filter(([team]) => can(viewer, "proposals:decide", team) && !prefs.muted.includes(team))
          .map(([team, tasks]) => {
            const box = inbox(tasks, { now: now.getTime() });
            return {
              team,
              items: [...box.questions, ...box.blocked].map((w) => ({ id: w.task.id, title: w.task.title, status: w.task.status, since: w.since })),
            };
          })
          .filter((w) => w.items.length)
      : [];
    if (items.length || waiting.length) {
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: prefs.timeZone, weekday: "long", month: "long", day: "numeric" }).format(now);
      const ids = items.map((q) => q._id);
      try {
        await sendMail({ to: person.email, ...digestMail(items.map(eventOf), waiting, titles, settings.baseURL, day) });
        if (ids.length) await queue().updateMany({ _id: { $in: ids } }, { $set: { sentAt: now, error: null } });
        sent++;
      } catch (error) {
        if (ids.length)
          await queue().updateMany({ _id: { $in: ids } }, { $inc: { attempts: 1 }, $set: { error: (error as Error).message.slice(0, 300) } });
        console.error(`[notify] couldn't send ${person.userId} their digest: ${(error as Error).message}`);
      }
    }
    await marks().updateOne({ _id: markId }, { $set: { at: now } }, { upsert: true });
  }
  return sent;
}

// When a person was last emailed, and how many emails wait (for the settings page).
export async function deliveryOf(userId: string): Promise<{ lastSent: Date | null; waiting: number; failing: string | null }> {
  const [last, waiting, failing] = await Promise.all([
    queue()
      .find({ userId, sentAt: { $ne: null } })
      .sort({ sentAt: -1 })
      .limit(1)
      .next(),
    queue().countDocuments({ userId, sentAt: null, attempts: { $lt: ATTEMPTS } }),
    queue().findOne({ userId, sentAt: null, error: { $ne: null } }),
  ]);
  return { lastSent: last?.sentAt ?? null, waiting, failing: failing?.error ?? null };
}

// Started once per server (instrumentation.ts): a run every NOTIFY_EVERY_SECONDS, never two at once.
const runner = globalThis as typeof globalThis & { a6gNotifier?: ReturnType<typeof setInterval> };
export function startNotifier(): void {
  if (runner.a6gNotifier) return;
  let every: number;
  try {
    every = config().notifyEverySeconds;
  } catch (error) {
    console.error(`[notify] not started: ${(error as Error).message}`);
    return;
  }
  if (!every) return;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const done = await notifyOnce();
      if (done.sent || done.digests)
        console.info(`[notify] sent ${done.sent} email${done.sent === 1 ? "" : "s"} and ${done.digests} digest${done.digests === 1 ? "" : "s"}`);
    } catch (error) {
      console.error(`[notify] ${(error as Error).message}`);
    } finally {
      running = false;
    }
  };
  runner.a6gNotifier = setInterval(run, every * 1000);
  runner.a6gNotifier.unref?.();
  setTimeout(run, Math.min(every, 5) * 1000).unref?.();
}
