// A team's rules: .e9g/team.json in its checkout, read with defaults filled in and checked. Every part of the
// factory reads the team through loadTeam, so a default or a check lives in one place. schema/team.schema.json
// describes the same file for editors.
import { existsSync, readFileSync } from "node:fs";
import { teamFile } from "./paths.ts";
import { POLICIES, type PolicyState } from "./policies.ts";
import { minutes } from "./util.ts";

// A role's settings in team.json (schema/team.schema.json, $defs.role).
export interface RoleSettings {
  limit?: number;
  write?: string[];
  deny?: string[];
  branch?: string;
  mcp?: string[];
  readOnly?: boolean;
  compactAt?: number;
}

export interface PageSpec {
  id: string;
  path: string;
  exclude?: string[];
}
export interface Viewport {
  id: string;
  width: number;
  height: number;
  isMobile?: boolean;
  deviceScaleFactor?: number;
}
// team.json "pages": the finish line for teams that build pages (lib/commands/pages.ts).
export interface PagesSettings {
  appUrl?: string;
  content?: string[];
  list?: PageSpec[];
  ignoreConsole?: string[];
  viewports?: Viewport[];
  schemes?: string[];
  settleMs?: number;
  base?: string;
  allowedChanges?: string[];
}

export interface NeverRule {
  rule: string;
  reason: string;
  // A command the rule must refuse; e9g check proves it does.
  example?: string;
}
export interface CommandOwner {
  rule: string;
  roles: string[];
  reason?: string;
}
export interface ContextCommand {
  title: string;
  command: string;
}

// .e9g/team.json as written. normalize checks it and fills in the defaults.
export interface RawTeam {
  $schema?: string;
  name?: string;
  title?: string;
  owner?: string;
  factory?: string;
  branch?: string;
  base?: string;
  protectedBranches?: string[];
  push?: { remote?: string; branch?: string; every?: string | number } | null;
  board?: "files" | { github?: { label?: string } };
  branchPrefix?: string;
  model?: string;
  roles?: Record<string, RoleSettings>;
  review?: { required?: string[]; removedPattern?: string | null };
  gate?: { full?: string; quick?: string; concurrency?: number };
  environment?: { script?: string; health?: string[]; needsDocker?: boolean };
  vars?: Record<string, string>;
  afterMerge?: string | null;
  finish?: string | null;
  progress?: string | null;
  pages?: PagesSettings;
  policies?: Record<string, string>;
  never?: (NeverRule | [string, string])[];
  commandOwners?: (CommandOwner | [string, string[], string?])[];
  context?: (ContextCommand | [string, string])[];
  docs?: string[];
  polishRounds?: number;
  worktreeSetup?: string | null;
  watchdog?: { tickEvery?: string | number; stuckAfter?: string | number; pruneAfter?: string | number; doneTickEvery?: string | number };
  protect?: string[];
  isolation?: string;
  startPrompt?: string | null;
  legacyInstances?: Record<string, string>;
  t3ProjectId?: string;
}

// What the factory knows about a role (ROLES), and a team's role with its settings and the defaults merged.
export interface RoleDefaults {
  summary: string;
  limit?: number;
  readOnly: boolean;
  write: string[];
  mcp?: string[];
  worktree?: boolean;
}
export interface Lane extends RoleDefaults {
  write: string[];
  deny: string[];
  mcp: string[];
  branch?: string;
  compactAt?: number;
}

export interface Team {
  raw: RawTeam;
  home: string;
  name: string;
  title: string;
  owner: string | null;
  factory: string | null;
  branch: string;
  base: string;
  protectedBranches: string[];
  push: { remote: string; branch: string; everyMin: number } | null;
  board: { type: "github"; label: string } | { type: "files" };
  branchPrefix: string;
  model: string;
  roles: Record<string, Lane>;
  review: { required: string[]; removedPattern: string | null };
  gate: { full: string | null; quick: string | null; concurrency: number };
  environment: { script: string | null; health: string[]; needsDocker: boolean };
  vars: Record<string, string>;
  afterMerge: string | null;
  finish: string | null;
  progress: string | null;
  pages: PagesSettings | null;
  policies: Record<string, PolicyState>;
  never: NeverRule[];
  commandOwners: CommandOwner[];
  context: ContextCommand[];
  docs: string[];
  polishRounds: number;
  worktreeSetup: string | null;
  watchdog: { tickEveryMin: number; stuckAfterMin: number; pruneAfterMin: number; doneTickEveryMin: number };
  protect: string[];
  isolation: string;
  startPrompt: string | null;
  plannerCompactAt: number;
  legacyInstances: Record<string, string>;
}

// A team as loadTeam returns it: where it was read from, and what was wrong with it.
export interface LoadedTeam extends Team {
  file: string;
  warnings: string[];
  problems: string[];
}

export const GMAIL = [
  "mcp__claude_ai_Gmail__send_message",
  "mcp__claude_ai_Gmail__create_draft",
  "mcp__claude_ai_Gmail__search_threads",
  "mcp__claude_ai_Gmail__get_thread",
  "mcp__claude_ai_Gmail__get_message",
];

// The roles the factory has prompts for (plugin/agents/<role>.md), and what each is by default.
export const ROLES: Record<string, RoleDefaults> = {
  planner: { summary: "runs the team: plans, briefs, checks, merges, reports", readOnly: false, write: ["^\\.e9g/lessons\\.md$"], mcp: GMAIL },
  builder: { summary: "builds one ticket on its own branch", limit: 2, readOnly: false, write: ["*"], worktree: true },
  tester: { summary: "writes and fixes end-to-end tests on its own branch", limit: 1, readOnly: false, write: [], worktree: true },
  reviewer: { summary: "reviews one finished branch before it merges", limit: 1, readOnly: true, write: [] },
  "ux-specialist": { summary: "audits pages and journeys, desktop and phone, light and dark", limit: 1, readOnly: true, write: [] },
  innovator: { summary: "finds what the brief misses and proposes it", limit: 1, readOnly: true, write: [] },
};

const KNOWN_KEYS = new Set([
  "$schema",
  "name",
  "title",
  "factory",
  "owner",
  "branch",
  "base",
  "protectedBranches",
  "push",
  "board",
  "branchPrefix",
  "model",
  "roles",
  "review",
  "gate",
  "environment",
  "vars",
  "afterMerge",
  "finish",
  "progress",
  "pages",
  "policies",
  "never",
  "commandOwners",
  "context",
  "docs",
  "polishRounds",
  "worktreeSetup",
  "watchdog",
  "protect",
  "isolation",
  "startPrompt",
  "legacyInstances",
  "t3ProjectId",
]);

export class TeamError extends Error {
  problems: string[];
  constructor(file: string, problems: string[]) {
    super(`${file}:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.problems = problems;
  }
}

export function loadTeam(home: string, { strict = true }: { strict?: boolean } = {}): LoadedTeam {
  const file = teamFile(home);
  if (!existsSync(file)) throw new TeamError(file, ["missing: run e9g init to set up a team here"]);
  let raw: RawTeam;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as RawTeam;
  } catch (error) {
    throw new TeamError(file, [`not valid JSON: ${(error as Error).message}`]);
  }
  const { team, problems, warnings } = normalize(raw, home);
  if (strict && problems.length) throw new TeamError(file, problems);
  return Object.assign(team, { file, warnings, problems });
}

export function normalize(raw: RawTeam, home: string): { team: Team; problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const regex = (value: string, where: string): string => {
    try {
      new RegExp(value);
    } catch (error) {
      problems.push(`${where}: ${(error as Error).message}`);
    }
    return value;
  };

  for (const key of Object.keys(raw)) if (!KNOWN_KEYS.has(key)) warnings.push(`unknown key "${key}" (ignored)`);
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(raw.name ?? ""))
    problems.push('name: lowercase letters, digits and dashes, starting with a letter (e.g. "shop-redesign")');
  if (!raw.branch) problems.push("branch: the team's integration branch is required");
  if (raw.owner !== undefined && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw.owner)) problems.push("owner: an email address");

  const prefix = raw.branchPrefix ?? "e9g";
  const roles: Record<string, Lane> = {};
  const given: Record<string, RoleSettings> = raw.roles ?? { planner: {}, builder: {}, reviewer: {} };
  for (const [role, settings] of Object.entries(given)) {
    const base = ROLES[role];
    if (!base) {
      problems.push(`roles.${role}: no such role (the factory has ${Object.keys(ROLES).join(", ")})`);
      continue;
    }
    const merged: Lane = {
      ...base,
      ...settings,
      write: (settings.write ?? base.write).map((rule, i) => (rule === "*" ? rule : regex(rule, `roles.${role}.write[${i}]`))),
      deny: (settings.deny ?? []).map((rule, i) => regex(rule, `roles.${role}.deny[${i}]`)),
      mcp: settings.mcp ?? base.mcp ?? [],
    };
    if (role !== "planner" && !(Number.isInteger(merged.limit) && (merged.limit ?? -1) >= 0)) problems.push(`roles.${role}.limit: a whole number`);
    if (base.worktree) merged.branch = regex(settings.branch ?? `^${prefix}/${role === "tester" ? "t-" : "b\\d+-"}`, `roles.${role}.branch`);
    else if (settings.branch) {
      // Only roles that work on their own branch have one; a pattern here would let the merge queue take its branches.
      warnings.push(`roles.${role}.branch: the ${role} works in the shared checkout and has no branch (ignored)`);
      delete merged.branch;
    }
    roles[role] = merged;
  }
  if (!roles["planner"]) problems.push("roles.planner: every team has a planner");
  if (roles["tester"] && !roles["tester"].write.length) problems.push('roles.tester.write: say where tests live (e.g. ["^e2e/"])');

  const policies: Record<string, PolicyState> = {};
  for (const [id, state] of Object.entries(raw.policies ?? {})) {
    if (!POLICIES.some((policy) => policy.id === id)) problems.push(`policies.${id}: no such policy (${POLICIES.map((p) => p.id).join(", ")})`);
    else if (state !== "allow" && state !== "deny") problems.push(`policies.${id}: "allow" or "deny"`);
    else policies[id] = state;
  }

  // [rule, reason] pairs are accepted too, the way older loop.json files wrote them.
  const never = (raw.never ?? []).map((entry, i): NeverRule => {
    const value: NeverRule = Array.isArray(entry) ? { rule: entry[0], reason: entry[1] } : entry;
    regex(value.rule ?? "", `never[${i}].rule`);
    if (!value.reason) problems.push(`never[${i}].reason: say why, the agent reads it`);
    return value;
  });
  const commandOwners = (raw.commandOwners ?? []).map((entry, i): CommandOwner => {
    const value: CommandOwner = Array.isArray(entry) ? { rule: entry[0], roles: entry[1], ...(entry[2] === undefined ? {} : { reason: entry[2] }) } : entry;
    regex(value.rule ?? "", `commandOwners[${i}].rule`);
    return value;
  });
  const context = (raw.context ?? []).map((entry): ContextCommand => (Array.isArray(entry) ? { title: entry[0], command: entry[1] } : entry));

  let push: Team["push"] = null;
  if (raw.push) push = { remote: raw.push.remote ?? "origin", branch: raw.push.branch ?? raw.branch ?? "", everyMin: minutes(raw.push.every, 0) };
  const board: Team["board"] =
    typeof raw.board === "object" && raw.board?.github ? { type: "github", label: raw.board.github.label ?? "loop" } : { type: "files" };
  if (raw.board && raw.board !== "files" && board.type !== "github") problems.push('board: "files" or {"github": {"label": "loop"}}');

  const watchdog = raw.watchdog ?? {};
  const team: Team = {
    raw,
    home,
    name: raw.name ?? "",
    title: raw.title ?? raw.name ?? "",
    owner: raw.owner ?? null,
    factory: raw.factory ?? null,
    branch: raw.branch ?? "",
    base: raw.base ?? "main",
    protectedBranches: raw.protectedBranches ?? ["main", "master", "production", "prod"],
    push,
    board,
    branchPrefix: prefix,
    model: raw.model ?? "claude-opus-5-5",
    roles,
    review: { required: raw.review?.required ?? ["builder"], removedPattern: raw.review?.removedPattern ?? null },
    gate: {
      full: raw.gate?.full ?? null,
      quick: raw.gate?.quick ?? raw.gate?.full ?? null,
      concurrency: raw.gate?.concurrency ?? 2,
    },
    environment: {
      script: raw.environment?.script ?? null,
      health: raw.environment?.health ?? [],
      needsDocker: raw.environment?.needsDocker ?? false,
    },
    vars: raw.vars ?? {},
    afterMerge: raw.afterMerge ?? null,
    finish: raw.finish ?? null,
    progress: raw.progress ?? (raw.finish ? raw.finish.replace(/\bdone$/, "status") : null),
    pages: raw.pages ?? null,
    policies,
    never,
    commandOwners,
    context,
    docs: raw.docs ?? [".e9g/brief.md", ".e9g/notes.md"],
    polishRounds: raw.polishRounds ?? 1,
    worktreeSetup: raw.worktreeSetup ?? null,
    watchdog: {
      tickEveryMin: minutes(watchdog.tickEvery, 10),
      stuckAfterMin: minutes(watchdog.stuckAfter, 45),
      pruneAfterMin: minutes(watchdog.pruneAfter, 60),
      doneTickEveryMin: minutes(watchdog.doneTickEvery, 1440),
    },
    protect: (raw.protect ?? []).map((rule, i) => regex(rule, `protect[${i}]`)),
    isolation: raw.isolation ?? "strict",
    startPrompt: raw.startPrompt ?? null,
    plannerCompactAt: raw.roles?.planner?.compactAt ?? 160000,
    legacyInstances: raw.legacyInstances ?? {},
  };
  if (!["strict", "user"].includes(team.isolation)) problems.push('isolation: "strict" (no personal skills, plugins or connectors) or "user"');
  if (!team.finish) warnings.push("finish: no finish command, so the team can't tell when it's done");
  if (!team.gate.full) warnings.push("gate.full: no gate, so merges aren't checked");
  if (!team.owner) warnings.push("owner: nobody to email when the team is done or needs a decision");
  return { team, problems, warnings };
}

// One T3 provider instance per role; its id carries the team and the role.
export const instanceId = (team: Pick<Team, "name">, role: string): string => `e9g-${team.name}-${role}`;
// Own properties only: an instance named "constructor" is no role.
export function roleForInstance(team: Team, id: string): string | null {
  for (const role of Object.keys(team.roles)) if (instanceId(team, role) === id) return role;
  const legacy = Object.hasOwn(team.legacyInstances, id) ? team.legacyInstances[id] : undefined;
  return typeof legacy === "string" && Object.hasOwn(team.roles, legacy) ? legacy : null;
}

// Claude Code reports a plugin agent as "e9g:<role>".
export const roleOfAgent = (agentType: string | undefined): string => (agentType ?? "").replace(/^e9g:/, "");

export function laneAllows(team: Team, role: string, rel: string): boolean {
  const lane = team.roles[role];
  if (!lane) return false;
  if (lane.deny.some((rule) => new RegExp(rule).test(rel))) return false;
  return lane.write.some((rule) => rule === "*" || new RegExp(rule).test(rel));
}

export function roleForBranch(team: Team, branch: string): string | null {
  for (const [role, lane] of Object.entries(team.roles)) if (lane.branch && new RegExp(lane.branch).test(branch)) return role;
  return null;
}

// The factory's own files: the team's sources (.e9g/), and Claude Code's project configuration (.claude/ and
// .mcp.json: settings, hooks, agents, skills, commands), which would change how the agents themselves run.
export const FACTORY_PATH = /^\.e9g\/|^\.claude(\/|$)|^\.mcp\.json$/;

// Only a lane rule that names a factory path itself opens it (the planner's "^\.e9g/lessons\.md$"); a broad rule
// that happens to match one ("\.json$") doesn't.
const NAMES_FACTORY_PATH = /^\^\\?\.(?:e9g\/|claude\/|mcp\\?\.json)/;
export function factoryWrite(team: Team, role: string, rel: string): boolean {
  if (!FACTORY_PATH.test(rel)) return false;
  return !(team.roles[role]?.write ?? []).some((rule) => NAMES_FACTORY_PATH.test(rule) && new RegExp(rule).test(rel));
}
