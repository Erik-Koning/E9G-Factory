// A team's rules: .e9g/team.json in its checkout, read with defaults filled in and checked. Every part of the
// factory reads the team through loadTeam, so a default or a check lives in one place. schema/team.schema.json
// describes the same file for editors, and test/audit-setup.test.ts keeps the two in step.
import { existsSync, readFileSync } from "node:fs";
import { type Contact, DEFAULT_CONTACT } from "./contact.ts";
import { teamFile, VERSION_NAME } from "./paths.ts";
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
  title?: string;
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
  push?: { remote?: string; branch?: string; every?: string | number } | null | false;
  board?: "files" | { github?: { label?: string } };
  branchPrefix?: string;
  model?: string;
  roles?: Record<string, RoleSettings>;
  review?: { required?: string[]; removedPattern?: string | null };
  gate?: { full?: string | null; quick?: string | null; concurrency?: number };
  environment?: { script?: string | null; health?: string[]; needsDocker?: boolean };
  vars?: Record<string, string | number | boolean>;
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
  contact?: { mode?: string; every?: string | number };
  protect?: string[];
  isolation?: string;
  startPrompt?: string | null;
  legacyInstances?: Record<string, string>;
  t3ProjectId?: string | null;
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
  contact: Contact;
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
  planner: {
    summary: "runs the team: plans, briefs, checks, merges, reports",
    readOnly: false,
    write: ["^\\.e9g/lessons\\.md$", "^\\.e9g/decisions\\.md$"],
    mcp: GMAIL,
  },
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
  "contact",
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

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// The shapes schema/team.schema.json gives these values; normalize checks the same ones.
export const TEAM_NAME = /^[a-z][a-z0-9-]{0,30}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// Spaces around it are allowed ("10m "), as minutes() reads it.
const DURATION = /^\s*\d+(\.\d+)?\s*(m|min|h|d)?\s*$/;
const HEALTH = /^(any:)?https?:\/\/\S+$/;
const URL_START = /^https?:\/\/\S+$/;
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// What a team's vars can't set: the factory's own (E9G_*), and the ones that tell Claude Code where a member's project,
// settings and plugin are. Claude Code's tuning vars (CLAUDE_CODE_MAX_OUTPUT_TOKENS) are the team's to set.
const RESERVED_VAR = /^(E9G_|CLAUDE_(PROJECT_DIR|CONFIG_DIR|PLUGIN_ROOT|ENV_FILE)$)/;
// Page and viewport ids name files (results, screenshots, verdicts).
const ID = /^[\w-]+$/;
const PAGES_DONE = /\be9g\s+pages\s+done\b/;
const SCHEMES = ["light", "dark", "no-preference"];
// Matches nothing: what an invalid pattern becomes, so a team with problems never matches more than it said.
const NOTHING = "(?!)";

// review.removedPattern's default when the team has a tester: a removed line with an assertion in it, so a test branch
// that drops one needs a review. Real assertions only: not .toString(…), nor a helper such as assertMainBranch(…).
export const ASSERTION_PATTERN = [
  // expect(…), expect.soft(…)
  String.raw`\bexpect(\.\w+)*\s*\(`,
  // Node's and Chai's assert(…), assert.equal(…)
  String.raw`\bassert\s*[.(]`,
  // Python's assert statement
  String.raw`^\s*assert\s`,
  // Rust's assert!(…), assert_eq!(…), debug_assert!(…)
  String.raw`\b(debug_)?assert(_\w+)?!`,
  // xUnit's: self.assertEqual(…), assertTrue(…), assertThat(…)
  String.raw`\bassert(Not)?(\w*Equals?|True|False|Null|None|Same|That|Throws|DoesNotThrow|Raises\w*|In|Is(Not)?(None|Instance)?|Greater(Equal)?|Less(Equal)?|Regex|Warns\w*|Logs|All|InstanceOf)\s*\(`,
  // should.js and Chai's x.should.equal(…)
  String.raw`\bshould\.`,
  // Jest, Vitest and Playwright matchers: .toBe(…), .toEqual(…), .toHaveURL(…)
  String.raw`\.(toBe\w*|toEqual|toStrictEqual|toMatch\w*|toContain\w*|toHave\w*|toThrow\w*)\s*\(`,
].join("|");

export function normalize(raw: RawTeam, home: string): { team: Team; problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];

  // Checks for one value each: they record a problem and return undefined when the value doesn't fit.
  const bad = (where: string, what: string): undefined => {
    problems.push(`${where}: ${what}`);
    return undefined;
  };
  const regex = (value: unknown, where: string): string => {
    if (typeof value !== "string" || value === "") {
      bad(where, "a regular expression");
      return NOTHING;
    }
    try {
      new RegExp(value);
      return value;
    } catch (error) {
      bad(where, (error as Error).message);
      return NOTHING;
    }
  };
  const text = (value: unknown, where: string): string | undefined =>
    value === undefined || (typeof value === "string" && value !== "") ? value : bad(where, "text (a non-empty string)");
  // A command the team may leave out: null or "" means none, as 0.2.0 read it.
  const textOrNull = (value: unknown, where: string): string | null | undefined => (value === null || value === "" ? null : text(value, where));
  const whole = (value: unknown, where: string, min: number): number | undefined =>
    value === undefined || (Number.isInteger(value) && (value as number) >= min)
      ? (value as number | undefined)
      : bad(where, min ? `a whole number, at least ${min}` : "a whole number");
  const flag = (value: unknown, where: string): boolean | undefined =>
    value === undefined || typeof value === "boolean" ? value : bad(where, "true or false");
  const role = (value: unknown, where: string): string | undefined =>
    typeof value === "string" && Object.hasOwn(ROLES, value) ? value : bad(where, `a role (${Object.keys(ROLES).join(", ")})`);
  const need = <T>(value: unknown, where: string, check: (value: unknown, where: string) => T | undefined): T | undefined =>
    value === undefined ? bad(where, "required") : check(value, where);
  const list = <T>(value: unknown, where: string, item: (value: unknown, where: string) => T | undefined): T[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) return bad(where, "a list");
    return value.map((entry, i) => item(entry, `${where}[${i}]`)).filter((entry): entry is T => entry !== undefined);
  };
  // An object with these keys (null: any keys). Any other key is ignored with a warning, as at the top level: a typo
  // or a note ($comment) mustn't stop a running team. Nothing below copies a key it doesn't name.
  const object = (value: unknown, where: string, keys: string[] | null): Record<string, unknown> | undefined => {
    if (value === undefined) return undefined;
    if (!isObject(value)) return bad(where, "an object");
    for (const key of Object.keys(value))
      if (keys && !keys.includes(key)) warnings.push(`unknown key "${where}.${key}" (ignored; ${where} takes ${keys.join(", ")})`);
    return value;
  };
  // An object, or the older array form that lists the same values in order ([rule, reason], [title, command]).
  const entry = (value: unknown, where: string, keys: string[], positional: string[], min = positional.length): Record<string, unknown> | undefined => {
    if (!Array.isArray(value)) return isObject(value) ? object(value, where, keys) : bad(where, "an object");
    if (value.length >= min && value.length <= positional.length) return Object.fromEntries(value.map((item: unknown, i) => [positional[i], item]));
    return bad(where, `[${positional.join(", ")}]`);
  };
  const duration = (value: unknown, where: string, fallback: number): number => {
    if (value === undefined) return fallback;
    if ((typeof value === "number" && Number.isFinite(value) && value >= 0) || (typeof value === "string" && DURATION.test(value)))
      return minutes(value, fallback);
    bad(where, "a duration (45m, 6h, 2d, or a number of minutes)");
    return fallback;
  };

  const input: Record<string, unknown> = isObject(raw) ? raw : {};
  if (!isObject(raw)) bad("team.json", "an object with the team's settings");
  for (const key of Object.keys(input)) if (!KNOWN_KEYS.has(key)) warnings.push(`unknown key "${key}" (ignored)`);
  text(input["$schema"], "$schema");
  const name = typeof input.name === "string" ? input.name : "";
  if (!TEAM_NAME.test(name)) problems.push('name: lowercase letters, digits and dashes, starting with a letter (e.g. "shop-redesign")');
  const branch = typeof input.branch === "string" ? input.branch : "";
  if (!branch) problems.push("branch: the team's integration branch is required");
  if (input.owner !== undefined && !(typeof input.owner === "string" && EMAIL.test(input.owner))) problems.push("owner: an email address");
  let factory: string | null = null;
  if (input.factory !== undefined) {
    if (typeof input.factory === "string" && VERSION_NAME.test(input.factory)) factory = input.factory;
    else problems.push('factory: an installed version, such as "0.3.0", or "dev" (e9g versions lists them)');
  }
  const protectedBranches = list(input.protectedBranches, "protectedBranches", text) ?? ["main", "master", "production", "prod"];
  if (branch && protectedBranches.includes(branch))
    problems.push(`branch: ${branch} is protected (protectedBranches), so the team could never merge into it; give it its own branch, such as e9g/next`);

  const prefix = text(input.branchPrefix, "branchPrefix") ?? "e9g";
  const roles: Record<string, Lane> = {};
  const given = input.roles === undefined ? { planner: {}, builder: {}, reviewer: {} } : (object(input.roles, "roles", null) ?? {});
  for (const [id, value] of Object.entries(given)) {
    const base = ROLES[id];
    if (!base || !Object.hasOwn(ROLES, id)) {
      problems.push(`roles.${id}: no such role (the factory has ${Object.keys(ROLES).join(", ")})`);
      continue;
    }
    const where = `roles.${id}`;
    // The lane is the factory's defaults plus only these settings, so any other key (such as "worktree") is ignored and
    // can't change what the factory gives the role.
    const settings = object(value, where, ["limit", "write", "deny", "branch", "mcp", "readOnly", "compactAt"]) ?? {};
    const lane: Lane = {
      ...base,
      write: list(settings.write, `${where}.write`, (rule, at) => (rule === "*" ? rule : regex(rule, at))) ?? base.write,
      deny: list(settings.deny, `${where}.deny`, regex) ?? [],
      mcp: list(settings.mcp, `${where}.mcp`, text) ?? base.mcp ?? [],
    };
    const limit = whole(settings.limit, `${where}.limit`, 0);
    if (limit !== undefined) lane.limit = limit;
    const readOnly = flag(settings.readOnly, `${where}.readOnly`);
    if (readOnly !== undefined) lane.readOnly = readOnly;
    const compactAt = whole(settings.compactAt, `${where}.compactAt`, 1);
    if (compactAt !== undefined) lane.compactAt = compactAt;
    const pattern = settings.branch === undefined ? undefined : regex(settings.branch, `${where}.branch`);
    if (base.worktree) lane.branch = pattern ?? regex(`^${prefix}/${id === "tester" ? "t-" : "b\\d+-"}`, `${where}.branch`);
    // Only roles that work on their own branch have one; a pattern here would let the merge queue take its branches.
    else if (pattern !== undefined) warnings.push(`${where}.branch: the ${id} works in the shared checkout and has no branch (ignored)`);
    roles[id] = lane;
  }
  if (!roles["planner"]) problems.push("roles.planner: every team has a planner");
  if (roles["tester"] && !roles["tester"].write.length) problems.push('roles.tester.write: say where tests live (e.g. ["^e2e/"])');

  const policies: Record<string, PolicyState> = {};
  for (const [id, state] of Object.entries(object(input.policies, "policies", null) ?? {})) {
    if (!POLICIES.some((policy) => policy.id === id)) problems.push(`policies.${id}: no such policy (${POLICIES.map((p) => p.id).join(", ")})`);
    else if (state !== "allow" && state !== "deny") problems.push(`policies.${id}: "allow" or "deny"`);
    else policies[id] = state;
  }

  // [rule, reason] pairs are accepted too, the way older loop.json files wrote them.
  const never =
    list(input.never, "never", (value, where): NeverRule | undefined => {
      const rule = entry(value, where, ["rule", "reason", "example"], ["rule", "reason"]);
      if (!rule) return undefined;
      const reason = typeof rule.reason === "string" && rule.reason ? rule.reason : bad(`${where}.reason`, "say why, the agent reads it");
      // "" is no example, as 0.2.0 read it.
      const example = textOrNull(rule.example, `${where}.example`) ?? undefined;
      return { rule: regex(rule.rule, `${where}.rule`), reason: reason ?? "", ...(example === undefined ? {} : { example }) };
    }) ?? [];
  const commandOwners =
    list(input.commandOwners, "commandOwners", (value, where): CommandOwner | undefined => {
      const owner = entry(value, where, ["rule", "roles", "reason"], ["rule", "roles", "reason"], 2);
      if (!owner) return undefined;
      const reason = text(owner.reason, `${where}.reason`);
      return {
        rule: regex(owner.rule, `${where}.rule`),
        roles: need(owner.roles, `${where}.roles`, (owners, at) => list(owners, at, role)) ?? [],
        ...(reason === undefined ? {} : { reason }),
      };
    }) ?? [];
  const context =
    list(input.context, "context", (value, where): ContextCommand | undefined => {
      const command = entry(value, where, ["title", "command"], ["title", "command"]);
      if (!command) return undefined;
      const title = need(command.title, `${where}.title`, text);
      const run = need(command.command, `${where}.command`, text);
      return title === undefined || run === undefined ? undefined : { title, command: run };
    }) ?? [];

  // null or false: nothing leaves the machine.
  let push: Team["push"] = null;
  if (input.push !== undefined && input.push !== null && input.push !== false) {
    const value = object(input.push, "push", ["remote", "branch", "every"]);
    if (value)
      push = {
        remote: text(value.remote, "push.remote") ?? "origin",
        branch: text(value.branch, "push.branch") ?? branch,
        everyMin: duration(value.every, "push.every", 0),
      };
  }
  let board: Team["board"] = { type: "files" };
  if (input.board !== undefined && input.board !== "files") {
    const value = isObject(input.board) ? object(input.board, "board", ["github"]) : undefined;
    const github = value && isObject(value.github) ? object(value.github, "board.github", ["label"]) : undefined;
    if (!github) problems.push('board: "files", or {"github": {"label": "e9g"}}');
    else board = { type: "github", label: text(github.label, "board.github.label") ?? "e9g" };
  }

  const review = object(input.review, "review", ["required", "removedPattern"]) ?? {};
  // A tester's branches get the assertion default; null turns it off.
  let removedPattern: string | null = roles["tester"] ? ASSERTION_PATTERN : null;
  if (review.removedPattern !== undefined) removedPattern = review.removedPattern === null ? null : regex(review.removedPattern, "review.removedPattern");
  const gate = object(input.gate, "gate", ["full", "quick", "concurrency"]) ?? {};
  const full = textOrNull(gate.full, "gate.full") ?? null;
  // quick: null (or left out) is the full gate; "" is none, as 0.2.0 read it.
  const quick = gate.quick === "" ? null : (textOrNull(gate.quick, "gate.quick") ?? full);
  const environment = object(input.environment, "environment", ["script", "health", "needsDocker"]) ?? {};
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(object(input.vars, "vars", null) ?? {})) {
    if (!VAR_NAME.test(key)) problems.push(`vars.${key}: a variable name (letters, digits and _)`);
    else if (RESERVED_VAR.test(key))
      problems.push(
        `vars.${key}: a variable name of the team's own; the factory sets E9G_…, and CLAUDE_PROJECT_DIR, CLAUDE_CONFIG_DIR, CLAUDE_PLUGIN_ROOT and CLAUDE_ENV_FILE say where a member runs`
      );
    else if (typeof value === "string") vars[key] = value;
    // An environment variable is text either way, as 0.2.0 passed it.
    else if (typeof value === "number" || typeof value === "boolean") {
      vars[key] = String(value);
      warnings.push(`vars.${key}: ${value} is passed as the text "${value}" (put it in quotes to say so)`);
    } else problems.push(`vars.${key}: text, a number or true/false`);
  }
  const legacyInstances: Record<string, string> = {};
  for (const [id, value] of Object.entries(object(input.legacyInstances, "legacyInstances", null) ?? {})) {
    const owner = role(value, `legacyInstances.${id}`);
    if (owner) legacyInstances[id] = owner;
  }
  const finish = textOrNull(input.finish, "finish") ?? null;
  const watchdog = object(input.watchdog, "watchdog", ["tickEvery", "stuckAfter", "pruneAfter", "doneTickEvery"]) ?? {};
  const contact = object(input.contact, "contact", ["mode", "every"]) ?? {};
  const contactMode = contact.mode ?? DEFAULT_CONTACT.mode;
  if (contactMode !== "digest" && contactMode !== "priority")
    problems.push('contact.mode: "digest" (at most one message per contact.every, everything open together) or "priority" (each as soon as it\'s needed)');
  const isolation = input.isolation ?? "strict";
  if (isolation !== "strict" && isolation !== "user") problems.push('isolation: "strict" (no personal skills, plugins or connectors) or "user"');
  // null: none yet, which register assigns (it reads the value as written, so "" isn't none).
  if (input.t3ProjectId !== null) text(input.t3ProjectId, "t3ProjectId");

  // pages: the finish line for teams that build pages (lib/commands/pages.ts).
  let pages: PagesSettings | null = null;
  const pagesIn = object(input.pages, "pages", [
    "appUrl",
    "base",
    "content",
    "allowedChanges",
    "list",
    "viewports",
    "schemes",
    "ignoreConsole",
    "settleMs",
  ]);
  if (pagesIn) {
    const page = (value: unknown, where: string): PageSpec | undefined => {
      const spec = object(value, where, ["id", "path", "title", "exclude"]);
      if (!spec) return undefined;
      const id = need(spec.id, `${where}.id`, (id, at) =>
        typeof id === "string" && ID.test(id) ? id : bad(at, "letters, digits, _ and - (it names the page's files)")
      );
      const path = need(spec.path, `${where}.path`, (path, at) =>
        typeof path === "string" && path.startsWith("/") ? path : bad(at, "the page's path on the app, starting with /")
      );
      const title = text(spec.title, `${where}.title`);
      const exclude = list(spec.exclude, `${where}.exclude`, regex);
      if (id === undefined || path === undefined) return undefined;
      return { id, path, ...(title === undefined ? {} : { title }), ...(exclude === undefined ? {} : { exclude }) };
    };
    const viewport = (value: unknown, where: string): Viewport | undefined => {
      const spec = object(value, where, ["id", "width", "height", "isMobile", "deviceScaleFactor"]);
      if (!spec) return undefined;
      const id = need(spec.id, `${where}.id`, (id, at) => (typeof id === "string" && ID.test(id) ? id : bad(at, "letters, digits, _ and -")));
      const width = need(spec.width, `${where}.width`, (n, at) => whole(n, at, 1));
      const height = need(spec.height, `${where}.height`, (n, at) => whole(n, at, 1));
      const isMobile = flag(spec.isMobile, `${where}.isMobile`);
      const scale = spec.deviceScaleFactor;
      if (scale !== undefined && !(typeof scale === "number" && scale > 0)) bad(`${where}.deviceScaleFactor`, "a number above 0");
      if (id === undefined || width === undefined || height === undefined) return undefined;
      return {
        id,
        width,
        height,
        ...(isMobile === undefined ? {} : { isMobile }),
        ...(typeof scale === "number" && scale > 0 ? { deviceScaleFactor: scale } : {}),
      };
    };
    const nonEmpty = <T>(value: unknown, where: string, item: (value: unknown, where: string) => T | undefined, what: string): T[] | undefined =>
      Array.isArray(value) && !value.length ? bad(where, what) : list(value, where, item);
    pages = {};
    if (!Array.isArray(pagesIn.list) || !pagesIn.list.length)
      bad("pages.list", 'the pages to check, at least one (e.g. [{"id": "landing", "path": "/"}])');
    else pages.list = list(pagesIn.list, "pages.list", page) ?? [];
    const ids = (pages.list ?? []).map((spec) => spec.id);
    for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) problems.push(`pages.list: more than one page is named ${id}`);
    const appUrl =
      pagesIn.appUrl === undefined || (typeof pagesIn.appUrl === "string" && URL_START.test(pagesIn.appUrl))
        ? pagesIn.appUrl
        : bad("pages.appUrl", "a URL (http://…)");
    if (appUrl !== undefined) pages.appUrl = appUrl;
    const pagesBase = text(pagesIn.base, "pages.base");
    if (pagesBase !== undefined) pages.base = pagesBase;
    const content = list(pagesIn.content, "pages.content", text);
    if (content !== undefined) pages.content = content;
    const allowedChanges = list(pagesIn.allowedChanges, "pages.allowedChanges", regex);
    if (allowedChanges !== undefined) pages.allowedChanges = allowedChanges;
    const viewports = nonEmpty(pagesIn.viewports, "pages.viewports", viewport, "at least one viewport, or leave it out for the defaults");
    if (viewports !== undefined) pages.viewports = viewports;
    const schemes = nonEmpty(
      pagesIn.schemes,
      "pages.schemes",
      (scheme, at) => (typeof scheme === "string" && SCHEMES.includes(scheme) ? scheme : bad(at, SCHEMES.join(", "))),
      "at least one colour scheme, or leave it out for light and dark"
    );
    if (schemes !== undefined) pages.schemes = schemes;
    const ignoreConsole = list(pagesIn.ignoreConsole, "pages.ignoreConsole", regex);
    if (ignoreConsole !== undefined) pages.ignoreConsole = ignoreConsole;
    const settleMs = whole(pagesIn.settleMs, "pages.settleMs", 0);
    if (settleMs !== undefined) pages.settleMs = settleMs;
  }
  if (finish && PAGES_DONE.test(finish) && input.pages === undefined)
    problems.push('pages: the finish line is e9g pages done, so "pages" must list the pages it checks');

  const team: Team = {
    raw,
    home,
    name,
    // "" is the name, like leaving it out.
    title: input.title === "" ? name : (text(input.title, "title") ?? name),
    owner: typeof input.owner === "string" ? input.owner : null,
    factory,
    branch,
    base: text(input.base, "base") ?? "main",
    protectedBranches,
    push,
    board,
    branchPrefix: prefix,
    model: text(input.model, "model") ?? "claude-opus-5-5",
    roles,
    review: { required: list(review.required, "review.required", role) ?? ["builder"], removedPattern },
    gate: { full, quick, concurrency: whole(gate.concurrency, "gate.concurrency", 1) ?? 2 },
    environment: {
      script: textOrNull(environment.script, "environment.script") ?? null,
      health:
        list(environment.health, "environment.health", (url, where) =>
          typeof url === "string" && HEALTH.test(url) ? url : bad(where, "a URL (http://…), or any:<url> to accept any answer")
        ) ?? [],
      needsDocker: flag(environment.needsDocker, "environment.needsDocker") ?? false,
    },
    vars,
    afterMerge: textOrNull(input.afterMerge, "afterMerge") ?? null,
    finish,
    // Left out or null: the finish command with done→status. "": none, as 0.2.0 read it.
    progress: input.progress === "" ? null : (textOrNull(input.progress, "progress") ?? (finish ? finish.replace(/\bdone$/, "status") : null)),
    pages,
    policies,
    never,
    commandOwners,
    context,
    docs: list(input.docs, "docs", text) ?? [".e9g/brief.md", ".e9g/notes.md"],
    polishRounds: whole(input.polishRounds, "polishRounds", 0) ?? 1,
    worktreeSetup: textOrNull(input.worktreeSetup, "worktreeSetup") ?? null,
    watchdog: {
      tickEveryMin: duration(watchdog.tickEvery, "watchdog.tickEvery", 10),
      stuckAfterMin: duration(watchdog.stuckAfter, "watchdog.stuckAfter", 45),
      pruneAfterMin: duration(watchdog.pruneAfter, "watchdog.pruneAfter", 60),
      doneTickEveryMin: duration(watchdog.doneTickEvery, "watchdog.doneTickEvery", 1440),
    },
    contact: {
      mode: contactMode === "priority" ? "priority" : "digest",
      everyMin: duration(contact.every, "contact.every", DEFAULT_CONTACT.everyMin),
    },
    protect: list(input.protect, "protect", regex) ?? [],
    isolation: isolation === "user" ? "user" : "strict",
    startPrompt: textOrNull(input.startPrompt, "startPrompt") ?? null,
    plannerCompactAt: roles["planner"]?.compactAt ?? 160000,
    legacyInstances,
  };
  if (push && push.branch && protectedBranches.includes(push.branch))
    problems.push(`push.branch: ${push.branch} is protected (protectedBranches); the planner pushes only the team's branch`);
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
