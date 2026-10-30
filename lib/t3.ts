// Everything E9G Factory knows about T3 Code lives here: where its data is, the tables and columns it reads, the CLI
// commands it runs, the settings it writes and the tools the planner calls. T3 Code is a dependency, not a fork;
// when it updates, this is the one file to adjust. `e9g doctor` runs contract() against the installed T3 and
// refuses a version outside package.json's "e9g.t3code" range.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { releaseSlot, takeSlot } from "./lock.ts";
import { E9G_HOME, PACKAGE } from "./paths.ts";
import { writeFileAtomic } from "./util.ts";

export const T3_HOME = process.env.T3CODE_HOME ?? join(homedir(), ".t3");
export const DB = join(T3_HOME, "userdata", "statev2.sqlite");
export const SETTINGS = join(T3_HOME, "userdata", "settings.json");
// Where the server listens: T3 writes it in server-runtime.json when it starts (T3CODE_PORT moves it).
export function serverUrl(): string {
  try {
    const origin = (JSON.parse(readFileSync(join(T3_HOME, "userdata", "server-runtime.json"), "utf8")) as { origin?: unknown }).origin;
    if (typeof origin === "string" && /^https?:\/\/[^/]+$/.test(origin)) return `${origin}/`;
  } catch {}
  return "http://127.0.0.1:3773/";
}
export const SUPPORTED = PACKAGE.e9g.t3code;
export const TOOLS = { prefix: "mcp__t3-code__", delegate: "mcp__t3-code__delegate_task" };
export const worktreesDir = (checkout: string): string => join(T3_HOME, "worktrees", checkout.split("/").pop() ?? "");

// The parts of T3's settings.json the factory reads and writes. T3 defines the whole file with Effect schemas in
// packages/contracts/src/settings.ts and providerInstance.ts (not published to npm); everything else in the file is
// kept as it is.
export interface EnvironmentVariable {
  name: string;
  value: string;
  sensitive?: boolean;
}
export interface ProviderInstance {
  driver: string;
  displayName?: string;
  enabled?: boolean;
  environment?: EnvironmentVariable[];
  config?: { launchArgs?: string; autoCompactWindow?: string; [key: string]: unknown };
  [key: string]: unknown;
}
export interface ProjectScript {
  id: string;
  name: string;
  command: string;
  icon: string;
  runOnWorktreeCreate: boolean;
  async: boolean;
}
export interface T3Settings {
  providerInstances?: Record<string, ProviderInstance>;
  projectSettingsOverrides?: Record<string, Record<string, unknown>>;
  // The project scripts' older home, which T3 still keeps in step with projectSettingsOverrides (null: the defaults).
  projectScriptOverrides?: Record<string, ProjectScript[] | null>;
  projectSettingsFolded?: boolean;
  defaultProjectScripts?: ProjectScript[];
  [key: string]: unknown;
}

// A thread as `t3 thread show --json` prints it (the fields the factory reads).
export interface T3Thread {
  id?: string;
  title?: string;
  status?: string;
  archived?: boolean;
  updatedAt?: string;
  pendingRequestCount?: number;
  [key: string]: unknown;
}

// What the factory reads from T3's database. contract() checks these exist.
const COLUMNS: Record<string, string[]> = {
  orchestration_v2_projection_subagents: ["thread_id", "child_thread_id", "provider_instance_id", "status"],
  orchestration_v2_projection_threads: [
    "thread_id",
    "project_id",
    "provider_instance_id",
    "title",
    "payload_json",
    "created_at",
    "updated_at",
    "archived_at",
    "deleted_at",
  ],
  orchestration_v2_projection_provider_turns: ["thread_id", "started_at", "completed_at", "payload_json"],
  orchestration_v2_projection_runs: ["thread_id", "ordinal", "status"],
};
const RUNNING = "('running','starting','pending','queued','waiting')";
const STOPPED = "('interrupted','failed','cancelled')";
const q = (text: string): string => String(text).replaceAll("'", "''");
const ago = (minutes: number): string => `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${Number(minutes)} minutes')`;

// --- Version ----------------------------------------------------------------------------------------------

export function installedVersion(): string | null {
  const result = spawnSync("t3", ["--version"], { encoding: "utf8", timeout: 15_000 });
  const match = /(\d+\.\d+\.\d+)/.exec(`${result.stdout ?? ""}${result.stderr ?? ""}`);
  return match?.[1] ?? null;
}

// ">=0.1.2 <0.2.0": every comparator must hold.
export function satisfies(version: string, range = SUPPORTED): boolean {
  const parse = (v: string) => v.split(".").map(Number);
  const compare = (a: number[], b: number[]) => {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0);
    return 0;
  };
  return range.split(/\s+/).every((comparator) => {
    const [, op = "=", v] = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(comparator) ?? [];
    if (!v) return false;
    const c = compare(parse(version), parse(v));
    return { ">=": c >= 0, "<=": c <= 0, ">": c > 0, "<": c < 0, "=": c === 0 }[op] ?? false;
  });
}

// --- Database (read-only; unreadable reads as null, never as zero) ------------------------------------------

// Rows as sqlite3 -json prints them. The caller names the columns it selected.
export type Row = Record<string, string | number | null>;

export function query<T extends Row = Row>(sql: string): T[] | null {
  try {
    const out = execFileSync("sqlite3", ["-readonly", "-json", DB, sql], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
    return out.trim() ? (JSON.parse(out) as T[]) : [];
  } catch {
    return null;
  }
}

export function runningByInstance(ids: string[]): Record<string, number> | null {
  if (!ids.length) return {};
  const rows = query<{ instance: string; n: number }>(
    `select provider_instance_id as instance, count(*) as n from orchestration_v2_projection_subagents where status in ${RUNNING} and provider_instance_id in (${ids.map((id) => `'${q(id)}'`).join(",")}) group by 1`
  );
  if (!rows) return null;
  return Object.fromEntries(ids.map((id) => [id, rows.find((row) => row.instance === id)?.n ?? 0]));
}

// Whether a thread exists and is live, from the database: the CLI can fail for a moment, and a failed read must
// never look like a missing planner (that once started a second planner beside a live one).
export function threadExists(id: string): boolean | null {
  const rows = query<{ archived_at: string | null; deleted_at: string | null }>(
    `select archived_at, deleted_at from orchestration_v2_projection_threads where thread_id = '${q(id)}'`
  );
  if (rows === null) return null;
  const [row] = rows;
  return row !== undefined && !row.archived_at && !row.deleted_at;
}

// Live threads with this title started on an instance lately, newest first: a planner the watchdog started but didn't
// get an id back for. null when the database can't be read.
export const liveThreadsOn = (project: string, instance: string, title: string, sinceMin: number): string[] | null =>
  query<{ id: string }>(
    `select thread_id as id from orchestration_v2_projection_threads where project_id = '${q(project)}' and provider_instance_id = '${q(instance)}' and title = '${q(title)}' and archived_at is null and deleted_at is null and created_at >= ${ago(sinceMin)} order by created_at desc`
  )?.map((row) => row.id) ?? null;

export const runningChildren = (parent: string): number | null =>
  query<{ n: number }>(`select count(*) as n from orchestration_v2_projection_subagents where thread_id = '${q(parent)}' and status in ${RUNNING}`)?.[0]
    ?.n ?? null;

export const childCounts = (parent: string): { instance: string; n: number }[] =>
  query<{ instance: string; n: number }>(
    `select provider_instance_id as instance, count(*) as n from orchestration_v2_projection_subagents where thread_id = '${q(parent)}' and status in ${RUNNING} group by 1`
  ) ?? [];

export const quietChildren = (parent: string, quietMin: number): string[] =>
  (
    query<{ title: string }>(
      `select t.title from orchestration_v2_projection_subagents s join orchestration_v2_projection_threads t on t.thread_id = s.child_thread_id where s.status in ${RUNNING} and s.thread_id = '${q(parent)}' and t.updated_at < ${ago(quietMin)}`
    ) ?? []
  ).map((row) => row.title);

// Worktrees of the project's members that are done with them: every thread that used one finished long enough ago,
// completedAfterMin after it completed, and stoppedAfterMin after it was interrupted, failed or was cancelled (T3 can
// resume an interrupted thread, and a failed one is often retried in place). A member is a thread a planner started
// (a subagent row says how it ended) or one the watchdog started on a worker machine (on the team's own instances, its
// latest run says); a person's own threads in the project aren't. Whether a worktree still holds work is for the
// caller to check.
export const finishedWorktrees = (
  project: string,
  team: string,
  { completedAfterMin, stoppedAfterMin }: { completedAfterMin: number; stoppedAfterMin: number }
): string[] =>
  (
    query<{ path: string }>(
      `select json_extract(t.payload_json, '$.worktreePath') as path from orchestration_v2_projection_threads t left join orchestration_v2_projection_subagents s on s.child_thread_id = t.thread_id left join orchestration_v2_projection_runs r on r.thread_id = t.thread_id and r.ordinal = (select max(x.ordinal) from orchestration_v2_projection_runs x where x.thread_id = t.thread_id) where t.project_id = '${q(project)}' and json_extract(t.payload_json, '$.worktreePath') is not null and (s.child_thread_id is not null or t.provider_instance_id like 'e9g-${q(team)}-%') group by 1 having sum(case when coalesce(s.status, r.status) = 'completed' and t.updated_at < ${ago(completedAfterMin)} then 0 when coalesce(s.status, r.status) in ${STOPPED} and t.updated_at < ${ago(stoppedAfterMin)} then 0 else 1 end) = 0`
    ) ?? []
  ).map((row) => row.path);

// One row per turn (a planner wake or a child's task) with T3's token counts.
export interface Turn {
  instance: string;
  thread: string;
  started: string;
  completed: string | null;
  input: number | null;
  output: number | null;
  [column: string]: string | number | null;
}
export const turns = (project: string, since: string, until: string): Turn[] =>
  query<Turn>(`select t.provider_instance_id as instance, t.thread_id as thread, pt.started_at as started, pt.completed_at as completed,
      json_extract(pt.payload_json, '$.turnTokenUsage.inputTokens') as input,
      json_extract(pt.payload_json, '$.turnTokenUsage.outputTokens') as output
    from orchestration_v2_projection_threads t join orchestration_v2_projection_provider_turns pt on pt.thread_id = t.thread_id
    where t.project_id = '${q(project)}' and pt.started_at >= '${q(since)}' and pt.started_at < '${q(until)}'`) ?? [];

// --- CLI and server ---------------------------------------------------------------------------------------

function t3(args: string[], { timeoutMs = 60_000 } = {}): { ok: boolean; out: string; err: string } {
  const result = spawnSync("t3", args, { encoding: "utf8", timeout: timeoutMs });
  return { ok: result.status === 0, out: `${result.stdout ?? ""}`, err: `${result.stderr ?? ""}` };
}

export async function serverUp(timeoutMs = 5000): Promise<boolean> {
  try {
    const response = await fetch(serverUrl(), { signal: AbortSignal.timeout(timeoutMs) });
    return response.status < 500;
  } catch {
    return false;
  }
}
export const restartService = (): boolean =>
  t3(["service", "restart"], { timeoutMs: 120_000 }).ok || t3(["service", "install"], { timeoutMs: 120_000 }).ok;

export function threadShow(id: string): T3Thread | null {
  const result = t3(["thread", "show", id, "--json", "--messages", "0"]);
  if (!result.ok) return null;
  try {
    return (JSON.parse(result.out) as { thread?: T3Thread }).thread ?? null;
  } catch {
    return null;
  }
}

export function threadStart(
  project: string,
  prompt: string,
  { instance, model, title, worktree }: { instance: string; model: string; title: string; worktree?: string }
): { id: string | null; error?: string } {
  const result = t3([
    "thread",
    "start",
    project,
    prompt,
    "--provider",
    instance,
    "--model",
    model,
    "--title",
    title,
    ...(worktree ? ["--worktree", worktree] : []),
    "--json",
  ]);
  if (!result.ok) return { id: null, error: result.err.trim() };
  try {
    return { id: (JSON.parse(result.out) as { threadId?: string }).threadId ?? null };
  } catch {
    return { id: null, error: result.out.trim() };
  }
}

export const threadSend = (id: string, text: string): boolean => t3(["thread", "send", id, text]).ok;

export function projectAdd(title: string, dir: string): string | null {
  const result = t3(["project", "add", "--title", title, dir]);
  return /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(`${result.out}${result.err}`)?.[0] ?? null;
}

// --- Settings ---------------------------------------------------------------------------------------------

export const readSettings = (): T3Settings => JSON.parse(readFileSync(SETTINGS, "utf8")) as T3Settings;

const ofTeam = (entry: ProviderInstance | undefined, team: string): boolean =>
  (entry?.environment ?? []).some((variable) => variable.name === "E9G_TEAM" && variable.value === team);
export const SETUP_SCRIPT = "e9g-setup";

// The settings with the team's provider instances (those whose E9G_TEAM is the team) replaced, and the factory's
// own settings for the project. Everything of the person's own stays: their other instances, the project's other
// scripts, its default model and the global settings.
export function withTeam(
  settings: T3Settings,
  {
    team,
    instances,
    project,
    setup,
    branchPrefix,
  }: { team: string; instances: Record<string, ProviderInstance>; project: string; setup: string | null; branchPrefix: string }
): T3Settings {
  const next: T3Settings = structuredClone(settings);
  const previous = next.providerInstances ?? {};
  next.providerInstances = { ...Object.fromEntries(Object.entries(previous).filter(([, entry]) => !ofTeam(entry, team))), ...instances };
  const overrides: Record<string, unknown> = { ...(next.projectSettingsOverrides?.[project] ?? {}) };
  // Earlier versions made the planner the project's default model, so a thread opened by hand ran as a planner.
  const selection = overrides["defaultModelSelection"] as { instanceId?: unknown } | null | undefined;
  const id = typeof selection?.instanceId === "string" ? selection.instanceId : "";
  if (id && (Object.hasOwn(instances, id) || ofTeam(previous[id], team))) delete overrides["defaultModelSelection"];
  Object.assign(overrides, {
    defaultRuntimeMode: "full-access",
    defaultThreadEnvMode: "local",
    newWorktreesStartFromOrigin: false,
    branchNamingMode: "static",
    branchNamePrefix: branchPrefix,
    sidebarAutoSettleOnMerge: false,
    continueThreadsAfterServerUpdate: true,
    // The factory removes members' worktrees itself, keeping any that hold work no branch has (e9g status lists them).
    worktreeCleanup: { mode: "off" },
  });
  // The project's scripts as T3 resolves them (its own list, else the older per-project list, else the defaults),
  // with only the factory's entry changed.
  const legacy = next.projectSettingsFolded ? undefined : next.projectScriptOverrides?.[project];
  const scripts = (overrides["defaultProjectScripts"] as ProjectScript[] | undefined) ?? legacy ?? next.defaultProjectScripts ?? [];
  const ours: ProjectScript | null = setup
    ? { id: SETUP_SCRIPT, name: "Install dependencies", command: setup, icon: "configure", runOnWorktreeCreate: true, async: false }
    : null;
  const at = scripts.findIndex((script) => script.id === SETUP_SCRIPT);
  if (ours || at >= 0) {
    const others = scripts.filter((script) => script.id !== SETUP_SCRIPT);
    // In its old place, or first, so dependencies are installed before anything else runs in a new worktree.
    const changed = ours ? [...others.slice(0, Math.max(at, 0)), ours, ...others.slice(Math.max(at, 0))] : others;
    overrides["defaultProjectScripts"] = changed;
    next.projectScriptOverrides = { ...(next.projectScriptOverrides ?? {}), [project]: changed };
  }
  next.projectSettingsOverrides = { ...(next.projectSettingsOverrides ?? {}), [project]: overrides };
  return next;
}

// A read-modify-write of T3's settings: one e9g command at a time (a lock in ~/.e9g), and written only if T3 itself
// hasn't changed the file since it was read; otherwise the change is made again on what T3 wrote. A backup of the
// previous file stays beside it.
function updateSettings(change: (settings: T3Settings) => T3Settings): T3Settings {
  const slot = join(E9G_HOME, "locks", "t3-settings");
  const until = Date.now() + 30_000;
  let token = takeSlot(slot, "e9g: T3 Code's settings");
  while (!token && Date.now() < until) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    token = takeSlot(slot, "e9g: T3 Code's settings");
  }
  if (!token) throw new Error(`another e9g command held T3 Code's settings for 30 s (${slot}); try again`);
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const before = readFileSync(SETTINGS, "utf8");
      const next = change(JSON.parse(before) as T3Settings);
      if (readFileSync(SETTINGS, "utf8") !== before) continue;
      writeFileAtomic(`${SETTINGS}.bak-e9g`, before);
      writeFileAtomic(SETTINGS, `${JSON.stringify(next, null, 2)}\n`);
      // T3 Code reloads the file and may write its own copy at any moment: once it has had a moment, the change must
      // still be there (change is idempotent: applying it again changes nothing), or it's made again.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      const after = JSON.parse(readFileSync(SETTINGS, "utf8")) as T3Settings;
      if (isDeepStrictEqual(change(structuredClone(after)), after)) return next;
    }
    throw new Error(`T3 Code kept changing ${SETTINGS} while e9g wrote it; try again`);
  } finally {
    releaseSlot(slot, token);
  }
}

export function writeTeam(options: {
  team: string;
  instances: Record<string, ProviderInstance>;
  project: string;
  setup: string | null;
  branchPrefix: string;
}): void {
  updateSettings((settings) => withTeam(settings, options));
}

export function removeInstances(team: string): number {
  // Counted the first time: updateSettings applies the change again to check it held.
  let removed: number | null = null;
  updateSettings((settings) => {
    const before = settings.providerInstances ?? {};
    const providerInstances = Object.fromEntries(Object.entries(before).filter(([, entry]) => !ofTeam(entry, team)));
    removed ??= Object.keys(before).length - Object.keys(providerInstances).length;
    return { ...settings, providerInstances };
  });
  return removed ?? 0;
}

// A provider instance: one per role. T3 tokenises launchArgs with quotes, passes --append-system-prompt-file's
// text into the system prompt after its own runtime instructions, and the rest to Claude Code as flags.
export function instance({
  displayName,
  launchArgs,
  environment,
  compactAt,
}: {
  displayName: string;
  launchArgs: string;
  environment: Record<string, string | number>;
  compactAt?: number | null | undefined;
}): ProviderInstance {
  return {
    driver: "claudeAgent",
    displayName,
    enabled: true,
    environment: Object.entries(environment).map(([name, value]) => ({ name, value: String(value), sensitive: false })),
    config: { launchArgs, ...(compactAt ? { autoCompactWindow: String(compactAt) } : {}) },
  };
}

// --- Contract ---------------------------------------------------------------------------------------------

// What this version of the factory needs from T3 Code. Each problem is a sentence a person can act on.
export function contract(): string[] {
  const problems: string[] = [];
  const version = installedVersion();
  if (!version) return ["T3 Code's CLI (t3) isn't on PATH: install T3 Code (https://github.com/pingdotgg/t3code)"];
  if (!satisfies(version, SUPPORTED))
    problems.push(`T3 Code ${version} is outside the range this factory supports (${SUPPORTED}); upgrade E9G Factory, or adjust lib/t3.ts and the range`);
  if (!existsSync(DB)) problems.push(`T3 Code's database isn't at ${DB}`);
  else {
    for (const [table, columns] of Object.entries(COLUMNS)) {
      const rows = query<{ name: string }>(`pragma table_info(${table})`);
      if (!rows?.length) problems.push(`T3 Code's database has no ${table} table`);
      else for (const column of columns) if (!rows.some((row) => row.name === column)) problems.push(`T3 Code's ${table} has no ${column} column`);
    }
  }
  const help = t3(["thread", "--help"]).out;
  for (const command of ["start", "send", "show"]) if (!new RegExp(`\\b${command}\\b`).test(help)) problems.push(`t3 thread ${command} is missing`);
  if (!existsSync(SETTINGS)) problems.push(`T3 Code's settings aren't at ${SETTINGS}`);
  return problems;
}
