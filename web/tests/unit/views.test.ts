// What the pages work out from a team's graph: progress, journeys, merges, how a request is going and why it was
// turned down. Built with the factory's own newTask, as its commands make them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type FeatureRequest, MERGE, newTask, type Status, type Task } from "../../../lib/tasks/model.ts";
import { journeys, merges, progress, proposals, rejectionOf, requestState } from "../../server/views.ts";

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
