// The task graph's model: what a task and a feature request are, which statuses a task moves between and who may move
// it, how a task is scored, and which task a member claims. Pure: the stores (files.ts, mongo.ts) keep the documents
// and the commands (lib/commands/task.ts, request.ts) change them, each through these rules.

export const KINDS = ["feature", "bug", "ux", "test", "test-infra", "chore", "research", "journey"] as const;
export type Kind = (typeof KINDS)[number];
export const STATUSES = ["triage", "proposed", "researching", "approved", "building", "review", "done", "blocked", "question", "rejected"] as const;
export type Status = (typeof STATUSES)[number];
export const SEVERITIES = ["blocker", "major", "minor"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const RISKS = ["low", "medium", "high"] as const;
export type Risk = (typeof RISKS)[number];

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
export const heldHere = (claim: Claim | null, worktree: string | null, machine: string): boolean =>
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
// An event in a document's history: what happened, in words, and for a move the statuses it went between and the
// commit it was at, which the commands read rather than the words.
export interface Event {
  at: string;
  by: string;
  what: string;
  from?: string;
  to?: string;
  sha?: string;
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
  // How much could break, as the reviewer judged it when it approved (a high-risk change merges with its tests).
  risk: Risk | null;
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
  // A hash of the stakeholder's own link to e9g serve's form (e9g request stakeholders add), or none.
  key?: string | null;
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
    risk: null,
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

// What refuses a change; the commands print it as it is.
export class Refused extends Error {}

// Who's acting on a task: a team role, the operator (a person, outside any team), or the factory itself.
export type Actor = string;
export const OPERATOR = "operator";
export const MERGE = "merge-queue";
export const WATCHDOG = "watchdog";

// The kinds a member files as findings, which the planner may approve (team.json approval.findings).
export const FINDINGS: Kind[] = ["bug", "ux", "test", "test-infra"];
// Going back to these, a task needs approving again.
export const UNAPPROVED: Status[] = ["triage", "proposed", "researching"];

// --- How a task moves -----------------------------------------------------------------------------------------------
// Every change of a task's status goes through move(), against one table: the command it comes from (via), who may
// make it, from which statuses to which, and what else must hold. docs/plans/task-graph.md shows the same table.

export type Via = "status" | "approve" | "reject" | "research" | "escalate" | "claim" | "release" | "submit" | "changes" | "merge" | "conflict" | "expire";
export interface ApprovalRules {
  mode: "operator" | "thresholds" | "full";
  maxSize: Size;
  findings: "planner" | "approver";
}
export interface MoveContext {
  // The whole graph: dependencies, journeys and other claims.
  all: Task[];
  approval?: ApprovalRules;
  // Where the member making a claim, a release or a submit works.
  machine?: string;
  worktree?: string | null;
  // A changes verdict's or a merge's branch, and the commit a merge merged.
  branch?: string;
  tip?: string;
  // A merge of a rebase: the commit the review approved, which the task may still name.
  rebasedFrom?: string;
  now?: number;
}
type Check = (task: Task, to: Status, actor: Actor, ctx: MoveContext) => string | null;
interface Rule {
  via: Via;
  by: Actor[];
  from: readonly Status[];
  to: readonly Status[];
  check?: Check;
}
const first =
  (...checks: Check[]): Check =>
  (task, to, actor, ctx) =>
    checks.reduce<string | null>((why, check) => why ?? check(task, to, actor, ctx), null);

// New work is scored before it's approved; a finding with a severity needn't be, and a journey, which only groups
// tasks that are each approved, never is.
const scored: Check = (t) =>
  t.kind !== "journey" && !t.score && (t.kind === "feature" || !t.severity)
    ? `task ${t.id} isn't scored yet; the planner scores it first (e9g task score)`
    : null;
// A journey only groups tasks, each approved on its own: the approver has nothing to decide about it.
const notJourney: Check = (t) => (t.kind === "journey" ? `#${t.id} is a journey: it only groups tasks, and each of them is decided on its own` : null);
const approverActs: Check = (_t, _to, _actor, { approval }) =>
  approval?.mode === "operator"
    ? "this team's proposals are decided by the operator (team.json approval.mode); there's nothing for the approver to do"
    : null;
const withinThresholds: Check = (t, _to, _actor, { approval }) => {
  if (approval?.mode !== "thresholds") return null;
  if (t.score === null || SIZES[t.score.size] <= SIZES[approval.maxSize]) return null;
  return `size ${t.score.size}, over this team's ${approval.maxSize}, is the operator's to approve (team.json approval): e9g task escalate ${t.id} --reason "…"`;
};
// A finding the planner rewrote (its title, body or kind) is the planner's proposal now, not the member's finding.
const rewrittenByPlanner = (t: Task): boolean => t.history.some((e) => e.by === "planner" && /\bedited\b[^;]*\b(title|body|kind)\b/.test(e.what));
// The planner approves a finding another member filed, so nobody approves their own (team.json approval.findings).
const othersFinding: Check = (t, _to, _actor, { approval }) => {
  if (!FINDINGS.includes(t.kind) || t.by === "planner" || rewrittenByPlanner(t))
    return `the planner doesn't approve its own proposals: the approver or the operator does (e9g task approve ${t.id})`;
  if (approval?.findings === "approver") return "this team's approver decides findings too (team.json approval.findings)";
  if (!t.severity) return `give task ${t.id} its severity first (e9g task edit ${t.id} --sev …)`;
  if (approval && t.score && SIZES[t.score.size] > SIZES[approval.maxSize])
    return `size ${t.score.size} is over this team's ${approval.maxSize}: the approver or the operator decides it`;
  return null;
};
const wasApproved: Check = (t, to) =>
  to === "approved" && !t.approval ? `task ${t.id} was never approved; the approver or the operator approves it (e9g task approve ${t.id})` : null;
const codeDone = (t: Task): string => `code is done when the merge queue merges it (e9g merge … --closes ${t.id}); reject it instead if it won't be built`;
// Code isn't done by anyone's say-so. Research is, when the planner says so; a journey, once its tasks are and the planner
// has verified it.
const plannerDone: Check = (t, _to, _actor, { all }) => {
  if (t.kind === "research") return null;
  if (t.kind !== "journey") return codeDone(t);
  return journeyDue(t, all) ? null : `journey ${t.id} is done once it's verified: its tasks done, then its audit, end-to-end spec and polish`;
};
const holder: Check = (t, _to, _actor, { machine = "", worktree = null }) =>
  heldHere(t.claim, worktree, machine)
    ? null
    : `task ${t.id} isn't claimed from this worktree (${t.claim ? `the ${t.claim.role} on ${t.claim.machine} holds it` : "nobody holds it"})`;
// The claimant hands it back; the planner (or the operator) may free one whose member is gone.
const holderOrPlanner: Check = (t, to, actor, ctx) => (actor === "planner" || actor === OPERATOR ? null : holder(t, to, actor, ctx));
const sameBranch: Check = (t, _to, _actor, { branch }) =>
  t.branch && branch && t.branch !== branch ? `task ${t.id} was submitted on ${t.branch}, not ${branch}` : null;
// The merge queue closes the branch's task once what it submitted is what merged; never a journey.
const merged: Check = (t, _to, _actor, { branch, tip, rebasedFrom }) =>
  t.kind === "journey"
    ? `#${t.id} is a journey, done once the planner has verified it`
    : tip && t.branch === branch && t.sha && t.sha !== tip && t.sha !== rebasedFrom
      ? `#${t.id} was submitted at ${t.sha.slice(0, 9)}, and ${tip.slice(0, 9)} merged`
      : null;
const leaseOut: Check = (t, _to, _actor, { now = Date.now() }) =>
  t.claim && Date.parse(t.claim.until) <= now ? null : `task ${t.id}'s claim hasn't run out`;

// The planner's own moves (e9g task status): it never claims, approves its own proposals or marks code done.
const PLANNER_TO: [Status[], Status[]][] = [
  [["triage"], ["proposed", "rejected", "question", "blocked"]],
  [["proposed"], ["triage", "rejected", "question", "blocked"]],
  [
    ["researching", "approved"],
    ["proposed", "rejected", "question", "blocked"],
  ],
  [
    ["building", "review"],
    ["blocked", "question", "rejected"],
  ],
  // Back to approved only when it was approved before.
  [["blocked"], ["proposed", "approved", "rejected", "question"]],
  [["question"], ["proposed", "approved", "rejected", "blocked"]],
  [["done", "rejected"], ["proposed"]],
];
const EVERY: readonly Status[] = STATUSES;
const OPERATOR_FROM: Status[] = ["proposed", "researching", "question", "triage"];

const RULES: Rule[] = [
  ...PLANNER_TO.map(([from, to]): Rule => ({ via: "status", by: ["planner"], from, to, check: wasApproved })),
  { via: "status", by: ["planner"], from: ["triage", "approved", "researching", "proposed", "question", "blocked"], to: ["done"], check: plannerDone },
  // The operator makes any move but one: a task is building only when a member claims it, so it has a claim to expire.
  { via: "status", by: [OPERATOR], from: EVERY, to: EVERY.filter((s) => s !== "building") },

  { via: "approve", by: ["approver"], from: ["proposed"], to: ["approved"], check: first(notJourney, approverActs, scored, withinThresholds) },
  { via: "approve", by: ["planner"], from: ["triage", "proposed"], to: ["approved"], check: othersFinding },
  { via: "approve", by: [OPERATOR], from: [...OPERATOR_FROM, "blocked"], to: ["approved"], check: scored },
  { via: "reject", by: ["approver"], from: ["proposed"], to: ["rejected"], check: first(notJourney, approverActs) },
  { via: "reject", by: [OPERATOR], from: OPERATOR_FROM, to: ["rejected"] },
  { via: "research", by: ["approver"], from: ["proposed"], to: ["researching"], check: first(notJourney, approverActs) },
  { via: "research", by: [OPERATOR], from: OPERATOR_FROM, to: ["researching"] },
  { via: "escalate", by: ["approver"], from: ["proposed"], to: ["question"], check: first(notJourney, approverActs) },
  { via: "escalate", by: [OPERATOR], from: OPERATOR_FROM, to: ["question"] },

  { via: "claim", by: ["builder", "tester"], from: ["approved"], to: ["building"], check: (t, _to, actor, { all }) => claimRefusal(t, actor, all) },
  {
    via: "release",
    by: ["builder", "tester", "planner", OPERATOR],
    from: ["building"],
    to: ["approved", "blocked"],
    check: holderOrPlanner,
  },
  { via: "submit", by: ["builder", "tester"], from: ["building"], to: ["review"], check: holder },
  { via: "changes", by: ["reviewer", OPERATOR], from: ["review"], to: ["approved", "blocked"], check: sameBranch },
  { via: "merge", by: [MERGE], from: ["approved", "blocked", "question", "review"], to: ["done"], check: merged },
  // A branch that conflicts goes back to be claimed again and rebased.
  { via: "conflict", by: [MERGE], from: ["review"], to: ["approved"], check: sameBranch },
  { via: "expire", by: [WATCHDOG], from: ["building"], to: ["approved"], check: leaseOut },
];

const DOES: Record<Via, string> = {
  status: "set a task's status",
  approve: "approve proposals",
  reject: "reject proposals",
  research: "send proposals back for research",
  escalate: "escalate proposals",
  claim: "claim tasks; builders and testers do",
  release: "release tasks",
  submit: "submit tasks; builders and testers submit what they built",
  changes: "ask for changes",
  merge: "merge",
  conflict: "send a conflicting branch back",
  expire: "expire claims",
};
const DONE_TO: Partial<Record<Via, string>> = { approve: "approved", reject: "rejected", research: "sent back for research", escalate: "escalated" };

// Why `task` can't go from where it is to `to` through `via`, but would from somewhere else.
function notFrom(t: Task, to: Status, via: Via): string {
  const proposal = DONE_TO[via];
  if (proposal) return `task ${t.id} is ${t.status}; only a proposal is ${proposal}`;
  if (via === "claim") return `task ${t.id} is ${t.status}, not approved`;
  if (via === "release") return `task ${t.id} isn't claimed (${t.status})`;
  if (via === "submit") return `task ${t.id} isn't claimed from this worktree (${t.status})`;
  if (via === "changes" || via === "conflict") return `task ${t.id} is ${t.status}, not in review`;
  if (via === "merge" && t.kind === "journey") return `#${t.id} is a journey, done once the planner has verified it`;
  if (to === "done" && t.kind === "journey") return `journey ${t.id} is ${t.status}; reopen it first (e9g task status ${t.id} proposed)`;
  if (via === "merge")
    return t.status === "building"
      ? `#${t.id} is being built by the ${t.claim?.role ?? "a member"}${t.claim ? ` on ${t.claim.machine}` : ""}`
      : t.status === "rejected"
        ? `#${t.id} was rejected`
        : `#${t.id} is ${t.status}, never approved`;
  if (via === "expire") return `task ${t.id} isn't building`;
  if (to === "approved") return `the planner doesn't approve its own proposals: the approver or the operator does (e9g task approve ${t.id})`;
  if (to === "done") return codeDone(t);
  if (to === "review") return "a task goes to review when its claimant submits it (e9g task submit)";
  return `a ${t.status} task doesn't go to ${to}`;
}

// Why `actor` can't move `task` to `to` through `via`, or null when it can.
export function moveRefusal(task: Task, to: Status, via: Via, actor: Actor, ctx: MoveContext): string | null {
  if (task.status === to) return `task ${task.id} is already ${to}`;
  if (to === "building" && via !== "claim") return "a task is building only when a builder or tester claims it (e9g task claim)";
  const theirs = RULES.filter((rule) => rule.via === via && rule.by.includes(actor));
  if (!theirs.length)
    return via === "status"
      ? `only the planner (or the operator) sets a task's status; the ${actor} uses its own task commands`
      : `the ${actor} doesn't ${DOES[via]}`;
  const fits = theirs.filter((rule) => rule.to.includes(to) && rule.from.includes(task.status));
  if (!fits.length) return notFrom(task, to, via);
  let why: string | null = null;
  for (const rule of fits) {
    const refusal = rule.check?.(task, to, actor, ctx) ?? null;
    if (refusal === null) return null;
    why ??= refusal;
  }
  return why;
}

// The planner's and the operator's e9g task status.
export const statusRefusal = (task: Task, to: Status, actor: Actor, all: Task[] = []): string | null => moveRefusal(task, to, "status", actor, { all });

// `task` moved to `to`, or a Refused saying why it can't be. A move takes the approval with it back among the
// proposals, and the claim with it anywhere but building; `fields` are the rest of what it changes.
export function move(
  task: Task,
  to: Status,
  via: Via,
  actor: Actor,
  ctx: MoveContext,
  { fields = {}, why, by = actor, sha }: { fields?: Partial<Task>; why?: string | undefined; by?: string; sha?: string } = {}
): Task {
  const refusal = moveRefusal(task, to, via, actor, ctx);
  if (refusal) throw new Refused(refusal);
  const moved: Task = {
    ...task,
    ...(UNAPPROVED.includes(to) ? { approval: null } : {}),
    ...(to === "building" ? {} : { claim: null }),
    ...fields,
    status: to,
  };
  return withEvent(moved, by, `${task.status} → ${to}${why ? `: ${why}` : ""}`, { from: task.status, to, ...(sha ? { sha } : {}) });
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

// A journey groups tasks, which are approved one by one; it needs no approval of its own. It's due its verification
// once its children are all done (or rejected), at least one done: worked out wherever it's shown, never stored.
export function journeyDue(journey: Task, all: Task[]): boolean {
  if (journey.kind !== "journey" || journey.status === "done" || journey.status === "rejected") return false;
  const children = all.filter((t) => t.parent === journey.id);
  return children.some((t) => t.status === "done") && children.every((t) => t.status === "done" || t.status === "rejected");
}

// An event in a document's history, and the document with it.
export function withEvent<T extends { history: Event[]; updatedAt: string }>(
  doc: T,
  by: Actor,
  what: string,
  moved: Pick<Event, "from" | "to" | "sha"> = {}
): T {
  const at = nowIso();
  return { ...doc, updatedAt: at, history: [...doc.history, { at, by, what, ...moved }].slice(-200) };
}
