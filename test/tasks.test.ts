import { baseTeam, bash, commit, e9g, git, holds, makeRepo, tmp, write } from "./helpers.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { RawTeam } from "../lib/config.ts";
import { machineName } from "../lib/machine.ts";
import { fileStore } from "../lib/tasks/files.ts";
import { update } from "../lib/tasks/store.ts";
import {
  branchFor,
  claimRefusal,
  DEFAULT_WEIGHTS,
  journeyDue,
  MERGE,
  moveRefusal,
  STATUSES,
  type Via,
  WATCHDOG,
  type ApprovalRules,
  newTask,
  nextClaim,
  OPERATOR,
  priorityOf,
  type Score,
  statusRefusal,
  type Task,
  ticketOf,
} from "../lib/tasks/model.ts";
import { claimMark, closeMerged, expireClaims, importBoard, markClaim, renewClaims, summary } from "../lib/tasks/ops.ts";

const team = (overrides: RawTeam = {}) =>
  baseTeam({
    roles: {
      planner: {},
      builder: { limit: 2, deny: ["^e2e/"] },
      reviewer: { limit: 1 },
      tester: { limit: 1, write: ["^e2e/"] },
      approver: { limit: 1 },
    },
    ...overrides,
  });

// One team checkout with a run folder of its own (tests run at once, and the default run folder is the team's name).
function setup(raw: RawTeam = team()) {
  const home = makeRepo(raw);
  const run = tmp("e9g-run-");
  const as = (role: string | null, cwd = home) => ({
    cwd,
    env: role ? { E9G_HOME_DIR: home, E9G_TEAM: "fixture", E9G_ROLE: role, E9G_RUN: run } : { E9G_RUN: run },
  });
  // A member's own worktree, on a branch of its own, as T3 Code makes it.
  const worktree = (name: string) => {
    const dir = join(tmp("e9g-wt-"), name);
    git(home, "worktree", "add", "-q", "-b", `wt/${name}`, dir, "e9g/next");
    return realpathSync(dir);
  };
  return { home, run, as, worktree, store: () => fileStore(run, "fixture") };
}

const SCORE = ["--pain", "3", "--reach", "2", "--revenue", "1", "--wow", "2", "--distribution", "1", "--leverage", "2", "--urgency", "1", "--risk", "0"];
const GATE = ["--asked", "the operator, for repeat users", "--simplify", "nothing to delete", "--simplest", "one button"];

const task = (fields: Partial<Task> & { id: string }): Task => ({
  ...newTask({ team: "fixture", title: `task ${fields.id}`, kind: "feature", status: "approved", by: "planner", ...fields }),
  version: 1,
  ...fields,
});

describe("the task model", () => {
  test("priority weighs the scores, then confidence and size", () => {
    const top: Score = {
      pain: 3,
      reach: 3,
      revenue: 3,
      wow: 3,
      distribution: 3,
      leverage: 3,
      urgency: 3,
      risk: 3,
      confidence: "data",
      size: "S",
      why: "",
    };
    assert.equal(priorityOf(top), 100);
    assert.equal(priorityOf({ ...top, size: "M" }), 50);
    assert.equal(priorityOf({ ...top, confidence: "hunch" }), 50);
    const painOnly: Score = {
      pain: 3,
      reach: 0,
      revenue: 0,
      wow: 0,
      distribution: 0,
      leverage: 0,
      urgency: 0,
      risk: 0,
      confidence: "data",
      size: "S",
      why: "",
    };
    assert.equal(priorityOf(painOnly), Math.round((100 * 9) / (3 * 14)), "pain weighs 3 of the 14");
    assert.equal(priorityOf(painOnly, { ...DEFAULT_WEIGHTS, pain: 0 }), 0);
  });

  test("the planner moves tasks, but never approves its own or marks code done", () => {
    const proposed = task({ id: "1", status: "proposed" });
    assert.match(statusRefusal(proposed, "approved", "planner") ?? "", /doesn't approve its own/);
    assert.equal(statusRefusal(proposed, "approved", OPERATOR), null, "the operator may");
    assert.match(statusRefusal(task({ id: "2", status: "review" }), "done", "planner") ?? "", /merge queue/);
    const journey = task({ id: "3", status: "approved", kind: "journey" });
    assert.match(statusRefusal(journey, "done", "planner", [journey]) ?? "", /done once it's verified/, "an empty journey isn't due");
    const child = task({ id: "9", status: "done", parent: "3" });
    assert.equal(statusRefusal(journey, "done", "planner", [journey, child]), null, "its tasks done, the planner verifies and closes it");
    assert.equal(
      statusRefusal(task({ id: "4", status: "approved", kind: "research" }), "done", "planner"),
      null,
      "research is done when the planner says"
    );
    assert.match(statusRefusal(task({ id: "5", status: "approved" }), "building", "planner") ?? "", /claims/);
    const unblocked = task({ id: "6", status: "blocked", approval: { by: "approver", at: "x", note: "" } });
    assert.equal(statusRefusal(unblocked, "approved", "planner"), null, "a task approved before goes back to approved");
    assert.match(statusRefusal(task({ id: "7", status: "blocked" }), "approved", "planner") ?? "", /never approved/);
    assert.match(statusRefusal(task({ id: "8", status: "proposed" }), "rejected", "builder") ?? "", /only the planner/);
  });

  test("the move table, walked whole, keeps the rules nobody may break", () => {
    const VIAS: Via[] = ["status", "approve", "reject", "research", "escalate", "claim", "release", "submit", "changes", "merge", "expire"];
    const ACTORS = ["planner", "approver", "builder", "tester", "reviewer", "ux-specialist", OPERATOR, MERGE, WATCHDOG];
    const approval: ApprovalRules = { mode: "full", maxSize: "XL", findings: "planner" };
    const allowed: string[] = [];
    for (const kind of ["feature", "bug", "journey"] as const)
      for (const from of STATUSES)
        for (const approved of [false, true]) {
          const t = task({
            id: "1",
            kind,
            status: from,
            severity: "major",
            score: { pain: 1, reach: 1, revenue: 1, wow: 1, distribution: 1, leverage: 1, urgency: 1, risk: 1, confidence: "data", size: "S", why: "x" },
            approval: approved ? { by: "approver", at: "x", note: "" } : null,
            by: "tester",
            claim: { role: "builder", machine: "m", worktree: "/w", at: "x", until: new Date(0).toISOString() },
          });
          const ctx = { all: [t], approval, machine: "m", worktree: "/w", now: Date.now() };
          for (const via of VIAS)
            for (const actor of ACTORS)
              for (const to of STATUSES)
                if (moveRefusal(t, to, via, actor, ctx) === null) allowed.push(`${kind} ${from}${approved ? "+" : ""} -${via}/${actor}-> ${to}`);
        }
    const moves = (pattern: RegExp) => allowed.filter((m) => pattern.test(m));
    assert.deepEqual(
      moves(/-> building$/).filter((m) => !/-claim\/(builder|tester)->/.test(m)),
      [],
      "only a claim builds"
    );
    assert.deepEqual(
      moves(/^(feature|bug) .* -> done$/).filter((m) => !/-(merge\/merge-queue|status\/operator)->/.test(m)),
      [],
      "code is done when it merges"
    );
    assert.deepEqual(
      moves(/^journey .* -> done$/).filter((m) => /merge/.test(m)),
      [],
      "a journey isn't closed by a merge"
    );
    assert.deepEqual(
      moves(/-> approved$/).filter(
        (m) => /\/planner->/.test(m) && !/^\S+ \S+\+ /.test(m) && !/-release\//.test(m) && !/^bug (triage|proposed) -approve/.test(m)
      ),
      [],
      "the planner approves only what was approved before, and others' findings"
    );
    assert.deepEqual(moves(/-(approve|reject|research|escalate)\/(builder|tester|reviewer|ux-specialist)->/), [], "members don't decide proposals");
    // Nothing gets stuck: from every status but done and rejected, someone on the team can move a task on.
    for (const from of STATUSES.filter((s) => s !== "done" && s !== "rejected"))
      assert.ok(moves(new RegExp(`^feature ${from}\\+? -\\w+/(?!operator)`)).length > 0, `a feature in ${from} can move on without the operator`);
  });

  test("claims follow kind, dependencies and files, in severity then priority order", () => {
    const all = [
      task({ id: "1", status: "done" }),
      task({ id: "2", after: ["1"], priority: 10 }),
      task({ id: "3", after: ["9"], priority: 90 }),
      task({ id: "4", kind: "test" }),
      task({ id: "5", priority: 40, files: ["src/a/"] }),
      task({ id: "6", status: "building", files: ["src/a/b.ts"] }),
      task({ id: "7", priority: 5, severity: "blocker" }),
      task({ id: "8", status: "approved", kind: "journey" }),
      task({ id: "9", status: "proposed" }),
    ];
    assert.match(claimRefusal(all[2] as Task, "builder", all) ?? "", /waits for 9 \(proposed\)/);
    assert.match(claimRefusal(all[3] as Task, "builder", all) ?? "", /test work/);
    assert.match(claimRefusal(all[4] as Task, "builder", all) ?? "", /being built on the same files/);
    assert.match(claimRefusal(all[7] as Task, "builder", all) ?? "", /journey work/);
    assert.match(claimRefusal(all[1] as Task, "reviewer", all) ?? "", /doesn't claim/);
    assert.equal(nextClaim(all, "builder")?.id, "7", "a blocker first, whatever its priority");
    assert.equal(
      nextClaim(
        all.filter((t) => t.id !== "7"),
        "builder"
      )?.id,
      "2"
    );
    assert.equal(nextClaim(all, "tester")?.id, "4");
  });

  test("branch names carry the task's number, which the merge reads back", () => {
    const t = task({ id: "142", title: "Resume a paused recording — after reload!" });
    assert.equal(branchFor(t, "builder", "e9g"), "e9g/b142-resume-a-paused-recording-after-reload");
    assert.equal(branchFor(t, "tester", "team"), "team/t-142-resume-a-paused-recording-after-reload");
    assert.equal(ticketOf("e9g/b142-resume", "e9g"), "142");
    assert.equal(ticketOf("e9g/t-142-resume", "e9g"), "142");
    assert.equal(ticketOf("e9g/b12-x/v2-y", "e9g"), "12");
    assert.equal(ticketOf("e9g/topic", "e9g"), undefined);
  });

  test("a journey is due its verification when its tasks are done", () => {
    const journey = task({ id: "1", kind: "journey", status: "approved" });
    const done = task({ id: "2", parent: "1", status: "done" });
    assert.equal(journeyDue(journey, [journey, done, task({ id: "3", parent: "1", status: "review" })]), false);
    assert.equal(journeyDue(journey, [journey, done, task({ id: "3", parent: "1", status: "rejected" })]), true);
    assert.equal(journeyDue(journey, [journey]), false, "an empty journey isn't done");
  });
});

describe("the file store", { concurrency: true }, () => {
  test("numbers tasks, and replaces only the version it read", async () => {
    const store = fileStore(tmp("e9g-run-"), "fixture");
    const a = await store.tasks.create(newTask({ team: "fixture", title: "a", kind: "feature", status: "proposed", by: "planner" }));
    const b = await store.tasks.create(newTask({ team: "fixture", title: "b", kind: "feature", status: "proposed", by: "planner" }));
    assert.deepEqual([a.id, b.id, a.version], ["1", "2", 1]);
    const first = await store.tasks.replace({ ...a, title: "a2" });
    assert.equal(first?.version, 2);
    assert.equal(await store.tasks.replace({ ...a, title: "stale" }), null, "a write from version 1 after version 2");
    assert.equal((await store.tasks.get("1"))?.title, "a2");
    assert.equal((await store.tasks.createAs("10", { ...a, title: "kept" }))?.id, "10");
    assert.equal(await store.tasks.createAs("10", { ...a }), null);
    assert.equal((await store.tasks.create({ ...a })).id, "11", "later tasks number after an imported one");
    assert.equal(await store.tasks.get("../1"), null);
    const request = await store.requests.create({
      team: "fixture",
      title: "r",
      body: "",
      from: null,
      status: "new",
      tasks: [],
      notes: [],
      createdAt: "",
      updatedAt: "",
      history: [],
    });
    assert.equal(request.id, "r1");
  });

  test("claims made at once never take the same task", async () => {
    const { run, as, worktree } = setup();
    const store = fileStore(run, "fixture");
    for (const id of ["1", "2", "3"])
      await store.tasks.createAs(
        id,
        newTask({ team: "fixture", title: `t${id}`, kind: "feature", status: "approved", by: "planner", files: [`src/${id}/`] })
      );
    const trees = ["a", "b", "c", "d"].map(worktree);
    const results = await Promise.all(trees.map((dir) => e9g(["task", "claim"], as("builder", dir))));
    assert.deepEqual(results.map((r) => r.code).sort(), [0, 0, 0, 3], results.map((r) => r.out).join("\n"));
    const claimed = (await store.tasks.all()).filter((t) => t.status === "building");
    assert.equal(new Set(claimed.map((t) => t.claim?.worktree)).size, 3);
  });
});

describe("e9g task, from proposal to merge", () => {
  test("the planner proposes and scores, the approver approves, a builder claims, submits and the merge closes it", async () => {
    const { home, run, as, worktree, store } = setup();
    // Proposals need the gate and a score; the planner can't approve its own.
    assert.equal((await e9g(["task", "add", "Resume a paused recording"], as("planner"))).code, 0);
    assert.match(
      (await e9g(["task", "score", "1", ...SCORE, "--confidence", "asks", "--size", "M", "--why", "users lose work"], as("planner"))).out,
      /passes the gate first/
    );
    const scored = await e9g(["task", "score", "1", ...SCORE, ...GATE, "--confidence", "asks", "--size", "M", "--why", "users lose work"], as("planner"));
    assert.equal(scored.code, 0, scored.out);
    assert.equal(
      (await store().tasks.get("1"))?.priority,
      priorityOf({ pain: 3, reach: 2, revenue: 1, wow: 2, distribution: 1, leverage: 2, urgency: 1, risk: 0, confidence: "asks", size: "M", why: "" })
    );
    assert.equal((await e9g(["task", "status", "1", "approved"], as("planner"))).code, 2);
    assert.equal((await e9g(["task", "approve", "1"], as("builder"))).code, 2);
    assert.equal((await e9g(["task", "approve", "1", "--note", "fits the direction"], as("approver"))).code, 0);

    // A builder claims it in its own worktree, not the team's checkout, and hands it in on a branch with its number.
    assert.match((await e9g(["task", "claim"], as("builder"))).out, /own worktree/);
    const tree = worktree("b1");
    const claimed = await e9g(["task", "claim"], as("builder", tree));
    assert.equal(claimed.code, 0, claimed.out);
    assert.match(claimed.out, /git branch -m e9g\/b1-resume-a-paused-recording/);
    assert.match((await e9g(["task", "claim"], as("builder", tree))).out, /holds task 1 already/);
    assert.ok(existsSync(claimMark(run, tree)));
    assert.match((await e9g(["task", "submit", "1"], as("builder", tree))).out, /name your branch/);
    git(tree, "branch", "-m", "e9g/b1-resume-a-paused-recording");
    assert.match((await e9g(["task", "submit", "1"], as("builder", tree))).out, /nothing beyond/);
    commit(tree, { "src/resume.ts": "export const resume = true;\n" });
    const submitted = await e9g(["task", "submit", "1"], as("builder", tree));
    assert.equal(submitted.code, 0, submitted.out);
    let t = await store().tasks.get("1");
    assert.deepEqual([t?.status, t?.branch, t?.claim], ["review", "e9g/b1-resume-a-paused-recording", null]);
    assert.ok(!existsSync(claimMark(run, tree)));

    // Changes send it back for another round; the next builder works on the same branch.
    const sha = git(tree, "rev-parse", "HEAD");
    git(tree, "checkout", "-q", "--detach");
    assert.equal(
      (await e9g(["verdict", "review", "e9g/b1-resume-a-paused-recording", "changes", "--sha", sha, "--note", "handle a second reload"], as("reviewer")))
        .code,
      0
    );
    t = await store().tasks.get("1");
    assert.deepEqual([t?.status, t?.rounds], ["approved", 1]);
    assert.match(t?.notes.at(-1)?.text ?? "", /round 1 of 3\): handle a second reload/);
    const again = await e9g(["task", "claim", "1"], as("builder", worktree("b2")));
    assert.match(again.out, /git checkout e9g\/b1-resume-a-paused-recording/);

    // The merge queue closes it.
    await store().tasks.replace({ ...((await store().tasks.get("1")) as Task), status: "review", claim: null });
    assert.equal(
      (await e9g(["verdict", "review", "e9g/b1-resume-a-paused-recording", "approve", "--sha", sha, "--risk", "medium"], as("reviewer"))).code,
      0
    );
    const merged = await e9g(["merge", "e9g/b1-resume-a-paused-recording"], as("planner"));
    assert.equal(merged.code, 0, merged.out);
    t = await store().tasks.get("1");
    assert.equal(t?.status, "done");
    assert.match(t?.history.at(-1)?.what ?? "", /review → done: merged/);
    assert.ok(existsSync(join(home, "src/resume.ts")));
  });

  test("approval: thresholds hold large work for the operator; a journey needs no approval; the operator approves anything", async () => {
    const { as, store } = setup();
    for (const [title, kind, size] of [
      ["Small", "feature", "S"],
      ["Large", "feature", "L"],
      ["Checkout journey", "journey", "M"],
    ] as const) {
      await e9g(["task", "add", title, "--kind", kind], as("planner"));
      const id = String((await store().tasks.all()).length);
      await e9g(["task", "score", id, ...SCORE, ...GATE, "--confidence", "data", "--size", size, "--why", "x"], as("planner"));
    }
    assert.equal((await e9g(["task", "approve", "1"], as("approver"))).code, 0);
    assert.match((await e9g(["task", "approve", "2"], as("approver"))).out, /over this team's M.*escalate/);
    assert.match((await e9g(["task", "list"], as("planner"))).out, /#3 .*journey/);
    assert.doesNotMatch((await e9g(["task", "show", "3"], as("planner"))).out, /approved by/, "nobody had to approve the journey");
    assert.equal((await e9g(["task", "escalate", "2", "--reason", "it changes scope"], as("approver"))).code, 0);
    assert.equal((await store().tasks.get("2"))?.status, "question");
    assert.equal((await e9g(["task", "approve", "2"], as(null))).code, 0, "the operator answers it");
    assert.equal((await store().tasks.get("2"))?.approval?.by, OPERATOR);
  });

  test("approval: operator mode keeps the approver out; full lets it approve anything", async () => {
    const operator = setup(team({ approval: { mode: "operator" } }));
    await e9g(["task", "add", "Thing"], operator.as("planner"));
    await e9g(["task", "score", "1", ...SCORE, ...GATE, "--confidence", "data", "--size", "XL", "--why", "x"], operator.as("planner"));
    assert.match((await e9g(["task", "approve", "1"], operator.as("approver"))).out, /decided by the operator/);
    const full = setup(team({ approval: { mode: "full" } }));
    await e9g(["task", "add", "Thing"], full.as("planner"));
    await e9g(["task", "score", "1", ...SCORE, ...GATE, "--confidence", "data", "--size", "XL", "--why", "x"], full.as("planner"));
    assert.equal((await e9g(["task", "approve", "1"], full.as("approver"))).code, 0);
  });

  test("a finding the planner rewrote is its own; a journey isn't the approver's; a task being built isn't re-scored", async () => {
    const { as, store } = setup(team({ approval: { mode: "full" } }));
    const body = ["--body", "Steps: open /x, press Save. Nothing happens; it should save."];
    await e9g(["task", "add", "Typo in the footer", "--kind", "bug", "--sev", "minor", ...body], as("builder"));
    await e9g(["task", "edit", "1", "--title", "Rewrite billing for a new provider"], as("planner"));
    assert.match((await e9g(["task", "approve", "1"], as("planner"))).out, /doesn't approve its own/, "rewritten, it's the planner's");
    await e9g(["task", "add", "Checkout", "--kind", "journey"], as("planner"));
    assert.match((await e9g(["task", "approve", "2"], as("approver"))).out, /is a journey/);
    assert.match((await e9g(["task", "reject", "2", "--reason", "x"], as("approver"))).out, /is a journey/);
    // The operator setting a task approved approves it, so a claim of it can be handed back.
    await e9g(["task", "add", "Thing"], as("planner"));
    assert.equal((await e9g(["task", "status", "3", "approved"], as(null))).code, 0);
    assert.equal((await store().tasks.get("3"))?.approval?.by, OPERATOR);
    await update(store().tasks, "3", (t) => ({
      ...t,
      status: "building" as const,
      claim: { role: "builder", machine: "m", worktree: "/w", at: "x", until: "y" },
    }));
    assert.match(
      (await e9g(["task", "score", "3", ...SCORE, ...GATE, "--confidence", "data", "--size", "S", "--why", "x"], as("planner"))).out,
      /once it's back/
    );
    assert.equal((await e9g(["task", "release", "3"], as("planner"))).code, 0);
    assert.equal((await store().tasks.get("3"))?.status, "approved");
  });

  test("the planner approves a finding another member filed, never its own proposal", async () => {
    const { as, store } = setup();
    const body = ["--body", "Steps: open /x, press Save. Nothing happens; it should save."];
    await e9g(["task", "add", "Save does nothing", "--sev", "major", ...body], as("tester"));
    assert.equal((await e9g(["task", "approve", "1", "--note", "real"], as("planner"))).code, 0);
    assert.deepEqual([(await store().tasks.get("1"))?.status, (await store().tasks.get("1"))?.approval?.by], ["approved", "planner"]);
    await e9g(["task", "add", "My idea"], as("planner"));
    await e9g(["task", "score", "2", ...SCORE, ...GATE, "--confidence", "data", "--size", "S", "--why", "x"], as("planner"));
    assert.match((await e9g(["task", "approve", "2"], as("planner"))).out, /doesn't approve its own/);
    await e9g(["task", "add", "Bug the planner saw", "--kind", "bug", "--sev", "minor"], as("planner"));
    assert.match((await e9g(["task", "approve", "3"], as("planner"))).out, /doesn't approve its own/, "nor a finding it filed itself");
    const strict = setup(team({ approval: { findings: "approver" } }));
    await e9g(["task", "add", "Save does nothing", "--sev", "major", ...body], strict.as("tester"));
    assert.match((await e9g(["task", "approve", "1"], strict.as("planner"))).out, /approver decides findings too/);
  });

  test("findings go to triage with a severity and a body; members can't shape tasks", async () => {
    const { as, store } = setup();
    assert.match((await e9g(["task", "add", "Button is dead"], as("tester"))).out, /--sev/);
    assert.match((await e9g(["task", "add", "Button is dead", "--sev", "major"], as("tester"))).out, /what happened/);
    const filed = await e9g(
      ["task", "add", "Button is dead", "--sev", "major", "--body", "Steps: open /x, press Save. Nothing happens; it should save."],
      as("tester")
    );
    assert.equal(filed.code, 0, filed.out);
    assert.deepEqual([(await store().tasks.get("1"))?.status, (await store().tasks.get("1"))?.kind], ["triage", "bug"]);
    assert.equal((await e9g(["task", "edit", "1", "--title", "x"], as("tester"))).code, 2);
    assert.equal((await e9g(["task", "note", "1", "also on phone"], as("tester"))).code, 0);
    assert.equal((await e9g(["task", "status", "1", "proposed", "--reason", "real"], as("planner"))).code, 0);
    assert.match((await e9g(["task", "edit", "1", "--after", "1"], as("planner"))).out, /other than this one/);
  });

  test("a journey is due its verification when its last task merges", async () => {
    const { run } = setup();
    const store = fileStore(run, "fixture");
    await store.tasks.createAs("1", newTask({ team: "fixture", title: "journey", kind: "journey", status: "approved", by: "planner" }));
    await store.tasks.createAs("2", newTask({ team: "fixture", title: "a", kind: "feature", status: "done", parent: "1", by: "planner" }));
    await store.tasks.createAs("3", newTask({ team: "fixture", title: "b", kind: "feature", status: "review", parent: "1", by: "planner" }));
    await store.tasks.createAs(
      "4",
      newTask({
        team: "fixture",
        title: "c",
        kind: "feature",
        status: "building",
        by: "planner",
        claim: { role: "builder", machine: "m", worktree: "/w", at: "x", until: "y" },
      })
    );
    assert.deepEqual(await closeMerged(store, ["3", "4", "99"], { branch: "e9g/b3-b", sha: "abc" }), {
      closed: ["3"],
      skipped: ["#4 is being built by the builder on m"],
    });
    assert.equal((await store.tasks.get("4"))?.status, "building", "a task someone is building isn't closed out from under them");
    const all = await store.tasks.all();
    assert.equal(journeyDue(all.find((t) => t.id === "1") as Task, all), true);
  });

  test("a graph for BetterDiagrams: a band per journey, columns by dependency", async () => {
    const { run, as } = setup();
    const store = fileStore(run, "fixture");
    await store.tasks.createAs("1", newTask({ team: "fixture", title: "journey", kind: "journey", status: "approved", by: "planner" }));
    await store.tasks.createAs("2", newTask({ team: "fixture", title: "first", kind: "feature", status: "approved", parent: "1", by: "planner" }));
    await store.tasks.createAs(
      "3",
      newTask({ team: "fixture", title: "second", kind: "feature", status: "approved", parent: "1", after: ["2"], by: "planner" })
    );
    await store.tasks.createAs("4", newTask({ team: "fixture", title: "loose", kind: "bug", status: "triage", by: "tester" }));
    assert.equal((await e9g(["task", "graph"], as("builder"))).code, 0);
    const doc = JSON.parse(readFileSync(join(run, "task-graph.json"), "utf8"));
    const node = (id: string) => doc.nodes.find((n: { id: string }) => n.id === id);
    assert.equal(node("j1").kind, "group");
    assert.equal(node("t2").parentId, "j1");
    assert.ok(node("t3").x > node("t2").x, "after its dependency");
    assert.equal(node("t4").parentId, "none");
    assert.deepEqual(
      doc.edges.map((e: { source: string; target: string }) => [e.source, e.target]),
      [["t2", "t3"]]
    );
  });
});

describe("claims over time", () => {
  test("the heartbeat renews a claim; the watchdog's expiry returns a stale one", async () => {
    const { run, worktree } = setup();
    const store = fileStore(run, "fixture");
    const tree = worktree("hb");
    const past = new Date(Date.now() - 60_000).toISOString();
    await store.tasks.createAs(
      "1",
      newTask({
        team: "fixture",
        title: "a",
        kind: "feature",
        status: "building",
        by: "planner",
        claim: { role: "builder", machine: machineName(), worktree: tree, at: past, until: past },
      })
    );
    await store.tasks.createAs(
      "2",
      newTask({
        team: "fixture",
        title: "b",
        kind: "feature",
        status: "building",
        by: "planner",
        claim: { role: "builder", machine: "m", worktree: "/elsewhere", at: past, until: past },
      })
    );
    markClaim(run, tree, ["1"]);
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(claimMark(run, tree), old, old);
    assert.equal(await renewClaims(async () => store, run, tree, 45), 1);
    assert.ok(Date.parse((await store.tasks.get("1"))?.claim?.until ?? "") > Date.now() + 40 * 60_000);
    assert.equal(await renewClaims(async () => store, run, tree, 45), 0, "not again within five minutes");
    assert.deepEqual(await expireClaims(store), ["2"]);
    assert.deepEqual([(await store.tasks.get("2"))?.status, (await store.tasks.get("2"))?.claim], ["approved", null]);
    assert.equal((await store.tasks.get("1"))?.status, "building");
  });

  test("the stop hook keeps a builder from stopping on a claim it hasn't handed in", async () => {
    const { home, run, as, worktree } = setup();
    const store = fileStore(run, "fixture");
    await store.tasks.createAs("1", newTask({ team: "fixture", title: "a", kind: "feature", status: "approved", by: "planner" }));
    const tree = worktree("stop");
    assert.equal((await e9g(["task", "claim"], as("builder", tree))).code, 0);
    const stop = () =>
      spawnSync(process.execPath, [join(import.meta.dirname, "..", "plugin", "hooks", "stop.ts")], {
        input: JSON.stringify({ session_id: `s-${Math.random()}`, cwd: tree, agent_type: "e9g:builder" }),
        env: { ...process.env, E9G_TEAM: "fixture", E9G_HOME_DIR: home, E9G_ROLE: "builder", E9G_RUN: run, CLAUDE_PROJECT_DIR: tree },
        encoding: "utf8",
      });
    const idle = stop();
    assert.equal(idle.status, 2, idle.stderr);
    assert.match(idle.stderr, /e9g task release 1 --blocked/);
    git(tree, "branch", "-m", "e9g/b1-a");
    commit(tree, { "src/a.ts": "a\n" });
    const built = stop();
    assert.equal(built.status, 2);
    assert.match(built.stderr, /e9g task submit 1/);
    assert.equal((await e9g(["task", "submit", "1"], as("builder", tree))).code, 0);
    assert.equal(stop().status, 0);
  });
});

describe("a 0.3 files board", () => {
  test("comes across ticket by ticket, keeping numbers, once", async () => {
    const { home, run, as } = setup();
    write(join(home, ".e9g/run/board"), {
      "12-save-fails.md": "status: ready\nkind: bug\nsev: major\npage: editor\n\n# Save fails on phone\n\nSteps…\n",
      "13-checkout.md": "status: done\nkind: feature\n\nCheckout works.\n",
      "f-20261027-0100-dead-link.md": "status: triage\nkind: ux\nsev: minor\n\nThe footer link is dead.\n",
    });
    const listed = await e9g(["task", "list", "--all"], as("planner"));
    assert.equal(listed.code, 0, listed.out);
    const store = fileStore(run, "fixture");
    const twelve = await store.tasks.get("12");
    assert.deepEqual(
      [twelve?.title, twelve?.status, twelve?.severity, twelve?.area, twelve?.approval?.by],
      ["Save fails on phone", "approved", "major", "editor", "import"]
    );
    assert.equal((await store.tasks.get("13"))?.status, "done");
    const finding = await store.tasks.get("14");
    assert.deepEqual([finding?.status, finding?.kind, finding?.title], ["triage", "ux", "dead link"]);
    assert.deepEqual(await importBoard(store, join(home, ".e9g/run/board"), run, "fixture", "planner"), []);
    writeFileSync(join(home, ".e9g/run/board/f-20261027-0200-more.md"), "kind: bug\nsev: major\n\nMore.\n");
    assert.deepEqual(await importBoard(store, join(home, ".e9g/run/board"), run, "fixture", "planner"), ["15"]);
  });
});

describe("the planner's summary and the guard", () => {
  test("the summary names what's building, waiting and due", () => {
    const text = summary(
      [
        task({
          id: "1",
          status: "building",
          claim: { role: "builder", machine: "studio", worktree: "/w", at: "x", until: new Date(Date.now() + 30 * 60_000).toISOString() },
        }),
        task({ id: "2", status: "review", branch: "e9g/b2-x" }),
        task({ id: "3", status: "approved", kind: "journey" }),
        task({ id: "6", status: "done", parent: "3" }),
        task({ id: "4", status: "proposed" }),
        task({ id: "5", status: "triage" }),
      ],
      { approval: "thresholds" }
    );
    assert.match(text, /approved 1, building 1, review 1/);
    assert.match(text, /Journeys due their verification: #3 task 3/);
    assert.match(text, /#1 task 1 \(builder@studio, lease (29|30) min\)/);
    assert.match(text, /Waiting for review: #2 task 2 \[e9g\/b2-x\]/);
    assert.match(text, /Proposals for the approver: 1 \(#4 unscored\)/);
  });

  test("each role runs its own task commands", async () => {
    const home = makeRepo(team());
    await holds([
      bash(home, "builder", "e9g task claim", "allow"),
      bash(home, "builder", "e9g task submit 3", "allow"),
      bash(home, "builder", "e9g task add 'Dead button' --sev major --body x", "allow"),
      bash(home, "builder", "e9g task approve 3", "refuse"),
      bash(home, "builder", "e9g task score 3 --pain 3", "refuse"),
      bash(home, "approver", "e9g task approve 3 --note fits", "allow"),
      bash(home, "approver", "e9g task status 3 approved", "refuse"),
      bash(home, "planner", "e9g task status 3 rejected --reason dup", "allow"),
      bash(home, "planner", "e9g task approve 3", "allow"),
      bash(makeRepo(team({ approval: { findings: "approver" } })), "planner", "e9g task approve 3", "refuse"),
      bash(home, "reviewer", "e9g task claim", "refuse"),
      bash(home, "tester", "e9g task list --all", "allow"),
      // Without its instance's E9G_TEAM a command takes the caller for the operator: nobody unsets or clears it.
      bash(home, "planner", "E9G_TEAM= e9g task status 3 done", "refuse"),
      bash(home, "planner", "env -u E9G_TEAM e9g task add x --approved", "refuse"),
      bash(home, "planner", "unset E9G_TEAM; e9g task approve 3", "refuse"),
      bash(home, "builder", "env -i PATH=/usr/bin e9g task list", "refuse"),
      bash(home, "planner", 'touch "$E9G_RUN/idle"', "allow"),
      bash(home, "builder", "/usr/bin/env -u E9G_TEAM e9g task list", "refuse"),
      bash(home, "builder", "exec -c e9g task list", "refuse"),
      bash(home, "builder", "npx cross-env E9G_TEAM= e9g task list", "refuse"),
      bash(home, "builder", "E9G_DEBUG=1 npm test", "allow"),
      [home, "planner", "mcp__t3-code__delegate_task", { target: { providerInstanceId: "e9g-fixture-builder", environmentId: "other-mac" } }, "refuse"],
    ]);
  });
});

describe("review: risk and looking", () => {
  test("an approval says its risk; a UI change approved without screenshots is said so, not refused", async () => {
    const { home, as } = setup();
    git(home, "checkout", "-q", "-b", "e9g/b1-panel");
    const panel = Array.from({ length: 20 }, (_, i) => `export const line${i} = ${i};`).join("\n");
    const sha = commit(home, { "src/components/Panel.tsx": `${panel}\n` });
    git(home, "checkout", "-q", "e9g/next");
    assert.match((await e9g(["verdict", "review", "e9g/b1-panel", "approve", "--sha", sha], as("reviewer"))).out, /--risk low\|medium\|high/);
    const approved = await e9g(["verdict", "review", "e9g/b1-panel", "approve", "--sha", sha, "--risk", "low"], as("reviewer"));
    assert.equal(approved.code, 0, approved.out);
    assert.match(approved.out, /approved without screenshots, though it changes 20 lines of UI/);
    assert.equal(JSON.parse(readFileSync(join(home, ".e9g/run/state/reviews/e9g_b1-panel.json"), "utf8")).risk, "low");
    assert.equal(
      (await e9g(["verdict", "review", "e9g/b1-panel", "changes", "--sha", sha, "--note", "x"], as("reviewer"))).code,
      0,
      "changes say no risk"
    );
  });

  test("a change the reviewer judges high-risk merges only with its tests in the same branch", async () => {
    const { home, as, store } = setup();
    await store().tasks.createAs("1", newTask({ team: "fixture", title: "pay", kind: "feature", status: "review", by: "planner", branch: "e9g/b1-pay" }));
    git(home, "checkout", "-q", "-b", "e9g/b1-pay");
    const bare = commit(home, { "src/billing/pay.ts": "export const pay = (cents: number) => cents;\n" });
    git(home, "checkout", "-q", "e9g/next");
    assert.equal((await e9g(["verdict", "review", "e9g/b1-pay", "approve", "--sha", bare, "--risk", "high"], as("reviewer"))).code, 0);
    assert.equal((await store().tasks.get("1"))?.risk, "high");
    const refused = await e9g(["merge", "e9g/b1-pay"], as(null));
    assert.equal(refused.code, 2, refused.out);
    assert.match(refused.out, /high-risk, and it changes no tests/);
    git(home, "checkout", "-q", "e9g/b1-pay");
    const tested = commit(home, { "src/billing/pay.test.ts": "import { pay } from './pay.ts';\nif (pay(1) !== 1) throw new Error('pay');\n" });
    git(home, "checkout", "-q", "e9g/next");
    await e9g(["verdict", "review", "e9g/b1-pay", "approve", "--sha", tested, "--risk", "high"], as("reviewer"));
    assert.equal((await store().tasks.get("1"))?.sha, tested, "the approved commit is the task's round");
    const merged = await e9g(["merge", "e9g/b1-pay"], as(null));
    assert.equal(merged.code, 0, merged.out);
    assert.equal((await store().tasks.get("1"))?.status, "done", "merging what was approved closes it");
  });

  test("submit records whether the task touched UI and the team's critical paths", async () => {
    const { as, worktree, store } = setup(team({ critical: ["^src/billing/"] }));
    await store().tasks.createAs("1", newTask({ team: "fixture", title: "bill", kind: "feature", status: "approved", by: "planner" }));
    const tree = worktree("ui");
    assert.equal((await e9g(["task", "claim", "1"], as("builder", tree))).code, 0);
    git(tree, "branch", "-m", "e9g/b1-bill");
    commit(tree, { "src/billing/Invoice.tsx": "export const Invoice = () => null;\n" });
    assert.equal((await e9g(["task", "submit", "1"], as("builder", tree))).code, 0);
    const t = await store().tasks.get("1");
    assert.deepEqual([t?.ui, t?.critical], [true, ["^src/billing/"]]);
  });
});

describe("the audit's findings stay fixed", () => {
  test("importing at once, or after a stop, never doubles a ticket; padded numbers come across canonical", async () => {
    const { home, run } = setup();
    write(join(home, ".e9g/run/board"), {
      "007-login.md": "status: ready\nkind: bug\nsev: major\n\nLogin fails.\n",
      "8-logout.md": "status: closed\nkind: bug\n\nLogout.\n",
    });
    const store = fileStore(run, "fixture");
    const runs = await Promise.all([1, 2, 3].map(() => importBoard(store, join(home, ".e9g/run/board"), run, "fixture", "planner")));
    assert.equal(runs.flat().length, 2, JSON.stringify(runs));
    const all = await store.tasks.all();
    assert.deepEqual(
      all.map((t) => [t.id, t.status]),
      [
        ["7", "approved"],
        ["8", "done"],
      ]
    );
    // Stopped after making a task but before noting the file: noted now, not imported again.
    writeFileSync(join(run, "tasks", ".imported.json"), "[]");
    assert.deepEqual(await importBoard(store, join(home, ".e9g/run/board"), run, "fixture", "planner"), []);
    assert.equal((await store.tasks.all()).length, 2);
    assert.equal(await store.tasks.createAs("007", newTask({ team: "fixture", title: "x", kind: "bug", status: "triage", by: "planner" })), null);
  });

  test("a changes verdict only sends back a task in review; the limit counts rounds of rework", async () => {
    const { run } = setup();
    const store = fileStore(run, "fixture");
    const { changesRequested } = await import("../lib/tasks/ops.ts");
    await store.tasks.createAs("1", newTask({ team: "fixture", title: "a", kind: "feature", status: "done", by: "planner", branch: "e9g/b1-a" }));
    const done = await changesRequested(store, "1", { branch: "e9g/b1-a", note: "x", maxRounds: 3, by: "reviewer" });
    assert.match(done.skipped ?? "", /is done, not in review/);
    assert.equal((await store.tasks.get("1"))?.status, "done");
    await store.tasks.createAs("2", newTask({ team: "fixture", title: "b", kind: "feature", status: "review", by: "planner", branch: "e9g/b2-b" }));
    for (const round of [1, 2, 3]) {
      const { task } = await changesRequested(store, "2", { branch: "e9g/b2-b", note: `r${round}`, maxRounds: 3, by: "reviewer" });
      assert.equal(task?.status, "approved", `round ${round} is a rework`);
      await store.tasks.replace({ ...((await store.tasks.get("2")) as Task), status: "review" });
    }
    assert.equal((await changesRequested(store, "2", { branch: "e9g/b2-b", note: "r4", maxRounds: 3, by: "reviewer" })).task?.status, "blocked");
  });

  test("approval goes with a task back to the proposals, and a new score; journeys are done only once verified", async () => {
    const { as, store } = setup();
    await e9g(["task", "add", "Thing"], as("planner"));
    await e9g(["task", "score", "1", ...SCORE, ...GATE, "--confidence", "data", "--size", "S", "--why", "x"], as("planner"));
    await e9g(["task", "approve", "1"], as("approver"));
    // proposed → blocked → approved would be the planner approving its own.
    assert.equal((await e9g(["task", "status", "1", "proposed"], as("planner"))).code, 0);
    await e9g(["task", "status", "1", "blocked"], as("planner"));
    assert.match((await e9g(["task", "status", "1", "approved"], as("planner"))).out, /never approved/);
    await e9g(["task", "status", "1", "proposed"], as("planner"));
    await e9g(["task", "approve", "1"], as("approver"));
    assert.match(
      (await e9g(["task", "score", "1", ...SCORE, "--confidence", "data", "--size", "XL", "--why", "bigger"], as("planner"))).out,
      /back to proposed/
    );
    assert.deepEqual([(await store().tasks.get("1"))?.status, (await store().tasks.get("1"))?.approval], ["proposed", null]);
    await e9g(["task", "add", "Journey", "--kind", "journey"], as("planner"));
    assert.match((await e9g(["task", "status", "2", "done"], as("planner"))).out, /done once it's verified/);
    assert.match((await e9g(["task", "status", "1", "building"], as(null))).out, /only when a builder or tester claims it/, "not even the operator");
  });

  test("an approved task edited in what it is goes back for approving; a journey needs no approval of its own", async () => {
    const { as, store } = setup(team({ approval: { mode: "full" } }));
    await e9g(["task", "add", "Thing"], as("planner"));
    await e9g(["task", "score", "1", ...SCORE, ...GATE, "--confidence", "data", "--size", "S", "--why", "x"], as("planner"));
    await e9g(["task", "approve", "1"], as("approver"));
    assert.equal((await e9g(["task", "edit", "1", "--files", "src/a/"], as("planner"))).code, 0, "where it lands is shaping");
    assert.equal((await store().tasks.get("1"))?.status, "approved");
    assert.match((await e9g(["task", "edit", "1", "--body", "Something much bigger"], as("planner"))).out, /to be approved again/);
    assert.deepEqual([(await store().tasks.get("1"))?.status, (await store().tasks.get("1"))?.approval], ["proposed", null]);
    assert.match(
      (await e9g(["task", "score", "1", ...SCORE, "--asked", "x", "--confidence", "data", "--size", "S", "--why", "x"], as("planner"))).out,
      /all three/
    );
    // A journey only groups tasks: its tasks are approved on their own, and it's done once they are and it's verified.
    await e9g(["task", "add", "Checkout", "--kind", "journey"], as("planner"));
    await e9g(["task", "add", "Pay", "--parent", "2"], as("planner"));
    await e9g(["task", "score", "3", ...SCORE, ...GATE, "--confidence", "data", "--size", "S", "--why", "x"], as("planner"));
    assert.equal((await e9g(["task", "approve", "3"], as("approver"))).code, 0, "no journey approval first");
    assert.match((await e9g(["task", "status", "2", "done"], as("planner"))).out, /done once it's verified/);
    await update(store().tasks, "3", (t) => ({ ...t, status: "done" as const }));
    assert.equal((await e9g(["task", "status", "2", "done"], as("planner"))).code, 0, "its task done, the planner closes it");
    assert.match((await e9g(["task", "edit", "2", "--kind", "feature"], as("planner"))).out, /has tasks/);
  });

  test("text that starts with -- is text; --help prints the usage; the rules name CLAUDE.md only when there is one", async () => {
    const { home, as, store } = setup();
    assert.equal((await e9g(["task", "add", "--skip-common leaves out common words"], as("planner"))).code, 0);
    assert.equal((await store().tasks.get("1"))?.title, "--skip-common leaves out common words");
    const help = await e9g(["task", "add", "--help"], as("planner"));
    assert.deepEqual([help.code, /usage: e9g task/.test(help.out)], [0, true]);
    assert.equal((await e9g(["request", "list", "--help"], as("planner"))).code, 0);
    const { compile } = await import("../lib/prompts.ts");
    const { loadTeam } = await import("../lib/config.ts");
    assert.doesNotMatch(compile(loadTeam(home), "builder"), /`CLAUDE\.md`/, "this checkout has none");
    writeFileSync(join(home, "CLAUDE.md"), "# Rules\n");
    assert.match(compile(loadTeam(home), "builder"), /`CLAUDE\.md` \(the repository's own rules/);
  });

  test("options a subcommand doesn't read are refused; an agent's graph stays in the run folder", async () => {
    const { home, as } = setup();
    await e9g(["task", "add", "Thing"], as("planner"));
    assert.match((await e9g(["task", "status", "1", "rejected", "--sev", "minor"], as("planner"))).out, /takes --reason, not --sev/);
    assert.match((await e9g(["task", "graph", "--out", join(home, ".e9g/team.json")], as("reviewer"))).out, /run folder or \/tmp/);
    assert.equal((await e9g(["task", "graph", "--out", join(tmp(), "g.json")], as("reviewer"))).code, 0);
  });

  test("a rework is handed in changed, and a member that gives up hands its task back", async () => {
    const { home, run, as, worktree, store } = setup();
    await store().tasks.createAs("1", newTask({ team: "fixture", title: "a", kind: "feature", status: "approved", by: "planner" }));
    const tree = worktree("rw");
    await e9g(["task", "claim"], as("builder", tree));
    git(tree, "branch", "-m", "e9g/b1-a");
    const sha = commit(tree, { "src/a.ts": "a\n" });
    await e9g(["task", "submit", "1"], as("builder", tree));
    await store().tasks.replace({ ...((await store().tasks.get("1")) as Task), status: "approved", rounds: 1 });
    await e9g(["task", "claim", "1"], as("builder", tree));
    assert.match((await e9g(["task", "submit", "1"], as("builder", tree))).out, /the commit the reviewer asked changes on/);
    assert.equal(git(tree, "rev-parse", "HEAD"), sha);
    // A rework that doesn't build on its last round (a branch started over beside it) isn't handed in.
    git(tree, "checkout", "-q", "-B", "e9g/b1-a", "e9g/next");
    commit(tree, { "src/a.ts": "started over\n" });
    assert.match((await e9g(["task", "submit", "1"], as("builder", tree))).out, /doesn't hold the task's last round/);
    git(tree, "checkout", "-q", "-B", "e9g/b1-a", sha);
    // Three refused stops: the fourth lets it go, and the task goes back as blocked.
    const stop = () =>
      spawnSync(process.execPath, [join(import.meta.dirname, "..", "plugin", "hooks", "stop.ts")], {
        input: JSON.stringify({ session_id: "giving-up", cwd: tree, agent_type: "e9g:builder" }),
        env: { ...process.env, E9G_TEAM: "fixture", E9G_HOME_DIR: home, E9G_ROLE: "builder", E9G_RUN: run, CLAUDE_PROJECT_DIR: tree },
        encoding: "utf8",
      });
    for (let i = 0; i < 3; i++) assert.equal(stop().status, 2);
    const last = stop();
    assert.equal(last.status, 0);
    assert.match(last.stderr, /Task 1 went back as blocked/);
    assert.equal((await store().tasks.get("1"))?.status, "blocked");
  });
});
