import { baseTeam, commit, a6g, git, makeRepo, tmp, write } from "./helpers.ts";
import assert from "node:assert/strict";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { loadTeam } from "../lib/config.ts";

const as = (home: string, role: string) => ({ cwd: home, env: { A6G_HOME_DIR: home, A6G_TEAM: "fixture", A6G_ROLE: role } });

describe("team members' commands", { concurrency: true }, () => {
  test("only the role that owns a verdict records it; a person may too", async () => {
    const home = makeRepo();
    git(home, "checkout", "-q", "-b", "a6g/b1-x");
    const sha = commit(home, { "src/x.ts": "x\n" });
    git(home, "checkout", "-q", "a6g/next");
    assert.equal((await a6g(["verdict", "review", "a6g/b1-x", "approve"], as(home, "builder"))).code, 2);
    assert.equal((await a6g(["verdict", "ux", "landing", "pass"], as(home, "reviewer"))).code, 2);
    assert.equal((await a6g(["verdict", "review", "a6g/b1-x", "approve", "--sha", sha, "--risk", "low", "--note", "fine"], as(home, "reviewer"))).code, 0);
    const review = JSON.parse(readFileSync(join(home, ".a6g/run/state/reviews/a6g_b1-x.json"), "utf8"));
    assert.deepEqual([review.verdict, review.sha, review.note, review.by], ["approve", sha, "fine", "reviewer"]);
    assert.equal((await a6g(["verdict", "ux", "landing", "issues", "--ref", sha], { cwd: home })).code, 0, "the operator, outside the team");
    assert.equal(JSON.parse(readFileSync(join(home, ".a6g/run/state/ux/landing.json"), "utf8")).by, "operator");
    assert.equal((await a6g(["verdict", "review", "a6g/b1-x", "maybe"], as(home, "reviewer"))).code, 2);
  });

  test("the log is newest first, with the real time", async () => {
    const home = makeRepo();
    await a6g(["log", "first entry"], as(home, "planner"));
    await a6g(["log", "--label", "merge 2", "second entry"], as(home, "planner"));
    const text = readFileSync(join(home, ".a6g/run/state/log.md"), "utf8");
    assert.match(text, /^# Fixture team: planner's log/);
    assert.ok(text.indexOf("second entry") < text.indexOf("first entry"));
    assert.match(text, /\*\*\d{4}-\d\d-\d\d \d\d:\d\d, merge 2\.\*\* second entry/);
  });

  test("drain", async () => {
    const home = makeRepo();
    assert.match((await a6g(["drain"], as(home, "planner"))).out, /not draining/);
    await a6g(["drain", "tester", "ux-specialist"], as(home, "planner"));
    assert.equal(readFileSync(join(home, ".a6g/run/state/drain"), "utf8").trim(), "tester ux-specialist");
    await a6g(["drain", "off"], as(home, "planner"));
    assert.ok(!existsSync(join(home, ".a6g/run/state/drain")));
  });

  test("gate, finish and progress run the team's commands", async () => {
    const home = makeRepo(
      baseTeam({ gate: { full: "echo full-ran", quick: "echo quick-ran" }, finish: "echo not yet && exit 1", progress: "echo halfway" })
    );
    assert.match((await a6g(["gate", "--quick"], as(home, "builder"))).out, /quick-ran/);
    assert.match((await a6g(["gate"], as(home, "builder"))).out, /full-ran/);
    const finish = await a6g(["finish"], as(home, "planner"));
    assert.equal(finish.code, 1);
    assert.match((await a6g(["progress"], as(home, "planner"))).out, /halfway/);
  });
});

describe("a6g init --no-interview", () => {
  test("makes the team's checkout and a draft that passes its own rules", async () => {
    const repo = tmp("a6g-init-");
    write(repo, {
      "package.json": {
        name: "shop",
        scripts: { dev: "next dev", typecheck: "tsc", lint: "eslint .", test: "vitest", build: "next build" },
        dependencies: { next: "16" },
      },
      "package-lock.json": "{}\n",
      "src/index.ts": "export {};\n",
    });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "-c", "user.email=t@example.com", "-c", "user.name=T", "add", "-A");
    git(repo, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qm", "init");
    const result = await a6g(["init", repo, "--name", "shop", "--owner", "op@example.com", "--no-interview"], { cwd: repo });
    assert.equal(result.code, 0, result.out);
    const checkout = `${repo}-a6g`;
    assert.equal(git(checkout, "rev-parse", "--abbrev-ref", "HEAD"), "a6g/next");
    const team = loadTeam(checkout);
    assert.deepEqual(team.problems, []);
    assert.equal(team.owner, "op@example.com");
    assert.ok(team.roles["ux-specialist"]);
    for (const script of ["gate.sh", "env.sh", "after-merge.sh"])
      assert.doesNotThrow(() => accessSync(join(checkout, ".a6g/adapters", script), constants.X_OK));
    const gate = readFileSync(join(checkout, ".a6g/adapters/gate.sh"), "utf8");
    assert.match(gate, /check typecheck npm run typecheck/);
    assert.match(gate, /check build npm run build/);
    assert.doesNotMatch(gate, /\{\{\w+\}\}/);
    assert.doesNotMatch(readFileSync(join(checkout, ".a6g/adapters/env.sh"), "utf8"), /\{\{\w+\}\}/);
    assert.ok(existsSync(join(checkout, ".a6g/run/setup/detect.json")));
    assert.equal(git(checkout, "check-ignore", ".a6g/run/setup/detect.json"), ".a6g/run/setup/detect.json");
    const again = await a6g(["init", repo, "--name", "shop", "--no-interview"], { cwd: repo });
    assert.match(again.out, /kept \.a6g\/team\.json/, "never overwrites");
  });
});

describe("a6g upgrade's pin", () => {
  test("changes only the factory line, or adds one after the name, keeping the file's own formatting", async () => {
    const { pinned } = await import("../lib/commands/team.ts");
    const text = '{\n  "name": "shop",\n  "factory": "0.2.0",\n  "protectedBranches": ["main", "master"],\n  "branch": "a6g/next"\n}\n';
    assert.equal(pinned(text, "0.3.0"), text.replace('"0.2.0"', '"0.3.0"'));
    const unpinned = '{\n  "name": "shop",\n  "roles": { "planner": {} },\n  "branch": "a6g/next"\n}\n';
    assert.equal(pinned(unpinned, "0.3.0"), '{\n  "name": "shop",\n  "factory": "0.3.0",\n  "roles": { "planner": {} },\n  "branch": "a6g/next"\n}\n');
    assert.equal(JSON.parse(pinned('{"branch": "x", "name": "shop"}', "dev")).factory, "dev", "a file it can't edit in place is written out");
  });
});
