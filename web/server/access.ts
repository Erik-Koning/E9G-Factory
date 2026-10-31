// Who may see and do what, per team. Pure: the pages and the server actions ask here, and the unit tests prove it.
//
// - admin (the operator): everything, on every team, but only from a session signed in with a second factor;
// - member: the board, journeys, the graph, every request (senders by role), and sending requests;
// - contributor: the team's overview (status, journeys, progress counts), their own requests, and sending requests.

export const TEAM_ROLES = ["member", "contributor"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];
export const isTeamRole = (value: unknown): value is TeamRole => typeof value === "string" && (TEAM_ROLES as readonly string[]).includes(value);

export interface Viewer {
  userId: string;
  admin: boolean;
  // This session began with a second factor: an authenticator code, a backup code, or a passkey that verified the
  // person (a PIN or biometrics). Only an admin needs it.
  secondFactor: boolean;
  // The person's role on each team they belong to.
  teams: Readonly<Record<string, TeamRole>>;
}

export type Ability =
  // The team's status, its journeys and how many tasks are where.
  | "team:overview"
  // The board, the graph and recent merges.
  | "team:board"
  // Every request of the team (otherwise only one's own).
  | "requests:all"
  | "requests:send"
  // Who sent a request, by name and email (otherwise by role).
  | "senders:names"
  // Approve, reject, research and escalate proposals.
  | "proposals:decide"
  // Invite people, set their roles, remove and ban them.
  | "people:manage";

const ROLE_ABILITIES: Record<TeamRole, readonly Ability[]> = {
  member: ["team:overview", "team:board", "requests:all", "requests:send"],
  contributor: ["team:overview", "requests:send"],
};

// An admin whose session lacks its second factor may do nothing until they sign in again with it.
export const blockedAdmin = (viewer: Viewer | null): boolean => viewer !== null && viewer.admin && !viewer.secondFactor;

export function roleIn(viewer: Viewer | null, team: string): "admin" | TeamRole | null {
  if (!viewer || blockedAdmin(viewer)) return null;
  if (viewer.admin) return "admin";
  return Object.hasOwn(viewer.teams, team) ? (viewer.teams[team] ?? null) : null;
}

// Whether `viewer` may do `ability`: on `team`, or anywhere for the abilities that aren't a team's (people:manage).
export function can(viewer: Viewer | null, ability: Ability, team?: string): boolean {
  if (!viewer || blockedAdmin(viewer)) return false;
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
