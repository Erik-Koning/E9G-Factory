import { fakeKeychain, tmp, write } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { applyControls, clearNotes, holdNote, pendingNotes, progressHold, queueNote, readHold } from "../lib/holds.ts";
import {
  budgetControl,
  type Control,
  type Hold,
  holdOf,
  holdReport,
  journeysUnderWay,
  pauseControl,
  resumeControl,
  settledControl,
  settling,
} from "../lib/tasks/controls.ts";
import { fileStore } from "../lib/tasks/files.ts";
import { claimRefusal, newTask, nextClaim, Refused, type Task } from "../lib/tasks/model.ts";

const task = (fields: Partial<Task> & { id: string }): Task => ({
  ...newTask({ team: "fixture", title: `task ${fields.id}`, kind: "feature", status: "approved", by: "planner", ...fields }),
  version: 1,
  ...fields,
});
let n = 0;
const control = (fields: Omit<Control, "id" | "version">): Control => ({ ...fields, id: `k${++n}`, version: 1 });

// Two journeys: #1 under way (#11 being built, #12 in review, #13 approved, #14 sent back for changes), #2 not begun
// (#21 approved); and #30, outside any journey, approved.
const graph = (): Task[] => [
  task({ id: "1", kind: "journey", status: "proposed", title: "J1 · A donor gives" }),
  task({ id: "2", kind: "journey", status: "proposed", title: "J2 · Anyone searches" }),
  task({ id: "11", parent: "1", status: "building", branch: "a6g/b11-x", files: ["a/"] }),
  task({ id: "12", parent: "1", status: "review", branch: "a6g/b12-x", files: ["b/"] }),
  task({ id: "13", parent: "1", files: ["c/"] }),
  task({ id: "14", parent: "1", branch: "a6g/b14-x", files: ["d/"] }),
  task({ id: "21", parent: "2", files: ["e/"] }),
  task({ id: "30", files: ["f/"] }),
];

describe("graceful pauses", () => {
  test("a pause after the current tasks lets only the work begun be claimed, its sent-back rework included", () => {
    const all = graph();
    const hold = holdOf([control(pauseControl(all, "fixture", { scope: "tasks", by: "operator" }))]);
    assert.deepEqual(hold?.tasks, ["11", "12", "14"]);
    assert.equal(claimRefusal(all.find((t) => t.id === "14") as Task, "builder", all, hold), null, "sent back for changes: finish it");
    for (const id of ["13", "21", "30"])
      assert.match(claimRefusal(all.find((t) => t.id === id) as Task, "builder", all, hold) ?? "", /outside that, so it waits until they resume/);
    assert.equal(nextClaim(all, "builder", undefined, hold)?.id, "14");
  });

  test("a pause after the current journeys lets their tasks be claimed, polish added later too; nothing else", () => {
    const all = graph();
    assert.deepEqual(
      journeysUnderWay(all).map((j) => j.id),
      ["1"]
    );
    const hold = holdOf([control(pauseControl(all, "fixture", { scope: "journeys", by: "operator" }))]);
    assert.deepEqual(hold?.journeys, ["1"]);
    const polish = task({ id: "15", parent: "1", kind: "ux", files: ["g/"] });
    assert.equal(claimRefusal(all.find((t) => t.id === "13") as Task, "builder", all, hold), null);
    assert.equal(claimRefusal(polish, "builder", [...all, polish], hold), null);
    assert.match(claimRefusal(all.find((t) => t.id === "21") as Task, "builder", all, hold) ?? "", /after journey #1/);
    assert.match(claimRefusal(all.find((t) => t.id === "30") as Task, "builder", all, hold) ?? "", /outside that/);
  });

  test("named journeys are checked; with none under way, a journey pause is refused", () => {
    const all = graph();
    assert.deepEqual(pauseControl(all, "fixture", { scope: "journeys", journeys: ["2"], by: "operator" }).journeys, ["2"]);
    assert.throws(() => pauseControl(all, "fixture", { scope: "journeys", journeys: ["13"], by: "operator" }), /#13 isn't a journey/);
    const quiet = all.map((t) => (t.kind === "journey" ? t : { ...t, status: "approved" as const, branch: null }));
    assert.throws(() => pauseControl(quiet, "fixture", { scope: "journeys", by: "operator" }), Refused);
  });

  test("a pause now refuses every claim; a later resume ends it; budgets don't count", () => {
    const all = graph();
    const now = control(pauseControl(all, "fixture", { scope: "now", by: "operator" }));
    assert.match(claimRefusal(all.find((t) => t.id === "14") as Task, "builder", all, holdOf([now])) ?? "", /paused the team/);
    assert.equal(holdOf([now, control(resumeControl("fixture", "operator"))]), null);
    assert.equal(holdOf([now, control(budgetControl("fixture", "operator", null))])?.control, now.id);
    assert.equal(holdOf([]), null);
  });

  test("a hold settles once nothing in it can move: building, review, claimable work and members keep it going", () => {
    let all = graph();
    const hold = holdOf([control(pauseControl(all, "fixture", { scope: "tasks", by: "operator" }))]);
    if (!hold) throw new Error("no hold");
    const first = settling(hold, all, 2);
    assert.equal(first.settled, false);
    assert.deepEqual(first.left, ["#11 being built: task 11", "#12 in review: task 12", "#14 to build: task 14", "2 members at work"]);
    // All three finish: nothing in it is left, whatever else is approved.
    all = all.map((t) => (["11", "12", "14"].includes(t.id) ? { ...t, status: "done" as const } : t));
    assert.deepEqual(settling(hold, all, 0), { settled: true, left: [], stuck: [] });
  });

  test("work in a hold that can't move without the operator doesn't keep it from settling, and says why", () => {
    const all = graph().map((t) =>
      t.id === "11"
        ? { ...t, status: "question" as const }
        : t.id === "12"
          ? { ...t, status: "blocked" as const }
          : t.id === "14"
            ? { ...t, after: ["30"] }
            : t
    );
    const hold = holdOf([control(pauseControl(graph(), "fixture", { scope: "tasks", by: "operator" }))]);
    if (!hold) throw new Error("no hold");
    const now = settling(hold, all, 0);
    assert.equal(now.settled, true);
    assert.match(now.stuck.join("\n"), /#11 question/);
    assert.match(now.stuck.join("\n"), /#12 blocked/);
    assert.match(now.stuck.join("\n"), /#14 waits for #30, which can't finish in this hold/);
  });

  test("a journey hold waits for the journey's verification, then settles; the report says what happened", () => {
    const since = new Date(Date.now() - 60_000).toISOString();
    const done = (t: Task): Task => ({
      ...t,
      status: "done",
      history: [...t.history, { at: new Date().toISOString(), by: "merge", what: "merged", to: "done" }],
    });
    let all = graph().map((t) => (t.parent === "1" ? done(t) : t));
    const ask = { ...pauseControl(graph(), "fixture", { scope: "journeys", by: "operator", note: "check J1" }), at: since };
    const hold = holdOf([control(ask)]);
    if (!hold) throw new Error("no hold");
    assert.deepEqual(settling(hold, all, 0).left, ["journey #1 due its verification (the planner's)"]);
    all = all.map((t) => (t.id === "1" ? { ...t, status: "done" as const } : t));
    assert.equal(settling(hold, all, 0).settled, true);
    const report = holdReport(hold, [...all, task({ id: "40", status: "question", title: "Q: the consent words" })], []);
    assert.match(report, /Paused after journey #1, as asked at .* \("check J1"\)/);
    assert.match(report, /Done since then \(4\):\n {2}#11 task 11/);
    assert.match(report, /#1 J1 · A donor gives: done, 4\/4 tasks done/);
    assert.match(report, /Waiting for you:\n {2}#40 Q: the consent words/);
    assert.match(report, /until you resume the team/);
  });
});

describe("holds that can't reopen or hang", () => {
  test("a pause now outranks a graceful one asked after it, and the watchdog's record of a settled hold is a pause now", () => {
    const all = graph();
    const now = control(pauseControl(all, "fixture", { scope: "now", by: "operator" }));
    const after = control(pauseControl(all, "fixture", { scope: "tasks", by: "operator" }));
    assert.equal(holdOf([now, after])?.scope, "now");
    assert.match(claimRefusal(all.find((t) => t.id === "14") as Task, "builder", all, holdOf([now, after])) ?? "", /paused the team/);
    const graceful = control(pauseControl(all, "fixture", { scope: "tasks", by: "operator" }));
    const hold = holdOf([graceful]);
    if (!hold) throw new Error("no hold");
    const settled = control(settledControl("fixture", hold));
    assert.equal(holdOf([graceful, settled])?.scope, "now");
    assert.equal(holdOf([graceful, settled, control(pauseControl(all, "fixture", { scope: "journeys", by: "operator" }))])?.scope, "now");
    assert.equal(holdOf([graceful, settled, control(resumeControl("fixture", "operator"))]), null);
  });

  test("work claimed after the hold, outside it, isn't waited for; nor is a proposal nobody has decided on for half an hour", () => {
    const since = "2026-11-04T10:00:00.000Z";
    const later = "2026-11-04T10:05:00.000Z";
    const all = [
      ...graph().filter((t) => t.id !== "11" && t.id !== "12"),
      task({ id: "40", status: "building", claim: { role: "builder", machine: "m", worktree: "/w", at: later, until: later } }),
      task({ id: "41", parent: "1", status: "proposed", updatedAt: "2026-11-04T09:00:00.000Z" }),
      task({ id: "42", parent: "1", status: "proposed", updatedAt: "2026-11-04T10:20:00.000Z" }),
    ];
    // Asked of the graph as it was, before #40 was claimed.
    const hold = { ...holdOf([control(pauseControl(graph(), "fixture", { scope: "journeys", journeys: ["1"], by: "operator" }))]), since } as Hold;
    const now = settling(hold, all, 0, Date.parse("2026-11-04T10:30:00.000Z"));
    assert.match(now.stuck.join("\n"), /#40 being built: task 40 \(started after the pause was asked, outside it/);
    assert.match(now.stuck.join("\n"), /#41 proposed, waiting for a decision/);
    assert.deepEqual(now.left, ["#13 to build: task 13", "#14 to build: task 14", "#42 proposed, for the planner or approver: task 42"]);
  });
});

describe("controls in the run folder", () => {
  test("controls apply whatever order they reach the store in; an earlier version's record still counts", () => {
    const run = tmp("a6g-holds-");
    write(run, { "controls-applied": "2" });
    const k = (id: string, c: Omit<Control, "id" | "version">): Control => ({ ...c, id, version: 1 });
    const r = (id: string) => k(id, resumeControl("fixture", "operator", `note ${id}`));
    assert.deepEqual(
      applyControls(run, [r("k1"), r("k2"), r("k4")]).tell.map((t) => t.text.match(/note k\d/)?.[0]),
      ["note k4"]
    );
    // k3 lands in the store after k4 was applied: it's applied all the same.
    assert.deepEqual(
      applyControls(run, [r("k1"), r("k2"), r("k3"), r("k4")]).tell.map((t) => t.text.match(/note k\d/)?.[0]),
      ["note k3"]
    );
    assert.deepEqual(applyControls(run, [r("k1"), r("k2"), r("k3"), r("k4")]).tell, []);
  });

  test("a pause asked of a paused team keeps the settled one and its report", () => {
    const run = tmp("a6g-holds-");
    let all = graph();
    applyControls(run, [control(pauseControl(all, "fixture", { scope: "tasks", by: "operator" }))]);
    all = all.map((t) => (["11", "12", "14"].includes(t.id) ? { ...t, status: "done" as const } : t));
    progressHold(run, all, 0);
    const report = readHold(run)?.report;
    assert.ok(report);
    const { log } = applyControls(run, [control(pauseControl(all, "fixture", { scope: "now", by: "operator" }))]);
    assert.match(log[0] ?? "", /paused already/);
    assert.equal(readHold(run)?.report, report);
  });

  test("messages the planner couldn't take wait, in order, and go once taken", () => {
    const run = tmp("a6g-holds-");
    queueNote(run, "one");
    queueNote(run, "two");
    assert.deepEqual(pendingNotes(run), ["one", "two"]);
    clearNotes(run, 1);
    assert.deepEqual(pendingNotes(run), ["two"]);
    clearNotes(run, 1);
    assert.deepEqual(pendingNotes(run), []);
  });

  test("each control applies once, in order: a pause now, a graceful one, a resume, a budget", () => {
    const run = tmp("a6g-holds-");
    const all = graph();
    const now = control(pauseControl(all, "fixture", { scope: "now", by: "operator" }));
    let applied = applyControls(run, [now]);
    assert.ok(existsSync(join(run, "paused")));
    assert.equal(readHold(run)?.scope, "now");
    assert.deepEqual(
      applied.tell.map((t) => t.wake),
      [false],
      "a pause now only reaches a planner mid-turn"
    );
    assert.deepEqual(applyControls(run, [now]), { log: [], tell: [] }, "applied once");

    const resume = control(resumeControl("fixture", "web:s1", "J1 looks right; go on"));
    applied = applyControls(run, [now, resume]);
    assert.ok(!existsSync(join(run, "paused")) && readHold(run) === null);
    assert.equal(applied.log[0], "the operator (web app) resumed the team");
    assert.match(applied.tell[0]?.text ?? "", /wrote:\n\nJ1 looks right; go on\n\n/);

    const graceful = control(pauseControl(all, "fixture", { scope: "tasks", by: "operator" }));
    const budget = control(
      budgetControl("fixture", "operator", { daily: 40, weekly: null, total: 500, since: "2026-11-01T00:00:00Z", autoResume: false })
    );
    applied = applyControls(run, [now, resume, graceful, budget]);
    assert.ok(!existsSync(join(run, "paused")), "a graceful pause doesn't stop the team yet");
    assert.equal(readHold(run)?.settledAt, null);
    assert.equal(applied.tell[0]?.wake, true);
    assert.match(applied.log[1] ?? "", /\$40 a day, none a week, \$500 in all/);
    assert.match(holdNote(run), /pausing the team after the work under way \(#11, #12, #14\)/);
    assert.deepEqual(JSON.parse(readFileSync(join(run, "controls-applied"), "utf8")), [now.id, resume.id, graceful.id, budget.id]);
  });

  test("a graceful hold records what's left, then pauses the team with its report", () => {
    const run = tmp("a6g-holds-");
    let all = graph();
    applyControls(run, [control(pauseControl(all, "fixture", { scope: "tasks", by: "operator" }))]);
    assert.equal(progressHold(run, all, 1)?.settled, false);
    assert.deepEqual(readHold(run)?.left, ["#11 being built: task 11", "#12 in review: task 12", "#14 to build: task 14", "1 member at work"]);
    assert.ok(!existsSync(join(run, "paused")));
    all = all.map((t) => (["11", "12", "14"].includes(t.id) ? { ...t, status: "done" as const } : t));
    assert.equal(progressHold(run, all, 0)?.settled, true);
    assert.ok(existsSync(join(run, "paused")));
    assert.match(readHold(run)?.report ?? "", /^Paused after the work under way/);
    assert.equal(progressHold(run, all, 0), null, "a settled hold stays as it is");
    assert.equal(holdNote(run), "");
  });

  test("a graceful pause asked for while the team is paused already changes nothing", () => {
    const run = tmp("a6g-holds-");
    write(run, { paused: "" });
    const { log } = applyControls(run, [control(pauseControl(graph(), "fixture", { scope: "tasks", by: "operator" }))]);
    assert.match(log[0] ?? "", /paused already/);
    assert.equal(readHold(run), null);
  });

  test("the file store keeps controls in order, and never gives an id twice", async () => {
    const store = fileStore(tmp("a6g-run-"), "fixture");
    const a = await store.controls.create(pauseControl(graph(), "fixture", { scope: "tasks", by: "operator" }));
    const b = await store.controls.create(resumeControl("fixture", "operator"));
    assert.deepEqual([a.id, b.id], ["k1", "k2"]);
    assert.deepEqual(
      (await store.controls.all()).map((c) => c.kind),
      ["pause", "resume"]
    );
  });
});

describe("a6g pause and resume, and the watchdog", () => {
  async function world() {
    const { fakeWorld } = await import("./fake-t3.ts");
    const w = await fakeWorld();
    const file = join(w.a6gHome, "teams", "fixture.json");
    write(join(w.a6gHome, "teams"), {
      "fixture.json": { ...JSON.parse(readFileSync(file, "utf8")), tasks: { store: "files", database: "a6g", lead: null } },
    });
    write(w.run, { "planner-thread": "mcp:planner\n" });
    const store = fileStore(w.run, "fixture");
    for (const t of graph()) {
      const { id, version: _v, ...fields } = t;
      await store.tasks.createAs(id, fields);
    }
    return { w, store };
  }

  test("pause --after tasks drains to a pause with a report; resume --note gives the planner the feedback", async () => {
    const { w, store } = await world();
    try {
      const paused = await w.a6g("pause", "fixture", "--after", "tasks", "--note", "let me look");
      assert.equal(paused.code, 0, paused.out);
      assert.match(paused.out, /is pausing after the work under way \(#11, #12, #14\)/);
      assert.ok(!existsSync(join(w.run, "paused")));
      assert.ok(
        w.calls().some((c) => /thread send mcp:planner The operator is pausing the team after the work under way/.test(c)),
        w.calls().join("\n")
      );
      assert.match((await w.a6g("status", "fixture")).out, /fixture \(Fixture team\) pausing/);

      // The watchdog: still work left, so the team keeps going, its ticks saying so.
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      assert.ok(!existsSync(join(w.run, "paused")));
      assert.deepEqual(readHold(w.run)?.left, ["#11 being built: task 11", "#12 in review: task 12", "#14 to build: task 14"]);

      // It's all merged: the next run pauses the team and keeps the report.
      for (const id of ["11", "12", "14"]) {
        const t = await store.tasks.get(id);
        if (t) await store.tasks.replace({ ...t, status: "done" });
      }
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      assert.ok(existsSync(join(w.run, "paused")));
      assert.match(readHold(w.run)?.report ?? "", /Paused after the work under way \(#11, #12, #14\).*\("let me look"\)/);
      assert.match((await w.a6g("status", "fixture")).out, /paused after the work under way .* a6g resume fixture carries on/);

      const resumed = await w.a6g("resume", "fixture", "--note", "Good. Start J2 next.");
      assert.equal(resumed.code, 0, resumed.out);
      assert.ok(!existsSync(join(w.run, "paused")) && readHold(w.run) === null);
      // The fake T3 logs a call a line at a time, blank lines dropped; the note is on its own.
      assert.match(w.calls().join("\n"), /thread send mcp:planner The operator resumed the team, and wrote:\nGood\. Start J2 next\.\n/);
      assert.deepEqual(
        (await store.controls.all()).map((c) => `${c.kind} ${c.by}`),
        ["pause operator", "pause watchdog", "resume operator"]
      );
    } finally {
      await w.close();
    }
  });

  test("pause now stops the team at once; start leaves a recorded pause alone, resume lifts it", async () => {
    const { w, store } = await world();
    try {
      assert.equal((await w.a6g("pause", "fixture")).code, 0);
      assert.ok(existsSync(join(w.run, "paused")));
      assert.equal(holdOf(await store.controls.all())?.scope, "now");
      assert.match((await w.a6g("start", "fixture")).out, /fixture is paused \(by the operator, now\): a6g resume fixture starts it again/);
      assert.ok(existsSync(join(w.run, "paused")));
      assert.equal((await w.a6g("resume", "fixture")).code, 0);
      assert.ok(!existsSync(join(w.run, "paused")));
      assert.equal(holdOf(await store.controls.all()), null);
    } finally {
      await w.close();
    }
  });

  test("with the task graph out of reach, pause now still stops this machine, and resume still starts it", async () => {
    fakeKeychain();
    const { fakeWorld } = await import("./fake-t3.ts");
    const w = await fakeWorld();
    try {
      const file = join(w.a6gHome, "teams", "fixture.json");
      write(join(w.a6gHome, "teams"), {
        "fixture.json": { ...JSON.parse(readFileSync(file, "utf8")), tasks: { store: "mongo", database: "a6g", lead: null } },
      });
      const paused = await w.a6g("pause", "fixture");
      assert.equal(paused.code, 0, paused.out);
      assert.match(paused.out, /couldn't record the pause in the task graph .*paused on this machine/);
      assert.ok(existsSync(join(w.run, "paused")));
      assert.notEqual((await w.a6g("pause", "fixture", "--after", "tasks")).code, 0, "a graceful pause needs the graph");
      const resumed = await w.a6g("resume", "fixture");
      assert.match(resumed.out, /couldn't record the resume/);
      assert.ok(!existsSync(join(w.run, "paused")));
    } finally {
      await w.close();
    }
  });

  test("on a worker machine, pause and resume are that machine's alone", async () => {
    const { w, store } = await world();
    try {
      const file = join(w.a6gHome, "teams", "fixture.json");
      write(join(w.a6gHome, "teams"), { "fixture.json": { ...JSON.parse(readFileSync(file, "utf8")), worker: true } });
      assert.match((await w.a6g("pause", "fixture")).out, /this machine's members of fixture are paused/);
      assert.ok(existsSync(join(w.run, "paused")));
      assert.deepEqual(await store.controls.all(), [], "the team isn't paused");
      assert.notEqual((await w.a6g("pause", "fixture", "--after", "tasks")).code, 0);
      assert.equal((await w.a6g("resume", "fixture")).code, 0);
      assert.ok(!existsSync(join(w.run, "paused")));
    } finally {
      await w.close();
    }
  });

  test("a journey pause with nothing under way is refused, and records nothing", async () => {
    const { w, store } = await world();
    try {
      const bad = await w.a6g("pause", "fixture", "--after", "journeys", "--journeys", "13");
      assert.notEqual(bad.code, 0);
      assert.match(bad.out, /#13 isn't a journey/);
      assert.deepEqual(await store.controls.all(), []);
      assert.notEqual((await w.a6g("pause", "fixture", "--after", "lunch")).code, 0);
    } finally {
      await w.close();
    }
  });
});
