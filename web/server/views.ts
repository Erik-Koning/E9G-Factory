// What the pages show of a team's graph, worked out from the factory's documents (never stored).
import { claimOrder, type FeatureRequest, journeyDue, MERGE, STATUSES, type Status, type Task } from "../../lib/tasks/model.ts";

// How many tasks are where, in words a contributor reads (journeys aren't counted: they group tasks).
export const PROGRESS: { label: string; statuses: Status[] }[] = [
  { label: "Waiting for a decision", statuses: ["triage", "proposed", "researching", "question"] },
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

// The board: a column per status that has tasks, in claim order.
export function board(tasks: Task[]): { status: Status; tasks: Task[] }[] {
  return STATUSES.map((status) => ({ status, tasks: tasks.filter((t) => t.status === status).sort(claimOrder) })).filter((c) => c.tasks.length);
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

// Why the planner rejected a request: its note, as `e9g request reject` writes it.
export const rejectionOf = (request: FeatureRequest): string | null =>
  request.status === "rejected" ? (request.notes.findLast((n) => n.text.startsWith("rejected: "))?.text.slice("rejected: ".length) ?? null) : null;

// The proposals an admin decides on, highest priority first; journeys need no decision.
export const PROPOSALS: Status[] = ["question", "proposed", "researching"];
export function proposals(tasks: Task[]): Task[] {
  return tasks
    .filter((t) => PROPOSALS.includes(t.status) && t.kind !== "journey")
    .sort((a, b) => PROPOSALS.indexOf(a.status) - PROPOSALS.indexOf(b.status) || (b.priority ?? -1) - (a.priority ?? -1) || Number(a.id) - Number(b.id));
}
