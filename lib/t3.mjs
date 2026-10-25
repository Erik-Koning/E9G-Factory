// Everything E9G Factory knows about T3 Code lives here: where its data is, the tables and columns it reads, the CLI
// commands it runs, the settings it writes and the tools the planner calls. T3 Code is a dependency, not a fork;
// when it updates, this is the one file to adjust. `e9g doctor` runs contract() against the installed T3 and
// refuses a version outside package.json's "e9g.t3code" range.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PACKAGE } from "./paths.mjs";
import { writeJson } from "./util.mjs";

export const T3_HOME = process.env.T3CODE_HOME ?? join(homedir(), ".t3");
export const DB = join(T3_HOME, "userdata", "statev2.sqlite");
export const SETTINGS = join(T3_HOME, "userdata", "settings.json");
export const SERVER = "http://127.0.0.1:3773/";
export const SUPPORTED = PACKAGE.e9g.t3code;
export const TOOLS = { prefix: "mcp__t3-code__", delegate: "mcp__t3-code__delegate_task" };
export const worktreesDir = (checkout) => join(T3_HOME, "worktrees", checkout.split("/").pop());

// What the factory reads from T3's database. contract() checks these exist.
const COLUMNS = {
  orchestration_v2_projection_subagents: ["thread_id", "child_thread_id", "provider_instance_id", "status"],
  orchestration_v2_projection_threads: ["thread_id", "project_id", "provider_instance_id", "title", "payload_json", "updated_at"],
  orchestration_v2_projection_provider_turns: ["thread_id", "started_at", "completed_at", "payload_json"],
};
const RUNNING = "('running','starting','pending','queued','waiting')";
const FINISHED = "('completed','interrupted','failed','cancelled')";
const q = (text) => String(text).replaceAll("'", "''");

// --- Version ----------------------------------------------------------------------------------------------

export function installedVersion() {
  const result = spawnSync("t3", ["--version"], { encoding: "utf8", timeout: 15_000 });
  const match = /(\d+\.\d+\.\d+)/.exec(`${result.stdout ?? ""}${result.stderr ?? ""}`);
  return match ? match[1] : null;
}

// ">=0.1.2 <0.2.0": every comparator must hold.
export function satisfies(version, range = SUPPORTED) {
  const parse = (v) => v.split(".").map(Number);
  const compare = (a, b) => {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  };
  return range.split(/\s+/).every((comparator) => {
    const [, op, v] = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(comparator) ?? [];
    if (!v) return false;
    const c = compare(parse(version), parse(v));
    return { ">=": c >= 0, "<=": c <= 0, ">": c > 0, "<": c < 0, "=": c === 0, undefined: c === 0 }[op];
  });
}

// --- Database (read-only; unreadable reads as null, never as zero) ------------------------------------------

export function query(sql) {
  try {
    const out = execFileSync("sqlite3", ["-readonly", "-json", DB, sql], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
    return out.trim() ? JSON.parse(out) : [];
  } catch {
    return null;
  }
}

export function runningByInstance(ids) {
  if (!ids.length) return {};
  const rows = query(
    `select provider_instance_id as instance, count(*) as n from orchestration_v2_projection_subagents where status in ${RUNNING} and provider_instance_id in (${ids.map((id) => `'${q(id)}'`).join(",")}) group by 1`
  );
  if (!rows) return null;
  return Object.fromEntries(ids.map((id) => [id, rows.find((row) => row.instance === id)?.n ?? 0]));
}

// Whether a thread exists and is live, from the database: the CLI can fail for a moment, and a failed read must
// never look like a missing planner (that once started a second planner beside a live one).
export function threadExists(id) {
  const rows = query(`select archived_at, deleted_at from orchestration_v2_projection_threads where thread_id = '${q(id)}'`);
  if (rows === null) return null;
  return rows.length > 0 && !rows[0].archived_at && !rows[0].deleted_at;
}

export const runningChildren = (parent) =>
  query(`select count(*) as n from orchestration_v2_projection_subagents where thread_id = '${q(parent)}' and status in ${RUNNING}`)?.[0]?.n ?? null;

export const childCounts = (parent) =>
  query(
    `select provider_instance_id as instance, count(*) as n from orchestration_v2_projection_subagents where thread_id = '${q(parent)}' and status = 'running' group by 1`
  ) ?? [];

export const quietChildren = (parent, quietMin) =>
  (
    query(
      `select t.title from orchestration_v2_projection_subagents s join orchestration_v2_projection_threads t on t.thread_id = s.child_thread_id where s.status = 'running' and s.thread_id = '${q(parent)}' and t.updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${Number(quietMin)} minutes')`
    ) ?? []
  ).map((row) => row.title);

// Worktrees of the project's children that finished more than afterMin minutes ago, unless another thread still
// uses the same worktree.
export const finishedWorktrees = (project, afterMin) =>
  (
    query(
      `select distinct json_extract(t.payload_json, '$.worktreePath') as path from orchestration_v2_projection_threads t join orchestration_v2_projection_subagents s on s.child_thread_id = t.thread_id where t.project_id = '${q(project)}' and s.status in ${FINISHED} and t.updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${Number(afterMin)} minutes') and json_extract(t.payload_json, '$.worktreePath') is not null and not exists (select 1 from orchestration_v2_projection_threads o where o.thread_id != t.thread_id and json_extract(o.payload_json, '$.worktreePath') = json_extract(t.payload_json, '$.worktreePath') and o.updated_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${Number(afterMin)} minutes'))`
    ) ?? []
  ).map((row) => row.path);

// One row per turn (a planner wake or a child's task) with T3's token counts.
export const turns = (project, since, until) =>
  query(`select t.provider_instance_id as instance, t.thread_id as thread, pt.started_at as started, pt.completed_at as completed,
      json_extract(pt.payload_json, '$.turnTokenUsage.inputTokens') as input,
      json_extract(pt.payload_json, '$.turnTokenUsage.outputTokens') as output
    from orchestration_v2_projection_threads t join orchestration_v2_projection_provider_turns pt on pt.thread_id = t.thread_id
    where t.project_id = '${q(project)}' and pt.started_at >= '${q(since)}' and pt.started_at < '${q(until)}'`) ?? [];

// --- CLI and server ---------------------------------------------------------------------------------------

function t3(args, { timeoutMs = 60_000 } = {}) {
  const result = spawnSync("t3", args, { encoding: "utf8", timeout: timeoutMs });
  return { ok: result.status === 0, out: `${result.stdout ?? ""}`, err: `${result.stderr ?? ""}` };
}

export async function serverUp() {
  try {
    const response = await fetch(SERVER, { signal: AbortSignal.timeout(5000) });
    return response.status < 500;
  } catch {
    return false;
  }
}
export const restartService = () => t3(["service", "restart"], { timeoutMs: 120_000 }).ok || t3(["service", "install"], { timeoutMs: 120_000 }).ok;

export function threadShow(id) {
  const result = t3(["thread", "show", id, "--json", "--messages", "0"]);
  if (!result.ok) return null;
  try {
    return JSON.parse(result.out).thread ?? null;
  } catch {
    return null;
  }
}

export function threadStart(project, prompt, { instance, model, title }) {
  const result = t3(["thread", "start", project, prompt, "--provider", instance, "--model", model, "--title", title, "--json"]);
  if (!result.ok) return { id: null, error: result.err.trim() };
  try {
    return { id: JSON.parse(result.out).threadId ?? null };
  } catch {
    return { id: null, error: result.out.trim() };
  }
}

export const threadSend = (id, text) => t3(["thread", "send", id, text]).ok;

export function projectAdd(title, dir) {
  const result = t3(["project", "add", "--title", title, dir]);
  return /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(`${result.out}${result.err}`)?.[0] ?? null;
}

// --- Settings ---------------------------------------------------------------------------------------------

export const readSettings = () => JSON.parse(readFileSync(SETTINGS, "utf8"));

// Replaces the team's provider instances (every id starting with prefix) and the project's settings and setup
// script, keeping a backup of the previous file beside it.
export function writeTeam({ prefix, instances, project, setup, plannerInstance, model, branchPrefix }) {
  const settings = readSettings();
  copyFileSync(SETTINGS, `${SETTINGS}.bak-e9g`);
  const kept = Object.fromEntries(Object.entries(settings.providerInstances ?? {}).filter(([id]) => !id.startsWith(prefix)));
  settings.providerInstances = { ...kept, ...instances };
  const script = setup
    ? [{ id: "e9g-setup", name: "Install dependencies", command: setup, icon: "configure", runOnWorktreeCreate: true, async: false }]
    : [];
  settings.projectSettingsOverrides ??= {};
  settings.projectSettingsOverrides[project] = {
    ...(settings.projectSettingsOverrides[project] ?? {}),
    defaultModelSelection: { instanceId: plannerInstance, model },
    defaultRuntimeMode: "full-access",
    defaultThreadEnvMode: "local",
    newWorktreesStartFromOrigin: false,
    branchNamingMode: "static",
    branchNamePrefix: branchPrefix,
    sidebarAutoSettleOnMerge: false,
    continueThreadsAfterServerUpdate: true,
    defaultProjectScripts: script,
  };
  settings.projectScriptOverrides ??= {};
  settings.projectScriptOverrides[project] = script;
  settings.autoResumeLimitedThreads = true;
  writeJson(SETTINGS, settings);
}

export function removeInstances(prefix) {
  const settings = readSettings();
  const before = Object.keys(settings.providerInstances ?? {}).length;
  settings.providerInstances = Object.fromEntries(Object.entries(settings.providerInstances ?? {}).filter(([id]) => !id.startsWith(prefix)));
  copyFileSync(SETTINGS, `${SETTINGS}.bak-e9g`);
  writeJson(SETTINGS, settings);
  return before - Object.keys(settings.providerInstances).length;
}

// A provider instance: one per role. T3 tokenises launchArgs with quotes, passes --append-system-prompt-file's
// text into the system prompt after its own runtime instructions, and the rest to Claude Code as flags.
export function instance({ displayName, launchArgs, environment, compactAt }) {
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
export function contract() {
  const problems = [];
  const version = installedVersion();
  if (!version) return ["T3 Code's CLI (t3) isn't on PATH: install T3 Code (https://github.com/pingdotgg/t3code)"];
  if (!satisfies(version, SUPPORTED))
    problems.push(`T3 Code ${version} is outside the range this factory supports (${SUPPORTED}); upgrade E9G Factory, or adjust lib/t3.mjs and the range`);
  if (!existsSync(DB)) problems.push(`T3 Code's database isn't at ${DB}`);
  else {
    for (const [table, columns] of Object.entries(COLUMNS)) {
      const rows = query(`pragma table_info(${table})`);
      if (!rows?.length) problems.push(`T3 Code's database has no ${table} table`);
      else for (const column of columns) if (!rows.some((row) => row.name === column)) problems.push(`T3 Code's ${table} has no ${column} column`);
    }
  }
  const help = t3(["thread", "--help"]).out;
  for (const command of ["start", "send", "show"]) if (!new RegExp(`\\b${command}\\b`).test(help)) problems.push(`t3 thread ${command} is missing`);
  if (!existsSync(SETTINGS)) problems.push(`T3 Code's settings aren't at ${SETTINGS}`);
  return problems;
}
