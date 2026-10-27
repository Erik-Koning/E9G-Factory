import { baseTeam, makeRepo, write } from "./helpers.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  FACTORY_PATH,
  factoryWrite,
  instanceId,
  laneAllows,
  loadTeam,
  normalize,
  ROLES,
  roleForBranch,
  roleForInstance,
  roleOfAgent,
  TeamError,
  type RawTeam,
} from "../lib/config.ts";

const norm = (raw: RawTeam | Record<string, unknown>) => normalize({ name: "fixture", branch: "e9g/next", ...raw } as RawTeam, "");

describe("config", () => {
  test("defaults", () => {
    const { team, problems } = norm({});
    assert.deepEqual(problems, []);
    assert.deepEqual(Object.keys(team.roles), ["planner", "builder", "reviewer"]);
    assert.equal(team.roles.builder?.limit, ROLES["builder"]?.limit);
    assert.deepEqual(team.roles.builder?.write, ["*"]);
    assert.equal(team.roles.builder?.branch, "^e9g/b\\d+-");
    assert.equal(team.roles.reviewer?.readOnly, true);
    assert.deepEqual(team.protectedBranches, ["main", "master", "production", "prod"]);
    assert.equal(team.board.type, "files");
    assert.equal(team.push, null);
    assert.equal(team.isolation, "strict");
    assert.equal(team.watchdog.tickEveryMin, 10);
    assert.equal(team.gate.quick, null);
  });

  test("branch patterns follow branchPrefix, and a given branch wins", () => {
    const { team } = norm({ branchPrefix: "loop", roles: { planner: {}, builder: {}, tester: { write: ["^e2e/"] }, reviewer: { branch: "^nope/" } } });
    assert.equal(team.roles.builder?.branch, "^loop/b\\d+-");
    assert.equal(team.roles.tester?.branch, "^loop/t-");
    assert.equal(team.roles.reviewer?.branch, undefined, "only builders and testers have branches");
    const custom = norm({ roles: { planner: {}, builder: { branch: "^concept/b\\d+-" } } }).team;
    assert.equal(custom.roles.builder?.branch, "^concept/b\\d+-");
  });

  test("durations, push and board", () => {
    const { team } = norm({
      push: { every: "6h" },
      board: { github: { label: "loop" } },
      watchdog: { tickEvery: "5m", stuckAfter: "45m", pruneAfter: "2h", doneTickEvery: "1d" },
      gate: { full: "make check" },
    });
    assert.deepEqual(team.push, { remote: "origin", branch: "e9g/next", everyMin: 360 });
    assert.deepEqual(team.board, { type: "github", label: "loop" });
    assert.deepEqual(team.watchdog, { tickEveryMin: 5, stuckAfterMin: 45, pruneAfterMin: 120, doneTickEveryMin: 1440 });
    assert.equal(team.gate.quick, "make check", "quick falls back to full");
    assert.equal(norm({ finish: "e9g pages done" }).team.progress, "e9g pages status");
  });

  test("problems", () => {
    const problems = (raw: Record<string, unknown>) => normalize(raw as RawTeam, "").problems.join("\n");
    assert.match(problems({ name: "Bad Name", branch: "x" }), /name:/);
    assert.match(problems({ name: "ok" }), /branch:/);
    assert.match(problems({ name: "ok", branch: "x", owner: "not-an-email" }), /owner:/);
    assert.match(problems({ name: "ok", branch: "x", roles: { planner: {}, wizard: {} } }), /roles\.wizard: no such role/);
    assert.match(problems({ name: "ok", branch: "x", roles: { builder: {} } }), /every team has a planner/);
    assert.match(problems({ name: "ok", branch: "x", roles: { planner: {}, builder: { write: ["("] } } }), /roles\.builder\.write\[0\]/);
    assert.match(problems({ name: "ok", branch: "x", roles: { planner: {}, builder: { limit: 1.5 } } }), /roles\.builder\.limit/);
    assert.match(problems({ name: "ok", branch: "x", roles: { planner: {}, tester: {} } }), /roles\.tester\.write/);
    assert.match(problems({ name: "ok", branch: "x", policies: { deploy: "maybe" } }), /policies\.deploy/);
    assert.match(problems({ name: "ok", branch: "x", policies: { teleport: "allow" } }), /policies\.teleport: no such policy/);
    assert.match(problems({ name: "ok", branch: "x", never: [{ rule: "x" }] }), /never\[0\]\.reason/);
    assert.match(problems({ name: "ok", branch: "x", isolation: "loose" }), /isolation/);
    assert.match(normalize({ name: "ok", branch: "x", flavour: 1 } as RawTeam, "").warnings.join("\n"), /unknown key "flavour"/);
  });

  test("older [rule, reason] and [title, command] arrays are accepted", () => {
    const { team, problems } = norm({
      never: [["\\bx\\b", "no x"]],
      commandOwners: [["\\by\\b", ["planner"], "only the planner"]],
      context: [["Board", "ls"]],
    });
    assert.deepEqual(problems, []);
    assert.deepEqual(team.never, [{ rule: "\\bx\\b", reason: "no x" }]);
    assert.deepEqual(team.commandOwners, [{ rule: "\\by\\b", roles: ["planner"], reason: "only the planner" }]);
    assert.deepEqual(team.context, [{ title: "Board", command: "ls" }]);
  });

  test("lanes, branches, instances and agent names", () => {
    const { team } = norm(baseTeam());
    assert.ok(laneAllows(team, "builder", "src/app.ts"));
    assert.ok(!laneAllows(team, "builder", "e2e/a.spec.ts"), "deny wins");
    assert.ok(laneAllows(team, "tester", "e2e/a.spec.ts"));
    assert.ok(!laneAllows(team, "tester", "src/app.ts"));
    assert.ok(!laneAllows(team, "reviewer", "README.md"));
    assert.ok(!laneAllows(team, "Explore", "README.md"), "a role the team doesn't have writes nothing");
    assert.ok(laneAllows(team, "planner", ".e9g/lessons.md"));
    assert.ok(laneAllows(team, "planner", ".e9g/decisions.md"));
    assert.ok(!laneAllows(team, "planner", ".e9g/direction.md"), "the direction is the operator's");
    assert.equal(roleForBranch(team, "e9g/b12-thing"), "builder");
    assert.equal(roleForBranch(team, "e9g/t-specs"), "tester");
    assert.equal(roleForBranch(team, "feature/x"), null);
    assert.equal(instanceId(team, "builder"), "e9g-fixture-builder");
    assert.equal(roleForInstance(team, "e9g-fixture-builder"), "builder");
    assert.equal(roleForInstance(team, "claudeBuilder"), null);
    assert.equal(roleForInstance(norm({ ...baseTeam(), legacyInstances: { claudeBuilder: "builder" } }).team, "claudeBuilder"), "builder");
    assert.equal(roleOfAgent("e9g:ux-specialist"), "ux-specialist");
    assert.equal(roleOfAgent("Explore"), "Explore");
    assert.equal(roleOfAgent(undefined), "");
  });

  test("the factory's own paths", () => {
    for (const path of [
      ".e9g/team.json",
      ".e9g/adapters/gate.sh",
      ".claude/settings.json",
      ".claude/settings.local.json",
      ".claude/hooks/x.mjs",
      ".claude/agents/a.md",
      ".claude/commands/x.md",
      ".claude/skills/deploy/SKILL.md",
      ".claude",
      ".mcp.json",
    ])
      assert.ok(FACTORY_PATH.test(path), path);
    for (const path of ["src/.e9g.ts", "docs/e9g.md", "CLAUDE.md", ".claudex/a"]) assert.ok(!FACTORY_PATH.test(path), path);
  });

  test("only a lane rule that names a factory file opens it", () => {
    const { team } = norm({ roles: { planner: {}, builder: { limit: 1, write: ["^src/", "\\.json$", "\\.md$", "^\\.claude/agents/notes\\.md$"] } } });
    assert.ok(!factoryWrite(team, "planner", ".e9g/lessons.md"), "the planner's default lane names its lessons");
    assert.ok(!factoryWrite(team, "planner", ".e9g/decisions.md"), "and its decisions");
    assert.ok(factoryWrite(team, "planner", ".e9g/direction.md"), "but not the operator's direction");
    assert.ok(factoryWrite(team, "builder", ".e9g/decisions.md"), "nor does a broad rule open the planner's decisions");
    assert.ok(factoryWrite(team, "planner", ".e9g/team.json"));
    for (const path of [".e9g/team.json", ".e9g/brief.md", ".claude/settings.json", ".mcp.json"]) assert.ok(factoryWrite(team, "builder", path), path);
    assert.ok(!factoryWrite(team, "builder", ".claude/agents/notes.md"), "named by the rule itself");
    assert.ok(!factoryWrite(team, "builder", "src/app.ts"), "not a factory path");
  });

  test("loadTeam reads the checkout's file and refuses a broken one", () => {
    const home = makeRepo();
    assert.equal(loadTeam(home).name, "fixture");
    write(home, { ".e9g/team.json": "{ not json" });
    assert.throws(() => loadTeam(home), TeamError);
    write(home, { ".e9g/team.json": { name: "Bad Name", branch: "x" } });
    assert.throws(() => loadTeam(home), /name:/);
    assert.equal(loadTeam(home, { strict: false }).problems.length, 1);
  });
});
