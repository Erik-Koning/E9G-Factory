// The task graph's model: what a task and a feature request are, which statuses a task moves between and who may move
// it, how a task is scored, and which task a member claims. Pure: the stores (files.ts, mongo.ts) keep the documents
// and the commands (lib/commands/task.ts, request.ts) change them, each through these rules.

export const KINDS = ["feature", "bug", "ux", "test", "test-infra", "chore", "research", "journey"] as const;
export type Kind = (typeof KINDS)[number];
export const STATUSES = [
  "triage",
  "proposed",
  "researching",
  "approved",
  "building",
  "review",
  "verify",
  "done",
  "blocked",
  "question",
  "rejected",
] as const;
export type Status = (typeof STATUSES)[number];
export const SEVERITIES = ["blocker", "major", "minor"] as const;
export type Severity = (typeof SEVERITIES)[number];

// Scores are 0–3 against the anchors in the planner's prompt; priority weighs them (team.json priorities.weights).
export const DIMENSIONS = ["pain", "reach", "revenue", "wow", "distribution", "leverage", "urgency", "risk"] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export const DEFAULT_WEIGHTS: Record<Dimension, number> = { pain: 3, reach: 2, revenue: 2, wow: 2, distribution: 1, leverage: 2, urgency: 1, risk: 1 };
export const CONFIDENCE = { hunch: 0.5, asks: 0.8, data: 1 } as const;
export type Confidence = keyof typeof CONFIDENCE;
export const SIZES = { S: 1, M: 2, L: 4, XL: 8 } as const;
export type Size = keyof typeof SIZES;

export type Score = Record<Dimension, number> & { confidence: Confidence; size: Size; why: string };
// The Musk gate, before scoring: who asked and why, what could be deleted or simplified instead, the simplest version.
export interface Gate {
  asked: string;
  simplify: string;
  simplest: string;
}
// Whether `claim` is held from this worktree on this machine (two machines can have a worktree at the same path).
export const heldHere = (claim: Claim | null, worktree: string | null, machine: string): claim is Claim =>
  claim !== null && claim.worktree === worktree && claim.machine === machine;
export interface Claim {
  role: string;
  machine: string;
  // The member's own checkout (its git top level), which its heartbeats renew the claim from.
  worktree: string;
  at: string;
  until: string;
}
export interface Note {
  at: string;
  by: string;
  text: string;
}
export interface Event {
  at: string;
  by: string;
  what: string;
}

// Every document a store keeps: an id it assigns, and a version it checks on every replace.
export interface Doc {
  id: string;
  version: number;
}

export interface Task extends Doc {
  team: string;
  title: string;
  kind: Kind;
  status: Status;
  severity: Severity | null;
  body: string;
  area: string | null;
  // Where the work is expected to land (path prefixes): two tasks that share one aren't built at once.
  files: string[];
  // The journey it belongs to, and the tasks that must be done before it can be claimed.
  parent: string | null;
  after: string[];
  request: string | null;
  gate: Gate | null;
  score: Score | null;
  priority: number | null;
  approval: { by: string; at: string; note: string } | null;
  notes: Note[];
  claim: Claim | null;
  branch: string | null;
  sha: string | null;
  rounds: number;
  ui: boolean | null;
  critical: string[];
  by: string;
  createdAt: string;
  updatedAt: string;
  history: Event[];
}

export const REQUEST_STATUSES = ["new", "researching", "promoted", "rejected"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
// A stakeholder's feature request. Who sent it is a stakeholder id: names and email addresses stay with the
// stakeholders, which agents never see (Article 8).
export interface FeatureRequest extends Doc {
  team: string;
  title: string;
  body: string;
  from: string | null;
  status: RequestStatus;
  tasks: string[];
  notes: Note[];
  createdAt: string;
  updatedAt: string;
  history: Event[];
}
export interface Stakeholder extends Doc {
  team: string;
  name: string;
  email: string;
  role: string;
  createdAt: string;
}
// A cycle the planner closed (team.json mode "cycles").
export interface Cycle extends Doc {
  team: string;
  report: string;
  done: string[];
  at: string;
}

export const nowIso = (): string => new Date().toISOString();

// A new task's fields, with defaults for what it doesn't say.
export function newTask(fields: Partial<Task> & Pick<Task, "team" | "title" | "kind" | "status" | "by">): Omit<Task, "id" | "version"> {
  const at = nowIso();
  return {
    severity: null,
    body: "",
    area: null,
    files: [],
    parent: null,
    after: [],
    request: null,
    gate: null,
    score: null,
    priority: null,
    approval: null,
    notes: [],
    claim: null,
    branch: null,
    sha: null,
    rounds: 0,
    ui: null,
    critical: [],
    createdAt: at,
    updatedAt: at,
    history: [{ at, by: fields.by, what: `added as ${fields.status}` }],
    ...fields,
  };
}

// priority = 100 × (weighted score ÷ the most it could be) × confidence ÷ size, rounded.
export function priorityOf(score: Score, weights: Record<Dimension, number> = DEFAULT_WEIGHTS): number {
  const total = DIMENSIONS.reduce((sum, d) => sum + weights[d], 0);
  if (total <= 0) return 0;
  const weighted = DIMENSIONS.reduce((sum, d) => sum + weights[d] * score[d], 0);
  return Math.round(((100 * weighted) / (3 * total)) * (CONFIDENCE[score.confidence] / SIZES[score.size]));
}

// Who's acting on a task: a team role, the operator (a person, outside any team), or the factory itself.
export type Actor = string;
export const OPERATOR = "operator";
export const MERGE = "merge-queue";
export const WATCHDOG = "watchdog";

// The statuses the planner may set with e9g task status. It never claims (building), approves its own proposals
// (approved, unless the task was approved before and only blocked since), or marks code done: approval is the
// approver's or the operator's, and code is done when the merge queue merges it.
const PLANNER_TO: Record<Status, Status[]> = {
  triage: ["proposed", "rejected", "question", "blocked"],
  proposed: ["triage", "rejected", "question", "blocked"],
  researching: ["proposed", "rejected", "question", "blocked"],
  approved: ["proposed", "rejected", "question", "blocked"],
  building: ["blocked", "question", "rejected"],
  review: ["blocked", "question", "rejected"],
  verify: ["done", "blocked", "question"],
  done: ["proposed"],
  blocked: ["proposed", "approved", "rejected", "question"],
  question: ["proposed", "approved", "rejected", "blocked"],
  rejected: ["proposed"],
};
// Code isn't done by anyone's say-so. Research is, when the planner says so; a journey, once it has been verified.
const RESEARCH_DONE_FROM: Status[] = ["approved", "researching", "proposed", "question", "blocked"];
// Going back to these, a task needs approving again.
export const UNAPPROVED: Status[] = ["triage", "proposed", "researching"];

// Why `actor` can't move `task` to `to` with e9g task status, or null when it can. The operator may make any move but
// one: a task is building only when a member claims it, so it always has a claim to expire.
export function statusRefusal(task: Task, to: Status, actor: Actor): string | null {
  if (task.status === to) return `task ${task.id} is already ${to}`;
  if (to === "building") return "a task is building only when a builder or tester claims it (e9g task claim)";
  if (actor === OPERATOR) return null;
  if (actor !== "planner") return `only the planner (or the operator) sets a task's status; the ${actor} uses its own task commands`;
  if (to === "done" && task.kind === "research" && RESEARCH_DONE_FROM.includes(task.status)) return null;
  if (to === "done" && task.kind === "journey" && task.status !== "verify")
    return `journey ${task.id} is done once it's verified: its tasks done, then its audit, end-to-end spec and polish (it's ${task.status})`;
  // A journey goes to verify by hand only once it was approved (the merge queue moves it when its last task is done).
  if (to === "verify" && task.kind === "journey" && !["done", "rejected"].includes(task.status))
    return task.approval ? null : `journey ${task.id} was never approved; the approver or the operator approves it (e9g task approve ${task.id})`;
  if (!PLANNER_TO[task.status].includes(to)) {
    if (to === "approved") return `the planner doesn't approve its own proposals: the approver or the operator does (e9g task approve ${task.id})`;
    if (to === "done") return `code is done when the merge queue merges it (e9g merge … --closes ${task.id}); reject it instead if it won't be built`;
    if (to === "review") return "a task goes to review when its claimant submits it (e9g task submit)";
    return `a ${task.status} task doesn't go to ${to}`;
  }
  if (to === "approved" && !task.approval)
    return `task ${task.id} was never approved; the approver or the operator approves it (e9g task approve ${task.id})`;
  return null;
}

// Which kinds each role builds.
export const CLAIMS: Record<string, Kind[]> = {
  builder: ["feature", "bug", "ux", "chore"],
  tester: ["test", "test-infra"],
};

const SEVERITY_ORDER: Record<string, number> = { blocker: 0, major: 1, minor: 3 };
// Claim order: blockers, then majors, then the rest by priority (unscored work after scored) with minor findings last
// (polish is bounded, Article 9), then the oldest.
export function claimOrder(a: Task, b: Task): number {
  const sev = (t: Task) => SEVERITY_ORDER[t.severity ?? ""] ?? 2;
  if (sev(a) !== sev(b)) return sev(a) - sev(b);
  const pa = a.priority ?? -1;
  const pb = b.priority ?? -1;
  if (pa !== pb) return pb - pa;
  return Number(a.id) - Number(b.id) || a.id.localeCompare(b.id);
}

// Two path prefixes overlap when either contains the other ("src/a/" and "src/a/b.ts").
const overlaps = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);
export function conflictOf(task: Task, building: Task[]): Task | null {
  return (
    building.find(
      (other) =>
        other.id !== task.id &&
        ((task.area !== null && task.area !== "" && other.area === task.area) || task.files.some((f) => other.files.some((g) => overlaps(f, g))))
    ) ?? null
  );
}

// Why `task` can't be claimed by `role` now, or null when it can.
export function claimRefusal(task: Task, role: string, all: Task[]): string | null {
  const kinds = CLAIMS[role];
  if (!kinds) return `the ${role} doesn't claim tasks; builders and testers do`;
  if (task.status !== "approved") return `task ${task.id} is ${task.status}, not approved`;
  if (!kinds.includes(task.kind)) return `task ${task.id} is ${task.kind} work, which the ${role} doesn't take (it takes ${kinds.join(", ")})`;
  const byId = new Map(all.map((t) => [t.id, t]));
  const waiting = task.after.filter((id) => byId.get(id)?.status !== "done");
  if (waiting.length) return `task ${task.id} waits for ${waiting.map((id) => `${id} (${byId.get(id)?.status ?? "missing"})`).join(", ")}`;
  const conflict = conflictOf(
    task,
    all.filter((t) => t.status === "building")
  );
  if (conflict) return `task ${conflict.id} is being built on the same ${conflict.area === task.area && task.area ? `area (${task.area})` : "files"}`;
  return null;
}

// The task `role` should claim next, of those it may: the first in claim order.
export function nextClaim(all: Task[], role: string, kind?: Kind): Task | null {
  return all.filter((t) => (kind === undefined || t.kind === kind) && claimRefusal(t, role, all) === null).sort(claimOrder)[0] ?? null;
}

// The branch name a claimant uses, matching its role's pattern (e9g/b142-resume-a-recording, e9g/t-142-…).
export function branchFor(task: Task, role: string, prefix: string): string {
  const slug =
    task.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "task";
  return role === "tester" ? `${prefix}/t-${task.id}-${slug}` : `${prefix}/b${task.id}-${slug}`;
}

// The ticket a branch's name gives: the number in the first part after the prefix (e9g/b12-x/v2-y closes 12, and a
// tester's e9g/t-12-x closes 12).
export function ticketOf(branch: string, prefix: string): string | undefined {
  const rest = branch.startsWith(`${prefix}/`) ? branch.slice(prefix.length + 1) : branch.includes("/") ? branch.slice(branch.indexOf("/") + 1) : branch;
  return /^(?:[a-z]*|t-)(\d+)-/.exec(rest.split("/")[0] ?? "")?.[1];
}

// An approved journey whose children are all done (or rejected), with at least one done, is due its verification.
export function journeyDue(journey: Task, all: Task[]): boolean {
  if (journey.kind !== "journey" || journey.status !== "approved") return false;
  const children = all.filter((t) => t.parent === journey.id);
  return children.some((t) => t.status === "done") && children.every((t) => t.status === "done" || t.status === "rejected");
}

// An event in a document's history, and the document with it.
export function withEvent<T extends { history: Event[]; updatedAt: string }>(doc: T, by: Actor, what: string): T {
  const at = nowIso();
  return { ...doc, updatedAt: at, history: [...doc.history, { at, by, what }].slice(-200) };
}
