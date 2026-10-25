import "./helpers.mjs";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { instance, query, runningByInstance, satisfies, SUPPORTED, worktreesDir } from "../lib/t3.mjs";

describe("t3 adapter", () => {
  test("version ranges", () => {
    assert.ok(satisfies("0.1.2", ">=0.1.2 <0.2.0"));
    assert.ok(satisfies("0.1.10", ">=0.1.2 <0.2.0"), "numeric, not string, comparison");
    assert.ok(!satisfies("0.2.0", ">=0.1.2 <0.2.0"));
    assert.ok(!satisfies("0.1.1", ">=0.1.2 <0.2.0"));
    assert.ok(satisfies("1.2.3", "1.2.3"));
    assert.ok(satisfies("1.2.3", "=1.2.3"));
    assert.ok(satisfies("1.2.0", ">1.0.0 <=1.2.0"));
    assert.ok(!satisfies("1.2.1", ">1.0.0 <=1.2.0"));
    assert.ok(!satisfies("1.2.3", "^1.2.0"), "unsupported comparators never match");
    assert.match(SUPPORTED, /^>=\d+\.\d+\.\d+ <\d+\.\d+\.\d+$/);
  });

  test("an unreadable database reads as unknown, never as zero", () => {
    assert.equal(query("select 1"), null);
    assert.equal(runningByInstance(["e9g-x-builder"]), null);
    assert.deepEqual(runningByInstance([]), {});
  });

  test("a provider instance carries its flags and environment", () => {
    const made = instance({
      displayName: "Team · builder",
      launchArgs: "--agent e9g:builder",
      environment: { E9G_TEAM: "x", PORT: 9100 },
      compactAt: null,
    });
    assert.equal(made.driver, "claudeAgent");
    assert.deepEqual(made.config, { launchArgs: "--agent e9g:builder" });
    assert.deepEqual(made.environment, [
      { name: "E9G_TEAM", value: "x", sensitive: false },
      { name: "PORT", value: "9100", sensitive: false },
    ]);
    assert.equal(instance({ displayName: "p", launchArgs: "", environment: {}, compactAt: 160000 }).config.autoCompactWindow, "160000");
    assert.match(worktreesDir("/Users/x/Work/shop-e9g"), /\/worktrees\/shop-e9g$/);
  });
});
