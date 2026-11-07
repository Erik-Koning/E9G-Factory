// Regressions from the independent review before 0.2.0 was published: each test is one finding.
import { baseTeam, bash, commit, a6g, git, holds, makeRepo, tmp, tool, write } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

const merge = (home: string, ...args: string[]) => a6g(["merge", ...args], { cwd: home, env: { A6G_HOME_DIR: home } });
const approve = (home: string, branch: string) =>
  a6g(["verdict", "review", branch, "approve", "--sha", git(home, "rev-parse", branch), "--risk", "low", "--note", "ok"], {
    cwd: home,
    env: { A6G_HOME_DIR: home, A6G_TEAM: "fixture", A6G_ROLE: "reviewer" },
  });
const record = (home: string, branch: string): { message: string } =>
  JSON.parse(readFileSync(join(home, ".a6g/run/state/merges", `${branch.replaceAll("/", "_")}.json`), "utf8"));

describe("the review's findings stay fixed", { concurrency: true }, () => {
  test("ordinary searches and branch names aren't read as writes", () => {
    const home = makeRepo(baseTeam({ roles: { planner: {}, builder: { limit: 2 }, reviewer: { limit: 1 }, tester: { limit: 1, write: ["^e2e/"] } } }));
    return holds([
      bash(home, "reviewer", 'grep -rn "</Link>" src/', "allow"),
      bash(home, "reviewer", "rg '<h1>' src", "allow"),
      bash(home, "reviewer", "awk '$3 > 100' README.md", "allow"),
      bash(home, "reviewer", 'grep "=> {" src/app.ts', "allow"),
      bash(home, "reviewer", "cd /tmp && git -C . log > /tmp/a6g-log.txt", "allow"),
      bash(home, "tester", "git checkout -b a6g/t-login", "allow"),
      bash(home, "tester", "git checkout -- src/app.ts", "refuse"),
    ]);
  });

  test("a member's shell can't write the team's checkout from its worktree", () => {
    const home = makeRepo();
    const worktree = join(tmp("a6g-wt-"), "b2");
    git(home, "worktree", "add", "-q", "-b", "a6g/b2-x", worktree, "a6g/next");
    const inWorktree = { cwd: worktree };
    return holds([
      bash(home, "builder", `echo '{}' > ${join(home, ".a6g/team.json")}`, "refuse", inWorktree),
      bash(home, "builder", `cp README.md ${join(home, ".claude/settings.json")}`, "refuse", inWorktree),
      bash(home, "builder", `echo x > ${join(home, "src/app.ts")}`, "refuse", inWorktree),
      bash(home, "builder", "echo x > src/app.ts", "allow", inWorktree),
      bash(home, "builder", `echo x > ${join(home, ".a6g/run/board/f-20260101-0000-x.md")}`, "allow", inWorktree),
    ]);
  });

  test("secrets: no writing env files, no recursive grep over them, example files are fine", () => {
    const home = makeRepo(baseTeam(), { ".env.example": "A=\n", "src/lib/secrets/index.ts": "export {};\n" });
    const plain = makeRepo();
    writeFileSync(join(home, ".env"), "STRIPE=sk_test\n");
    return holds([
      tool(home, "builder", "Write", { file_path: join(home, ".env.local") }, "refuse"),
      bash(home, "builder", "grep -rn STRIPE .", "refuse"),
      bash(home, "builder", "rg -n STRIPE .", "allow"),
      bash(plain, "builder", "grep -rn STRIPE .", "allow"),
      tool(home, "builder", "Read", { file_path: join(home, "src/lib/secrets/index.ts") }, "allow"),
      tool(home, "builder", "Read", { file_path: join(home, ".env.local.example") }, "allow"),
      bash(home, "builder", "cat .env.local.example", "allow"),
      bash(home, "builder", "cat .env", "refuse"),
    ]);
  });

  test("a subagent never gets more than its member, whatever its agent type", () => {
    const home = makeRepo();
    const asBuilder = { env: { A6G_ROLE: "builder" } };
    return holds([
      bash(home, "a6g:planner", "a6g merge a6g/b1-x", "refuse", asBuilder),
      tool(home, "a6g:planner", "Write", { file_path: join(home, ".a6g/lessons.md") }, "refuse", asBuilder),
      tool(home, "a6g:planner", "mcp__t3-code__delegate_task", { target: { providerInstanceId: "a6g-fixture-builder" } }, "refuse", asBuilder),
    ]);
  });

  test("the merge command itself refuses anyone but the planner", async () => {
    const home = makeRepo();
    const result = await a6g(["merge", "a6g/b1-x"], { cwd: home, env: { A6G_HOME_DIR: home, A6G_TEAM: "fixture", A6G_ROLE: "builder" } });
    assert.equal(result.code, 2);
    assert.match(result.out, /only the planner merges/);
  });

  test("--rebased-from refuses a branch with merge commits", async () => {
    const home = makeRepo();
    git(home, "checkout", "-q", "-b", "a6g/b3-x");
    const approved = commit(home, { "src/x.ts": "export const x = 1;\n" });
    git(home, "checkout", "-q", "a6g/next");
    assert.equal((await approve(home, "a6g/b3-x")).code, 0);
    commit(home, { "README.md": "moved on\n" }, "next moves");
    // "Rebase" by merging next in, with extra code hidden in the merge commit.
    git(home, "checkout", "-q", "a6g/b3-x");
    git(home, "merge", "--no-commit", "-q", "a6g/next");
    write(home, { "src/unreviewed.ts": "export const evil = 1;\n" });
    git(home, "add", "-A");
    git(home, "commit", "-qm", "merge next");
    git(home, "checkout", "-q", "a6g/next");
    const result = await merge(home, "a6g/b3-x", "--rebased-from", approved);
    assert.equal(result.code, 2, result.out);
    assert.match(record(home, "a6g/b3-x").message, /merge commits/);
  });

  test("a rename can't hide a deletion outside the lane", async () => {
    const home = makeRepo(baseTeam({ roles: { planner: {}, builder: { limit: 1 }, reviewer: { limit: 1 }, tester: { limit: 1, write: ["^e2e/"] } } }));
    git(home, "checkout", "-q", "-b", "a6g/t-move");
    mkdirSync(join(home, "e2e"), { recursive: true });
    git(home, "mv", "src/app.ts", "e2e/app.spec.ts");
    git(home, "commit", "-qm", "move");
    git(home, "checkout", "-q", "a6g/next");
    const result = await merge(home, "a6g/t-move");
    assert.equal(result.code, 2, result.out);
    assert.match(record(home, "a6g/t-move").message, /outside its lane: .*src\/app\.ts/);
  });

  test("a checkout that moved off the integration branch during the gate gets nothing merged", async () => {
    const home = makeRepo(baseTeam({ gate: { full: 'git -C "$A6G_HOME_DIR" checkout -q main' } }));
    git(home, "checkout", "-q", "-b", "a6g/b4-x");
    commit(home, { "src/four.ts": "export const four = 4;\n" });
    git(home, "checkout", "-q", "a6g/next");
    await approve(home, "a6g/b4-x");
    const next = git(home, "rev-parse", "a6g/next");
    const main = git(home, "rev-parse", "main");
    const result = await merge(home, "a6g/b4-x");
    assert.equal(result.code, 2, result.out);
    assert.equal(git(home, "rev-parse", "a6g/next"), next);
    assert.equal(git(home, "rev-parse", "main"), main);
  });

  test("registering one team keeps another team's instances, even with a longer name", async () => {
    const { writeTeam, readSettings, SETTINGS } = await import("../lib/t3.ts");
    const of = (team: string, role: string) => ({
      driver: "claudeAgent",
      environment: [{ name: "A6G_TEAM", value: team }],
      config: { launchArgs: `--agent a6g:${role}` },
    });
    mkdirSync(join(SETTINGS, ".."), { recursive: true });
    writeFileSync(
      SETTINGS,
      JSON.stringify({
        providerInstances: { "a6g-app-planner": of("app", "planner"), "a6g-app-v2-planner": of("app-v2", "planner"), mine: { driver: "codex" } },
      })
    );
    writeTeam({ team: "app", instances: { "a6g-app-builder": of("app", "builder") }, project: "p", setup: null, branchPrefix: "a6g" });
    assert.deepEqual(Object.keys(readSettings().providerInstances ?? {}).sort(), ["a6g-app-builder", "a6g-app-v2-planner", "mine"]);
  });
});
