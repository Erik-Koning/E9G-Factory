// Shared by the tests. Imported first, so E9G_HOME and T3CODE_HOME point at empty temporary folders before any of
// the factory's modules read them: no test touches ~/.e9g, ~/.t3, launchd or T3 Code's settings.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const tmp = (prefix = "e9g-test-") => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

process.env.E9G_HOME = tmp("e9g-home-");
process.env.T3CODE_HOME = tmp("e9g-t3-");
for (const key of ["E9G_TEAM", "E9G_HOME_DIR", "E9G_RUN", "E9G_ROLE", "E9G_SETUP", "E9G_VERSION", "E9G_MERGE_QUEUED", "CLAUDE_PROJECT_DIR"])
  delete process.env[key];

export const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export function write(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof text === "string" ? text : `${JSON.stringify(text, null, 2)}\n`);
  }
}

export const baseTeam = (overrides = {}) => ({
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
export function makeRepo(team = baseTeam(), files = {}) {
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

export function commit(dir, files, message = "change") {
  write(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", message);
  return git(dir, "rev-parse", "HEAD");
}

const GUARD = join(ROOT, "plugin", "hooks", "guard.mjs");

// Runs the guard the way Claude Code would, as one role of the team in `home`. Returns "allow", "refuse" or an error.
export function guard(home, role, tool, input, { env = {}, cwd = home, run = `${home}-run` } = {}) {
  const result = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({
      tool_name: tool,
      tool_input: input,
      agent_type: role === null ? undefined : role.includes(":") || role === "Explore" ? role : `e9g:${role}`,
      cwd,
      session_id: "test",
    }),
    env: { ...process.env, E9G_TEAM: "fixture", E9G_HOME_DIR: home, E9G_RUN: run, E9G_ROLE: role ?? "", CLAUDE_PROJECT_DIR: cwd, ...env },
    encoding: "utf8",
  });
  return { outcome: result.status === 2 ? "refuse" : result.status === 0 ? "allow" : `error ${result.status}: ${result.stderr}`, said: result.stderr };
}

// The same, without waiting: tests run many guard cases at once, since each is a fresh node process.
export function guardAsync(home, role, tool, input, { env = {}, cwd = home, run = `${home}-run` } = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [GUARD], {
      env: { ...process.env, E9G_TEAM: "fixture", E9G_HOME_DIR: home, E9G_RUN: run, E9G_ROLE: role ?? "", CLAUDE_PROJECT_DIR: cwd, ...env },
    });
    let said = "";
    child.stderr.on("data", (chunk) => (said += chunk));
    child.on("close", (code) => done({ outcome: code === 2 ? "refuse" : code === 0 ? "allow" : `error ${code}: ${said}`, said }));
    child.stdin.end(
      JSON.stringify({
        tool_name: tool,
        tool_input: input,
        agent_type: role.includes(":") || role === "Explore" ? role : `e9g:${role}`,
        cwd,
        session_id: "test",
      })
    );
  });
}

// Runs [home, role, tool, input, expected, options] cases a few at a time; returns the ones that came out wrong.
export async function guardAll(cases, width = 8) {
  const wrong = [];
  for (let i = 0; i < cases.length; i += width) {
    const batch = cases.slice(i, i + width);
    const results = await Promise.all(batch.map(([home, role, tool, input, , options]) => guardAsync(home, role, tool, input, options)));
    results.forEach(({ outcome, said }, j) => {
      const [, role, tool, input, expected] = batch[j];
      if (outcome !== expected) wrong.push(`${role} ${tool} ${JSON.stringify(input)}: expected ${expected}, got ${outcome} ${said}`.trim());
    });
  }
  return wrong;
}

export const E9G = join(ROOT, "bin", "e9g.mjs");
export function e9g(args, { cwd, env = {} } = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [E9G, ...args], { cwd, env: { ...process.env, ...env } });
    let out = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => (out += chunk));
    child.on("close", (code) => done({ code, out }));
  });
}
