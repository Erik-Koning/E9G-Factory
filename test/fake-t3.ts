// A throwaway T3 Code and E9G home for the watchdog, rotate, register and upgrade: a fake `t3`, `osascript`,
// `launchctl`, `docker` and `open` first on PATH (test/fake-t3/), a T3 database with the tables the factory reads,
// a server that answers while a flag file exists, and a registered team. Nothing touches ~/.t3, ~/.e9g or launchd.
import { baseTeam, e9g, git, makeRepo, ROOT, tmp } from "./helpers.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, join } from "node:path";
import type { RawTeam } from "../lib/config.ts";
import type { RegistryEntry } from "../lib/paths.ts";

const BIN = join(ROOT, "test", "fake-t3");

export interface World {
  root: string;
  home: string;
  run: string;
  e9gHome: string;
  t3Home: string;
  db: string;
  worktreesDir: string;
  env: NodeJS.ProcessEnv;
  sql: (text: string) => string;
  thread: (row: { id: string; instance: string; title?: string; worktreePath?: string | null; createdMin?: number; updatedMin?: number }) => void;
  child: (row: { parent: string; id: string; instance: string; status: string; worktreePath?: string | null; updatedMin?: number }) => void;
  worktree: (name: string, branch: string) => string;
  show: (thread: Record<string, unknown>) => void;
  calls: () => string[];
  setUp: (up: boolean) => void;
  e9g: (...args: string[]) => Promise<{ code: number | null; out: string }>;
  close: () => Promise<void>;
}

const ago = (min: number): string => new Date(Date.now() - min * 60_000).toISOString();

export async function fakeWorld(team: RawTeam = baseTeam(), { register = true }: { register?: boolean } = {}): Promise<World> {
  const root = tmp("e9g-world-");
  const e9gHome = join(root, "e9g");
  const t3Home = join(root, "t3");
  const run = join(e9gHome, "runs", team.name ?? "fixture");
  for (const dir of [join(t3Home, "userdata"), join(e9gHome, "teams"), run, join(root, "home")]) mkdirSync(dir, { recursive: true });
  const db = join(t3Home, "userdata", "statev2.sqlite");
  execFileSync("sqlite3", [db], { input: readFileSync(join(BIN, "schema.sql"), "utf8") });
  writeFileSync(join(t3Home, "userdata", "settings.json"), "{}\n");

  // T3's server answers while `up` exists; the fake `t3 service restart` creates it.
  const up = join(root, "t3-up");
  writeFileSync(up, "");
  const server = createServer((_, response) => {
    response.statusCode = existsSync(up) ? 200 : 503;
    response.end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  writeFileSync(join(t3Home, "userdata", "server-runtime.json"), JSON.stringify({ origin: `http://127.0.0.1:${port}` }));

  const home = makeRepo(team);
  const worktreesDir = join(t3Home, "worktrees", basename(home));
  if (register) {
    const entry: RegistryEntry = {
      name: team.name ?? "fixture",
      title: team.title ?? "Fixture team",
      home,
      run,
      project: "proj-1",
      version: "dev",
      plannerInstance: `e9g-${team.name ?? "fixture"}-planner`,
      model: "m",
      health: [],
      needsDocker: false,
      worktreesDir,
      watchdog: { tickEveryMin: 10, stuckAfterMin: 45, pruneAfterMin: 60, doneTickEveryMin: 1440 },
      startPrompt: "go",
      registeredAt: new Date().toISOString(),
    };
    writeFileSync(join(e9gHome, "teams", `${entry.name}.json`), JSON.stringify(entry));
  }
  const log = join(root, "t3.log");
  const showFile = join(root, "show.json");
  const show = (thread: Record<string, unknown>) => writeFileSync(showFile, JSON.stringify({ thread }));
  show({ status: "idle", updatedAt: new Date().toISOString(), pendingRequestCount: 0 });
  const env: NodeJS.ProcessEnv = {
    HOME: join(root, "home"),
    E9G_HOME: e9gHome,
    T3CODE_HOME: t3Home,
    PATH: `${BIN}:${process.env.PATH}`,
    FAKE_T3_LOG: log,
    FAKE_T3_SHOW: showFile,
    FAKE_T3_UP: up,
  };
  const sql = (text: string) => execFileSync("sqlite3", [db, text], { encoding: "utf8" });
  let n = 0;
  const thread: World["thread"] = ({ id, instance, title = id, worktreePath = null, createdMin = 120, updatedMin = 120 }) => {
    sql(
      `insert into orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, archived_at, payload_json, provider_instance_id) values ('${id}', 'proj-1', '${title}', 'claudeAgent', 'full-access', 'default', '${ago(createdMin)}', '${ago(updatedMin)}', null, '${JSON.stringify({ worktreePath })}', '${instance}')`
    );
  };
  const child: World["child"] = ({ parent, id, instance, status, worktreePath = null, updatedMin = 120 }) => {
    thread({ id, instance, worktreePath, updatedMin });
    sql(
      `insert into orchestration_v2_projection_subagents (subagent_id, thread_id, parent_node_id, provider, child_thread_id, origin, status, updated_at, payload_json, provider_instance_id) values ('sa-${++n}', '${parent}', 'node', 'claudeAgent', '${id}', 'mcp', '${status}', '${ago(updatedMin)}', '{}', '${instance}')`
    );
  };
  const worktree = (name: string, branch: string): string => {
    const path = join(worktreesDir, name);
    mkdirSync(worktreesDir, { recursive: true });
    git(home, "worktree", "add", "-q", "-b", branch, path, team.branch ?? "e9g/next");
    return path;
  };
  return {
    root,
    home,
    run,
    e9gHome,
    t3Home,
    db,
    worktreesDir,
    env,
    sql,
    thread,
    child,
    worktree,
    show,
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []),
    setUp: (on) => (on ? writeFileSync(up, "") : rmSync(up, { force: true })),
    e9g: (...args) => e9g(args, { cwd: root, env }),
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
