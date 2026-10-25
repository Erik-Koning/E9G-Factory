// A team's rules: .e9g/team.json in its checkout, read with defaults filled in and checked. Every part of the
// factory reads the team through loadTeam, so a default or a check lives in one place. schema/team.schema.json
// describes the same file for editors.
import { existsSync, readFileSync } from "node:fs";
import { teamFile } from "./paths.mjs";
import { POLICIES } from "./policies.mjs";
import { minutes } from "./util.mjs";

export const GMAIL = [
  "mcp__claude_ai_Gmail__send_message",
  "mcp__claude_ai_Gmail__create_draft",
  "mcp__claude_ai_Gmail__search_threads",
  "mcp__claude_ai_Gmail__get_thread",
  "mcp__claude_ai_Gmail__get_message",
];

// The roles the factory has prompts for (plugin/agents/<role>.md), and what each is by default.
export const ROLES = {
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
  constructor(file, problems) {
    super(`${file}:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.problems = problems;
  }
}

export function loadTeam(home, { strict = true } = {}) {
  const file = teamFile(home);
  if (!existsSync(file)) throw new TeamError(file, ["missing: run e9g init to set up a team here"]);
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new TeamError(file, [`not valid JSON: ${error.message}`]);
  }
  const { team, problems, warnings } = normalize(raw, home);
  if (strict && problems.length) throw new TeamError(file, problems);
  return Object.assign(team, { file, warnings, problems });
}

export function normalize(raw, home) {
  const problems = [];
  const warnings = [];
  const regex = (value, where) => {
    try {
      new RegExp(value);
    } catch (error) {
      problems.push(`${where}: ${error.message}`);
    }
    return value;
  };

  for (const key of Object.keys(raw)) if (!KNOWN_KEYS.has(key)) warnings.push(`unknown key "${key}" (ignored)`);
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(raw.name ?? ""))
    problems.push('name: lowercase letters, digits and dashes, starting with a letter (e.g. "shop-redesign")');
  if (!raw.branch) problems.push("branch: the team's integration branch is required");
  if (raw.owner !== undefined && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw.owner)) problems.push("owner: an email address");

  const prefix = raw.branchPrefix ?? "e9g";
  const roles = {};
  for (const [role, given] of Object.entries(raw.roles ?? { planner: {}, builder: {}, reviewer: {} })) {
    const base = ROLES[role];
    if (!base) {
      problems.push(`roles.${role}: no such role (the factory has ${Object.keys(ROLES).join(", ")})`);
      continue;
    }
    const merged = { ...base, ...given };
    if (role !== "planner" && !(Number.isInteger(merged.limit) && merged.limit >= 0)) problems.push(`roles.${role}.limit: a whole number`);
    merged.write = (merged.write ?? []).map((rule, i) => (rule === "*" ? rule : regex(rule, `roles.${role}.write[${i}]`)));
    merged.deny = (merged.deny ?? []).map((rule, i) => regex(rule, `roles.${role}.deny[${i}]`));
    merged.mcp = merged.mcp ?? [];
    if (base.worktree) merged.branch = regex(given.branch ?? `^${prefix}/${role === "tester" ? "t-" : "b\\d+-"}`, `roles.${role}.branch`);
    else if (given.branch) {
      // Only roles that work on their own branch have one; a pattern here would let the merge queue take its branches.
      warnings.push(`roles.${role}.branch: the ${role} works in the shared checkout and has no branch (ignored)`);
      delete merged.branch;
    }
    roles[role] = merged;
  }
  if (!roles.planner) problems.push("roles.planner: every team has a planner");
  if (roles.tester && !roles.tester.write.length) problems.push('roles.tester.write: say where tests live (e.g. ["^e2e/"])');

  const policies = raw.policies ?? {};
  for (const [id, state] of Object.entries(policies)) {
    if (!POLICIES.some((policy) => policy.id === id)) problems.push(`policies.${id}: no such policy (${POLICIES.map((p) => p.id).join(", ")})`);
    else if (!["allow", "deny"].includes(state)) problems.push(`policies.${id}: "allow" or "deny"`);
  }

  // [rule, reason] pairs are accepted too, the way older loop.json files wrote them.
  const never = (raw.never ?? []).map((entry, i) => {
    const value = Array.isArray(entry) ? { rule: entry[0], reason: entry[1] } : entry;
    regex(value.rule ?? "", `never[${i}].rule`);
    if (!value.reason) problems.push(`never[${i}].reason: say why, the agent reads it`);
    return value;
  });
  const commandOwners = (raw.commandOwners ?? []).map((entry, i) => {
    const value = Array.isArray(entry) ? { rule: entry[0], roles: entry[1], reason: entry[2] } : entry;
    regex(value.rule ?? "", `commandOwners[${i}].rule`);
    return value;
  });
  const context = (raw.context ?? []).map((entry) => (Array.isArray(entry) ? { title: entry[0], command: entry[1] } : entry));

  let push = null;
  if (raw.push) push = { remote: raw.push.remote ?? "origin", branch: raw.push.branch ?? raw.branch, everyMin: minutes(raw.push.every, 0) };
  const board = typeof raw.board === "object" && raw.board?.github ? { type: "github", label: raw.board.github.label ?? "loop" } : { type: "files" };
  if (raw.board && raw.board !== "files" && board.type !== "github") problems.push('board: "files" or {"github": {"label": "loop"}}');

  const watchdog = raw.watchdog ?? {};
  const team = {
    raw,
    home,
    name: raw.name,
    title: raw.title ?? raw.name,
    owner: raw.owner ?? null,
    factory: raw.factory ?? null,
    branch: raw.branch,
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
export const instanceId = (team, role) => `e9g-${team.name}-${role}`;
export function roleForInstance(team, id) {
  for (const role of Object.keys(team.roles)) if (instanceId(team, role) === id) return role;
  return team.legacyInstances[id] ?? null;
}

// Claude Code reports a plugin agent as "e9g:<role>".
export const roleOfAgent = (agentType) => (agentType ?? "").replace(/^e9g:/, "");

export function laneAllows(team, role, rel) {
  const lane = team.roles[role];
  if (!lane) return false;
  if (lane.deny.some((rule) => new RegExp(rule).test(rel))) return false;
  return lane.write.some((rule) => rule === "*" || new RegExp(rule).test(rel));
}

export function roleForBranch(team, branch) {
  for (const [role, lane] of Object.entries(team.roles)) if (lane.branch && new RegExp(lane.branch).test(branch)) return role;
  return null;
}

// The factory's own files: the team's sources (.e9g/, except what a role's lane names, like the planner's lessons)
// and Claude Code's project settings and hooks, which would change how the agents themselves run.
export const FACTORY_PATH = /^\.e9g\/|^\.claude\/(settings(\.local)?\.json$|hooks\/|agents\/)/;
