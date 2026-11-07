// What the pages show of a team's graph, worked out from the factory's documents (never stored).
import { claimOrder, type FeatureRequest, journeyDue, MERGE, type Status, type Task } from "../../lib/tasks/model.ts";
import type { Control } from "../../lib/tasks/controls.ts";
import type { UsageDay } from "../../lib/tasks/spend.ts";
import type { TeamState } from "../../lib/tasks/teams.ts";

// How many tasks are where, in words a contributor reads (journeys aren't counted: they group tasks).
export const PROGRESS: { label: string; statuses: Status[] }[] = [
  { label: "In triage", statuses: ["triage"] },
  { label: "Waiting for a decision", statuses: ["proposed", "researching", "question"] },
  { label: "Approved, to build", statuses: ["approved"] },
  { label: "Being built", statuses: ["building"] },
  { label: "In review", statuses: ["review"] },
  { label: "Blocked", statuses: ["blocked"] },
  { label: "Done", statuses: ["done"] },
];
export function progress(tasks: Task[]): { label: string; count: number }[] {
  const work = tasks.filter((t) => t.kind !== "journey");
  return PROGRESS.map(({ label, statuses }) => ({ label, count: work.filter((t) => statuses.includes(t.status)).length }));
}

export interface JourneyView {
  id: string;
  title: string;
  status: Status;
  due: boolean;
  done: number;
  total: number;
}
export function journeys(tasks: Task[]): JourneyView[] {
  return tasks
    .filter((t) => t.kind === "journey" && t.status !== "rejected")
    .map((j) => {
      const children = tasks.filter((t) => t.parent === j.id && t.status !== "rejected");
      return {
        id: j.id,
        title: j.title,
        status: j.status,
        due: journeyDue(j, tasks),
        done: children.filter((t) => t.status === "done").length,
        total: children.length,
      };
    });
}

// The merge queue's merges, newest first.
export function merges(tasks: Task[], limit = 5): { task: Task; at: string }[] {
  return tasks
    .flatMap((task) => {
      const event = task.history.findLast((e) => e.by === MERGE && e.to === "done");
      return event ? [{ task, at: event.at }] : [];
    })
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}

// How a request is going, as its sender reads it: built once every task it became is done.
export function requestState(request: FeatureRequest, byId: Map<string, Task>): string {
  if (request.status !== "promoted") return request.status;
  const statuses = request.tasks.map((id) => byId.get(id)?.status);
  if (statuses.length && statuses.every((s) => s === "done" || s === "rejected") && statuses.includes("done")) return "built";
  return "being built";
}

// Why the planner rejected a request: its note, as `a6g request reject` writes it.
export const rejectionOf = (request: FeatureRequest): string | null =>
  request.status === "rejected" ? (request.notes.findLast((n) => n.text.startsWith("rejected: "))?.text.slice("rejected: ".length) ?? null) : null;

// The proposals an admin decides on, highest priority first; journeys need no decision.
export const PROPOSALS: Status[] = ["question", "proposed", "researching"];
export function proposals(tasks: Task[]): Task[] {
  return tasks
    .filter((t) => PROPOSALS.includes(t.status) && t.kind !== "journey")
    .sort((a, b) => PROPOSALS.indexOf(a.status) - PROPOSALS.indexOf(b.status) || (b.priority ?? -1) - (a.priority ?? -1) || Number(a.id) - Number(b.id));
}

// --- The board ----------------------------------------------------------------------------------------------------
// A column per step of a task's way through the team, left to right: the planner triages, the approver (or the
// operator) decides, members claim and build, the reviewer reviews, the merge queue merges. Journeys aren't cards (they
// group them: each card names its journey). Done shows the newest `doneLimit`; rejected work is counted, or a lane of
// its own when asked for.

export type Lane = "triage" | "proposed" | "approved" | "building" | "review" | "blocked" | "done" | "rejected";
export const LANES: { lane: Lane; label: string; statuses: Status[]; hint: string }[] = [
  { lane: "triage", label: "Triage", statuses: ["triage"], hint: "Suggestions and findings, for the planner to sort" },
  { lane: "proposed", label: "Proposed", statuses: ["question", "proposed", "researching"], hint: "Waiting for a decision" },
  { lane: "approved", label: "Approved", statuses: ["approved"], hint: "In the order members claim them" },
  { lane: "building", label: "Building", statuses: ["building"], hint: "Claimed by a member" },
  { lane: "review", label: "Review", statuses: ["review"], hint: "Waiting for the reviewer" },
  { lane: "blocked", label: "Blocked", statuses: ["blocked"], hint: "Stopped until something changes" },
  { lane: "done", label: "Done", statuses: ["done"], hint: "Newest first" },
  { lane: "rejected", label: "Rejected", statuses: ["rejected"], hint: "Turned down, newest first" },
];

export interface Card {
  task: Task;
  // A building task whose member's lease ran out: the watchdog hands it back on its next run.
  lapsed: boolean;
  // The tasks it comes after that aren't done yet.
  waits: { id: string; status: Status | "missing" }[];
  // When it got where it is (done: when it was done).
  since: string;
}
export interface Column {
  lane: Lane;
  label: string;
  hint: string;
  cards: Card[];
  // Cards past the limit (done only).
  more: number;
}

const enteredAt = (t: Task): string => t.history.findLast((e) => e.to === t.status)?.at ?? t.createdAt;

// The board's columns; `rejected` adds a lane of the rejected work, otherwise only counted.
export function kanban(tasks: Task[], { now = Date.now(), doneLimit = 8, rejected = false } = {}): { columns: Column[]; rejected: number } {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const work = tasks.filter((t) => t.kind !== "journey");
  const card = (task: Task): Card => ({
    task,
    lapsed: task.status === "building" && task.claim !== null && Date.parse(task.claim.until) <= now,
    waits: task.after.flatMap((id) => {
      const status: Status | "missing" = byId.get(id)?.status ?? "missing";
      return status === "done" ? [] : [{ id, status }];
    }),
    since: task.status === "building" && task.claim ? task.claim.at : enteredAt(task),
  });
  const order: Record<Lane, (a: Card, b: Card) => number> = {
    triage: (a, b) => b.task.createdAt.localeCompare(a.task.createdAt),
    // Escalated first, then by priority, as on the Decisions page.
    proposed: (a, b) => PROPOSALS.indexOf(a.task.status) - PROPOSALS.indexOf(b.task.status) || (b.task.priority ?? -1) - (a.task.priority ?? -1),
    approved: (a, b) => claimOrder(a.task, b.task),
    building: (a, b) => a.since.localeCompare(b.since),
    review: (a, b) => a.since.localeCompare(b.since),
    blocked: (a, b) => b.since.localeCompare(a.since),
    done: (a, b) => b.since.localeCompare(a.since),
    rejected: (a, b) => b.since.localeCompare(a.since),
  };
  const columns = LANES.map(({ lane, label, statuses, hint }) => {
    const cards = work
      .filter((t) => statuses.includes(t.status))
      .map(card)
      .sort(order[lane]);
    const limit = lane === "done" ? doneLimit : cards.length;
    return { lane, label, hint, cards: cards.slice(0, limit), more: Math.max(0, cards.length - limit) };
  }).filter((c) => (c.lane === "blocked" ? c.cards.length > 0 : c.lane === "rejected" ? rejected : true));
  return { columns, rejected: rejected ? 0 : work.filter((t) => t.status === "rejected").length };
}

// The pause and resume panel: the latest pause or resume asked for since the team's Mac last reported (it hasn't been
// applied yet), and the latest controls, newest first.
export function controlsView(status: TeamState | null, controls: Control[], limit = 6): { pending: Control | null; recent: Control[] } {
  const last = controls.findLast((c) => c.kind === "pause" || c.kind === "resume") ?? null;
  return { pending: last && (!status || last.at > status.at) ? last : null, recent: controls.slice(-limit).reverse() };
}

// Who asked for a control, in words.
export const askedBy = (by: string): string =>
  by === "budget"
    ? "the budget"
    : by === "watchdog"
      ? "the team's Mac, as the pause settled"
      : by.startsWith("web:")
        ? "an admin, here"
        : "the operator, in the terminal";

// Spend each day for the `n` days ending `last` (the lead's day, YYYY-MM-DD), every machine's added up; a day with
// nothing counted is $0.
export function dailySpend(days: UsageDay[], last: string, n = 14): { day: string; cost: number }[] {
  const end = Date.parse(`${last}T12:00:00Z`);
  const keys = Array.from({ length: n }, (_, i) => new Date(end - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10));
  const sums = new Map(keys.map((day) => [day, 0]));
  for (const d of days) if (sums.has(d.day)) sums.set(d.day, (sums.get(d.day) ?? 0) + d.rows.reduce((sum, r) => sum + r.cost, 0));
  return keys.map((day) => ({ day, cost: Math.round((sums.get(day) ?? 0) * 100) / 100 }));
}

// A chart's top and its ticks: clean steps (1, 2, 2.5 or 5 of a power of ten), three or four of them, covering `max`.
export function axis(max: number): { top: number; ticks: number[] } {
  if (!(max > 0)) return { top: 1, ticks: [0, 1] };
  const raw = max / 3;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? 10 * power;
  const top = Math.ceil(max / step) * step;
  return { top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => Math.round(i * step * 1e6) / 1e6) };
}

export { dollars } from "../../lib/tasks/spend.ts";
