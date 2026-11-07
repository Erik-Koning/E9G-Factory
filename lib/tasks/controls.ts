// What the operator asks of a team, from the CLI (a6g pause, resume, budget) or the web app: an append-only log in the
// team's store, beside its task graph (k1, k2, …). The watchdog applies each new one in the run folder (lib/holds.ts);
// claims read the latest pause from the store itself, so a hold stops new work the moment it's asked for.
//
// A pause has a scope:
//   now        what pausing always did: nothing starts or merges; running members finish their turn.
//   tasks      the work under way finishes (built, reviewed, sent back and fixed, merged); nothing new is claimed.
//   journeys   the journeys under way (or those chosen) finish, verification and polish included; nothing else starts.
// Either graceful scope ends in the same pause as "now" once nothing in it can move (it has settled), with a report of
// where the team stands; work stays stopped until the operator resumes it.
import { journeyDue, nowIso, Refused, type Doc, type Task } from "./model.ts";

export const HOLD_SCOPES = ["now", "tasks", "journeys"] as const;
export type HoldScope = (typeof HOLD_SCOPES)[number];
export const isHoldScope = (value: unknown): value is HoldScope => typeof value === "string" && (HOLD_SCOPES as readonly string[]).includes(value);

// A team's spending limits, in API-equivalent US dollars (lib/prices.ts), each optional: per calendar day and week on
// the lead's clock, and in all since `since` (lib/budget.ts enforces them). With `autoResume`, a team the budget paused
// for a day or a week starts again when the next one does.
export interface Limits {
  daily: number | null;
  weekly: number | null;
  total: number | null;
  since: string;
  autoResume: boolean;
}

export interface Control extends Doc {
  team: string;
  kind: "pause" | "resume" | "budget";
  // "operator" (the CLI), "web:<stakeholder id>" (an admin on the web app), or "budget" (the watchdog, at a limit).
  by: string;
  at: string;
  // The operator's words: a resume's feedback goes to the planner.
  note: string;
  // A pause: how far work goes, and what may still be claimed, fixed when it was asked for.
  scope: HoldScope | null;
  tasks: string[];
  journeys: string[];
  // A budget: the limits from now on (null: none).
  limits: Limits | null;
  // A pause or resume the budget made: which limit, for which period ("daily:2026-11-04", "weekly:2026-11-02",
  // "total:2026-10-02"), and ":hard" for the pause past the limit's last tenth. Null for the operator's.
  trigger?: string | null;
}

// The pause in force, from the latest pause or resume.
export interface Hold {
  control: string;
  scope: HoldScope;
  tasks: string[];
  journeys: string[];
  since: string;
  by: string;
  note: string;
}

// A hold as the watchdog keeps it (the run folder's hold.json) and reports it to the web app: what's still moving,
// what can't move without the operator, and once it settled, when and the report.
export interface HoldState extends Hold {
  settledAt: string | null;
  left: string[];
  stuck: string[];
  report: string | null;
}

// Work that's begun: being built, in review, or sent back for changes (approved again, its branch made).
const started = (t: Task): boolean => t.status === "building" || t.status === "review" || (t.status === "approved" && t.branch !== null);
const finished = (t: Task): boolean => t.status === "done" || t.status === "rejected";

// The journeys under way: not finished, with a task begun or done.
export function journeysUnderWay(all: Task[]): Task[] {
  return all.filter((j) => j.kind === "journey" && !finished(j) && all.some((t) => t.parent === j.id && (started(t) || t.status === "done")));
}

const blank = { note: "", scope: null, tasks: [], journeys: [], limits: null };

// A pause, its scope fixed against the graph as it is now. `journeys` picks some of those under way; by default, all.
export function pauseControl(
  all: Task[],
  team: string,
  ask: { scope: HoldScope; journeys?: string[] | undefined; by: string; note?: string },
  at = nowIso()
): Omit<Control, "id" | "version"> {
  const tasks = ask.scope === "now" ? [] : all.filter(started).map((t) => t.id);
  let journeys: string[] = [];
  if (ask.scope === "journeys") {
    const underWay = journeysUnderWay(all).map((j) => j.id);
    if (ask.journeys?.length) {
      for (const id of ask.journeys) {
        const j = all.find((t) => t.id === id);
        if (!j || j.kind !== "journey") throw new Refused(`#${id} isn't a journey`);
        if (finished(j)) throw new Refused(`journey #${id} is ${j.status} already`);
      }
      journeys = [...new Set(ask.journeys)];
    } else journeys = underWay;
    if (!journeys.length) throw new Refused("no journey is under way: pause after the current tasks, or now");
  }
  return { ...blank, team, kind: "pause", by: ask.by, at, note: ask.note?.trim() ?? "", scope: ask.scope, tasks, journeys };
}

export const resumeControl = (team: string, by: string, note = "", at = nowIso()): Omit<Control, "id" | "version"> => ({
  ...blank,
  team,
  kind: "resume",
  by,
  at,
  note: note.trim(),
});

export const budgetControl = (team: string, by: string, limits: Limits | null, at = nowIso()): Omit<Control, "id" | "version"> => ({
  ...blank,
  team,
  kind: "budget",
  by,
  at,
  limits,
});

// The pause in force, of those since the last resume: a pause now outranks a graceful one (a stopped team isn't
// reopened by asking it to finish something; the watchdog records one when a hold settles), otherwise the latest.
// Controls come oldest first, as the store lists them.
export function holdOf(controls: Control[]): Hold | null {
  const pauses = controls.slice(controls.findLastIndex((c) => c.kind === "resume") + 1).filter((c) => c.kind === "pause" && c.scope);
  const chosen = pauses.findLast((c) => c.scope === "now") ?? pauses.at(-1);
  if (!chosen?.scope) return null;
  return { control: chosen.id, scope: chosen.scope, tasks: chosen.tasks, journeys: chosen.journeys, since: chosen.at, by: chosen.by, note: chosen.note };
}

// The pause the watchdog records once a graceful hold has settled, so every machine's claims see the team stopped.
export const settledControl = (team: string, hold: Hold, at = nowIso()): Omit<Control, "id" | "version"> => ({
  ...blank,
  team,
  kind: "pause",
  by: "watchdog",
  at,
  note: `the pause after ${describeHold(hold)} settled`,
  scope: "now",
});

// The limits in force: the latest budget's.
export const limitsOf = (controls: Control[]): Limits | null => controls.findLast((c) => c.kind === "budget")?.limits ?? null;

const ids = (list: string[]): string => list.map((id) => `#${id}`).join(", ");
export function describeHold(hold: Pick<Hold, "scope" | "tasks" | "journeys">): string {
  if (hold.scope === "now") return "now";
  if (hold.scope === "journeys") return `journey${hold.journeys.length === 1 ? "" : "s"} ${ids(hold.journeys)}`;
  return hold.tasks.length ? `the work under way (${ids(hold.tasks)})` : "the work under way (none)";
}

// Whether `task` may be claimed while `hold` is in force; null when it may.
export function holdRefusal(task: Task, hold: Hold | null): string | null {
  if (!hold) return null;
  if (hold.scope === "now") return "the operator paused the team: claim nothing until they resume it";
  if (hold.tasks.includes(task.id)) return null;
  if (hold.scope === "journeys" && task.parent !== null && hold.journeys.includes(task.parent)) return null;
  return `the operator is pausing the team after ${describeHold(hold)}; #${task.id} is outside that, so it waits until they resume it`;
}

const inScope = (t: Task, hold: Hold): boolean =>
  hold.tasks.includes(t.id) || (hold.scope === "journeys" && t.parent !== null && hold.journeys.includes(t.parent));

// A proposal no one has decided on for this long is waiting for the operator, as far as a hold is concerned.
export const UNDECIDED_MIN = 30;

// When a task was last claimed: its claim, or the latest move to building in its history.
const claimedAt = (t: Task): string | null => t.claim?.at ?? t.history.findLast((e) => e.to === "building")?.at ?? null;

// Where a graceful hold stands: `left` is what can still move (work, or the planner's and members' turns), `stuck` what
// can't without the operator. It has settled when nothing's left and no member is at work.
export function settling(hold: Hold, all: Task[], membersAtWork: number, now = Date.now()): { settled: boolean; left: string[]; stuck: string[] } {
  const left: string[] = [];
  const stuck: string[] = [];
  const byId = new Map(all.map((t) => [t.id, t]));
  // What's being built or in review finishes first; but work outside the hold claimed after it was asked for (by a
  // member on a factory version older than holds, or a claim that crossed it) isn't waited for: it waits for the resume.
  for (const t of all) {
    if (t.status !== "building" && t.status !== "review") continue;
    const line = `#${t.id} ${t.status === "building" ? "being built" : "in review"}: ${t.title}`;
    const at = claimedAt(t);
    if (!inScope(t, hold) && at !== null && at > hold.since)
      stuck.push(`${line} (started after the pause was asked, outside it: it waits for the resume)`);
    else left.push(line);
  }
  const scoped = all.filter((t) => t.kind !== "journey" && inScope(t, hold) && !finished(t) && t.status !== "building" && t.status !== "review");
  for (const t of scoped) {
    const waiting = t.after.filter((id) => byId.get(id)?.status !== "done");
    const outside = waiting.filter((id) => {
      const dep = byId.get(id);
      return !dep || !inScope(dep, hold) || dep.status === "blocked" || dep.status === "question" || dep.status === "rejected";
    });
    if (t.status === "blocked" || t.status === "question") stuck.push(`#${t.id} ${t.status}: ${t.title}`);
    else if (outside.length) stuck.push(`#${t.id} waits for ${ids(outside)}, which can't finish in this hold`);
    else if (t.status === "approved") left.push(`#${t.id} to build${waiting.length ? ` after ${ids(waiting)}` : ""}: ${t.title}`);
    else if (now - Date.parse(t.updatedAt) >= UNDECIDED_MIN * 60_000) stuck.push(`#${t.id} ${t.status}, waiting for a decision: ${t.title}`);
    else left.push(`#${t.id} ${t.status}, for the planner or approver: ${t.title}`);
  }
  if (hold.scope === "journeys")
    for (const id of hold.journeys) {
      const j = byId.get(id);
      if (!j || finished(j)) continue;
      if (journeyDue(j, all)) left.push(`journey #${id} due its verification (the planner's)`);
      else if (!all.some((t) => t.parent === id && !finished(t))) stuck.push(`journey #${id} has no open tasks, and isn't done`);
    }
  if (membersAtWork > 0) left.push(`${membersAtWork} member${membersAtWork === 1 ? "" : "s"} at work`);
  return { settled: left.length === 0, left, stuck };
}

// What the operator reads once a hold settles: what got done since it was asked for, each journey, what waits for
// them, and what's next. Plain text, for email and the web app alike.
export function holdReport(hold: Hold, all: Task[], stuck: string[], extra: string[] = []): string {
  const doneSince = all.filter((t) => t.kind !== "journey" && t.status === "done" && t.history.some((e) => e.to === "done" && e.at >= hold.since));
  const journeys = all.filter((t) => t.kind === "journey");
  const questions = all.filter((t) => t.status === "question");
  const open = (status: string) => all.filter((t) => t.kind !== "journey" && t.status === status).length;
  const lines = [
    `Paused after ${describeHold(hold)}, as asked at ${hold.since.slice(0, 16).replace("T", " ")} UTC${hold.note ? ` ("${hold.note}")` : ""}.`,
    "",
    doneSince.length ? `Done since then (${doneSince.length}):` : "Nothing was finished since then.",
    ...doneSince.map((t) => `  #${t.id} ${t.title}`),
  ];
  if (journeys.length) {
    lines.push("", "Journeys:");
    for (const j of journeys) {
      const kids = all.filter((t) => t.parent === j.id && t.status !== "rejected");
      lines.push(`  #${j.id} ${j.title}: ${j.status}, ${kids.filter((t) => t.status === "done").length}/${kids.length} tasks done`);
    }
  }
  if (questions.length) lines.push("", "Waiting for you:", ...questions.map((t) => `  #${t.id} ${t.title}`));
  if (stuck.length) lines.push("", "Stopped in the hold, and why:", ...stuck.map((s) => `  ${s}`));
  lines.push("", `Not started: ${open("approved")} approved, ${open("proposed") + open("triage") + open("researching")} still being decided.`);
  if (extra.length) lines.push("", ...extra);
  lines.push("", "Work stays stopped until you resume the team (the web app's Resume, or a6g resume <team>), with any feedback for the planner.");
  return lines.join("\n");
}
