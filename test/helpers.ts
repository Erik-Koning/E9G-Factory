// Shared by the tests. Imported first, so E9G_HOME, T3CODE_HOME and HOME point at empty temporary folders before any of
// the factory's modules read them: no test touches ~/.e9g, ~/.t3, launchd or T3 Code's settings.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RawTeam } from "../lib/config.ts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const tmp = (prefix = "e9g-test-") => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

process.env.E9G_HOME = tmp("e9g-home-");
process.env.T3CODE_HOME = tmp("e9g-t3-");
// HOME too, for whatever resolves homedir(): ~/.local/bin, ~/Library/LaunchAgents, ~/.claude. Repositories made here
// set their own git identity, since a fresh HOME has no ~/.gitconfig.
process.env.HOME = tmp("e9g-user-");
for (const key of ["E9G_TEAM", "E9G_HOME_DIR", "E9G_RUN", "E9G_ROLE", "E9G_SETUP", "E9G_VERSION", "E9G_MERGE_QUEUED", "CLAUDE_PROJECT_DIR"])
  delete process.env[key];
// Stand-ins for t3, launchctl, docker, osascript and open first on PATH (test/fake-t3/), for the tests that run e9g
// without a machine of their own; and a T3 server address where nothing listens, since lib/t3.ts would otherwise try
// the real server's default port.
process.env.PATH = `${join(ROOT, "test", "fake-t3")}:${process.env.PATH ?? ""}`;
export const NO_SERVER = "http://127.0.0.1:1";
export const fakeT3Home = (dir: string): void => {
  mkdirSync(join(dir, "userdata"), { recursive: true });
  writeFileSync(join(dir, "userdata", "server-runtime.json"), JSON.stringify({ origin: NO_SERVER }));
};
fakeT3Home(process.env.T3CODE_HOME);

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export function write(dir: string, files: Record<string, unknown>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof text === "string" ? text : `${JSON.stringify(text, null, 2)}\n`);
  }
}

export const baseTeam = (overrides: RawTeam = {}): RawTeam => ({
  name: "fixture",
  title: "Fixture team",
  owner: "op@example.com",
  branch: "e9g/next",
  board: "files",
  roles: {
    planner: {},
    builder: { limit: 2, deny: ["^e2e/"] },
    reviewer: { limit: 1 },
    "ux-specialist": { limit: 1 },
    tester: { limit: 1, write: ["^e2e/"] },
  },
  gate: { full: "true", quick: "true" },
  ...overrides,
});

// A git repository on its integration branch with .e9g/team.json committed, like a team's checkout.
export function makeRepo(team: RawTeam = baseTeam(), files: Record<string, unknown> = {}): string {
  const dir = tmp("e9g-repo-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  write(dir, { "README.md": "fixture\n", "src/app.ts": "export const a = 1;\n", ".e9g/.gitignore": "run/\n", ".e9g/team.json": team, ...files });
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  git(dir, "checkout", "-q", "-b", team.branch ?? "e9g/next");
  return dir;
}

export function commit(dir: string, files: Record<string, unknown>, message = "change"): string {
  write(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", message);
  return git(dir, "rev-parse", "HEAD");
}

const GUARD = join(ROOT, "plugin", "hooks", "guard.ts");
// As plugin/hooks/hooks.json runs the hooks.
const HOOK_ENV = { NODE_COMPILE_CACHE: join(ROOT, ".cache"), E9G_NODE_CACHE: "1" };

export interface GuardOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  run?: string;
}
export type Outcome = { outcome: string; said: string };
// [home, role, tool, input, expected, options]: one call to the guard and what it must do.
export type GuardCase = [string, string, string, Record<string, unknown>, "allow" | "refuse", (GuardOptions | undefined)?];

const agentType = (role: string | null) => (role === null ? undefined : role.includes(":") || role === "Explore" ? role : `e9g:${role}`);

// Runs the guard the way Claude Code would, as one role of the team in `home`. Returns "allow", "refuse" or an error.
export function guard(
  home: string,
  role: string | null,
  tool: string,
  input: Record<string, unknown>,
  { env = {}, cwd = home, run = `${home}-run` }: GuardOptions = {}
): Outcome {
  const result = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({
      tool_name: tool,
      tool_input: input,
      agent_type: agentType(role),
      cwd,
      session_id: "test",
    }),
    env: { ...process.env, ...HOOK_ENV, E9G_TEAM: "fixture", E9G_HOME_DIR: home, E9G_RUN: run, E9G_ROLE: role ?? "", CLAUDE_PROJECT_DIR: cwd, ...env },
    encoding: "utf8",
  });
  return { outcome: result.status === 2 ? "refuse" : result.status === 0 ? "allow" : `error ${result.status}: ${result.stderr}`, said: result.stderr };
}

// The same, without waiting: tests run many guard cases at once, since each is a fresh node process.
export function guardAsync(
  home: string,
  role: string,
  tool: string,
  input: Record<string, unknown>,
  { env = {}, cwd = home, run = `${home}-run` }: GuardOptions = {}
): Promise<Outcome> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [GUARD], {
      env: { ...process.env, ...HOOK_ENV, E9G_TEAM: "fixture", E9G_HOME_DIR: home, E9G_RUN: run, E9G_ROLE: role ?? "", CLAUDE_PROJECT_DIR: cwd, ...env },
    });
    let said = "";
    child.stderr.on("data", (chunk: Buffer) => (said += chunk));
    child.on("close", (code) => done({ outcome: code === 2 ? "refuse" : code === 0 ? "allow" : `error ${code}: ${said}`, said }));
    child.stdin.end(
      JSON.stringify({
        tool_name: tool,
        tool_input: input,
        agent_type: agentType(role),
        cwd,
        session_id: "test",
      })
    );
  });
}

// Runs [home, role, tool, input, expected, options] cases a few at a time; returns the ones that came out wrong.
export async function guardAll(cases: GuardCase[], width = 8): Promise<string[]> {
  const wrong: string[] = [];
  for (let i = 0; i < cases.length; i += width) {
    const batch = cases.slice(i, i + width);
    const results = await Promise.all(batch.map(([home, role, tool, input, , options]) => guardAsync(home, role, tool, input, options)));
    results.forEach(({ outcome, said }, j) => {
      const [, role, tool, input, expected] = batch[j] as GuardCase;
      if (outcome !== expected) wrong.push(`${role} ${tool} ${JSON.stringify(input)}: expected ${expected}, got ${outcome} ${said}`.trim());
    });
  }
  return wrong;
}

// Case builders for guardAll, and the assertion that every case comes out as expected.
export const bash = (home: string, role: string, command: string, expected: GuardCase[4], options?: GuardOptions): GuardCase => [
  home,
  role,
  "Bash",
  { command },
  expected,
  options,
];
export const tool = (
  home: string,
  role: string,
  name: string,
  input: Record<string, unknown>,
  expected: GuardCase[4],
  options?: GuardOptions
): GuardCase => [home, role, name, input, expected, options];
export const holds = async (cases: GuardCase[]): Promise<void> => assert.deepEqual(await guardAll(cases), []);

export const E9G = join(ROOT, "bin", "e9g.ts");
export function e9g(
  args: string[],
  { cwd, env = {}, input }: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}
): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [E9G, ...args], { env: { ...process.env, ...HOOK_ENV, ...env }, ...(cwd === undefined ? {} : { cwd }) });
    let out = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk: Buffer) => (out += chunk));
    child.on("close", (code) => done({ code, out }));
    if (input !== undefined) child.stdin.end(input);
  });
}

// A machine of its own, for anything that installs, runs the launcher or runs doctor: HOME, E9G_HOME and T3CODE_HOME
// in a temporary folder (T3's server address where nothing listens), and a PATH whose t3, launchctl, claude and gh are
// stand-ins. node is there under a name of its own (like Homebrew's /opt/homebrew/bin/node).
export function machine({ e9gHome }: { e9gHome?: string } = {}) {
  const root = tmp("e9g-machine-");
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin);
  const stub = (name: string, script: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub("t3", 'case "$1 $2" in "--version "*) echo 0.1.5 ;; "thread --help") echo "start send show" ;; *) exit 1 ;; esac');
  stub("launchctl", "exit 1");
  stub("claude", 'echo "2.1.300 (Claude Code)"');
  stub("gh", "exit 1");
  symlinkSync(process.execPath, join(bin, "node"));
  fakeT3Home(join(home, ".t3"));
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    E9G_HOME: e9gHome ?? join(home, ".e9g"),
    T3CODE_HOME: join(home, ".t3"),
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
  };
  return { root, home, bin, env, e9gHome: env.E9G_HOME as string, launcher: join(home, ".local", "bin", "e9g") };
}

// A repository with one commit on main, and an identity of its own (a test HOME has no ~/.gitconfig).
export function gitRepo(dir: string, files: Record<string, unknown> = {}): string {
  write(dir, files);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

// A clone of this checkout (its files as they are now), optionally as another version, to install from.
export function sourceCopy(version?: string): string {
  const dir = join(tmp("e9g-source-"), "E9G-Factory");
  for (const file of git(ROOT, "ls-files", "-co", "--exclude-standard").split("\n").filter(Boolean)) {
    const from = join(ROOT, file);
    if (!existsSync(from) || !lstatSync(from).isFile()) continue;
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    cpSync(from, join(dir, file));
  }
  // As in a worktree whose dependencies are linked in: a symlink self-install must skip.
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  if (version)
    for (const file of ["package.json", "plugin/.claude-plugin/plugin.json"]) {
      const json = JSON.parse(readFileSync(join(dir, file), "utf8")) as { version: string };
      json.version = version;
      writeFileSync(join(dir, file), `${JSON.stringify(json, null, 2)}\n`);
    }
  gitRepo(dir);
  return dir;
}
