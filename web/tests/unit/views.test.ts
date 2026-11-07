// What the pages work out from a team's graph: progress, journeys, merges, how a request is going and why it was
// turned down. Built with the factory's own newTask, as its commands make them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type FeatureRequest, MERGE, newTask, type Status, type Task } from "../../../lib/tasks/model.ts";
import { budgetControl, type Control, pauseControl, resumeControl } from "../../../lib/tasks/controls.ts";
import type { TeamState } from "../../../lib/tasks/teams.ts";
import {
  askedBy,
  axis,
  controlsView,
  dailySpend,
  dollars,
  journeys,
  kanban,
  merges,
  progress,
  proposals,
  rejectionOf,
  requestState,
} from "../../server/views.ts";

let next = 1;
const task = (status: Status, fields: Partial<Task> = {}): Task => ({
  ...newTask({ team: "shop", title: `task ${next}`, kind: "feature", status, by: "planner", ...fields }),
  id: String(next++),
  version: 1,
});
const request = (fields: Partial<FeatureRequest>): FeatureRequest => ({
  id: "r1",
  version: 1,
  team: "shop",
  title: "Export",
  body: "",
  from: "s1",
  status: "new",
  tasks: [],
  notes: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  history: [],
  ...fields,
});

test("progress counts work by where it is, journeys aside", () => {
  const tasks = [
    task("proposed"),
    task("question"),
    task("approved"),
    task("building"),
    task("done"),
    task("done"),
    task("rejected"),
    task("approved", { kind: "journey" }),
  ];
  assert.deepEqual(
    progress(tasks).map((p) => [p.label, p.count]),
    [
      ["In triage", 0],
      ["Waiting for a decision", 2],
      ["Approved, to build", 1],
      ["Being built", 1],
      ["In review", 0],
      ["Blocked", 0],
      ["Done", 2],
    ]
  );
});

test("a journey shows its progress, and is due its verification once its tasks are done (the factory's journeyDue)", () => {
  const journey = task("approved", { kind: "journey", title: "Checkout" });
  const tasks = [journey, task("done", { parent: journey.id }), task("building", { parent: journey.id }), task("rejected", { parent: journey.id })];
  assert.deepEqual(journeys(tasks), [{ id: journey.id, title: "Checkout", status: "approved", due: false, done: 1, total: 2 }]);
  const finished = tasks.map((t) => (t.status === "building" ? { ...t, status: "done" as const } : t));
  assert.equal(journeys(finished)[0]?.due, true);
});

test("recent merges are the merge queue's, newest first", () => {
  const a = task("done", { history: [{ at: "2026-10-02T00:00:00.000Z", by: MERGE, what: "review → done", from: "review", to: "done" }] });
  const b = task("done", { history: [{ at: "2026-10-03T00:00:00.000Z", by: MERGE, what: "review → done", from: "review", to: "done" }] });
  const research = task("done", { kind: "research", history: [{ at: "2026-10-04T00:00:00.000Z", by: "planner", what: "→ done", to: "done" }] });
  assert.deepEqual(
    merges([a, b, research]).map((m) => m.task.id),
    [b.id, a.id]
  );
});

test("a request reads as built once every task it became is done", () => {
  const done = task("done");
  const building = task("building");
  const byId = new Map([done, building].map((t) => [t.id, t]));
  assert.equal(requestState(request({ status: "new" }), byId), "new");
  assert.equal(requestState(request({ status: "promoted", tasks: [done.id, building.id] }), byId), "being built");
  assert.equal(requestState(request({ status: "promoted", tasks: [done.id] }), byId), "built");
});

test("a rejected request gives the planner's reason", () => {
  const notes = [
    { at: "2026-10-02T00:00:00.000Z", by: "planner", text: "looked into it" },
    { at: "2026-10-03T00:00:00.000Z", by: "planner", text: "rejected: out of scope for this cycle" },
  ];
  assert.equal(rejectionOf(request({ status: "rejected", notes })), "out of scope for this cycle");
  assert.equal(rejectionOf(request({ status: "researching", notes })), null);
});

test("proposals: escalated first, then proposed by priority, then researched; never a journey", () => {
  const low = task("proposed", { priority: 10 });
  const high = task("proposed", { priority: 80 });
  const question = task("question");
  const researching = task("researching");
  const journey = task("proposed", { kind: "journey" });
  assert.deepEqual(
    proposals([low, journey, researching, high, question, task("approved")]).map((t) => t.id),
    [question.id, high.id, low.id, researching.id]
  );
});

test("the board: a lane per step, journeys aside, each in its order, and rejected work only counted", () => {
  const now = Date.parse("2026-10-31T12:00:00.000Z");
  const claim = (at: string, until: string) => ({ role: "builder", machine: "studio", worktree: "/w", at, until });
  const late = task("building", { claim: claim("2026-10-31T11:00:00.000Z", "2026-10-31T13:00:00.000Z") });
  const early = task("building", { claim: claim("2026-10-31T10:00:00.000Z", "2026-10-31T11:30:00.000Z") });
  const reviewing = task("review", { branch: "a6g/b9-x", sha: "abcdef0123" });
  const dep = task("building");
  const low = task("approved", { priority: 10 });
  const blocker = task("approved", { severity: "blocker", after: [dep.id, low.id, "999"] });
  const oldTriage = task("triage", { createdAt: "2026-10-30T00:00:00.000Z" });
  const newTriage = task("triage", { createdAt: "2026-10-31T00:00:00.000Z", by: "stakeholder", from: "s2" });
  const proposed = task("proposed", { priority: 50 });
  const escalated = task("question");
  const done = (at: string) => task("done", { history: [{ at, by: MERGE, what: "review → done", from: "review", to: "done" }] });
  const dones = Array.from({ length: 10 }, (_, i) => done(`2026-10-${String(10 + i).padStart(2, "0")}T00:00:00.000Z`));
  const journey = task("approved", { kind: "journey" });
  const all = [late, early, reviewing, dep, low, blocker, oldTriage, newTriage, proposed, escalated, ...dones, task("rejected"), journey];
  const { columns, rejected } = kanban(all, { now, doneLimit: 8 });
  const lane = (name: string) => columns.find((c) => c.lane === name);
  // No blocked lane while nothing is blocked.
  assert.deepEqual(
    columns.map((c) => c.lane),
    ["triage", "proposed", "approved", "building", "review", "done"]
  );
  assert.deepEqual(
    lane("triage")?.cards.map((c) => c.task.id),
    [newTriage.id, oldTriage.id]
  );
  assert.deepEqual(
    lane("proposed")?.cards.map((c) => c.task.id),
    [escalated.id, proposed.id]
  );
  // Blockers first, as members claim them; a journey is never a card.
  assert.deepEqual(
    lane("approved")?.cards.map((c) => c.task.id),
    [blocker.id, low.id]
  );
  assert.deepEqual(lane("approved")?.cards[0]?.waits, [
    { id: dep.id, status: "building" },
    { id: low.id, status: "approved" },
    { id: "999", status: "missing" },
  ]);
  assert.deepEqual(
    lane("building")
      ?.cards.filter((c) => c.task.claim)
      .map((c) => [c.task.id, c.lapsed]),
    [
      [early.id, true],
      [late.id, false],
    ]
  );
  assert.deepEqual(
    lane("review")?.cards.map((c) => c.task.id),
    [reviewing.id]
  );
  // The newest done first, eight of them, and how many more.
  assert.equal(lane("done")?.cards[0]?.task.id, dones.at(-1)?.id);
  assert.deepEqual([lane("done")?.cards.length, lane("done")?.more], [8, 2]);
  assert.equal(rejected, 1);
  assert.deepEqual(
    kanban([...all, task("blocked")], { now }).columns.map((c) => c.lane),
    ["triage", "proposed", "approved", "building", "review", "blocked", "done"]
  );
  // Asked for, every done task and a lane of the rejected, which then aren't counted apart.
  const everything = kanban(all, { now, doneLimit: Infinity, rejected: true });
  assert.deepEqual([everything.columns.at(-2)?.cards.length, everything.columns.at(-2)?.more], [10, 0]);
  assert.deepEqual([everything.columns.at(-1)?.lane, everything.columns.at(-1)?.cards.length, everything.rejected], ["rejected", 1, 0]);
});

test("the pause panel shows a pause or resume as waiting until the team's Mac has reported since; budgets don't wait", () => {
  let k = 0;
  const control = (fields: Omit<Control, "id" | "version">, at: string): Control => ({ ...fields, at, id: `k${++k}`, version: 1 });
  const pause = control(pauseControl([], "shop", { scope: "now", by: "web:s1" }), "2026-11-01T10:00:00.000Z");
  const resume = control(resumeControl("shop", "operator", "go on"), "2026-11-01T10:05:00.000Z");
  const budget = control(budgetControl("shop", "web:s1", null), "2026-11-01T10:06:00.000Z");
  const status = (at: string): TeamState => ({ state: "paused", planner: null, members: {}, at });
  assert.equal(controlsView(null, [pause]).pending?.id, pause.id);
  assert.equal(controlsView(status("2026-11-01T10:00:30.000Z"), [pause]).pending, null);
  assert.equal(controlsView(status("2026-11-01T10:00:30.000Z"), [pause, resume, budget]).pending?.id, resume.id);
  assert.deepEqual(
    controlsView(status("2026-11-01T10:07:00.000Z"), [pause, resume, budget], 2).recent.map((c) => c.id),
    [budget.id, resume.id]
  );
  assert.equal(askedBy("web:s1"), "an admin, here");
  assert.equal(askedBy("operator"), "the operator, in the terminal");
  assert.equal(askedBy("budget"), "the budget");
  assert.equal(askedBy("watchdog"), "the team's Mac, as the pause settled");
});

test("the spend chart: 14 days ending on the lead's day, every machine added, empty days at $0; clean axis steps", () => {
  const row = (cost: number) => ({
    role: "builder",
    model: "m",
    task: null,
    requests: 1,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost,
    unpriced: 0,
  });
  const day = (d: string, machine: string, cost: number) => ({ team: "shop", day: d, machine, rows: [row(cost), row(cost / 2)], updatedAt: "" });
  const days = dailySpend(
    [day("2026-10-31", "studio", 2), day("2026-11-01", "studio", 1), day("2026-11-01", "worker", 1), day("2026-10-01", "studio", 99)],
    "2026-11-01",
    3
  );
  assert.deepEqual(days, [
    { day: "2026-10-30", cost: 0 },
    { day: "2026-10-31", cost: 3 },
    { day: "2026-11-01", cost: 3 },
  ]);
  assert.deepEqual(axis(7.2), { top: 7.5, ticks: [0, 2.5, 5, 7.5] });
  assert.deepEqual(axis(40), { top: 40, ticks: [0, 20, 40] });
  assert.equal(axis(0).top, 1);
  assert.deepEqual(axis(130).ticks, [0, 50, 100, 150]);
  assert.equal(dollars(3.456), "$3.46");
  assert.equal(dollars(42.4), "$42");
  assert.equal(dollars(12_345), "$12K");
  assert.equal(dollars(1_250), "$1.3K");
});
