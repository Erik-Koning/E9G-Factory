import { tmp, write } from "./helpers.ts";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { costOf, modelKey } from "../lib/prices.ts";
import { fileStore } from "../lib/tasks/files.ts";
import { newTask, type Task } from "../lib/tasks/model.ts";
import { dayOf, spendByWork, spendOf, type UsageDay, weekOf } from "../lib/tasks/spend.ts";
import { collectUsage, countedDays, encodePath, transcriptDirs } from "../lib/usage.ts";

const close = (actual: number | null, expected: number) => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);
const none = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };

describe("prices", () => {
  test("a request costs its tokens at its model's rates; cache reads and writes as the model prices them", () => {
    // Claude Opus 5.5: $4 in, $20 out, $0.20 a cache read, writes 1.25× and 2× input.
    close(costOf("claude-opus-5-5", { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6 }), 4 + 20 + 0.2 + 5 + 8);
    // Claude Sonnet 4.6 has no cache price of its own: 0.1× input.
    close(costOf("claude-sonnet-4-6", { ...none, cacheRead: 1e6 }), 0.3);
    // Fast mode is twice the rate; a dated or [1m] id is the same model.
    close(costOf("claude-opus-5-5", { ...none, output: 1e6, fast: true }), 40);
    close(costOf("claude-haiku-4-5-20251001", { ...none, input: 1e6 }), 1);
    assert.equal(modelKey("claude-opus-5[1m]"), "claude-opus-5");
    assert.equal(costOf("claude-unknown-9", { ...none, input: 1 }), null);
  });

  test("Claude Haiku 5.5 costs more past a 100K-token prompt, its cache reads too", () => {
    close(costOf("claude-haiku-5-5", { ...none, input: 100_000, output: 1e6 }), 0.01 + 0.5);
    close(costOf("claude-haiku-5-5", { ...none, input: 100_001, output: 1e6 }), (100_001 * 0.5) / 1e6 + 2.5);
    close(costOf("claude-haiku-5-5", { ...none, input: 1, cacheRead: 200_000 }), (1 * 0.5 + 200_000 * 0.05) / 1e6);
  });
});

// A Claude Code transcript's lines: the agent it ran as, then the assistant's requests, each streamed as several lines
// under one message id.
const agent = (name: string) => JSON.stringify({ type: "agent-setting", agentSetting: name });
const said = (id: string, at: string, model: string, branch: string, usage: Record<string, unknown>) =>
  JSON.stringify({ type: "assistant", timestamp: at, gitBranch: branch, message: { id, model, usage, content: [{ type: "text" }] } });

describe("counting what a team used", () => {
  function world() {
    const root = tmp("a6g-usage-");
    const projects = join(root, "projects");
    const home = "/Users/x/code/app";
    const worktrees = "/Users/x/.t3/worktrees/app";
    const ours = join(projects, "-Users-x-code-app");
    const tree = join(projects, "-Users-x--t3-worktrees-app-b12");
    const theirs = join(projects, "-Users-x-code-other");
    for (const dir of [ours, tree, theirs]) mkdirSync(dir, { recursive: true });
    return { run: join(root, "run"), projects, home, worktrees, ours, tree, theirs };
  }
  const at = (day: string, hour = 12) => new Date(`${day}T${String(hour).padStart(2, "0")}:00:00`).toISOString();

  test("each request once, by role, model and task, priced; only the team's agents; only what's new each time", () => {
    const w = world();
    const dirs = transcriptDirs(w.home, w.worktrees, w.projects);
    assert.equal(dirs.length, 2, "the checkout's and its worktree's, not another checkout's");
    const usage = { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 4000 };
    writeFileSync(
      join(w.ours, "planner.jsonl"),
      [
        agent("a6g:planner"),
        said("m1", at("2026-11-02"), "claude-opus-5-5", "a6g/next", usage),
        said("m1", at("2026-11-02"), "claude-opus-5-5", "a6g/next", usage),
        said("m2", at("2026-11-02"), "<synthetic>", "a6g/next", usage),
        "",
      ].join("\n")
    );
    writeFileSync(
      join(w.tree, "builder.jsonl"),
      [
        agent("a6g:builder"),
        said("b1", at("2026-11-02"), "claude-sonnet-5-5", "a6g/b12-save-the-card", {
          ...usage,
          cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 3000 },
        }),
        "",
      ].join("\n")
    );
    writeFileSync(join(w.theirs, "x.jsonl"), [agent("a6g:planner"), said("z", at("2026-11-02"), "claude-opus-5-5", "main", usage), ""].join("\n"));
    writeFileSync(join(w.ours, "plain.jsonl"), [said("p", at("2026-11-02"), "claude-opus-5-5", "main", usage), ""].join("\n"));

    const first = collectUsage({ run: w.run, team: "app", machine: "studio", dirs });
    assert.deepEqual(
      first.map((d) => [d.day, d.machine]),
      [["2026-11-02", "studio"]]
    );
    const rows = first[0]?.rows ?? [];
    const planner = rows.find((r) => r.role === "planner");
    const builder = rows.find((r) => r.role === "builder");
    assert.equal(rows.length, 2, JSON.stringify(rows));
    assert.deepEqual(
      { ...planner, cost: undefined },
      {
        role: "planner",
        model: "claude-opus-5-5",
        task: null,
        requests: 1,
        input: 1000,
        output: 2000,
        cacheRead: 10_000,
        cacheWrite: 4000,
        cost: undefined,
        unpriced: 0,
      }
    );
    close(planner?.cost ?? null, (1000 * 4 + 2000 * 20 + 10_000 * 0.2 + 4000 * 5) / 1e6);
    assert.equal(builder?.task, "12");
    close(builder?.cost ?? null, (1000 * 2 + 2000 * 10 + 10_000 * 0.2 + 1000 * 2.5 + 3000 * 4) / 1e6);

    // Nothing new: nothing changes. A request whose lines straddle two reads counts once; a half-written line waits.
    assert.deepEqual(collectUsage({ run: w.run, team: "app", machine: "studio", dirs }), []);
    appendFileSync(
      join(w.ours, "planner.jsonl"),
      `${said("m1", at("2026-11-02"), "claude-opus-5-5", "a6g/next", usage)}\n${said("m3", at("2026-11-03"), "claude-opus-5-5", "a6g/next", usage).slice(0, 40)}`
    );
    assert.deepEqual(collectUsage({ run: w.run, team: "app", machine: "studio", dirs }), []);
    appendFileSync(join(w.ours, "planner.jsonl"), `${said("m3", at("2026-11-03"), "claude-opus-5-5", "a6g/next", usage).slice(40)}\n`);
    const later = collectUsage({ run: w.run, team: "app", machine: "studio", dirs });
    assert.deepEqual(
      later.map((d) => [d.day, d.rows.map((r) => `${r.role} ${r.requests}`)]),
      [["2026-11-03", ["planner 1"]]]
    );
  });

  test("every day counted can be published again whole, for a store the team moved to", () => {
    const w = world();
    const dirs = transcriptDirs(w.home, w.worktrees, w.projects);
    const usage = { input_tokens: 1000, output_tokens: 0 };
    writeFileSync(
      join(w.ours, "p.jsonl"),
      [
        agent("a6g:planner"),
        said("a", at("2026-11-01"), "claude-opus-5-5", "a6g/next", usage),
        said("b", at("2026-11-02"), "claude-opus-5-5", "a6g/next", usage),
        "",
      ].join("\n")
    );
    collectUsage({ run: w.run, team: "app", machine: "studio", dirs });
    assert.deepEqual(
      countedDays(w.run, "app", "studio").map((d) => [d.day, d.machine, d.rows[0]?.requests]),
      [
        ["2026-11-01", "studio", 1],
        ["2026-11-02", "studio", 1],
      ]
    );
    assert.deepEqual(countedDays(tmp("a6g-empty-"), "app", "studio"), []);
  });

  test("folders named as Claude Code names them; a sibling team's worktrees, alike in name, aren't counted", () => {
    const root = tmp("a6g-usage-");
    const projects = join(root, "projects");
    const home = "/Users/x/My Code/shop_app";
    const worktrees = "/Users/x/.t3/worktrees/shop_app";
    const ours = join(projects, "-Users-x-My-Code-shop-app");
    const tree = join(projects, "-Users-x--t3-worktrees-shop-app-t3-1");
    const sibling = join(projects, "-Users-x--t3-worktrees-shop-app-admin-t3-2");
    for (const dir of [ours, tree, sibling]) mkdirSync(dir, { recursive: true });
    const line = (id: string, cwd: string) =>
      JSON.stringify({
        type: "assistant",
        timestamp: at("2026-11-02"),
        cwd,
        gitBranch: "a6g/next",
        message: { id, model: "claude-opus-5-5", usage: { input_tokens: 1 } },
      });
    writeFileSync(join(ours, "a.jsonl"), [agent("a6g:planner"), line("a", home), ""].join("\n"));
    writeFileSync(join(tree, "b.jsonl"), [agent("a6g:builder"), line("b", `${worktrees}/t3-1`), ""].join("\n"));
    writeFileSync(join(sibling, "c.jsonl"), [agent("a6g:builder"), line("c", "/Users/x/.t3/worktrees/shop_app-admin/t3-2"), ""].join("\n"));
    const dirs = transcriptDirs(home, worktrees, projects);
    assert.equal(dirs.length, 3, "the sibling's folder looks like ours by name");
    const [day] = collectUsage({ run: join(root, "run"), team: "shop", machine: "studio", dirs, home, worktrees });
    assert.deepEqual(day?.rows.map((r) => [r.role, r.requests]).sort(), [
      ["builder", 1],
      ["planner", 1],
    ]);
  });

  test("an unknown model's requests are counted, not priced", () => {
    const w = world();
    writeFileSync(
      join(w.ours, "p.jsonl"),
      [agent("a6g:planner"), said("u", at("2026-11-02"), "claude-new-6", "a6g/next", { input_tokens: 5 }), ""].join("\n")
    );
    const [day] = collectUsage({ run: w.run, team: "app", machine: "studio", dirs: transcriptDirs(w.home, w.worktrees, w.projects) });
    assert.deepEqual(
      day?.rows.map((r) => [r.requests, r.cost, r.unpriced]),
      [[1, 0, 1]]
    );
  });
});

describe("what a team spent", () => {
  const row = (cost: number, task: string | null = null) => ({
    role: "builder",
    model: "m",
    task,
    requests: 1,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost,
    unpriced: 0,
  });
  const day = (d: string, machine: string, ...costs: [number, string | null][]): UsageDay => ({
    team: "app",
    day: d,
    machine,
    rows: costs.map(([c, t]) => row(c, t)),
    updatedAt: "",
  });
  // Wednesday 2026-11-04: the week began on Monday the 2nd.
  const now = new Date("2026-11-04T15:00:00");
  const days = [
    day("2026-10-30", "studio", [5, null]),
    day("2026-11-02", "studio", [2, "12"]),
    day("2026-11-04", "studio", [1, "12"]),
    day("2026-11-04", "worker", [0.5, "13"]),
  ];

  test("today, this week from Monday, and in all or since the budget began, every machine's added up", () => {
    assert.equal(weekOf(now), "2026-11-02");
    assert.equal(dayOf(now), "2026-11-04");
    assert.deepEqual({ ...spendOf(days, now), at: "" }, { day: "2026-11-04", today: 1.5, week: 3.5, total: 8.5, since: null, unpriced: 0, at: "" });
    assert.equal(spendOf(days, now, new Date("2026-11-02T09:00:00").toISOString()).total, 3.5);
  });

  test("by journey and by task: a task's cost is its journey's too; the planner's own is no journey's", () => {
    const task = (id: string, fields: Partial<Task> = {}): Task => ({
      ...newTask({ team: "app", title: id, kind: "feature", status: "done", by: "planner", ...fields }),
      id,
      version: 1,
    });
    const tasks = [task("1", { kind: "journey" }), task("12", { parent: "1" }), task("13")];
    assert.deepEqual(spendByWork(days, tasks), {
      journeys: [
        { id: null, cost: 5.5 },
        { id: "1", cost: 3 },
      ],
      tasks: [
        { id: "12", cost: 3 },
        { id: "13", cost: 0.5 },
      ],
    });
  });

  test("the file store keeps a document per day and machine, replaced whole", async () => {
    const store = fileStore(tmp("a6g-run-"), "app");
    await store.usage.publish(days);
    await store.usage.publish([day("2026-11-04", "studio", [3, "12"])]);
    const read = await store.usage.since("2026-11-02");
    assert.deepEqual(
      read.map((d) => [d.day, d.machine, d.rows[0]?.cost]),
      [
        ["2026-11-02", "studio", 2],
        ["2026-11-04", "studio", 3],
        ["2026-11-04", "worker", 0.5],
      ]
    );
  });
});

describe("the watchdog counts what a team used", () => {
  test("a full run publishes this machine's days and keeps what the team spent; a6g status shows it", async () => {
    const { fakeWorld } = await import("./fake-t3.ts");
    const w = await fakeWorld();
    try {
      const file = join(w.a6gHome, "teams", "fixture.json");
      write(join(w.a6gHome, "teams"), {
        "fixture.json": { ...JSON.parse(readFileSync(file, "utf8")), tasks: { store: "files", database: "a6g", lead: null } },
      });
      write(w.run, { "planner-thread": "mcp:planner\n" });
      const transcripts = join(w.root, "home", ".claude", "projects", encodePath(w.home));
      mkdirSync(transcripts, { recursive: true });
      const now = new Date().toISOString();
      writeFileSync(
        join(transcripts, "p.jsonl"),
        [agent("a6g:planner"), said("m1", now, "claude-opus-5-5", "a6g/next", { input_tokens: 1_000_000, output_tokens: 100_000 }), ""].join("\n")
      );
      assert.equal((await w.a6g("watchdog", "run", "fixture")).code, 0);
      const spend = JSON.parse(readFileSync(join(w.run, "spend.json"), "utf8"));
      assert.equal(spend.today, 6);
      assert.ok(existsSync(join(w.run, "usage-days")));
      assert.match((await w.a6g("status", "fixture")).out, /Spent \(API-equivalent\): \$6\.00 today, \$6\.00 this week, \$6\.00 in all\./);
    } finally {
      await w.close();
    }
  });
});
