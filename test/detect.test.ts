import { git, tmp, write } from "./helpers.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { normalize } from "../lib/config.ts";
import { detect, draftTeam } from "../lib/detect.ts";

function fixture() {
  const dir = tmp("e9g-detect-");
  write(dir, {
    "package.json": {
      name: "shop",
      scripts: { dev: "next dev", typecheck: "tsc", test: "vitest" },
      devDependencies: { "@playwright/test": "1", vitest: "1" },
    },
    "packages/web/package.json": { name: "web", dependencies: { next: "16", stripe: "1" } },
    "pnpm-lock.yaml": "lockfileVersion: 9\n",
    "pnpm-workspace.yaml": "packages: ['packages/*']\n",
    "vercel.json": "{}\n",
    "supabase/config.toml": "project_id = 'x'\n",
    "e2e/home.spec.ts": "test\n",
    "CLAUDE.md": "# Rules\n\nNever link production.\nUse the components.\nDon't run supabase config push.\n",
    ".claude/settings.local.json": "{}\n",
    ".github/workflows/ci.yml":
      "name: CI\non: [push]\njobs:\n  check:\n    steps:\n      - run: pnpm install --frozen-lockfile\n      - run: |\n          pnpm typecheck\n          pnpm test\n",
    ".github/workflows/migrate.yml":
      "name: Migrate\non:\n  workflow_dispatch:\n  push:\njobs:\n  migrate:\n    steps:\n      - run: supabase db push --linked\n",
  });
  git(dir, "init", "-q", "-b", "trunk");
  return dir;
}

describe("detect", () => {
  const found = detect(fixture());

  test("package manager, scripts, tests and UI", () => {
    assert.equal(found.packageManager, "pnpm");
    assert.equal(found.installCommand, "pnpm install --frozen-lockfile --prefer-offline");
    assert.equal(found.workspaces, true);
    assert.equal(found.scripts.typecheck, "tsc");
    assert.deepEqual(found.e2e, ["@playwright/test"]);
    assert.equal(found.e2eDir, "e2e");
    assert.deepEqual(found.unitTests, ["vitest"]);
    assert.ok(found.ui.includes("next"), "a workspace package's dependencies count");
    assert.equal(found.git.defaultBranch, "trunk", "no remote and no main or master: the current branch");
  });

  test("the ways out, with the policy each falls under", () => {
    const byId = Object.fromEntries(found.surfaces.map((s) => [s.id, s.policy]));
    assert.equal(byId.vercel, "deploy");
    assert.equal(byId.supabase, "hosted-data");
    assert.equal(byId.stripe, "payments");
  });

  test("CI: what it runs, and which workflows reach outside", () => {
    const ci = Object.fromEntries(found.ci.map((w) => [w.name, w]));
    assert.deepEqual(ci["CI"]?.runs, ["pnpm install --frozen-lockfile", "pnpm typecheck", "pnpm test"]);
    assert.equal(ci["CI"]?.outward, false);
    assert.equal(ci["Migrate"]?.outward, true);
    assert.equal(ci["Migrate"]?.manual, true);
  });

  test("agent configuration and the repository's own prohibitions", () => {
    assert.equal(found.agentConfig.claudeMd, true);
    assert.equal(found.agentConfig.localSettings, true);
    const lines = found.prohibitions.map((p) => p.line);
    assert.ok(lines.includes("Never link production."));
    assert.ok(lines.includes("Don't run supabase config push."));
    assert.ok(!lines.includes("Use the components."));
  });

  test("the draft team is valid, with a tester for e2e/ and builders kept out of it", () => {
    const draft = draftTeam(found, { name: "shop", branch: "e9g/next", owner: "op@example.com" });
    const { team, problems } = normalize(JSON.parse(JSON.stringify(draft)), "/tmp/x");
    assert.deepEqual(problems, []);
    assert.deepEqual(team.roles.tester?.write, ["^e2e/"]);
    assert.deepEqual(team.roles.builder?.deny, ["^e2e/"]);
    assert.ok(team.roles["ux-specialist"], "a UI gets a UX specialist");
    assert.deepEqual(team.board, { type: "tasks" }, "no GitHub remote, so the task graph");
    assert.equal(team.environment.needsDocker, true, "Supabase runs in Docker");
    assert.equal(team.worktreeSetup, "pnpm install --frozen-lockfile --prefer-offline");
  });
});
