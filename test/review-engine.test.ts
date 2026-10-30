// Regressions from the review of the engine audit's fixes: each test is one of the review's findings.
import { commit, e9g, git, makeRepo, write } from "./helpers.ts";
import { fakeWorld } from "./fake-t3.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { acquire } from "../lib/lock.ts";

const as = (home: string, role: string) => ({ cwd: home, env: { E9G_HOME_DIR: home, E9G_TEAM: "fixture", E9G_ROLE: role } });
const read = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");

describe("the review of the engine fixes", { concurrency: 4 }, () => {
  test("1: a worktree's untracked files keep it, whatever git's own settings hide", async () => {
    const w = await fakeWorld();
    try {
      writeFileSync(join(w.run, "planner-thread"), "mcp:planner\n");
      git(w.home, "config", "status.showUntrackedFiles", "no");
      const path = w.worktree("t3-forgot", "e9g/b1-forgot");
      commit(path, { "src/one.ts": "export const one = 1;\n" }, "b1");
      write(path, { "src/forgot.ts": "never added\n" });
      w.child({ parent: "mcp:planner", id: "c1", instance: "e9g-fixture-builder", status: "completed", worktreePath: path });
      await w.e9g("watchdog", "run", "fixture");
      assert.ok(existsSync(join(path, "src/forgot.ts")), "the untracked file is still there");
      assert.match(read(join(w.run, "worktrees-kept.json")), /t3-forgot: uncommitted or untracked files/);
      const status = await w.e9g("status", "fixture");
      assert.match(status.out, /kept 1 finished worktrees that may hold work/);
    } finally {
      await w.close();
    }
  });

  test("2: a holder's start time reads the same whatever the caller's TZ", { timeout: 60_000 }, async () => {
    const home = makeRepo();
    const held = await acquire(home, "app", { slots: 1 });
    try {
      for (const TZ of ["UTC", "Pacific/Kiritimati", "America/Los_Angeles"]) {
        const result = await e9g(["lock", "app", "--wait-min", "0.03", "--", "true"], { cwd: home, env: { E9G_HOME_DIR: home, TZ } });
        assert.equal(result.code, 75, `${TZ}: the slot is held, so it waits and gives up (${result.out})`);
      }
    } finally {
      held?.();
    }
  });

  test("4: a verdict names a commit by its id, never by a branch or HEAD", async () => {
    const home = makeRepo();
    git(home, "checkout", "-q", "-b", "e9g/b1-x");
    commit(home, { "src/x.ts": "export const x = 1;\n" });
    git(home, "checkout", "-q", "e9g/next");
    for (const name of ["e9g/b1-x", "HEAD", "refs/heads/e9g/b1-x"]) {
      const result = await e9g(["verdict", "review", "e9g/b1-x", "approve", "--sha", name, "--risk", "low", "--note", "ok"], as(home, "reviewer"));
      assert.equal(result.code, 2, `${name}: ${result.out}`);
      assert.match(result.out, /takes the id of the commit you judged/);
    }
    const ux = await e9g(["verdict", "ux", "landing", "pass", "--ref", "e9g/next"], as(home, "ux-specialist"));
    assert.equal(ux.code, 2, ux.out);
    const sha = git(home, "rev-parse", "e9g/b1-x");
    assert.equal(
      (await e9g(["verdict", "review", "e9g/b1-x", "approve", "--sha", sha.slice(0, 12), "--risk", "low", "--note", "ok"], as(home, "reviewer"))).code,
      0
    );
  });

  test("5: rotate refuses a planner that is waiting for an answer", async () => {
    const w = await fakeWorld();
    try {
      writeFileSync(join(w.run, "planner-thread"), "mcp:old\n");
      for (const thread of [{ status: "waiting" }, { status: "idle", pendingRequestCount: 1 }]) {
        w.show({ ...thread, updatedAt: new Date().toISOString() });
        const result = await w.e9g("rotate", "fixture");
        assert.equal(result.code, 2, result.out);
        assert.match(result.out, /waiting for an answer/);
        assert.equal(read(join(w.run, "planner-thread")).trim(), "mcp:old");
      }
    } finally {
      await w.close();
    }
  });

  test("6: e9g start says so when T3 Code doesn't answer", async () => {
    const w = await fakeWorld();
    try {
      // A watchdog already installed, so start goes straight to watching.
      write(join(w.env.HOME as string, "Library/LaunchAgents"), { "ca.e9g.watchdog.plist": "<plist/>\n" });
      w.setUp(false);
      const result = await w.e9g("start", "fixture");
      assert.equal(result.code, 1, result.out);
      assert.match(result.out, /wasn't started: T3 Code isn't answering/);
    } finally {
      await w.close();
    }
  });

  test("7: the launchd job never reaches into a checkout to prune", async () => {
    const w = await fakeWorld();
    try {
      writeFileSync(join(w.run, "planner-thread"), "mcp:planner\n");
      const path = w.worktree("t3-done", "e9g/b1-done");
      commit(path, { "src/one.ts": "export const one = 1;\n" }, "b1");
      w.child({ parent: "mcp:planner", id: "c1", instance: "e9g-fixture-builder", status: "completed", worktreePath: path });
      await e9g(["watchdog", "run", "fixture"], { cwd: w.root, env: { ...w.env, E9G_LAUNCHD: "1" } });
      assert.ok(existsSync(path), "left for the merge queue or a run from a terminal");
      await w.e9g("watchdog", "run", "fixture");
      assert.ok(!existsSync(path), "which removes it");
    } finally {
      await w.close();
    }
  });

  test("9: --rebased-from on an approval whose commit is gone says so", async () => {
    const home = makeRepo();
    git(home, "checkout", "-q", "-b", "e9g/b1-x");
    const approved = commit(home, { "src/x.ts": "reviewed\n" });
    git(home, "checkout", "-q", "e9g/next");
    assert.equal(
      (await e9g(["verdict", "review", "e9g/b1-x", "approve", "--sha", approved, "--risk", "low", "--note", "ok"], as(home, "reviewer"))).code,
      0
    );
    git(home, "branch", "-D", "e9g/b1-x");
    git(home, "checkout", "-q", "-b", "e9g/b1-x", "e9g/next");
    commit(home, { "src/x.ts": "something else\n" });
    git(home, "checkout", "-q", "e9g/next");
    git(home, "reflog", "expire", "--expire-unreachable=now", "--all");
    git(home, "gc", "-q", "--prune=now");
    const result = await e9g(["merge", "e9g/b1-x", "--rebased-from", approved], { cwd: home, env: { E9G_HOME_DIR: home } });
    assert.equal(result.code, 2, result.out);
    assert.match(result.out, /is gone from the repository/);
  });

  test("10: the pin is the top-level factory key, never one inside vars", async () => {
    const { pinned } = await import("../lib/commands/team.ts");
    const text = '{\n  "name": "app",\n  "vars": { "factory": "acme-widgets" },\n  "factory": "0.3.0",\n  "branch": "e9g/next"\n}\n';
    const result = JSON.parse(pinned(text, "0.3.0"));
    assert.equal(result.vars.factory, "acme-widgets");
    assert.equal(result.factory, "0.3.0");
    const moved = JSON.parse(pinned(text, "0.4.0"));
    assert.deepEqual([moved.vars.factory, moved.factory], ["acme-widgets", "0.4.0"]);
  });
});

describe("seeing every team at once", () => {
  test("status shows the environment, the drain and the members; teams shows whether each runs", async () => {
    const w = await fakeWorld();
    try {
      const file = join(w.e9gHome, "teams", "fixture.json");
      const origin = (JSON.parse(read(join(w.t3Home, "userdata", "server-runtime.json"))) as { origin: string }).origin;
      writeFileSync(file, JSON.stringify({ ...JSON.parse(read(file)), health: [`${origin}/`, "http://127.0.0.1:9/"] }));
      write(w.home, { ".e9g/run/state/drain": "builder tester\n" });
      let result = await w.e9g("status", "fixture");
      assert.equal(result.code, 0, result.out);
      assert.match(result.out, /environment: partly up \(.* answers, http:\/\/127\.0\.0\.1:9\/ doesn't answer\)/);
      assert.match(result.out, /draining: builder tester/);
      assert.match(result.out, /members running: -/);
      result = await w.e9g("teams");
      assert.match(result.out, /^fixture\s+\S+\s+active\s/m);
      writeFileSync(join(w.run, "paused"), "");
      assert.match((await w.e9g("teams")).out, /^fixture\s+\S+\s+paused\s/m);
    } finally {
      await w.close();
    }
  });
});
