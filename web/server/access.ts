// Who may see and do what, per team. Pure: the pages and the server actions ask here, and the unit tests prove it.
//
// - admin (the operator): everything, on every team, but only from a session signed in with a second factor;
// - anyone: nothing at all while their session still owes a step: an authenticator's code (admins always, others once
//   they've turned one on), then confirming, from their email, an IP address they haven't used before;
// - member: the board, what's in progress, journeys, the graph, every request (senders by role), sending requests and
//   suggesting tasks for the planner to triage;
// - contributor: the team's overview (status, journeys, progress counts), their own requests, and sending requests.
import { KINDS, type Kind, SEVERITIES, type Severity } from "../../lib/tasks/model.ts";

export const TEAM_ROLES = ["member", "contributor"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];
export const isTeamRole = (value: unknown): value is TeamRole => typeof value === "string" && (TEAM_ROLES as readonly string[]).includes(value);

export interface Viewer {
  userId: string;
  admin: boolean;
  // This session has a second factor: it began with one (an authenticator code, a backup code, or a passkey that
  // verified the person with a PIN or biometrics), or one was entered since. Admins need it, and so does anyone who has
  // turned on an authenticator.
  secondFactor: boolean;
  // The person has an authenticator turned on.
  twoFactor: boolean;
  // The request comes from an IP address the person has confirmed.
  ipConfirmed: boolean;
  // The person's role on each team they belong to.
  teams: Readonly<Record<string, TeamRole>>;
}

export type Ability =
  // The team's status, its journeys and how many tasks are where.
  | "team:overview"
  // The board, what's in progress, the graph, recent merges and each task.
  | "team:board"
  // Every request of the team (otherwise only one's own).
  | "requests:all"
  | "requests:send"
  // Add a task as the operator: a proposal, or approved as it's added (a6g task add).
  | "tasks:add"
  // Suggest a task, which goes to triage for the planner.
  | "tasks:suggest"
  // Who sent a request, by name and email (otherwise by role).
  | "senders:names"
  // Approve, reject, research and escalate proposals.
  | "proposals:decide"
  // Read the audit log: everyone's sign-ins and changes.
  | "audit:read"
  // Invite people, set their roles, remove and ban them.
  | "people:manage"
  // Pause and resume a team, and set its budget: how it runs, the operator's alone, each time with an authenticator code.
  | "team:control";

const ROLE_ABILITIES: Record<TeamRole, readonly Ability[]> = {
  member: ["team:overview", "team:board", "requests:all", "requests:send", "tasks:suggest"],
  contributor: ["team:overview", "requests:send"],
};

// What a session must still do before anything opens: enter an authenticator's code, then confirm its IP address by
// email. Null when nothing's left.
export type PendingStep = "second-factor" | "confirm-ip";
export function pendingStep(viewer: Viewer | null): PendingStep | null {
  if (!viewer) return null;
  if ((viewer.admin || viewer.twoFactor) && !viewer.secondFactor) return "second-factor";
  if (!viewer.ipConfirmed) return "confirm-ip";
  return null;
}
export const blocked = (viewer: Viewer | null): boolean => pendingStep(viewer) !== null;

export function roleIn(viewer: Viewer | null, team: string): "admin" | TeamRole | null {
  if (!viewer || blocked(viewer)) return null;
  if (viewer.admin) return "admin";
  return Object.hasOwn(viewer.teams, team) ? (viewer.teams[team] ?? null) : null;
}

// Whether `viewer` may do `ability`: on `team`, or anywhere for the abilities that aren't a team's (people:manage).
export function can(viewer: Viewer | null, ability: Ability, team?: string): boolean {
  if (!viewer || blocked(viewer)) return false;
  if (viewer.admin) return true;
  if (team === undefined) return false;
  const role = roleIn(viewer, team);
  return role !== null && role !== "admin" && ROLE_ABILITIES[role].includes(ability);
}

// The teams `viewer` sees, of those there are.
export const visibleTeams = (viewer: Viewer | null, teams: readonly string[]): string[] => teams.filter((team) => roleIn(viewer, team) !== null);

// Whether `viewer` sees a request: every one with requests:all, otherwise only one sent from their own stakeholder on
// that team (`own`, or null when they have none there).
export function canSeeRequest(viewer: Viewer | null, team: string, request: { from: string | null }, own: string | null): boolean {
  if (can(viewer, "requests:all", team)) return true;
  return can(viewer, "requests:send", team) && own !== null && request.from === own;
}

export interface Sender {
  id: string;
  name: string;
  email: string;
  role: string;
}
// How a request's sender shows to `viewer`: themselves as "you", to an admin by name and address, to anyone else by
// the role only (names and addresses stay with the operator, Article 8).
export function senderLabel(viewer: Viewer | null, team: string, sender: Sender | null, own: string | null): string {
  if (!sender) return "no stakeholder";
  if (own !== null && sender.id === own) return "you";
  if (can(viewer, "senders:names", team)) return `${sender.name} <${sender.email}> (${sender.role})`;
  return sender.role;
}

// The same, short enough for a card on the board: "you", the name to an admin, the role to anyone else; null when
// nobody is on record (the team's own work).
export function senderShort(viewer: Viewer | null, team: string, sender: Sender | null, own: string | null): string | null {
  if (!sender) return null;
  if (own !== null && sender.id === own) return "you";
  return can(viewer, "senders:names", team) ? sender.name : sender.role;
}

// --- What's accepted ----------------------------------------------------------------------------------------------

export const LIMITS = { title: 200, body: 20_000, note: 2_000, name: 120, label: 80, email: 254, requestsPerDay: 20 } as const;
export const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// The shapes of ids in a URL or a form, checked before any lookup.
export const TEAM_PARAM = /^[a-z][a-z0-9-]{0,62}$/;
export const TASK_ID = /^[1-9]\d{0,8}$/;
export const REQUEST_ID = /^r[1-9]\d{0,8}$/;

export function requestProblem(title: string, body: string): string | null {
  if (!title.trim()) return "Give the request a title: what should be possible.";
  if (title.trim().length > LIMITS.title) return `Keep the title to ${LIMITS.title} characters; the rest goes in the description.`;
  if (body.length > LIMITS.body) return `Keep the description to ${LIMITS.body.toLocaleString("en")} characters.`;
  return null;
}

// What a task from the web may be. A suggestion is never a journey (those group the planner's tasks) or test plumbing.
export const SUGGESTED_KINDS: readonly Kind[] = ["feature", "bug", "ux", "chore", "research"];
export const isKind = (value: unknown, suggestion: boolean): value is Kind =>
  typeof value === "string" && (suggestion ? SUGGESTED_KINDS : KINDS).includes(value as Kind);
export const isSeverity = (value: unknown): value is Severity => typeof value === "string" && (SEVERITIES as readonly string[]).includes(value);
// "3, #5 7" as task ids, or null when one of them isn't an id.
export function taskIds(text: string): string[] | null {
  const ids = text
    .split(/[\s,]+/)
    .map((id) => id.replace(/^#/, ""))
    .filter(Boolean);
  return ids.every((id) => TASK_ID.test(id)) ? [...new Set(ids)] : null;
}
export const MAX_AFTER = 20;

export function taskProblem(
  { title, body, kind, severity, after }: { title: string; body: string; kind: string; severity: string; after: string },
  suggestion: boolean
): string | null {
  if (!title.trim()) return "Give the task a title: what should be true when it's done.";
  if (title.trim().length > LIMITS.title) return `Keep the title to ${LIMITS.title} characters; the rest goes in the description.`;
  if (!isKind(kind, suggestion)) return "Choose what kind of work it is.";
  if (severity && !isSeverity(severity)) return "Choose how bad it is: blocker, major or minor.";
  if (suggestion && (kind === "bug" || kind === "ux") && !severity) return "Say how bad it is: blocker, major or minor.";
  if (body.length > LIMITS.body) return `Keep the description to ${LIMITS.body.toLocaleString("en")} characters.`;
  if (suggestion && body.trim().length < 20) return "Say what happened or what's needed, and why, in a sentence or two.";
  const ids = taskIds(after);
  if (!ids) return "List the tasks it comes after by number: 3, 5.";
  if (ids.length > MAX_AFTER) return `It can come after at most ${MAX_AFTER} tasks.`;
  return null;
}

export const DECISIONS = ["approve", "reject", "research", "escalate"] as const;
export type DecisionKind = (typeof DECISIONS)[number];
export const isDecision = (value: unknown): value is DecisionKind => typeof value === "string" && (DECISIONS as readonly string[]).includes(value);

export function decisionProblem(decision: DecisionKind, text: string): string | null {
  if (text.length > LIMITS.note) return `Keep it to ${LIMITS.note.toLocaleString("en")} characters.`;
  if (decision === "approve") return null;
  if (!text.trim())
    return decision === "reject" ? "Say why it's rejected." : decision === "research" ? "Say what to find out." : "Say what has to be decided.";
  return null;
}

export function invitationProblem({
  email,
  name,
  team,
  role,
  label,
}: {
  email: string;
  name: string;
  team: string;
  role: string;
  label: string;
}): string | null {
  if (!EMAIL.test(email) || email.length > LIMITS.email) return "Give an email address (name@example.com).";
  if (!name.trim() || name.length > LIMITS.name) return `Give their name (up to ${LIMITS.name} characters).`;
  if (!TEAM_PARAM.test(team)) return "Choose a team.";
  if (!isTeamRole(role)) return "Choose member or contributor.";
  if (label.length > LIMITS.label) return `Keep their role for the agents to ${LIMITS.label} characters (customer, sales, support…).`;
  return null;
}
