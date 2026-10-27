import { baseTeam, makeRepo, tmp, write } from "./helpers.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { loadTeam } from "../lib/config.ts";
import { articles, compile, promptFile, promptStale, writePrompt } from "../lib/prompts.ts";

describe("prompts", () => {
  const home = makeRepo(
    baseTeam({
      finish: "e9g pages done",
      pages: { list: [{ id: "home", path: "/" }] },
      push: { every: "6h" },
      never: [{ rule: "\\bmake\\s+ship\\b", reason: "make ship sends it to customers" }],
    }),
    {
      ".e9g/brief.md": "Build it.\n",
      ".e9g/roles/builder.md": "Builders here use the blue components.\n",
      ".e9g/lessons.md": "- The dev server needs a restart after schema changes.\n",
      ".e9g/direction.md": "# Direction\n\n<!-- starter guidance -->\n\n## When goals conflict\n\n1. The shopper's trust over speed.\n",
      ".e9g/decisions.md": "- Show stock left on the cart? → Yes. Because trust over speed. (planner, ticket 4)\n",
    }
  );
  const team = loadTeam(home);

  test("every role's prompt carries the articles, its lane and its commands", () => {
    const text = articles();
    assert.match(text, /Article 1\. Mission/);
    assert.match(text, /Article 12\. Amendment/);
    for (const role of Object.keys(team.roles)) {
      const prompt = compile(team, role);
      assert.ok(prompt.includes(text), `${role}: articles`);
      assert.match(prompt, new RegExp(`You are the \\*\\*${role}\\*\\*`));
      assert.match(prompt, /## Your lane/);
      assert.match(prompt, /`e9g gate \[--quick\]`/);
      assert.match(prompt, /make ship sends it to customers/, `${role}: the team's never rules`);
      assert.doesNotMatch(prompt, /\{\{\w+\}\}/, `${role}: no placeholders`);
    }
  });

  test("only the planner gets the members table, merge and the operator", () => {
    const planner = compile(team, "planner");
    assert.match(planner, /e9g-fixture-builder/);
    assert.match(planner, /`e9g merge <branch> --queue/);
    assert.match(planner, /op@example\.com/);
    assert.match(planner, /at most every 6 h/);
    const builder = compile(team, "builder");
    assert.doesNotMatch(builder, /providerInstanceId/);
    assert.doesNotMatch(builder, /e9g merge/);
    assert.doesNotMatch(builder, /op@example\.com/);
    assert.match(builder, /Never: `\^e2e\/`/);
    assert.match(compile(team, "reviewer"), /e9g verdict review/);
    assert.doesNotMatch(compile(team, "builder"), /e9g verdict review/);
    assert.match(compile(team, "ux-specialist"), /e9g verdict ux/);
    assert.match(compile(team, "reviewer"), /change nothing in it/);
  });

  test("role notes go to their role; lessons go to everyone", () => {
    assert.match(compile(team, "builder"), /blue components/);
    assert.doesNotMatch(compile(team, "reviewer"), /blue components/);
    for (const role of Object.keys(team.roles)) assert.match(compile(team, role), /restart after schema changes/);
    assert.match(compile(team, "builder"), /`\.e9g\/brief\.md`/, "existing docs are listed");
    assert.doesNotMatch(compile(team, "builder"), /`\.e9g\/notes\.md`/, "missing docs aren't");
  });

  test("the direction and the decisions made from it go to everyone, without the starter's comments", () => {
    for (const role of Object.keys(team.roles)) {
      const prompt = compile(team, role);
      assert.match(prompt, /## The operator's direction \(\.e9g\/direction\.md\)[\s\S]*trust over speed/, `${role}: direction`);
      assert.match(prompt, /## Decisions made from it[\s\S]*Show stock left on the cart\? → Yes/, `${role}: decisions`);
      assert.doesNotMatch(prompt, /starter guidance/, `${role}: no HTML comments`);
    }
  });

  test("a starter direction no one has filled in stays out of the prompts", () => {
    const starter = readFileSync(new URL("../templates/team/direction.md", import.meta.url), "utf8");
    const bare = makeRepo(baseTeam(), { ".e9g/direction.md": starter });
    assert.doesNotMatch(compile(loadTeam(bare), "planner"), /## The operator's direction/);
  });

  test("a prompt goes stale when its sources change", () => {
    const run = tmp("e9g-run-");
    assert.ok(promptStale(team, "builder", run), "missing");
    writePrompt(team, "builder", run);
    assert.ok(!promptStale(team, "builder", run));
    assert.match(readFileSync(promptFile(run, "builder"), "utf8"), /sources [0-9a-f]{16} -->/);
    write(home, { ".e9g/roles/builder.md": "Changed notes.\n" });
    assert.ok(promptStale(team, "builder", run), "role notes changed");
    writePrompt(team, "builder", run);
    for (const files of [
      { ".e9g/direction.md": "# Direction\n\nSpeed first.\n" },
      { ".e9g/decisions.md": "- A → B. Because speed first. (operator, 2026-10-26, ticket 9)\n" },
    ]) {
      const file = Object.keys(files)[0];
      write(home, files);
      assert.ok(promptStale(team, "builder", run), `${file} changed`);
      writePrompt(team, "builder", run);
    }
    write(home, { ".e9g/team.json": baseTeam({ title: "Renamed" }) });
    assert.ok(promptStale(loadTeam(home), "builder", run), "team.json changed");
  });
});

describe("a compiled prompt's sources", () => {
  test("include the compiler, so a reinstalled release that renders differently recompiles", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../lib/prompts.ts", import.meta.url), "utf8");
    // The hash reads lib/prompts.ts itself; checking the line that does it keeps the guarantee from quietly going.
    assert.match(source, /read\(fileURLToPath\(import\.meta\.url\)\)/);
  });
});
