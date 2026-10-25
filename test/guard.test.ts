import { baseTeam, bash, type GuardCase, type GuardOptions, git, holds, makeRepo, ROOT, tmp, tool, write } from "./helpers.ts";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { guardCases } from "../lib/commands/check.ts";
import { loadTeam, type RawTeam } from "../lib/config.ts";

const at = (home: string, path: string) => (path.startsWith("/") ? path : join(home, path));
const writes = (home: string, role: string, path: string, expected: GuardCase[4], options?: GuardOptions): GuardCase => [
  home,
  role,
  "Write",
  { file_path: at(home, path) },
  expected,
  options,
];

describe("guard", () => {
  const home = makeRepo(
    baseTeam({
      protect: ["^\\.loop/state/journeys\\.json$"],
      commandOwners: [["\\bjourneys\\.mjs\\s+run\\b", ["planner", "tester"], "the journey runner records results"]],
      never: [{ rule: "\\bmake\\s+ship\\b", reason: "shipping is the operator's", example: "make ship" }],
    })
  );
  const team = loadTeam(home);

  test("the self-test e9g check generates passes", () =>
    holds(guardCases(team).map(({ role, tool: name, input, expect }) => [home, role, name, input, expect, { run: `${home}-check-run` }])));

  test("the self-test passes for every example team", () =>
    holds(
      readdirSync(join(ROOT, "examples")).flatMap((file) => {
        const example = makeRepo({ ...(JSON.parse(readFileSync(join(ROOT, "examples", file), "utf8")) as RawTeam), name: "fixture" });
        return guardCases(loadTeam(example)).map(
          ({ role, tool: name, input, expect }): GuardCase => [example, role, name, input, expect, { run: `${example}-run` }]
        );
      })
    ));

  test("ordinary work passes", () => {
    const worktree = join(tmp("e9g-wt-"), "b1");
    git(home, "worktree", "add", "-q", "-b", "e9g/b1-ordinary", worktree, "e9g/next");
    const inWorktree = { cwd: worktree };
    const builder = [
      "pnpm install --frozen-lockfile --prefer-offline && pnpm --filter web test",
      'git add -A && git commit -m "Add the login form (b1)"',
      "git add src/a.ts && git commit -m \"$(cat <<'EOF'\nFix the form\n\n1) validate\n2) submit (later)\nEOF\n)\"",
      "git rebase e9g/next && git branch -m e9g/b1-login",
      "git restore . && git checkout -- src/app.ts",
      "rm -rf dist .next && mkdir -p src/components/login && touch src/components/login/index.ts",
      "sed -i '' 's/foo/bar/g' src/app.ts && perl -pi -e 's/a/b/' src/app.ts",
      'jq -r ".data.key" fixtures/x.json && grep -rn "item.key" src/',
      "cat .env.example && grep -n DATABASE_URL .env.example",
      "find src -name '*.ts' | xargs wc -l",
      "echo $((2+3)); for f in src/*.ts; do echo $f; done",
      "e9g lock app -- pnpm test && timeout 60 pnpm test",
      "cd packages/db && pnpm drizzle-kit generate",
      "diff <(git show e9g/next:src/app.ts) src/app.ts",
      "cat <<'EOF' > src/new.ts\nexport const n = 1; // it's new\nEOF",
      'gh issue comment 12 --body "Done: see e9g/b1-x"',
      "git config --get user.email && git -c core.pager=cat log -1",
      "echo done # it's fine",
    ];
    const planner = [
      'e9g log --label "merge 3" "Merged b1; b2 running; next: b3."',
      "e9g merge e9g/b1-x --queue --closes 1",
      "git add .e9g/lessons.md && git commit -m 'lessons: builders rebase their own branch; never git push' -- .e9g/lessons.md",
      "git worktree add --detach /tmp/e9g-insp-1 e9g/b1-x && cd /tmp/e9g-insp-1 && pnpm test",
      "git -C /tmp/e9g-insp-1 log -3 && git worktree remove --force /tmp/e9g-insp-1",
      'gh issue create --title "b4: Settings page" --body "Don\'t run vercel deploy." --label e9g',
      "git merge --abort; git reset -- .e9g/lessons.md; git stash list",
    ];
    const reviewer = [
      "git worktree add --detach /tmp/review-1 e9g/b1-x && cd /tmp/review-1 && pnpm test",
      "git -C /tmp/review-1 status && git diff e9g/next...e9g/b1-x && git branch -a",
      'e9g verdict review e9g/b1-x approve --note "Fine; one nit: don\'t git push from scripts"',
    ];
    return holds([
      ...builder.map((command) => bash(home, "builder", command, "allow", inWorktree)),
      ...planner.map((command) => bash(home, "planner", command, "allow")),
      ...reviewer.map((command) => bash(home, "reviewer", command, "allow")),
      tool(
        home,
        "builder",
        "Monitor",
        { command: "tail -f /tmp/dev.log | grep --line-buffered Error", description: "errors", timeout_ms: 1000 },
        "allow",
        inWorktree
      ),
    ]);
  });

  test("shell writes are held to the same lanes as the file tools", () =>
    holds([
      bash(home, "builder", "echo x > .e9g/team.json", "refuse"),
      bash(home, "builder", "sed -i '' s/a/b/ .e9g/brief.md", "refuse"),
      bash(home, "builder", "cp notes.md .claude/settings.json", "refuse"),
      bash(home, "builder", "echo x > e2e/a.spec.ts", "refuse"),
      bash(home, "builder", "echo x > src/new.ts && git add src/new.ts", "allow"),
      bash(home, "builder", "echo x > /tmp/e9g-guard-test.txt", "allow"),
      bash(home, "tester", "echo x > src/app.ts", "refuse"),
      bash(home, "tester", "mkdir -p e2e/journeys && touch e2e/journeys/a.spec.ts", "allow"),
      bash(home, "builder", "echo x > .loop/state/journeys.json", "refuse"),
      writes(home, "builder", ".loop/state/journeys.json", "refuse"),
    ]));

  test("protected branches and the integration branch", () =>
    holds([
      bash(home, "planner", "git -C . push origin HEAD:main", "refuse"),
      bash(home, "planner", "git push origin e9g/next", "refuse"),
      bash(home, "builder", "git branch -D e9g/next", "refuse"),
      bash(home, "builder", "git update-ref refs/heads/e9g/next HEAD", "refuse"),
      bash(home, "planner", "git merge e9g/b1-x", "refuse"),
      bash(home, "planner", "git rebase main", "refuse"),
      bash(home, "planner", "git reset --hard HEAD~1", "refuse"),
      bash(home, "planner", "git merge --abort", "allow"),
      bash(home, "planner", "git commit -m lessons -- .e9g/lessons.md", "allow"),
    ]));

  test("the push cadence counts pushes that happened", async () => {
    const pushing = makeRepo(baseTeam({ push: { every: "6h" } }));
    const remote = tmp("e9g-remote-");
    git(remote, "init", "-q", "--bare");
    git(pushing, "remote", "add", "origin", remote);
    const run = tmp("e9g-run-");
    await holds([
      bash(pushing, "builder", "git push origin e9g/next", "refuse", { run }),
      bash(pushing, "planner", "git push origin other", "refuse", { run }),
      bash(pushing, "planner", "git push origin e9g/next", "allow", { run }),
    ]);
    // Allowed but never run (or failed): it doesn't start the clock.
    await holds([bash(pushing, "planner", "git push origin e9g/next", "allow", { run })]);
    git(pushing, "push", "-q", "origin", "e9g/next");
    await holds([bash(pushing, "planner", "git push origin e9g/next", "refuse", { run })]);
  });

  test("read-only roles and roles the team doesn't have", () =>
    holds([
      ...["git checkout -b x", "git stash", "git commit -am x", "git switch main", "git push origin x"].map((c) => bash(home, "reviewer", c, "refuse")),
      ...["git branch --list", "git branch -a", "git worktree add --detach /tmp/e9g-review b", "git diff e9g/next...b", "git log --oneline"].map((c) =>
        bash(home, "reviewer", c, "allow")
      ),
      writes(home, "Explore", "src/app.ts", "refuse"),
      bash(home, "Explore", "git commit -am x", "refuse"),
      tool(home, "Explore", "Read", { file_path: join(home, "README.md") }, "allow"),
    ]));

  test("outside the checkout: scratch and the planner's outbox", () => {
    const run = tmp("e9g-run-");
    return holds([
      writes(home, "planner", join(run, "outbox/2026-10-25-question.md"), "allow", { run }),
      writes(home, "builder", join(run, "outbox/2026-10-25-question.md"), "refuse", { run }),
      writes(home, "builder", "/tmp/e9g-scratch.txt", "allow"),
      writes(home, "builder", "/Users/nobody/elsewhere.txt", "refuse"),
    ]);
  });

  test("the run folder in the checkout: board, scratch, state", () =>
    holds([
      writes(home, "ux-specialist", ".e9g/run/board/f-20261025-1200-contrast.md", "allow"),
      writes(home, "ux-specialist", ".e9g/run/board/1-ticket.md", "refuse"),
      writes(home, "planner", ".e9g/run/board/1-ticket.md", "allow"),
      writes(home, "builder", ".e9g/run/scratch/notes.txt", "allow"),
      writes(home, "builder", ".e9g/run/locks/gate/slot-0/pid", "refuse"),
      writes(home, "planner", ".e9g/run/state/log.md", "refuse"),
      bash(home, "planner", "echo x >> .e9g/run/state/log.md", "refuse"),
    ]));

  test("owned commands, however they're called", () =>
    holds([
      bash(home, "builder", "node /Users/x/.e9g/versions/0.2.0/bin/e9g.mjs merge e9g/b1-x", "refuse"),
      bash(home, "builder", "~/.e9g/bin/e9g verdict review e9g/b1-x approve", "refuse"),
      bash(home, "reviewer", 'e9g verdict review e9g/b1-x approve --note "fine"', "allow"),
      bash(home, "ux-specialist", "e9g verdict ux landing pass", "allow"),
      bash(home, "builder", "e9g verdict ux landing pass", "refuse"),
      bash(home, "builder", "e9g env reset", "refuse"),
      bash(home, "builder", "e9g env status", "allow"),
      bash(home, "builder", "e9g gate --quick", "allow"),
      bash(home, "builder", "node scripts/journeys.mjs run", "refuse"),
      bash(home, "tester", "node scripts/journeys.mjs run", "allow"),
      bash(home, "planner", "e9g start fixture", "refuse"),
      bash(home, "planner", "git add .e9g/lessons.md && git commit -m 'start using the blue tokens'", "allow"),
      bash(home, "builder", "make ship", "refuse"),
    ]));

  test("outside tools: email, other connectors, starting members", async () => {
    const send = "mcp__claude_ai_Gmail__send_message";
    const delegate = "mcp__t3-code__delegate_task";
    await holds([
      tool(home, "planner", send, { to: ["op@example.com"], subject: "x" }, "allow"),
      tool(home, "planner", send, { to: ["someone@example.com"] }, "refuse"),
      tool(home, "planner", send, { to: ["op@example.com"], cc: ["someone@example.com"] }, "refuse"),
      tool(home, "builder", send, { to: ["op@example.com"] }, "refuse"),
      tool(home, "planner", "mcp__claude_ai_Claude_Docs__create", {}, "refuse"),
      tool(home, "planner", delegate, { target: { providerInstanceId: "claudeBuilder" } }, "refuse"),
      tool(home, "planner", delegate, { target: { providerInstanceId: "e9g-fixture-planner" } }, "refuse"),
      tool(home, "planner", delegate, { target: { providerInstanceId: "e9g-fixture-builder" }, isolation: "worktree" }, "allow"),
      tool(home, "builder", delegate, { target: { providerInstanceId: "e9g-fixture-builder" } }, "refuse"),
    ]);
    const draining = makeRepo();
    mkdirSync(join(draining, ".e9g/run/state"), { recursive: true });
    writeFileSync(join(draining, ".e9g/run/state/drain"), "builder tester\n");
    await holds([
      tool(draining, "planner", delegate, { target: { providerInstanceId: "e9g-fixture-builder" }, isolation: "worktree" }, "refuse"),
      tool(draining, "planner", delegate, { target: { providerInstanceId: "e9g-fixture-reviewer" } }, "allow"),
    ]);
  });

  test("secrets", () =>
    holds([
      tool(home, "builder", "Read", { file_path: join(home, ".env.local") }, "refuse"),
      tool(home, "builder", "Read", { file_path: join(home, ".env.example") }, "allow"),
      tool(home, "builder", "Grep", { pattern: "KEY", path: join(home, ".env") }, "refuse"),
      bash(home, "builder", "source .env.local", "refuse"),
    ]));

  test("setup mode writes only .e9g/ and runs only setup's commands", () => {
    const fresh = makeRepo();
    const options = { env: { E9G_TEAM: "", E9G_SETUP: "1" } };
    return holds([
      writes(fresh, "setup", ".e9g/team.json", "allow", options),
      writes(fresh, "setup", ".e9g/adapters/env.sh", "allow", options),
      writes(fresh, "setup", "src/app.ts", "refuse", options),
      bash(fresh, "setup", "e9g check --run", "allow", options),
      bash(fresh, "setup", "e9g register", "allow", options),
      bash(fresh, "setup", "e9g merge x", "refuse", options),
      bash(fresh, "setup", "vercel deploy", "refuse", options),
      bash(fresh, "setup", "git push origin e9g/next", "refuse", options),
      bash(fresh, "setup", "git add .e9g && git commit -m team", "allow", options),
    ]);
  });

  test("inert outside a team, and a broken team only reads", async () => {
    const fresh = makeRepo();
    await holds([writes(fresh, "builder", ".e9g/team.json", "allow", { env: { E9G_TEAM: "", E9G_SETUP: "" } })]);
    write(fresh, { ".e9g/team.json": "{ broken" });
    await holds([
      tool(fresh, "builder", "Read", { file_path: join(fresh, "README.md") }, "allow"),
      writes(fresh, "builder", "src/app.ts", "refuse"),
      bash(fresh, "builder", "ls", "refuse"),
    ]);
  });
});
