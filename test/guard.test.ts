import { baseTeam, bash, type GuardCase, type GuardOptions, git, guardAsync, holds, makeRepo, ROOT, tmp, tool, write } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { type GuardCase as SelfTestCase, guardCases } from "../lib/commands/check.ts";
import { loadTeam, type RawTeam } from "../lib/config.ts";
import { compile } from "../lib/prompts.ts";

const at = (home: string, path: string) => (path.startsWith("/") ? path : join(home, path));
const writes = (home: string, role: string, path: string, expected: GuardCase[4], options?: GuardOptions): GuardCase => [
  home,
  role,
  "Write",
  { file_path: at(home, path) },
  expected,
  options,
];

// e9g check's self-test for a team, as e9g check runs it: each case comes out as expected, and a refusal that names
// what it must say says it.
async function selfTest(home: string, cases: SelfTestCase[]): Promise<void> {
  await holds(cases.map(({ role, tool: name, input, expect }): GuardCase => [home, role, name, input, expect, { run: `${home}-check-run` }]));
  for (const { role, tool: name, input, says } of cases.filter((test) => test.says !== undefined)) {
    const { said } = await guardAsync(home, role, name, input, { run: `${home}-check-run` });
    assert.ok(said.includes(says ?? ""), `${role} ${JSON.stringify(input)} should say "${says}": ${said}`);
  }
}

describe("guard", () => {
  const home = makeRepo(
    baseTeam({
      protect: ["^\\.loop/state/journeys\\.json$"],
      commandOwners: [["\\bjourneys\\.mjs\\s+run\\b", ["planner", "tester"], "the journey runner records results"]],
      never: [{ rule: "\\bmake\\s+ship\\b", reason: "shipping is the operator's", example: "make ship" }],
    })
  );
  const team = loadTeam(home);

  test("the self-test e9g check generates passes", async () => {
    const cases = guardCases(team);
    // The protected-branch cases prove that check itself: they're the planner's, and say why.
    assert.ok(cases.filter((test) => test.says === "nothing is pushed to main" && test.role === "planner").length >= 2);
    await selfTest(home, cases);
  });

  test("the self-test passes for every example team", async () => {
    for (const file of readdirSync(join(ROOT, "examples"))) {
      const example = makeRepo({ ...(JSON.parse(readFileSync(join(ROOT, "examples", file), "utf8")) as RawTeam), name: "fixture" });
      await selfTest(example, guardCases(loadTeam(example)));
    }
  });

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
      'gh issue create --title "b4: Settings page" --body "Don\'t run vercel deploy." --label e9g --label E9G-Planner',
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

  test("everyday work in a pnpm, turbo, Next, Vitest and Playwright monorepo passes", () => {
    const mono = makeRepo(baseTeam({ environment: { script: ".e9g/adapters/env.sh" } }), {
      ".gitignore": "node_modules/\ndist/\n.next/\n.turbo/\ncoverage/\ntest-results/\nplaywright-report/\n.env*\n!.env.example\n",
      "package.json": JSON.stringify({ name: "mono", scripts: { test: "turbo run test", build: "turbo run build", "test:e2e": "playwright test" } }),
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "turbo.json": JSON.stringify({ tasks: { build: {}, test: {}, lint: {} } }),
      "packages/web/package.json": JSON.stringify({ name: "@app/web", scripts: { dev: "next dev", build: "next build", test: "vitest" } }),
      "packages/web/src/page.tsx": "export default function Page() { return null; }\n",
      "packages/db/package.json": JSON.stringify({ name: "@app/db" }),
      "packages/db/src/schema.ts": "export {};\n",
      "e2e/login.spec.ts": "import { test } from '@playwright/test';\n",
      "scripts/seed.ts": "export {};\n",
      ".env.example": "DATABASE_URL=\n",
      ".e9g/adapters/env.sh": "#!/bin/sh\n",
    });
    writeFileSync(join(mono, ".env.local"), "DATABASE_URL=postgres://localhost/app\n");
    const b = join(tmp("e9g-wt-"), "b2");
    git(mono, "worktree", "add", "-q", "-b", "e9g/b2-settings", b, "e9g/next");
    writeFileSync(join(b, ".env.local"), "DATABASE_URL=postgres://localhost/app\n");
    const t = join(tmp("e9g-wt-"), "t1");
    git(mono, "worktree", "add", "-q", "-b", "e9g/t-login", t, "e9g/next");
    const insp = join(tmp("e9g-insp-"), "x");
    git(mono, "worktree", "add", "-q", "--detach", insp, "e9g/next");
    const builder = [
      "pnpm install",
      "pnpm i --frozen-lockfile --prefer-offline",
      "pnpm -r build",
      "pnpm --filter @app/web dev",
      "pnpm --filter @app/web test -- --run",
      "pnpm turbo run build --filter=@app/web",
      "turbo run lint test --filter=...[origin/main]",
      "turbo run build --filter=@app/web -- --mode release",
      "turbo run dev --filter publisher-web",
      "nx test shipping-api",
      "pnpm vitest run packages/web",
      "pnpm exec vitest run --reporter=dot",
      "npx vitest run packages/web/src/page.test.tsx",
      "vitest run --coverage",
      "pnpm typecheck && pnpm lint",
      "pnpm biome check --write .",
      "pnpm prettier --write 'packages/**/*.{ts,tsx}'",
      "pnpm --filter @app/web exec next build",
      "pnpm --filter @app/web exec next lint --fix",
      "pnpm db:generate",
      "pnpm drizzle-kit generate",
      "pnpm --filter @app/db exec drizzle-kit generate",
      "pnpm add -D @types/node",
      "pnpm add zod --filter @app/web",
      "pnpm dlx shadcn@latest add button --cwd packages/web",
      "git status --short",
      "git diff --stat e9g/next...HEAD",
      "git log --oneline -10",
      "git add -A && git commit -m 'b2: the settings form'",
      "git commit -am 'fix: types'",
      "git fetch && git rebase e9g/next",
      "git rebase --continue",
      "git stash && git stash pop",
      "git checkout -- packages/web/src/page.tsx",
      "git restore --staged .",
      "git restore .",
      "git show HEAD:package.json | head",
      "git blame -L 1,5 packages/web/src/page.tsx",
      "git grep -n 'process.env' packages",
      "git branch -m e9g/b2-settings-page",
      "git worktree list",
      "rg -n 'useState' packages/web/src",
      "rg --files -g '*.tsx' packages",
      "rg -n TODO",
      "rg -n DATABASE_URL -g '!.env*'",
      "rg --hidden -n 'runs-on' .github",
      "grep -n Page packages/web/src/page.tsx",
      "grep -rn TODO packages/web/src",
      "sed -n '1,40p' packages/web/src/page.tsx",
      "sed -i '' 's/null/<main \\/>/' packages/web/src/page.tsx",
      "sed -i.bak 's/a/b/' packages/web/src/page.tsx",
      "awk '{print $1}' package.json",
      "jq '.scripts' package.json",
      "cat package.json | jq .name",
      "node scripts/check.mjs",
      "node -e 'console.log(process.version)'",
      `node -e "console.log(require('./package.json').name)"`,
      "node --test test/",
      "tsx scripts/seed.ts",
      "pnpm exec tsx scripts/seed.ts",
      "tsc --noEmit -p packages/web",
      "cat > packages/web/src/new.ts <<'EOF'\nexport const x = 1;\nEOF",
      'cat <<EOF > packages/web/src/built.ts\nexport const at = "$(date)";\nEOF',
      "mkdir -p packages/web/src/components && cat > packages/web/src/components/A.tsx <<'EOF'\nexport const A = () => <div>it's ok</div>;\nEOF",
      "cd packages/web && pnpm test",
      "cd packages/web && cd ../db && pnpm test",
      "(cd packages/web && pnpm build)",
      "pnpm test 2>&1 | tail -50",
      "pnpm test > /tmp/e9g-out.txt 2>&1; echo $?",
      "pnpm test | tee /tmp/e9g-t.log",
      'for f in packages/*/package.json; do jq -r .name "$f"; done',
      "ls -la packages/web",
      "ls -la .env*",
      "find . -name '*.ts' -not -path './node_modules/*' | head",
      "wc -l $(git ls-files '*.ts')",
      "[[ -f package.json && -d packages ]] && echo yes",
      "if [ -f pnpm-lock.yaml ]; then pnpm install; fi",
      'case "$x" in a) echo a;; b) echo b;; esac',
      "echo $((1 << 3))",
      "curl -s http://localhost:3000/api/health",
      "lsof -i :3000 | tail -n +2",
      "kill $(lsof -t -i :3000) || true",
      "gh issue view 12",
      "gh issue list --label e9g",
      "gh pr view 3 --json title",
      "gh run list --limit 5",
      "e9g gate --quick",
      "e9g lock app -- pnpm test",
      "e9g env status",
      "e9g progress",
      "e9g pages shots landing",
      "rm -rf node_modules/.cache dist .next .turbo",
      "rm -rf packages/web/dist",
      "touch packages/web/src/x.ts",
      "cp packages/web/src/page.tsx /tmp/e9g-page.bak",
      "mv packages/web/src/page.tsx packages/web/src/Page.tsx",
      "git mv packages/web/src/page.tsx packages/web/src/index.tsx",
      "ln -sf ../../node_modules packages/web/node_modules",
      "chmod +x scripts/check.mjs",
      "printf '%s\\n' a b > /tmp/e9g-x.txt",
      `echo '{"a":1}' | jq .a`,
      "date -u +%FT%TZ",
      "export FOO=1 && pnpm test",
      "NODE_OPTIONS=--max-old-space-size=4096 pnpm build",
      "timeout 300 pnpm test",
      "docker compose up -d db",
      "docker compose logs --tail=50 db",
      "supabase start",
      "supabase status",
      "supabase db reset",
      "supabase migration new add_settings",
      "pnpm supabase gen types typescript --local > packages/db/src/types.ts",
      "psql postgresql://postgres:postgres@localhost:54322/postgres -c 'select 1'",
      "python3 -c 'print(1)'",
      "make test",
      "true && false || echo recovered",
      "pnpm test -- --grep 'shipping address'",
      `concurrently "pnpm --filter @app/web dev" "pnpm --filter @app/db studio"`,
      `git commit -m "Settings: read STRIPE_SECRET_KEY from the environment, never .env.local"`,
    ];
    const tester = [
      "pnpm exec playwright test e2e/login.spec.ts",
      "npx playwright test --project=chromium",
      "npx playwright test --update-snapshots",
      "pnpm exec playwright install chromium",
      "npx playwright show-report",
      "PWDEBUG=0 pnpm exec playwright test --grep @smoke",
      "cat > e2e/settings.spec.ts <<'EOF'\nimport { test } from '@playwright/test';\nEOF",
      "git add e2e && git commit -m 't: the settings journey'",
      "git restore .",
      "git checkout -- .",
      "git checkout -- e2e",
      "git stash",
      "rm -rf test-results playwright-report",
      "mkdir -p e2e/fixtures && cp /tmp/e9g-x.json e2e/fixtures/",
      "sed -i '' 's/login/sign in/' e2e/login.spec.ts",
      "mv e2e/login.spec.ts e2e/sign-in.spec.ts",
      "touch e2e/journeys.spec.ts",
      "git status",
      "pnpm test:e2e",
      `node -e "console.log('journeys -> 3 passed')"`,
      "rg -n 'test\\(' e2e",
      "curl -sf http://localhost:3000 > /dev/null && echo up",
      "e9g lock browser -- pnpm exec playwright test",
      "e9g gate --quick",
    ];
    const reviewer = [
      "git diff e9g/next...e9g/b2-settings",
      "git log e9g/next..e9g/b2-settings --oneline",
      "git show e9g/b2-settings --stat",
      "git show e9g/b2-settings:packages/web/src/page.tsx",
      "git rev-parse e9g/b2-settings",
      "git branch -a",
      "git branch --show-current",
      "git worktree add --detach /tmp/e9g-review-2 e9g/b2-settings",
      `cd ${insp} && pnpm install --frozen-lockfile && pnpm test`,
      `git -C ${insp} checkout e9g/b2-settings`,
      `cd ${insp} && git checkout --detach e9g/b2-settings && pnpm turbo run build test`,
      `cd ${insp} && pnpm exec playwright test`,
      `git -C ${insp} diff --stat`,
      `npx tsc --noEmit -p ${insp}/packages/web`,
      `rg -n 'TODO|FIXME' ${insp}/packages`,
      "git worktree remove --force /tmp/e9g-review-2",
      "git fetch origin",
      "e9g verdict review e9g/b2-settings approve --sha abc1234 --note 'ok'",
      `e9g verdict review e9g/b2-settings changes --sha abc1234 --note "don't use any"`,
      "rg -n 'any' packages",
      "gh pr view 3",
      "git stash list",
      "git status",
      "git log -p -1 -- packages/web",
      "cat > /tmp/e9g-review-notes.md <<'EOF'\n# Review\n- it's fine\nEOF",
      "git diff --name-only e9g/next...e9g/b2-settings | xargs -I{} wc -l {}",
      "git log --format='%h %s' -5 | cat",
      "ls .e9g/run/board",
      "cat .e9g/brief.md",
      "echo '- the save button has no focus ring' > .e9g/run/board/f-20261025-1200-focus.md",
    ];
    const planner = [
      "e9g log 'Merged b1; next b3'",
      "e9g merge e9g/b2-settings --queue --closes 3",
      "e9g drain builder",
      "e9g drain off",
      "e9g env reset",
      ".e9g/adapters/env.sh up",
      "e9g status",
      "e9g pages run",
      "e9g verdict show review e9g/b2-settings",
      "e9g finish",
      "gh issue create --title 'b3: settings' --body 'Build the settings page' --label e9g --label E9G-Planner",
      "gh issue comment 3 --body 'merged in abc123'",
      "gh issue close 3 --comment 'Done'",
      "gh issue edit 3 --add-label blocked",
      "gh label list",
      "git log --oneline -5 e9g/next",
      "git status",
      "git diff e9g/next...e9g/b2-settings --stat",
      "git branch -D e9g/b1-old",
      "git branch -c e9g/next e9g/next-backup",
      "git worktree add --detach /tmp/e9g-insp-3 e9g/b2-settings && cd /tmp/e9g-insp-3 && git merge --no-commit --no-ff e9g/b3-x; git merge --abort",
      "git add .e9g/lessons.md && git commit -m 'lessons: builders rebase' -- .e9g/lessons.md",
      "cat >> .e9g/lessons.md <<'EOF'\n- builders rebase their own branch\nEOF",
      "cat > .e9g/run/board/4-settings.md <<'EOF'\n# 4: settings\nEOF",
      "git stash list",
      "git reset",
      "git reset -- .e9g/lessons.md",
      "git checkout -- .e9g/lessons.md",
      "git worktree prune",
      "git fetch origin && git log origin/main..e9g/next --oneline",
    ];
    return holds([
      ...builder.map((command) => bash(mono, "builder", command, "allow", { cwd: b })),
      ...tester.map((command) => bash(mono, "tester", command, "allow", { cwd: t })),
      ...reviewer.map((command) => bash(mono, "reviewer", command, "allow")),
      ...planner.map((command) => bash(mono, "planner", command, "allow")),
      tool(mono, "builder", "Grep", { pattern: "useState", glob: "*.tsx" }, "allow", { cwd: b }),
      tool(mono, "builder", "Grep", { pattern: "DATABASE_URL", path: join(b, "packages"), glob: "**/*" }, "allow", { cwd: b }),
      tool(mono, "builder", "Read", { file_path: join(b, ".env.example") }, "allow", { cwd: b }),
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

  test("protected branches and the integration branch", async () => {
    // The planner's exact push would refuse these too; what they say proves the protected-branch check.
    for (const command of ["git -C . push origin HEAD:main", "git push origin main", "git push origin HEAD:refs/heads/production"]) {
      const { outcome, said } = await guardAsync(home, "planner", "Bash", { command });
      assert.equal(outcome, "refuse", command);
      assert.match(said, /nothing is pushed to (main|production)/, command);
    }
    await holds([
      bash(home, "planner", "git -C . push origin HEAD:main", "refuse"),
      bash(home, "planner", "git push origin e9g/next", "refuse"),
      bash(home, "builder", "git branch -D e9g/next", "refuse"),
      bash(home, "builder", "git update-ref refs/heads/e9g/next HEAD", "refuse"),
      bash(home, "planner", "git merge e9g/b1-x", "refuse"),
      bash(home, "planner", "git rebase main", "refuse"),
      bash(home, "planner", "git reset --hard HEAD~1", "refuse"),
      bash(home, "planner", "git merge --abort", "allow"),
      bash(home, "planner", "git commit -m lessons -- .e9g/lessons.md", "allow"),
      bash(home, "builder", "git commit -am wip", "refuse"),
    ]);
  });

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

  test("the factory's folder and the run folder: only the planner's outbox, by any route", () => {
    const run = tmp("e9g-run-");
    const factory = process.env.E9G_HOME ?? "";
    return holds([
      bash(home, "planner", `echo "Subject: Which?" > ${run}/outbox/2026-10-25-question.md`, "allow", { run }),
      bash(home, "builder", `echo "Subject: from the team" > ${run}/outbox/x.md`, "refuse", { run }),
      bash(home, "planner", `echo x > ${run}/replies/r-1`, "refuse", { run }),
      bash(home, "builder", `echo '{"to":"attacker@example.com"}' > ${factory}/email.json`, "refuse", { run }),
      writes(home, "planner", join(factory, "email.json"), "refuse", { run }),
      bash(home, "builder", "security add-generic-password -U -s ca.e9g.email -a resend -w re_mine", "refuse"),
      bash(
        home,
        "builder",
        `node -e 'require("child_process").execFileSync("security", ["find-generic-password", "-s", "ca.e9g.email", "-w"])'`,
        "refuse"
      ),
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
      tool(home, "planner", send, { to: ["op@example.com"], subject: "[E9G-Planner] [Fixture team] x" }, "allow"),
      tool(home, "planner", send, { to: ["op@example.com"], subject: "[Fixture team] x" }, "refuse"),
      tool(home, "planner", send, { to: ["op@example.com"] }, "refuse"),
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

describe("what the planner sends is labelled E9G-Planner", () => {
  test("its GitHub issues carry the label, however it's given; members' issues and other gh commands are unaffected", () => {
    const home = makeRepo(baseTeam({ board: { github: { label: "loop" } } }));
    return holds([
      bash(home, "planner", 'gh issue create --title "Stuck checkout" --body "x" --label loop --label loop:triage', "refuse"),
      bash(home, "planner", 'gh issue create -t "Stuck checkout" -b x --label loop --label E9G-Planner', "allow"),
      bash(home, "planner", 'gh issue create -t "Stuck checkout" -b x -l "loop,loop:triage,E9G-Planner"', "allow"),
      bash(home, "planner", "gh -R acme/app issue create --title x --body y --label=E9G-Planner", "allow"),
      bash(home, "planner", 'gh label create E9G-Planner --color 5319E7 --description "Opened by an E9G team\'s planner"', "allow"),
      bash(home, "planner", "gh issue list --label E9G-Planner", "allow"),
      bash(home, "planner", "gh issue comment 12 --body 'Merged.'", "allow"),
      bash(home, "reviewer", 'gh issue create --title "Finding" --body x --label loop --label loop:triage', "allow"),
    ]);
  });

  test("the planner's prompt tells it so", () => {
    const team = loadTeam(makeRepo(baseTeam({ board: { github: { label: "loop" } } })));
    assert.match(compile(team, "planner"), /--label loop --label E9G-Planner/);
    assert.doesNotMatch(compile(team, "builder"), /E9G-Planner/);
  });
});

describe("e9g check's self-test", () => {
  test("ordinary work that the team's own rules narrow is expected to be refused, not allowed", () => {
    const team = loadTeam(
      makeRepo(baseTeam({ commandOwners: [{ rule: "\\bplaywright\\s+test\\b", roles: ["planner", "tester"], reason: "testers run e2e" }] }))
    );
    const playwright = guardCases(team).find((c) => c.tool === "Bash" && /playwright test/.test(String(c.input["command"])));
    assert.equal(playwright?.expect, "refuse");
    assert.match(playwright?.why ?? "", /narrow/);
  });
});

describe("the board's folder", () => {
  test("the planner makes it; others file findings in it", () => {
    const home = makeRepo();
    return holds([
      bash(home, "planner", "mkdir -p .e9g/run/board", "allow"),
      bash(home, "builder", "mkdir -p .e9g/run/board", "refuse"),
      bash(home, "reviewer", "touch .e9g/run/board/f-20261026-1200-x.md", "allow"),
    ]);
  });
});
