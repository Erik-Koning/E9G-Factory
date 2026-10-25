import { tmp } from "./helpers.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { acquire, TIMED_OUT, withLock } from "../lib/lock.mjs";

describe("lock", { concurrency: true }, () => {
  test("one slot: the second holder waits for the first", async () => {
    const home = tmp();
    const first = await acquire(home, "merge", { slots: 1, waitMin: 1 });
    assert.ok(first);
    const started = Date.now();
    setTimeout(first, 300);
    const second = await acquire(home, "merge", { slots: 1, waitMin: 1 });
    assert.ok(second);
    assert.ok(Date.now() - started >= 250, "it waited");
    second();
  });

  test("two slots hold two at once", async () => {
    const home = tmp();
    const a = await acquire(home, "gate", { slots: 2, waitMin: 0.01 });
    const b = await acquire(home, "gate", { slots: 2, waitMin: 0.01 });
    assert.ok(a && b);
    a();
    b();
  });

  test("a slot whose holder died is taken over", async () => {
    const home = tmp();
    const dead = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).stdout.trim();
    mkdirSync(join(home, ".e9g/run/locks/app/slot-0"), { recursive: true });
    writeFileSync(join(home, ".e9g/run/locks/app/slot-0/pid"), dead);
    const started = Date.now();
    const release = await acquire(home, "app", { slots: 1, waitMin: 0.01 });
    assert.ok(release);
    assert.ok(Date.now() - started < 1000, "without waiting");
    release();
  });

  test("no slot in time: null, and withLock reports TIMED_OUT", async () => {
    const home = tmp();
    const held = await acquire(home, "journeys", { slots: 1, waitMin: 1 });
    assert.equal(await acquire(home, "journeys", { slots: 1, waitMin: 0.01 }), null);
    const error = console.error;
    console.error = () => {};
    try {
      assert.equal(await withLock(home, "journeys", ["true"], { slots: 1, waitMin: 0.01 }), TIMED_OUT);
    } finally {
      console.error = error;
    }
    held();
    assert.equal(await withLock(home, "journeys", ["sh", "-c", "exit 3"], { slots: 1, waitMin: 0.01, stdio: "ignore" }), 3, "the command's own exit code");
  });
});
