// The operator's answers to what waits on them (lib/tasks/answer.ts), and the watchdog passing each to the planner once
// (lib/answers.ts).
import { tmp } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { relayAnswers } from "../lib/answers.ts";
import type { RegistryEntry } from "../lib/paths.ts";
import { answer, answersMessage, answersOn, answersSince, waitingSince, waitsOnOperator } from "../lib/tasks/answer.ts";
import { fileStore } from "../lib/tasks/files.ts";
import { newTask, OPERATOR, Refused, type Status, type Task, withEvent } from "../lib/tasks/model.ts";
import { update } from "../lib/tasks/store.ts";

async function graph() {
  const run = tmp("a6g-run-");
  const store = fileStore(run, "fixture");
  const add = (title: string, status: Status, fields: Partial<Task> = {}) =>
    store.tasks.create(newTask({ team: "fixture", title, kind: "feature", status, by: "planner", ...fields }));
  return { run, store, add };
}

describe("answering what waits on the operator", () => {
  test("an answer is the operator's note, marked, and leaves the task where it is", async () => {
    const { store, add } = await graph();
    const q = await add("Q: which consent words", "question", { kind: "research" });
    const answered = await answer(store, q.id, { who: OPERATOR, text: "  Go with (b), the plain draft.  " });
    assert.equal(answered.status, "question");
    assert.deepEqual(
      answered.notes.map((n) => [n.by, n.text, n.kind]),
      [[OPERATOR, "Go with (b), the plain draft.", "answer"]]
    );
    assert.match(answered.history.at(-1)?.what ?? "", /^answered: Go with \(b\)/);
    assert.equal(answersOn(answered).length, 1);
  });

  test("a blocked task takes an answer too; anything else, an empty answer or anyone but the operator doesn't", async () => {
    const { store, add } = await graph();
    const blocked = await add("Needs a key", "blocked", {
      ask: { reason: "only you hold the key", recommendation: "add it", by: "planner", at: "2026-11-01T00:00:00.000Z" },
    });
    // A block the team sorts out (no ask) isn't the operator's to answer.
    const theirs = await add("Waits on #1", "blocked");
    await assert.rejects(answer(store, theirs.id, { who: OPERATOR, text: "go" }), /doesn't wait/);
    assert.equal((await answer(store, blocked.id, { who: OPERATOR, text: "The key is in 1Password now." })).status, "blocked");
    const approved = await add("Build it", "approved");
    await assert.rejects(answer(store, approved.id, { who: OPERATOR, text: "yes" }), (e: Error) => e instanceof Refused && /doesn't wait/.test(e.message));
    await assert.rejects(answer(store, blocked.id, { who: OPERATOR, text: "   " }), /say what your answer is/);
    await assert.rejects(answer(store, blocked.id, { who: "planner", text: "fine" }), /only the operator/);
    await assert.rejects(answer(store, "999", { who: OPERATOR, text: "fine" }), /no task 999/);
    const journey = await add("A journey", "blocked", { kind: "journey" });
    assert.equal(waitsOnOperator(journey), false);
  });

  test("answers count from when the task last came to wait on the operator", async () => {
    const { store, add } = await graph();
    const q = await add("Q: open the staff pages?", "question");
    await answer(store, q.id, { who: OPERATOR, text: "Not yet." });
    // The planner acts, then asks again: the earlier answer isn't an answer to the new question.
    await new Promise((done) => setTimeout(done, 5));
    const asked = await update(store.tasks, q.id, (t) =>
      withEvent({ ...t, status: "proposed" }, "planner", "question → proposed", { from: "question", to: "proposed" })
    );
    await new Promise((done) => setTimeout(done, 5));
    const again = await update(store.tasks, asked.id, (t) =>
      withEvent({ ...t, status: "question" }, "planner", "proposed → question", { from: "proposed", to: "question" })
    );
    assert.equal(waitingSince(again), again.history.at(-1)?.at);
    assert.deepEqual(answersOn(again), []);
  });
});

describe("passing answers to the planner", () => {
  const entry = (run: string, fields: Partial<RegistryEntry> = {}): RegistryEntry =>
    ({ name: "fixture", title: "Fixture", run, tasks: { store: "files", database: "a6g", lead: null }, ...fields }) as RegistryEntry;

  test("answersSince lists answers on tasks still waiting, oldest first, each with its own key", async () => {
    const { store, add } = await graph();
    const a = await add("First", "question");
    const b = await add("Second", "blocked", {
      ask: { reason: "only you can", recommendation: "unblock it", by: "planner", at: "2026-11-01T00:00:00.000Z" },
    });
    await answer(store, b.id, { who: OPERATOR, text: "unblock with the staging key" });
    await answer(store, a.id, { who: OPERATOR, text: "(a)" });
    const tasks = await store.tasks.all();
    const pending = answersSince(tasks, "2000-01-01T00:00:00.000Z");
    assert.deepEqual(
      pending.map((p) => p.task.id),
      [b.id, a.id]
    );
    assert.equal(new Set(pending.map((p) => p.key)).size, 2);
    assert.deepEqual(answersSince(tasks, "2999-01-01T00:00:00.000Z"), []);
    // Once the planner moved a task on, its answer has nothing left to tell it.
    await update(store.tasks, a.id, (t) => ({ ...t, status: "approved" as const }));
    assert.deepEqual(
      answersSince(await store.tasks.all(), "2000-01-01T00:00:00.000Z").map((p) => p.task.id),
      [b.id]
    );
    const message = answersMessage(pending);
    assert.match(message, /^The operator answered in the web app:/);
    assert.match(message, new RegExp(`1\\. #${b.id} "Second" \\(blocked\\): unblock with the staging key`));
    assert.match(message, /don't note it again/);
  });

  test("relayAnswers tells the planner once, in one message, and again only after a failed send", async () => {
    const { run, store, add } = await graph();
    const q = await add("Q: consent", "question");
    await answer(store, q.id, { who: OPERATOR, text: "Use the draft." });
    const told: string[] = [];
    const logs: string[] = [];
    let works = false;
    const tell = (text: string) => {
      if (works) told.push(text);
      return works;
    };
    await relayAnswers(
      entry(run),
      tell,
      (t) => logs.push(t),
      (t) => logs.push(t)
    );
    assert.deepEqual(told, []);
    assert.match(logs.at(-1) ?? "", /trying again next run/);
    assert.equal(existsSync(join(run, "replies")), false);
    works = true;
    await relayAnswers(
      entry(run),
      tell,
      (t) => logs.push(t),
      (t) => logs.push(t)
    );
    assert.equal(told.length, 1);
    assert.match(told[0] ?? "", /Use the draft\./);
    assert.equal(readdirSync(join(run, "replies")).length, 1);
    await relayAnswers(
      entry(run),
      tell,
      (t) => logs.push(t),
      (t) => logs.push(t)
    );
    assert.equal(told.length, 1, "an answer goes once");
    // A worker never relays: the lead runs the planner.
    await answer(store, q.id, { who: OPERATOR, text: "And keep it short." });
    await relayAnswers(
      entry(run, { worker: true }),
      tell,
      () => {},
      () => {}
    );
    assert.equal(told.length, 1);
    await relayAnswers(
      entry(run),
      tell,
      () => {},
      () => {}
    );
    assert.equal(told.length, 2);
    assert.doesNotMatch(told[1] ?? "", /Use the draft/);
  });

  test("answers older than a day stay for the planner's own wakes", async () => {
    const { run, store, add } = await graph();
    const q = await add("Q: old", "question");
    await answer(store, q.id, { who: OPERATOR, text: "Long ago." });
    const told: string[] = [];
    await relayAnswers(
      entry(run),
      (t) => told.push(t) > 0,
      () => {},
      () => {},
      Date.now() + 2 * 86_400_000
    );
    assert.deepEqual(told, []);
  });
});
