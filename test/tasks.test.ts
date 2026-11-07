import { baseTeam, bash, commit, a6g, git, holds, makeRepo, tmp, write } from "./helpers.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { RawTeam } from "../lib/config.ts";
import { machineName } from "../lib/machine.ts";
import { fileStore } from "../lib/tasks/files.ts";
import { addTask } from "../lib/tasks/add.ts";
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
  nowIso,
  nextClaim,
  OPERATOR,
  priorityOf,
  type Score,
  statusRefusal,
  type Task,
  ticketOf,
} from "../lib/tasks/model.ts";
import { claimMark, closeMerged, expireClaims, importBoard, markClaim, renewClaims, settleWaits, summary } from "../lib/tasks/ops.ts";

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
  const run = tmp("a6g-run-");
  const as = (role: string | null, cwd = home) => ({
    cwd,
    env: role ? { A6G_HOME_DIR: home, A6G_TEAM: "fixture", A6G_ROLE: role, A6G_RUN: run } : { A6G_RUN: run },
  });
  // A member's own worktree, on a branch of its own, as T3 Code makes it.
  const worktree = (name: string) => {
    const dir = join(tmp("a6g-wt-"), name);
    git(home, "worktree", "add", "-q", "-b", `wt/${name}`, dir, "a6g/next");
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
    const VIAS: Via[] = ["status", "approve", "reject", "research", "escalate", "claim", "release", "submit", "changes", "merge", "expire", "settle"];
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
    assert.equal(branchFor(t, "builder", "a6g"), "a6g/b142-resume-a-paused-recording-after-reload");
    assert.equal(branchFor(t, "tester", "team"), "team/t-142-resume-a-paused-recording-after-reload");
    assert.equal(ticketOf("a6g/b142-resume", "a6g"), "142");
    assert.equal(ticketOf("a6g/t-142-resume", "a6g"), "142");
    assert.equal(ticketOf("a6g/b12-x/v2-y", "a6g"), "12");
    assert.equal(ticketOf("a6g/topic", "a6g"), undefined);
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
    const store = fileStore(tmp("a6g-run-"), "fixture");
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
    const results = await Promise.all(trees.map((dir) => a6g(["task", "claim"], as("builder", dir))));
    assert.deepEqual(results.map((r) => r.code).sort(), [0, 0, 0, 3], results.map((r) => r.out).join("\n"));
    const claimed = (await store.tasks.all()).filter((t) => t.status === "building");
    assert.equal(new Set(claimed.map((t) => t.claim?.worktree)).size, 3);
  });
});

describe("a6g task, from proposal to merge", () => {
  test("the planner proposes and scores, the approver approves, a builder claims, submits and the merge closes it", async () => {
    const { home, run, as, worktree, store } = setup();
    // Proposals need the gate and a score; the planner can't approve its own.
    assert.equal((await a6g(["task", "add", "Resume a paused recording"], as("planner"))).code, 0);
    assert.match(
      (await a6g(["task", "score", "1", ...SCORE, "--confidence", "asks", "--size", "M", "--why", "users lose work"], as("planner"))).out,
      /passes the gate first/
    );
    const scored = await a6g(["task", "score", "1", ...SCORE, ...GATE, "--confidence", "asks", "--size", "M", "--why", "users lose work"], as("planner"));
    assert.equal(scored.code, 0, scored.out);
    assert.equal(
      (await store().tasks.get("1"))?.priority,
      priorityOf({ pain: 3, reach: 2, revenue: 1, wow: 2, distribution: 1, leverage: 2, urgency: 1, risk: 0, confidence: "asks", size: "M", why: "" })
    );
    assert.equal((await a6g(["task", "status", "1", "approved"], as("planner"))).code, 2);
    assert.equal((await a6g(["task", "approve", "1"], as("builder"))).code, 2);
    assert.equal((await a6g(["task", "approve", "1", "--note", "fits the direction"], as("approver"))).code, 0);

    // A builder claims it in its own worktree, not the team's checkout, and hands it in on a branch with its number.
    assert.match((await a6g(["task", "claim"], as("builder"))).out, /own worktree/);
    const tree = worktree("b1");
    const claimed = await a6g(["task", "claim"], as("builder", tree));
    assert.equal(claimed.code, 0, claimed.out);
    assert.match(claimed.out, /git branch -m a6g\/b1-resume-a-paused-recording/);
    assert.match((await a6g(["task", "claim"], as("builder", tree))).out, /holds task 1 already/);
    assert.ok(existsSync(claimMark(run, tree)));
    assert.match((await a6g(["task", "submit", "1"], as("builder", tree))).out, /name your branch/);
    git(tree, "branch", "-m", "a6g/b1-resume-a-paused-recording");
    assert.match((await a6g(["task", "submit", "1"], as("builder", tree))).out, /nothing beyond/);
    commit(tree, { "src/resume.ts": "export const resume = true;\n" });
    const submitted = await a6g(["task", "submit", "1"], as("builder", tree));
    assert.equal(submitted.code, 0, submitted.out);
    let t = await store().tasks.get("1");
    assert.deepEqual([t?.status, t?.branch, t?.claim], ["review", "a6g/b1-resume-a-paused-recording", null]);
    assert.ok(!existsSync(claimMark(run, tree)));

    // Changes send it back for another round; the next builder works on the same branch.
    const sha = git(tree, "rev-parse", "HEAD");
    git(tree, "checkout", "-q", "--detach");
    assert.equal(
      (await a6g(["verdict", "review", "a6g/b1-resume-a-paused-recording", "changes", "--sha", sha, "--note", "handle a second reload"], as("reviewer")))
        .code,
      0
    );
    t = await store().tasks.get("1");
    assert.deepEqual([t?.status, t?.rounds], ["approved", 1]);
    assert.match(t?.notes.at(-1)?.text ?? "", /round 1 of 3\): handle a second reload/);
    const again = await a6g(["task", "claim", "1"], as("builder", worktree("b2")));
    assert.match(again.out, /git checkout a6g\/b1-resume-a-paused-recording/);

    // The merge queue closes it.
    await store().tasks.replace({ ...((await store().tasks.get("1")) as Task), status: "review", claim: null });
    assert.equal(
      (await a6g(["verdict", "review", "a6g/b1-resume-a-paused-recording", "approve", "--sha", sha, "--risk", "medium"], as("reviewer"))).code,
      0
    );
    const merged = await a6g(["merge", "a6g/b1-resume-a-paused-recording"], as("planner"));
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
      await a6g(["task", "add", title, "--kind", kind], as("planner"));
      const id = String((await store().tasks.all()).length);
      await a6g(["task", "score", id, ...SCORE, ...GATE, "--confidence", "data", "--size", size, "--why", "x"], as("planner"));
    }
    assert.equal((await a6g(["task", "approve", "1"], as("approver"))).code, 0);
    assert.match((await a6g(["task", "approve", "2"], as("approver"))).out, /over this team's M.*escalate/);
    assert.match((await a6g(["task", "list"], as("planner"))).out, /#3 .*journey/);
    assert.doesNotMatch((await a6g(["task", "show", "3"], as("planner"))).out, /approved by/, "nobody had to approve the journey");
    assert.match(
      (await a6g(["task", "escalate", "2", "--reason", "it changes scope"], as("approver"))).out,
      /--recommend/,
      "raised without a recommendation"
    );
    assert.equal(
      (await a6g(["task", "escalate", "2", "--reason", "it changes scope", "--recommend", "approve it: it's the launch"], as("approver"))).code,
      0
    );
    assert.deepEqual((await store().tasks.get("2"))?.ask, {
      reason: "it changes scope",
      recommendation: "approve it: it's the launch",
      by: "approver",
      at: (await store().tasks.get("2"))?.ask?.at,
    });
    assert.equal((await store().tasks.get("2"))?.status, "question");
    assert.equal((await a6g(["task", "approve", "2"], as(null))).code, 0, "the operator answers it");
    assert.equal((await store().tasks.get("2"))?.approval?.by, OPERATOR);
  });

  test("approval: operator mode keeps the approver out; full lets it approve anything", async () => {
    const operator = setup(team({ approval: { mode: "operator" } }));
    await a6g(["task", "add", "Thing"], operator.as("planner"));
    await a6g(["task", "score", "1", ...SCORE, ...GATE, "--confidence", "data", "--size", "XL", "--why", "x"], operator.as("planner"));
    assert.match((await a6g(["task", "approve", "1"], operator.as("approver"))).out, /decided by the operator/);
    const full = setup(team({ approval: { mode: "full" } }));
    await a6g(["task", "add", "Thing"], full.as("planner"));
    await a6g(["task", "score", "1", ...SCORE, ...GATE, "--confidence", "data", "--size", "XL", "--why", "x"], full.as("planner"));
    assert.equal((await a6g(["task", "approve", "1"], full.as("approver"))).code, 0);
  });

  test("a finding the planner rewrote is its own; a journey isn't the approver's; a task being built isn't re-scored", async () => {
    const { as, store } = setup(team({ approval: { mode: "full" } }));
    const body = ["--body", "Steps: open /x, press Save. Nothing happens; it should save."];
    await a6g(["task", "add", "Typo in the footer", "--kind", "bug", "--sev", "minor", ...body], as("builder"));
    await a6g(["task", "edit", "1", "--title", "Rewrite billing for a new provider"], as("planner"));
    assert.match((await a6g(["task", "approve", "1"], as("planner"))).out, /doesn't approve its own/, "rewritten, it's the planner's");
    await a6g(["task", "add", "Checkout", "--kind", "journey"], as("planner"));
    assert.match((await a6g(["task", "approve", "2"], as("approver"))).out, /is a journey/);
    assert.match((await a6g(["task", "reject", "2", "--reason", "x"], as("approver"))).out, /is a journey/);
    // The operator setting a task approved approves it, so a claim of it can be handed back.
    await a6g(["task", "add", "Thing"], as("planner"));
    assert.equal((await a6g(["task", "status", "3", "approved"], as(null))).code, 0);
    assert.equal((await store().tasks.get("3"))?.approval?.by, OPERATOR);
    await update(store().tasks, "3", (t) => ({
      ...t,
      status: "building" as const,
      claim: { role: "builder", machine: "m", worktree: "/w", at: "x", until: "y" },
    }));
    assert.match(
      (await a6g(["task", "score", "3", ...SCORE, ...GATE, "--confidence", "data", "--size", "S", "--why", "x"], as("planner"))).out,
      /once it's back/
    );
    assert.equal((await a6g(["task", "release", "3"], as("planner"))).code, 0);
    assert.equal((await store().tasks.get("3"))?.status, "approved");
  });

  test("the planner approves a finding another member filed, never its own proposal", async () => {
    const { as, store } = setup();
    const body = ["--body", "Steps: open /x, press Save. Nothing happens; it should save."];
    await a6g(["task", "add", "Save does nothing", "--sev", "major", ...body], as("tester"));
    assert.equal((await a6g(["task", "approve", "1", "--note", "real"], as("planner"))).code, 0);
    assert.deepEqual([(await store().tasks.get("1"))?.status, (await store().tasks.get("1"))?.approval?.by], ["approved", "planner"]);
    await a6g(["task", "add", "My idea"], as("planner"));
    await a6g(["task", "score", "2", ...SCORE, ...GATE, "--confidence", "data", "--size", "S", "--why", "x"], as("planner"));
    assert.match((await a6g(["task", "approve", "2"], as("planner"))).out, /doesn't approve its own/);
    await a6g(["task", "add", "Bug the planner saw", "--kind", "bug", "--sev", "minor"], as("planner"));
    assert.match((await a6g(["task", "approve", "3"], as("planner"))).out, /doesn't approve its own/, "nor a finding it filed itself");
    const strict = setup(team({ approval: { findings: "approver" } }));
    await a6g(["task", "add", "Save does nothing", "--sev", "major", ...body], strict.as("tester"));
    assert.match((await a6g(["task", "approve", "1"], strict.as("planner"))).out, /approver decides findings too/);
  });

  test("findings go to triage with a severity and a body; members can't shape tasks", async () => {
    const { as, store } = setup();
    assert.match((await a6g(["task", "add", "Button is dead"], as("tester"))).out, /--sev/);
    assert.match((await a6g(["task", "add", "Button is dead", "--sev", "major"], as("tester"))).out, /what happened/);
    const filed = await a6g(
      ["task", "add", "Button is dead", "--sev", "major", "--body", "Steps: open /x, press Save. Nothing happens; it should save."],
      as("tester")
    );
    assert.equal(filed.code, 0, filed.out);
    assert.deepEqual([(await store().tasks.get("1"))?.status, (await store().tasks.get("1"))?.kind], ["triage", "bug"]);
    assert.equal((await a6g(["task", "edit", "1", "--title", "x"], as("tester"))).code, 2);
    assert.equal((await a6g(["task", "note", "1", "also on phone"], as("tester"))).code, 0);
    assert.equal((await a6g(["task", "status", "1", "proposed", "--reason", "real"], as("planner"))).code, 0);
    assert.match((await a6g(["task", "edit", "1", "--after", "1"], as("planner"))).out, /other than this one/);
  });

  test("the web app adds through the same code: the operator proposes or approves, a stakeholder suggests for triage", async () => {
    const { run } = setup();
    const store = fileStore(run, "fixture");
    const journey = await addTask(store, "fixture", { title: "Checkout", kind: "journey" }, OPERATOR);
    assert.deepEqual([journey.status, journey.by, journey.approval], ["proposed", OPERATOR, null]);
    const approved = await addTask(store, "fixture", { title: "Pay by card", kind: "feature", parent: `#${journey.id}`, approved: true }, OPERATOR);
    assert.equal(approved.status, "approved");
    assert.equal(approved.parent, journey.id);
    assert.deepEqual(approved.approval?.by, OPERATOR);
    // Only the operator adds work approved: the planner's is a proposal whatever it asks for.
    assert.equal((await addTask(store, "fixture", { title: "x", kind: "feature", approved: true }, "planner")).status, "proposed");

    const steps = "Steps: open the cart, press Pay. Nothing happens; it should pay.";
    const suggested = await addTask(
      store,
      "fixture",
      { title: "Pay does nothing", kind: "bug", severity: "major", body: steps, after: [approved.id], from: "s2" },
      "stakeholder"
    );
    assert.deepEqual([suggested.status, suggested.by, suggested.from, suggested.after], ["triage", "stakeholder", "s2", [approved.id]]);
    assert.equal(suggested.history[0]?.what, "added as triage, from the web app by stakeholder s2");
    assert.equal(approved.history[0]?.what, "added as approved", "the CLI's own adds say nothing more");
    // A suggestion is held to a member's finding: a severity for a bug, and a body that says what happened.
    await assert.rejects(addTask(store, "fixture", { title: "Broken", kind: "bug", body: steps }, "stakeholder"), /--sev/);
    await assert.rejects(addTask(store, "fixture", { title: "Broken", kind: "feature", body: "short" }, "stakeholder"), /what happened/);
    await assert.rejects(addTask(store, "fixture", { title: "x", kind: "feature", parent: approved.id }, OPERATOR), /isn't one/);
    await assert.rejects(addTask(store, "fixture", { title: "x", kind: "feature", after: ["99"] }, OPERATOR), /no task 99/);
    await assert.rejects(addTask(store, "fixture", { title: "  ", kind: "feature" }, OPERATOR), /title/);
    // Promoting a request is the planner's (and the operator's).
    await assert.rejects(addTask(store, "fixture", { title: "x", kind: "feature", body: steps, request: "r1" }, "stakeholder"), /planner's/);
    assert.equal((await store.tasks.all()).length, 4);
    // The planner never approves a suggestion itself, even a bug with its severity: the approver or the operator does.
    const ctx = { all: await store.tasks.all(), approval: { mode: "thresholds" as const, maxSize: "M" as const, findings: "planner" as const } };
    assert.match(moveRefusal(suggested, "approved", "approve", "planner", ctx) ?? "", /suggested from the web app/);
    assert.equal(moveRefusal(suggested, "proposed", "status", "planner", ctx), null);
    assert.equal(moveRefusal(suggested, "approved", "approve", OPERATOR, ctx), null);
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
    assert.deepEqual(await closeMerged(store, ["3", "4", "99"], { branch: "a6g/b3-b", sha: "abc" }), {
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
    assert.equal((await a6g(["task", "graph"], as("builder"))).code, 0);
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

describe("raising to the operator, and waiting on other tasks", () => {
  test("a question carries why it's the operator's and the team's recommendation; the operator raising one gives the reason", async () => {
    const { as, store } = setup();
    for (const title of ["Which consent words", "Open the staff pages", "Mine to think about"]) await a6g(["task", "add", title], as("planner"));
    assert.match((await a6g(["task", "status", "1", "question"], as("planner"))).out, /--reason/);
    assert.match((await a6g(["task", "status", "1", "question", "--reason", "consent wording is the operator's"], as("planner"))).out, /--recommend/);
    assert.equal((await store().tasks.get("1"))?.status, "proposed", "refused, nothing moved");
    const raised = await a6g(
      ["task", "status", "1", "question", "--reason", "consent wording is the operator's", "--recommend", "(b) the plain draft"],
      as("planner")
    );
    assert.equal(raised.code, 0, raised.out);
    assert.match(raised.out, /raised to the operator/);
    assert.deepEqual(
      [(await store().tasks.get("1"))?.ask?.reason, (await store().tasks.get("1"))?.ask?.recommendation, (await store().tasks.get("1"))?.ask?.by],
      ["consent wording is the operator's", "(b) the plain draft", "planner"]
    );
    assert.match((await a6g(["task", "show", "1"], as("planner"))).out, /the team recommends: \(b\) the plain draft/);
    // A recommendation that changed, or one added to a question raised before they were required.
    assert.equal(
      (await a6g(["task", "ask", "1", "--reason", "consent wording is the operator's", "--recommend", "(a) the operator's words"], as("planner"))).code,
      0
    );
    assert.equal((await store().tasks.get("1"))?.ask?.recommendation, "(a) the operator's words");
    assert.match((await a6g(["task", "ask", "2", "--reason", "x", "--recommend", "y"], as("planner"))).out, /only a question or a blocked task/);
    assert.match((await a6g(["task", "ask", "1", "--reason", "x", "--recommend", "y"], as("builder"))).out, /the planner and the approver raise/);
    // The operator raising one to themselves needn't recommend.
    assert.equal((await a6g(["task", "status", "3", "question", "--reason", "I want to think about it"], as(null))).code, 0);
    // Moving on clears the ask.
    assert.equal((await a6g(["task", "status", "1", "proposed"], as("planner"))).code, 0);
    assert.equal((await store().tasks.get("1"))?.ask, null);
  });

  test("a block says what it's on: a reason (the planner's), raised with a recommendation, or other tasks it waits on", async () => {
    const { as, store } = setup();
    for (const title of ["Ship to Canada", "Handover log rows", "Handover log filter"]) await a6g(["task", "add", title], as("planner"));
    assert.match((await a6g(["task", "status", "1", "blocked"], as("planner"))).out, /--reason "…", or --waits-on/);
    assert.equal((await a6g(["task", "status", "1", "blocked", "--reason", "the carrier's sandbox is down"], as("planner"))).code, 0);
    assert.equal((await store().tasks.get("1"))?.ask, null, "the planner's to sort, not raised");
    assert.equal((await a6g(["task", "status", "1", "proposed"], as("planner"))).code, 0);
    assert.equal(
      (await a6g(["task", "status", "1", "blocked", "--reason", "only the operator holds the key", "--recommend", "add it to the vault"], as("planner")))
        .code,
      0
    );
    assert.equal((await store().tasks.get("1"))?.ask?.recommendation, "add it to the vault");
    assert.match((await a6g(["task", "status", "2", "blocked", "--waits-on", "2"], as("planner"))).out, /can't wait on itself/);
    assert.match((await a6g(["task", "status", "2", "blocked", "--waits-on", "99"], as("planner"))).out, /no task #99/);
    assert.match((await a6g(["task", "status", "2", "blocked", "--waits-on", "3", "--then", "later"], as("planner"))).out, /--then close/);
    const folded = await a6g(
      ["task", "status", "2", "blocked", "--waits-on", "#3", "--then", "close", "--reason", "folded into #3: the same component"],
      as("planner")
    );
    assert.equal(folded.code, 0, folded.out);
    assert.match(folded.out, /waiting on #3 \(then close\)/);
    assert.deepEqual([(await store().tasks.get("2"))?.wait?.on, (await store().tasks.get("2"))?.wait?.then], [["3"], "close"]);
    assert.match((await a6g(["task", "show", "2"], as("planner"))).out, /waits on #3, then closes \(folded into them\)/);
    // A task parked before it could say so says it in place: what it waits on, or that it's the operator's now.
    assert.equal((await a6g(["task", "status", "1", "blocked", "--waits-on", "3", "--reason", "the key comes with #3"], as(null))).code, 0);
    assert.deepEqual(
      [(await store().tasks.get("1"))?.status, (await store().tasks.get("1"))?.wait?.on, (await store().tasks.get("1"))?.ask],
      ["blocked", ["3"], null]
    );
    assert.match((await a6g(["task", "status", "1", "blocked", "--waits-on", "3"], as("builder"))).out, /only the planner/);
  });

  test("a task waiting on others closes, goes back to work or back to the planner as they settle, at the merge or the watchdog's run", async () => {
    const run = tmp("a6g-run-");
    const store = fileStore(run, "fixture");
    const add = (fields: Partial<Task> & Pick<Task, "title" | "status">) =>
      store.tasks.create(newTask({ team: "fixture", kind: "feature", by: "planner", ...fields }));
    const wait = (on: string[], then: "close" | "resume") => ({ on, then, by: "planner", at: nowIso() });
    const fix = await add({ title: "Handover log filter", status: "approved", approval: { by: "approver", at: "x", note: "" } });
    const folded = await add({ title: "Handover log rows", status: "blocked", wait: wait([fix.id], "close") });
    const after = await add({
      title: "Export the log",
      status: "blocked",
      approval: { by: "approver", at: "x", note: "" },
      wait: wait([fix.id], "resume"),
    });
    const never = await add({ title: "Print the log", status: "blocked", wait: wait([fix.id], "resume") });
    const dropped = await add({ title: "Old idea", status: "proposed" });
    const orphan = await add({ title: "Follows the old idea", status: "blocked", wait: wait([dropped.id], "close") });
    // Nothing moves while what they wait on is still going.
    assert.deepEqual(await settleWaits(store, WATCHDOG), []);
    // The merge closes the fix and what was folded into it; what waited goes back to work, or back to the planner.
    const merged = await closeMerged(store, [fix.id], { branch: "a6g/b1-filter", sha: "abc" });
    assert.deepEqual(merged.closed, [fix.id, folded.id]);
    const now = async (id: string) => (await store.tasks.get(id))?.status;
    assert.deepEqual([await now(folded.id), await now(after.id), await now(never.id)], ["done", "approved", "proposed"]);
    assert.match((await store.tasks.get(folded.id))?.history.at(-1)?.what ?? "", /done with #1, which it was folded into/);
    assert.equal((await store.tasks.get(folded.id))?.wait, null);
    // A rejected one sends what waited on it back to the planner.
    await update(store.tasks, dropped.id, (t) => ({ ...t, status: "rejected" as const }));
    assert.deepEqual(
      (await settleWaits(store, WATCHDOG)).map((s) => [s.id, s.to]),
      [[orphan.id, "proposed"]]
    );
    assert.match((await store.tasks.get(orphan.id))?.history.at(-1)?.what ?? "", /rejected or removed: the planner decides it again/);
    // Only the merge queue and the watchdog settle, and only as the wait says.
    const blockedAgain = await add({ title: "Waits on nothing", status: "blocked" });
    assert.match(moveRefusal(blockedAgain, "done", "settle", WATCHDOG, { all: await store.tasks.all() }) ?? "", /waits on no other task/);
    assert.match(moveRefusal(blockedAgain, "done", "settle", "planner", { all: [] }) ?? "", /doesn't settle tasks/);
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
    assert.equal((await a6g(["task", "claim"], as("builder", tree))).code, 0);
    const stop = () =>
      spawnSync(process.execPath, [join(import.meta.dirname, "..", "plugin", "hooks", "stop.ts")], {
        input: JSON.stringify({ session_id: `s-${Math.random()}`, cwd: tree, agent_type: "a6g:builder" }),
        env: { ...process.env, A6G_TEAM: "fixture", A6G_HOME_DIR: home, A6G_ROLE: "builder", A6G_RUN: run, CLAUDE_PROJECT_DIR: tree },
        encoding: "utf8",
      });
    const idle = stop();
    assert.equal(idle.status, 2, idle.stderr);
    assert.match(idle.stderr, /a6g task release 1 --blocked/);
    git(tree, "branch", "-m", "a6g/b1-a");
    commit(tree, { "src/a.ts": "a\n" });
    const built = stop();
    assert.equal(built.status, 2);
    assert.match(built.stderr, /a6g task submit 1/);
    assert.equal((await a6g(["task", "submit", "1"], as("builder", tree))).code, 0);
    assert.equal(stop().status, 0);
  });
});

describe("a 0.3 files board", () => {
  test("comes across ticket by ticket, keeping numbers, once", async () => {
    const { home, run, as } = setup();
    write(join(home, ".a6g/run/board"), {
      "12-save-fails.md": "status: ready\nkind: bug\nsev: major\npage: editor\n\n# Save fails on phone\n\nSteps…\n",
      "13-checkout.md": "status: done\nkind: feature\n\nCheckout works.\n",
      "f-20261027-0100-dead-link.md": "status: triage\nkind: ux\nsev: minor\n\nThe footer link is dead.\n",
    });
    const listed = await a6g(["task", "list", "--all"], as("planner"));
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
    assert.deepEqual(await importBoard(store, join(home, ".a6g/run/board"), run, "fixture", "planner"), []);
    writeFileSync(join(home, ".a6g/run/board/f-20261027-0200-more.md"), "kind: bug\nsev: major\n\nMore.\n");
    assert.deepEqual(await importBoard(store, join(home, ".a6g/run/board"), run, "fixture", "planner"), ["15"]);
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
        task({ id: "2", status: "review", branch: "a6g/b2-x" }),
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
    assert.match(text, /Waiting for review: #2 task 2 \[a6g\/b2-x\]/);
    assert.match(text, /Proposals for the approver: 1 \(#4 unscored\)/);
  });

  test("each role runs its own task commands", async () => {
    const home = makeRepo(team());
    await holds([
      bash(home, "builder", "a6g task claim", "allow"),
      bash(home, "builder", "a6g task submit 3", "allow"),
      bash(home, "builder", "a6g task add 'Dead button' --sev major --body x", "allow"),
      bash(home, "builder", "a6g task approve 3", "refuse"),
      bash(home, "builder", "a6g task score 3 --pain 3", "refuse"),
      bash(home, "approver", "a6g task approve 3 --note fits", "allow"),
      bash(home, "approver", "a6g task status 3 approved", "refuse"),
      bash(home, "planner", "a6g task status 3 rejected --reason dup", "allow"),
      bash(home, "planner", "a6g task approve 3", "allow"),
      bash(makeRepo(team({ approval: { findings: "approver" } })), "planner", "a6g task approve 3", "refuse"),
      bash(home, "reviewer", "a6g task claim", "refuse"),
      bash(home, "tester", "a6g task list --all", "allow"),
      // Without its instance's A6G_TEAM a command takes the caller for the operator: nobody unsets or clears it.
      bash(home, "planner", "A6G_TEAM= a6g task status 3 done", "refuse"),
      bash(home, "planner", "env -u A6G_TEAM a6g task add x --approved", "refuse"),
      bash(home, "planner", "unset A6G_TEAM; a6g task approve 3", "refuse"),
      bash(home, "builder", "env -i PATH=/usr/bin a6g task list", "refuse"),
      bash(home, "planner", 'touch "$A6G_RUN/idle"', "allow"),
      bash(home, "builder", "/usr/bin/env -u A6G_TEAM a6g task list", "refuse"),
      bash(home, "builder", "exec -c a6g task list", "refuse"),
      bash(home, "builder", "npx cross-env A6G_TEAM= a6g task list", "refuse"),
      bash(home, "builder", "A6G_DEBUG=1 npm test", "allow"),
      [home, "planner", "mcp__t3-code__delegate_task", { target: { providerInstanceId: "a6g-fixture-builder", environmentId: "other-mac" } }, "refuse"],
    ]);
  });
});

describe("review: risk and looking", () => {
  test("an approval says its risk; a UI change approved without screenshots is said so, not refused", async () => {
    const { home, as } = setup();
    git(home, "checkout", "-q", "-b", "a6g/b1-panel");
    const panel = Array.from({ length: 20 }, (_, i) => `export const line${i} = ${i};`).join("\n");
    const sha = commit(home, { "src/components/Panel.tsx": `${panel}\n` });
    git(home, "checkout", "-q", "a6g/next");
    assert.match((await a6g(["verdict", "review", "a6g/b1-panel", "approve", "--sha", sha], as("reviewer"))).out, /--risk low\|medium\|high/);
    const approved = await a6g(["verdict", "review", "a6g/b1-panel", "approve", "--sha", sha, "--risk", "low"], as("reviewer"));
    assert.equal(approved.code, 0, approved.out);
    assert.match(approved.out, /approved without screenshots, though it changes 20 lines of UI/);
    assert.equal(JSON.parse(readFileSync(join(home, ".a6g/run/state/reviews/a6g_b1-panel.json"), "utf8")).risk, "low");
    assert.equal(
      (await a6g(["verdict", "review", "a6g/b1-panel", "changes", "--sha", sha, "--note", "x"], as("reviewer"))).code,
      0,
      "changes say no risk"
    );
  });

  test("a change the reviewer judges high-risk merges only with its tests in the same branch", async () => {
    const { home, as, store } = setup();
    await store().tasks.createAs("1", newTask({ team: "fixture", title: "pay", kind: "feature", status: "review", by: "planner", branch: "a6g/b1-pay" }));
    git(home, "checkout", "-q", "-b", "a6g/b1-pay");
    const bare = commit(home, { "src/billing/pay.ts": "export const pay = (cents: number) => cents;\n" });
    git(home, "checkout", "-q", "a6g/next");
    assert.equal((await a6g(["verdict", "review", "a6g/b1-pay", "approve", "--sha", bare, "--risk", "high"], as("reviewer"))).code, 0);
    assert.equal((await store().tasks.get("1"))?.risk, "high");
    const refused = await a6g(["merge", "a6g/b1-pay"], as(null));
    assert.equal(refused.code, 2, refused.out);
    assert.match(refused.out, /high-risk, and it changes no tests/);
    git(home, "checkout", "-q", "a6g/b1-pay");
    const tested = commit(home, { "src/billing/pay.test.ts": "import { pay } from './pay.ts';\nif (pay(1) !== 1) throw new Error('pay');\n" });
    git(home, "checkout", "-q", "a6g/next");
    await a6g(["verdict", "review", "a6g/b1-pay", "approve", "--sha", tested, "--risk", "high"], as("reviewer"));
    assert.equal((await store().tasks.get("1"))?.sha, tested, "the approved commit is the task's round");
    const merged = await a6g(["merge", "a6g/b1-pay"], as(null));
    assert.equal(merged.code, 0, merged.out);
    assert.equal((await store().tasks.get("1"))?.status, "done", "merging what was approved closes it");
  });

  test("submit records whether the task touched UI and the team's critical paths", async () => {
    const { as, worktree, store } = setup(team({ critical: ["^src/billing/"] }));
    await store().tasks.createAs("1", newTask({ team: "fixture", title: "bill", kind: "feature", status: "approved", by: "planner" }));
    const tree = worktree("ui");
    assert.equal((await a6g(["task", "claim", "1"], as("builder", tree))).code, 0);
    git(tree, "branch", "-m", "a6g/b1-bill");
    commit(tree, { "src/billing/Invoice.tsx": "export const Invoice = () => null;\n" });
    assert.equal((await a6g(["task", "submit", "1"], as("builder", tree))).code, 0);
    const t = await store().tasks.get("1");
    assert.deepEqual([t?.ui, t?.critical], [true, ["^src/billing/"]]);
  });
});

describe("the audit's findings stay fixed", () => {
  test("importing at once, or after a stop, never doubles a ticket; padded numbers come across canonical", async () => {
    const { home, run } = setup();
    write(join(home, ".a6g/run/board"), {
      "007-login.md": "status: ready\nkind: bug\nsev: major\n\nLogin fails.\n",
      "8-logout.md": "status: closed\nkind: bug\n\nLogout.\n",
    });
    const store = fileStore(run, "fixture");
    const runs = await Promise.all([1, 2, 3].map(() => importBoard(store, join(home, ".a6g/run/board"), run, "fixture", "planner")));
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
    assert.deepEqual(await importBoard(store, join(home, ".a6g/run/board"), run, "fixture", "planner"), []);
    assert.equal((await store.tasks.all()).length, 2);
    assert.equal(await store.tasks.createAs("007", newTask({ team: "fixture", title: "x", kind: "bug", status: "triage", by: "planner" })), null);
  });

  test("a changes verdict only sends back a task in review; the limit counts rounds of rework", async () => {
    const { run } = setup();
    const store = fileStore(run, "fixture");
    const { changesRequested } = await import("../lib/tasks/ops.ts");
    await store.tasks.createAs("1", newTask({ team: "fixture", title: "a", kind: "feature", status: "done", by: "planner", branch: "a6g/b1-a" }));
    const done = await changesRequested(store, "1", { branch: "a6g/b1-a", note: "x", maxRounds: 3, by: "reviewer" });
    assert.match(done.skipped ?? "", /is done, not in review/);
    assert.equal((await store.tasks.get("1"))?.status, "done");
    await store.tasks.createAs("2", newTask({ team: "fixture", title: "b", kind: "feature", status: "review", by: "planner", branch: "a6g/b2-b" }));
    for (const round of [1, 2, 3]) {
      const { task } = await changesRequested(store, "2", { branch: "a6g/b2-b", note: `r${round}`, maxRounds: 3, by: "reviewer" });
      assert.equal(task?.status, "approved", `round ${round} is a rework`);
      await store.tasks.replace({ ...((await store.tasks.get("2")) as Task), status: "review" });
    }
    assert.equal((await changesRequested(store, "2", { branch: "a6g/b2-b", note: "r4", maxRounds: 3, by: "reviewer" })).task?.status, "blocked");
  });

  test("approval goes with a task back to the proposals, and a new score; journeys are done only once verified", async () => {
    const { as, store } = setup();
    await a6g(["task", "add", "Thing"], as("planner"));
    await a6g(["task", "score", "1", ...SCORE, ...GATE, "--confidence", "data", "--size", "S", "--why", "x"], as("planner"));
    await a6g(["task", "approve", "1"], as("approver"));
    // proposed → blocked → approved would be the planner approving its own.
    assert.equal((await a6g(["task", "status", "1", "proposed"], as("planner"))).code, 0);
    await a6g(["task", "status", "1", "blocked", "--reason", "waits for the design"], as("planner"));
    assert.match((await a6g(["task", "status", "1", "approved"], as("planner"))).out, /never approved/);
    await a6g(["task", "status", "1", "proposed"], as("planner"));
    await a6g(["task", "approve", "1"], as("approver"));
    assert.match(
      (await a6g(["task", "score", "1", ...SCORE, "--confidence", "data", "--size", "XL", "--why", "bigger"], as("planner"))).out,
      /back to proposed/
    );
    assert.deepEqual([(await store().tasks.get("1"))?.status, (await store().tasks.get("1"))?.approval], ["proposed", null]);
    await a6g(["task", "add", "Journey", "--kind", "journey"], as("planner"));
    assert.match((await a6g(["task", "status", "2", "done"], as("planner"))).out, /done once it's verified/);
    assert.match((await a6g(["task", "status", "1", "building"], as(null))).out, /only when a builder or tester claims it/, "not even the operator");
  });

  test("an approved task edited in what it is goes back for approving; a journey needs no approval of its own", async () => {
    const { as, store } = setup(team({ approval: { mode: "full" } }));
    await a6g(["task", "add", "Thing"], as("planner"));
    await a6g(["task", "score", "1", ...SCORE, ...GATE, "--confidence", "data", "--size", "S", "--why", "x"], as("planner"));
    await a6g(["task", "approve", "1"], as("approver"));
    assert.equal((await a6g(["task", "edit", "1", "--files", "src/a/"], as("planner"))).code, 0, "where it lands is shaping");
    assert.equal((await store().tasks.get("1"))?.status, "approved");
    assert.match((await a6g(["task", "edit", "1", "--body", "Something much bigger"], as("planner"))).out, /to be approved again/);
    assert.deepEqual([(await store().tasks.get("1"))?.status, (await store().tasks.get("1"))?.approval], ["proposed", null]);
    assert.match(
      (await a6g(["task", "score", "1", ...SCORE, "--asked", "x", "--confidence", "data", "--size", "S", "--why", "x"], as("planner"))).out,
      /all three/
    );
    // A journey only groups tasks: its tasks are approved on their own, and it's done once they are and it's verified.
    await a6g(["task", "add", "Checkout", "--kind", "journey"], as("planner"));
    await a6g(["task", "add", "Pay", "--parent", "2"], as("planner"));
    await a6g(["task", "score", "3", ...SCORE, ...GATE, "--confidence", "data", "--size", "S", "--why", "x"], as("planner"));
    assert.equal((await a6g(["task", "approve", "3"], as("approver"))).code, 0, "no journey approval first");
    assert.match((await a6g(["task", "status", "2", "done"], as("planner"))).out, /done once it's verified/);
    await update(store().tasks, "3", (t) => ({ ...t, status: "done" as const }));
    assert.equal((await a6g(["task", "status", "2", "done"], as("planner"))).code, 0, "its task done, the planner closes it");
    assert.match((await a6g(["task", "edit", "2", "--kind", "feature"], as("planner"))).out, /has tasks/);
  });

  test("text that starts with -- is text; --help prints the usage; the rules name CLAUDE.md only when there is one", async () => {
    const { home, as, store } = setup();
    assert.equal((await a6g(["task", "add", "--skip-common leaves out common words"], as("planner"))).code, 0);
    assert.equal((await store().tasks.get("1"))?.title, "--skip-common leaves out common words");
    const help = await a6g(["task", "add", "--help"], as("planner"));
    assert.deepEqual([help.code, /usage: a6g task/.test(help.out)], [0, true]);
    assert.equal((await a6g(["request", "list", "--help"], as("planner"))).code, 0);
    const { compile } = await import("../lib/prompts.ts");
    const { loadTeam } = await import("../lib/config.ts");
    assert.doesNotMatch(compile(loadTeam(home), "builder"), /`CLAUDE\.md`/, "this checkout has none");
    writeFileSync(join(home, "CLAUDE.md"), "# Rules\n");
    assert.match(compile(loadTeam(home), "builder"), /`CLAUDE\.md` \(the repository's own rules/);
  });

  test("options a subcommand doesn't read are refused; an agent's graph stays in the run folder", async () => {
    const { home, as } = setup();
    await a6g(["task", "add", "Thing"], as("planner"));
    assert.match(
      (await a6g(["task", "status", "1", "rejected", "--sev", "minor"], as("planner"))).out,
      /takes --reason, --recommend, --waits-on, --then, not --sev/
    );
    assert.match((await a6g(["task", "graph", "--out", join(home, ".a6g/team.json")], as("reviewer"))).out, /run folder or \/tmp/);
    assert.equal((await a6g(["task", "graph", "--out", join(tmp(), "g.json")], as("reviewer"))).code, 0);
  });

  test("a rework is handed in changed, and a member that gives up hands its task back", async () => {
    const { home, run, as, worktree, store } = setup();
    await store().tasks.createAs("1", newTask({ team: "fixture", title: "a", kind: "feature", status: "approved", by: "planner" }));
    const tree = worktree("rw");
    await a6g(["task", "claim"], as("builder", tree));
    git(tree, "branch", "-m", "a6g/b1-a");
    const sha = commit(tree, { "src/a.ts": "a\n" });
    await a6g(["task", "submit", "1"], as("builder", tree));
    await store().tasks.replace({ ...((await store().tasks.get("1")) as Task), status: "approved", rounds: 1 });
    await a6g(["task", "claim", "1"], as("builder", tree));
    assert.match((await a6g(["task", "submit", "1"], as("builder", tree))).out, /the commit the reviewer asked changes on/);
    assert.equal(git(tree, "rev-parse", "HEAD"), sha);
    // A rework that doesn't build on its last round (a branch started over beside it) isn't handed in.
    git(tree, "checkout", "-q", "-B", "a6g/b1-a", "a6g/next");
    commit(tree, { "src/a.ts": "started over\n" });
    assert.match((await a6g(["task", "submit", "1"], as("builder", tree))).out, /doesn't hold the task's last round/);
    git(tree, "checkout", "-q", "-B", "a6g/b1-a", sha);
    // Three refused stops: the fourth lets it go, and the task goes back as blocked.
    const stop = () =>
      spawnSync(process.execPath, [join(import.meta.dirname, "..", "plugin", "hooks", "stop.ts")], {
        input: JSON.stringify({ session_id: "giving-up", cwd: tree, agent_type: "a6g:builder" }),
        env: { ...process.env, A6G_TEAM: "fixture", A6G_HOME_DIR: home, A6G_ROLE: "builder", A6G_RUN: run, CLAUDE_PROJECT_DIR: tree },
        encoding: "utf8",
      });
    for (let i = 0; i < 3; i++) assert.equal(stop().status, 2);
    const last = stop();
    assert.equal(last.status, 0);
    assert.match(last.stderr, /Task 1 went back as blocked/);
    assert.equal((await store().tasks.get("1"))?.status, "blocked");
  });
});
