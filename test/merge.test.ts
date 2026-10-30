import { baseTeam, commit, e9g, git, makeRepo, write } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileStore } from "../lib/tasks/files.ts";

// Each checkout's run folder beside it (the default is the team's name, which every fixture shares).
const merge = (home: string, ...args: string[]) => e9g(["merge", ...args], { cwd: home, env: { E9G_HOME_DIR: home, E9G_RUN: `${home}-run` } });
const taskStatus = async (home: string, id: string) => (await fileStore(`${home}-run`, "fixture").tasks.get(id))?.status;
const approve = (home: string, branch: string) =>
  e9g(["verdict", "review", branch, "approve", "--sha", git(home, "rev-parse", branch), "--risk", "low", "--note", "ok"], {
    cwd: home,
    env: { E9G_HOME_DIR: home, E9G_TEAM: "fixture", E9G_ROLE: "reviewer", E9G_RUN: `${home}-run` },
  });
const record = (home: string, branch: string): { result: string; message: string; sha: string } =>
  JSON.parse(readFileSync(join(home, ".e9g/run/state/merges", `${branch.replaceAll("/", "_")}.json`), "utf8"));
const tip = (home: string, ref = "e9g/next"): string => git(home, "rev-parse", ref);

// A branch made from the integration branch, with one commit, and the checkout back on the integration branch.
function branch(home: string, name: string, files: Record<string, unknown>, from = "e9g/next"): string {
  git(home, "checkout", "-q", "-b", name, from);
  const sha = commit(home, files, `work on ${name}`);
  git(home, "checkout", "-q", "e9g/next");
  return sha;
}

describe("merge queue", { concurrency: true }, () => {
  test("a builder branch needs an approval of its exact tip", async () => {
    const home = makeRepo(baseTeam(), { ".e9g/run/board/1-feature.md": "status: review\nkind: feature\n\nDo it.\n" });
    const before = tip(home);
    branch(home, "e9g/b1-feature", { "src/feature.ts": "export const f = 1;\n" });

    let result = await merge(home, "e9g/b1-feature");
    assert.equal(result.code, 2, result.out);
    assert.match(record(home, "e9g/b1-feature").message, /has no review/);

    assert.equal((await approve(home, "e9g/b1-feature")).code, 0);
    git(home, "checkout", "-q", "e9g/b1-feature");
    commit(home, { "src/feature.ts": "export const f = 2;\n" }, "after the review");
    git(home, "checkout", "-q", "e9g/next");
    result = await merge(home, "e9g/b1-feature");
    assert.equal(result.code, 2);
    assert.match(record(home, "e9g/b1-feature").message, /the approval is for/);
    assert.equal(tip(home), before, "nothing merged");

    await approve(home, "e9g/b1-feature");
    result = await merge(home, "e9g/b1-feature");
    assert.equal(result.code, 0, result.out);
    assert.equal(record(home, "e9g/b1-feature").result, "merged");
    assert.equal(git(home, "rev-parse", "e9g/next^2"), tip(home, "e9g/b1-feature"), "a merge commit of the approved tip");
    assert.equal(await taskStatus(home, "1"), "done", "the board's ticket, now a task, is done");
    assert.match(readFileSync(join(home, ".e9g/run/state/merges.log"), "utf8"), /e9g\/b1-feature merged/);
    assert.ok(!existsSync(join(home, ".e9g/run/merge")), "the scratch worktree is gone");
  });

  test("a branch outside its lane is refused, approved or not", async () => {
    const home = makeRepo();
    const cases: [string, Record<string, string>][] = [
      ["e9g/b2-rules", { ".e9g/notes.md": "changed\n" }],
      ["e9g/b3-specs", { "e2e/a.spec.ts": "test\n" }],
      ["e9g/b4-settings", { ".claude/settings.json": "{}\n" }],
    ];
    for (const [name, files] of cases) {
      branch(home, name, files);
      await approve(home, name);
      const result = await merge(home, name);
      assert.equal(result.code, 2, `${name}: ${result.out}`);
      assert.match(record(home, name).message, /outside its lane/);
    }
    branch(home, "feature/x", { "src/x.ts": "x\n" });
    assert.equal((await merge(home, "feature/x")).code, 2, "not a team branch");
  });

  test("a failing gate merges nothing", async () => {
    const home = makeRepo(baseTeam({ gate: { full: "echo 'tests: 3 FAILED' && false" } }));
    const before = tip(home);
    branch(home, "e9g/b5-thing", { "src/thing.ts": "x\n" });
    await approve(home, "e9g/b5-thing");
    const result = await merge(home, "e9g/b5-thing");
    assert.equal(result.code, 4, result.out);
    assert.equal(tip(home), before);
    assert.match(record(home, "e9g/b5-thing").message, /the gate fails.*3 FAILED/);
  });

  test("a pure rebase merges on its earlier approval; a changed one doesn't", async () => {
    const home = makeRepo();
    const approved = branch(home, "e9g/b6-rebase", { "src/six.ts": "6\n" });
    await approve(home, "e9g/b6-rebase");
    branch(home, "e9g/b7-other", { "src/seven.ts": "7\n" });
    await approve(home, "e9g/b7-other");
    assert.equal((await merge(home, "e9g/b7-other")).code, 0);
    git(home, "checkout", "-q", "e9g/b6-rebase");
    git(home, "rebase", "-q", "e9g/next");
    git(home, "checkout", "-q", "e9g/next");
    assert.equal((await merge(home, "e9g/b6-rebase")).code, 2, "a new tip without --rebased-from");
    let result = await merge(home, "e9g/b6-rebase", "--rebased-from", approved);
    assert.equal(result.code, 0, result.out);

    const second = branch(home, "e9g/b8-sneaky", { "src/eight.ts": "8\n" });
    await approve(home, "e9g/b8-sneaky");
    git(home, "checkout", "-q", "e9g/b8-sneaky");
    git(home, "reset", "-q", "--hard", "e9g/next");
    commit(home, { "src/eight.ts": "8, and something else\n" }, "work on e9g/b8-sneaky");
    git(home, "checkout", "-q", "e9g/next");
    result = await merge(home, "e9g/b8-sneaky", "--rebased-from", second);
    assert.equal(result.code, 2, result.out);
    assert.match(record(home, "e9g/b8-sneaky").message, /isn't only a rebase/);
  });

  test("the planner's own commit during a merge still lets it in", async () => {
    const home = makeRepo(
      baseTeam({ gate: { full: `cd "$E9G_HOME_DIR" && echo lesson >> .e9g/lessons.md && git add .e9g/lessons.md && git commit -qm lessons` } })
    );
    branch(home, "e9g/b9-meanwhile", { "src/nine.ts": "9\n" });
    await approve(home, "e9g/b9-meanwhile");
    const result = await merge(home, "e9g/b9-meanwhile");
    assert.equal(result.code, 0, result.out);
    assert.equal(git(home, "log", "-1", "--format=%s", "e9g/next^1"), "lessons", "merged on top of the planner's commit");
    assert.ok(existsSync(join(home, "src/nine.ts")));
  });

  test("a test branch merges without review unless it removes an assertion", async () => {
    const home = makeRepo(baseTeam({ review: { required: ["builder"], removedPattern: "\\bexpect\\(" } }), {
      "e2e/a.spec.ts": "expect(one);\nexpect(two);\n",
    });
    branch(home, "e9g/t-more", { "e2e/b.spec.ts": "expect(three);\n" });
    let result = await merge(home, "e9g/t-more");
    assert.equal(result.code, 0, result.out);
    branch(home, "e9g/t-fewer", { "e2e/a.spec.ts": "expect(one);\n" });
    result = await merge(home, "e9g/t-fewer");
    assert.equal(result.code, 2, result.out);
    assert.match(record(home, "e9g/t-fewer").message, /has no review/);
  });

  test("closes the tickets it's told to, and refuses a dirty checkout", async () => {
    const home = makeRepo(baseTeam(), { ".e9g/run/board/7-seven.md": "status: review\n" });
    branch(home, "e9g/b10-ten", { "src/ten.ts": "10\n" });
    await approve(home, "e9g/b10-ten");
    write(home, { "README.md": "edited but not committed\n" });
    assert.equal((await merge(home, "e9g/b10-ten")).code, 2);
    assert.match(record(home, "e9g/b10-ten").message, /uncommitted changes/);
    git(home, "checkout", "--", "README.md");
    const result = await merge(home, "e9g/b10-ten", "--closes", "7");
    assert.equal(result.code, 0, result.out);
    assert.equal(await taskStatus(home, "7"), "done");
  });
});
