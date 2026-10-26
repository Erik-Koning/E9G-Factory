// Regressions from the review of the guard's rewrite (6785b3c..877a4ef): each test is one finding (the number is the
// review's).
import { baseTeam, bash, commit, e9g, git, guard, guardAsync, holds, makeRepo, ROOT, tmp, tool, write } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { normalize, type RawTeam } from "../lib/config.ts";
import { refusal } from "../lib/policies.ts";

// A pnpm monorepo's team checkout that ignores its env files and build output, with a builder's and a tester's
// worktree, each with its own .env.local (as worktreeSetup would copy in).
function monorepo(team: RawTeam = baseTeam()) {
  const home = makeRepo(team, {
    ".gitignore": "node_modules/\ndist/\n.next/\n.turbo/\ntest-results/\nplaywright-report/\n.env*\n!.env.example\n",
    "package.json": JSON.stringify({ name: "mono", scripts: { test: "vitest", build: "turbo run build" } }),
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    "packages/web/package.json": JSON.stringify({ name: "@app/web" }),
    "packages/web/src/page.tsx": "export default 1;\n",
    "packages/db/src/schema.ts": "export {};\n",
    "e2e/x.spec.ts": "test('x', () => {});\n",
    ".env.example": "A=\n",
  });
  writeFileSync(join(home, ".env.local"), "SECRET=1\n");
  const b = join(tmp("e9g-wt-"), "b2");
  git(home, "worktree", "add", "-q", "-b", "e9g/b2-x", b, team.branch ?? "e9g/next");
  writeFileSync(join(b, ".env.local"), "SECRET=1\n");
  const t = join(tmp("e9g-wt-"), "t1");
  git(home, "worktree", "add", "-q", "-b", "e9g/t-login", t, team.branch ?? "e9g/next");
  return { home, b, t, inB: { cwd: b }, inT: { cwd: t } };
}

// The refusal must say this: another check would refuse the call too.
async function refusedSaying(home: string, role: string, command: string, says: string, options: { cwd?: string } = {}): Promise<void> {
  const { outcome, said } = await guardAsync(home, role, "Bash", { command }, options);
  assert.equal(outcome, "refuse", `${role}: ${command}`);
  assert.ok(said.includes(says), `${role}: ${command}: should say "${says}", said ${said}`);
}

const fixture = (raw: RawTeam = {}) => normalize({ name: "fixture", branch: "e9g/next", ...raw }, "").team;

describe("the guard review's findings stay fixed", { concurrency: true }, () => {
  test("1: input that isn't a tool call refuses, and a guard that doesn't load reads no secret through a glob or a symlink", () => {
    const hook = join(ROOT, "plugin", "hooks", "guard.ts");
    const status = (path: string, stdin: string) =>
      spawnSync(process.execPath, [path], { input: stdin, env: { ...process.env, E9G_TEAM: "fixture", E9G_ROLE: "builder" }, encoding: "utf8" }).status;
    for (const stdin of ["null", "[]", '"x"', "5", '{"tool_name":5}', '{"tool_name":"Bash","tool_input":"ls"}'])
      assert.equal(status(hook, stdin), 2, stdin);

    const copy = tmp("e9g-factory-");
    for (const part of ["plugin", "lib", "package.json"]) cpSync(join(ROOT, part), join(copy, part), { recursive: true });
    writeFileSync(join(copy, "lib", "guard.ts"), 'throw new Error("broken at import");\n');
    const broken = join(copy, "plugin", "hooks", "guard.ts");
    const repo = tmp("e9g-repo-");
    writeFileSync(join(repo, ".env.local"), "SECRET=1\n");
    symlinkSync(join(repo, ".env.local"), join(repo, "notes.txt"));
    const call = (input: Record<string, unknown>) => JSON.stringify({ cwd: repo, ...input });
    assert.equal(status(broken, "null"), 2);
    assert.equal(status(broken, call({ tool_name: "Grep", tool_input: { pattern: "SECRET", glob: ".env*" } })), 2);
    assert.equal(status(broken, call({ tool_name: "Grep", tool_input: { pattern: "SECRET", glob: "*" } })), 2);
    assert.equal(status(broken, call({ tool_name: "Read", tool_input: { file_path: join(repo, "notes.txt") } })), 2);
    assert.equal(status(broken, call({ tool_name: "Read", tool_input: { file_path: "notes.txt" } })), 2);
    assert.equal(status(broken, call({ tool_name: "Read", tool_input: { file_path: join(repo, "README.md") } })), 0);
    assert.equal(status(broken, call({ tool_name: "Grep", tool_input: { pattern: "x", path: repo } })), 0);
  });

  test("2: the factory's operator commands and owned commands, however they're called", () => {
    const { home, b, inB } = monorepo(baseTeam({ environment: { script: ".e9g/adapters/env.sh" } as never }));
    return holds([
      ...["pause", "resume", "unregister", "rotate"].map((sub) =>
        bash(home, "builder", `node --no-warnings ~/.e9g/versions/0.3.0/bin/e9g.ts ${sub} fixture`, "refuse", inB)
      ),
      bash(home, "builder", "node --import tsx /Users/x/.e9g/versions/dev/bin/e9g.ts merge e9g/b2-x", "refuse", inB),
      bash(home, "builder", "deno run -A ~/.e9g/versions/0.3.0/bin/e9g.ts start fixture", "refuse", inB),
      bash(home, "builder", "arch -arm64 e9g pause fixture", "refuse", inB),
      bash(home, "builder", "concurrently 'e9g pause fixture'", "refuse", inB),
      bash(home, "builder", ". .e9g/adapters/env.sh reset", "refuse", inB),
      bash(home, "builder", "source .e9g/adapters/env.sh reset", "refuse", inB),
      bash(home, "planner", ". .e9g/adapters/env.sh reset", "allow"),
      bash(home, "builder", `node ${join(b, "scripts/check.mjs")}`, "allow", inB),
    ]);
  });

  test("2: the operator's commands refuse an agent on a team themselves", async () => {
    const agent = { env: { E9G_TEAM: "fixture", E9G_ROLE: "planner" } };
    // A team that isn't registered and folders that don't exist: whatever the command did before refusing, it can't
    // reach anything real.
    for (const args of [
      ["pause", "e9g-no-such-team"],
      ["resume", "e9g-no-such-team"],
      ["rotate", "e9g-no-such-team"],
      ["unregister", "e9g-no-such-team"],
      ["start", "e9g-no-such-team"],
      ["upgrade", "e9g-no-such-team"],
      ["register", "/tmp/e9g-no-such-checkout"],
      ["init", "/tmp/e9g-no-such-repo", "--no-interview"],
    ]) {
      const result = await e9g(args, agent);
      assert.equal(result.code, 2, `${args.join(" ")}: ${result.out}`);
      assert.match(result.out, /is the operator's; an agent on a team/, args.join(" "));
    }
    // self-install and watchdog install|remove would change this machine, so they're proven through the helper they call.
    const helper = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `import { operatorOnly } from "${join(ROOT, "lib/session.ts")}"; operatorOnly("watchdog install");`],
      {
        env: { ...process.env, E9G_TEAM: "fixture" },
        encoding: "utf8",
      }
    );
    assert.equal(helper.status, 2);
    assert.match(helper.stderr, /watchdog install is the operator's/);
    for (const [file, command] of [
      ["install.ts", "self-install"],
      ["watchdog.ts", "watchdog install"],
      ["watchdog.ts", "watchdog remove"],
    ] as const)
      assert.ok(readFileSync(join(ROOT, "lib/commands", file), "utf8").includes(`operatorOnly("${command}")`), command);
  });

  test("3: the rules for live keys, hosted databases and webhooks read free text too", () => {
    const { home, inB } = monorepo();
    return holds([
      bash(home, "builder", "echo 'STRIPE_SECRET_KEY=sk_live_abc123' >> packages/web/src/config.ts", "refuse", inB),
      bash(home, "builder", `gh issue comment 3 --body "key is sk_live_abc123"`, "refuse", inB),
      bash(home, "builder", `git commit -m "use mongodb+srv://u:p@cluster0.x.net"`, "refuse", inB),
      bash(home, "builder", "printf 'MONGO=mongodb+srv://u:p@x.mongodb.net' > packages/db/src/url.ts", "refuse", inB),
      bash(home, "builder", `git commit -m "post to https://hooks.slack.com/services/T0/B0/x"`, "refuse", inB),
      bash(home, "builder", `echo 'supabase link --project-ref abcdefgh' > scripts/link.sh`, "refuse", inB),
      // The command-position rules still don't read it.
      bash(home, "builder", `git commit -m "Deploy with vercel deploy --prod; run supabase db push by hand"`, "allow", inB),
      bash(home, "builder", "echo 'STRIPE_SECRET_KEY=sk_test_abc123' >> packages/web/src/config.ts", "allow", inB),
    ]);
  });

  test("4: rg and the Grep tool don't read env files through globs or -u, --no-ignore and --hidden", async () => {
    const { home, b, inB } = monorepo();
    const grep = (input: Record<string, unknown>, expected: "allow" | "refuse") =>
      tool(home, "builder", "Grep", { pattern: "SECRET", ...input }, expected, inB);
    await holds([
      grep({ glob: "*" }, "refuse"),
      grep({ glob: "**/*" }, "refuse"),
      grep({ path: b, glob: "*.local" }, "refuse"),
      grep({ glob: "*.ts" }, "allow"),
      grep({ glob: "*.{ts,tsx}" }, "allow"),
      grep({ glob: "!*.md" }, "allow"),
      grep({ path: join(b, "packages"), glob: "*" }, "allow"),
      bash(home, "builder", "rg -g '*' SECRET", "refuse", inB),
      bash(home, "builder", "rg -uu SECRET", "refuse", inB),
      bash(home, "builder", "rg --no-ignore --hidden SECRET .", "refuse", inB),
      bash(home, "builder", "rg --iglob '*.LOCAL' SECRET", "refuse", inB),
      bash(home, "builder", "git grep --no-index SECRET", "refuse", inB),
      bash(home, "builder", "rg -g '*.ts' SECRET", "allow", inB),
      bash(home, "builder", "rg -g '*' -g '!.env*' SECRET", "allow", inB),
      bash(home, "builder", "rg --hidden SECRET", "allow", inB),
      bash(home, "builder", "rg -u SECRET", "allow", inB),
      bash(home, "builder", "rg --files -g '*'", "allow", inB),
      bash(home, "builder", "git grep SECRET", "allow", inB),
      bash(home, "builder", "grep -rn SECRET --include='*.ts' .", "allow", inB),
    ]);
    // The refusal no longer sends grep -r to rg and Grep as if they always skipped env files.
    const { said } = guard(home, "builder", "Bash", { command: "grep -rn SECRET ." }, inB);
    assert.doesNotMatch(said, /which skip them/);
    assert.match(said, /\.env\.local holds secrets/);
  });

  test("5: the turbo and nx deploy rule reads task positions only", () => {
    const team = fixture();
    for (const command of [
      "nx test shipping-api",
      "nx run-many -t build -p web shipping",
      "turbo run dev --filter publisher-web",
      "pnpm nx g @nx/js:lib release-utils",
      "turbo run build --filter=@app/web -- --mode release",
      "nx run deploy-tools:build",
      "turbo run lint --filter=...[origin/main]",
      "pnpm run shipping-labels",
    ])
      assert.equal(refusal(team, command), null, command);
    for (const command of [
      "turbo run deploy",
      "turbo deploy",
      "turbo run build web#deploy",
      "turbo run deploy:prod --filter web",
      "nx deploy web",
      "nx run web:deploy",
      "nx run web:deploy:production",
      "nx web:release",
      "nx run-many -t deploy",
      "nx run-many --targets=build,deploy",
      "nx affected -t publish",
      "nx release publish",
      "pnpm nx run web:deploy",
      "npx turbo@latest run deploy",
      "pnpm run release-notes",
    ])
      assert.ok(refusal(team, command), command);
  });

  test("6: a cd that doesn't happen, cd -, pushd and popd, and GIT_DIR don't move the git rules", () => {
    const home = makeRepo();
    return holds([
      bash(home, "planner", "cd /tmp/e9g-does-not-exist; git reset --hard HEAD~1", "refuse"),
      bash(home, "planner", "cd /tmp/e9g-does-not-exist; git merge e9g/b2-x", "refuse"),
      bash(home, "planner", "cd /tmp/e9g-does-not-exist || git merge e9g/b2-x", "refuse"),
      bash(home, "planner", "cd /tmp && cd - && git merge e9g/b2-x", "refuse"),
      bash(home, "reviewer", "pushd /tmp >/dev/null; popd >/dev/null; git checkout e9g/b2-x", "refuse"),
      bash(home, "planner", `cd /tmp && GIT_DIR=${join(home, ".git")} git reset --hard HEAD~1`, "refuse"),
      bash(home, "planner", `export GIT_DIR=${join(home, ".git")}; cd /tmp && git merge e9g/b2-x`, "refuse"),
      bash(home, "reviewer", `cd /tmp && GIT_WORK_TREE=${home} git checkout e9g/b2-x`, "refuse"),
      // The planner's and reviewers' scratch worktrees still work, made in the same command.
      bash(home, "planner", "git worktree add --detach /tmp/e9g-insp-6 e9g/next && cd /tmp/e9g-insp-6 && git merge --no-commit e9g/b2-x", "allow"),
      bash(home, "reviewer", "cd /tmp && git status", "allow"),
    ]);
  });

  test("7: commands quoted in node -e and python -c, and the commands runners run", () => {
    const { home, inB, inT } = monorepo();
    return holds([
      ...[
        `node -e "require('child_process').execSync('vercel deploy --prod')"`,
        `python3 -c "import os; os.system('vercel deploy --prod')"`,
        `concurrently "pnpm dev" "vercel deploy --prod"`,
        `nodemon --exec 'vercel deploy'`,
        `ssh build-box 'vercel deploy --prod'`,
        `tmux new -d 'vercel deploy --prod'`,
        `git rebase -x 'npm publish' HEAD~1`,
        `git submodule foreach 'npm publish'`,
      ].map((command) => bash(home, "builder", command, "refuse", inB)),
      // What a program prints is prose: its > writes nothing.
      bash(home, "tester", `node -e "console.log('a > b')"`, "allow", inT),
      bash(home, "tester", `python3 -c "print('built -> dist')"`, "allow", inT),
      bash(home, "builder", `node -e "console.log(require('./package.json').name)"`, "allow", inB),
    ]);
  });

  test("8: what keeps files out, and what lists names, reads no secrets", () => {
    const { home, inB } = monorepo();
    return holds([
      bash(home, "builder", "rg -n DATABASE_URL -g '!**/.env*'", "allow", inB),
      bash(home, "builder", "rg --files -g '!**/*.pem'", "allow", inB),
      bash(home, "builder", "tar --exclude='.env*' -czf /tmp/e9g-src.tgz packages", "allow", inB),
      bash(home, "builder", "tar --exclude=.env.local -czf /tmp/e9g-src.tgz packages", "allow", inB),
      bash(home, "builder", "ls -la .env*", "allow", inB),
      bash(home, "builder", "test -f .env.local && echo yes", "allow", inB),
      bash(home, "builder", "git diff --stat -- . ':!.env*'", "allow", inB),
      bash(home, "builder", "cat .env*", "refuse", inB),
      bash(home, "builder", "tar -czf /tmp/e9g-src.tgz .env.local", "refuse", inB),
      bash(home, "builder", "ls -la > .env.local", "refuse", inB),
    ]);
  });

  test("9: a tester discards its own changes, and no more", () => {
    const home = makeRepo(baseTeam(), { "e2e/x.spec.ts": "test('x', () => {});\n" });
    commit(home, { "src/app.ts": "export const a = 2;\n" }, "a newer app");
    const worktree = join(tmp("e9g-wt-"), "t1");
    git(home, "worktree", "add", "-q", "-b", "e9g/t-login", worktree, "e9g/next");
    write(worktree, { "e2e/x.spec.ts": "test('y', () => {});\n" });
    const inT = { cwd: worktree };
    const dirty = join(tmp("e9g-wt-"), "t2");
    git(home, "worktree", "add", "-q", "-b", "e9g/t-dirty", dirty, "e9g/next");
    write(dirty, { "src/app.ts": "export const a = 3;\n" });
    return holds([
      bash(home, "tester", "git restore .", "allow", inT),
      bash(home, "tester", "git checkout -- .", "allow", inT),
      bash(home, "tester", "git restore --staged .", "allow", inT),
      bash(home, "tester", "git restore --staged src/app.ts", "allow", inT),
      bash(home, "tester", "git checkout -- e2e", "allow", inT),
      bash(home, "tester", "mkdir e2e/journeys && rm -rf e2e/journeys", "allow", inT),
      bash(home, "tester", "git restore src/app.ts", "refuse", inT),
      bash(home, "tester", "git restore --source HEAD~1 -- src", "refuse", inT),
      bash(home, "tester", "git checkout HEAD~1 -- .", "refuse", inT),
      bash(home, "tester", "git restore .", "refuse", { cwd: dirty }),
      // A folder is in a lane when what's in it is.
      bash(home, "builder", "rm -rf e2e", "refuse", inT),
    ]);
  });

  test("10: a substitution inside ${ … } is read", () => {
    const home = makeRepo();
    return holds([
      bash(home, "builder", "echo ${X:-$(vercel deploy --prod)}", "refuse"),
      bash(home, "builder", 'echo "${X:-$(vercel deploy --prod)}"', "refuse"),
      bash(home, "builder", "y=${X:-`vercel deploy`}", "refuse"),
      bash(home, "builder", "echo ${HOME:-/tmp} ${#PATH}", "allow"),
    ]);
  });

  test("11: shell writes cost no git spawn in the lane, and one for them all outside it", () => {
    const { home, b, t } = monorepo();
    const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const bin = tmp("e9g-bin-");
    const count = join(tmp("e9g-count-"), "git");
    writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$*" >> "${count}"\nexec "${real}" "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    const spawns = (role: string, cwd: string, command: string): number => {
      writeFileSync(count, "");
      const { outcome, said } = guard(home, role, "Bash", { command }, { cwd, env: { PATH: `${bin}:${process.env.PATH}` } });
      assert.equal(outcome, "allow", said);
      return readFileSync(count, "utf8").split("\n").filter(Boolean).length;
    };
    const files = Array.from({ length: 100 }, (_, i) => `packages/web/src/f${i}.ts`).join(" ");
    assert.equal(spawns("builder", b, `touch ${files}`), 0);
    assert.equal(spawns("builder", b, `rm -f ${files}`), 0);
    const outputs = Array.from({ length: 100 }, (_, i) => `test-results/r${i}.json`).join(" ");
    mkdirSync(join(t, "test-results"), { recursive: true });
    assert.equal(spawns("tester", t, `touch ${outputs}`), 1);
  });

  test("12: arithmetic, echo's flags and printf, --amend's abbreviations, and branch copies", () => {
    const home = makeRepo();
    commit(home, { ".e9g/lessons.md": "- one\n" }, "lessons");
    return holds([
      ...[
        "(( x = 1 << 4 ))\nvercel deploy --prod",
        "let x=1<<2\nvercel deploy --prod",
        "echo $[1<<2]\nvercel deploy --prod",
        "echo -n 'vercel deploy --prod' | sh",
        "echo -e 'vercel deploy --prod' | bash",
        "printf '%s\\n' 'vercel deploy --prod' | bash",
      ].map((command) => bash(home, "builder", command, "refuse")),
      bash(home, "planner", "git commit --amen --no-edit", "refuse"),
      bash(home, "planner", "git commit --am --no-edit", "refuse"),
      bash(home, "planner", "git branch -c e9g/next e9g/next-backup", "allow"),
      bash(home, "planner", "git branch -c e9g/b1-x e9g/next", "refuse"),
      bash(home, "planner", "git branch -C e9g/next", "refuse"),
      bash(home, "builder", "git push --mirr origin", "refuse"),
      bash(home, "builder", "git push --del origin x", "refuse"),
    ]);
  });

  test("13: the paths no test held before", async () => {
    const { home, b, inB, inT } = monorepo(baseTeam({ push: { remote: "origin" } }));
    await holds([
      bash(home, "builder", "echo 'vercel deploy --prod' | sh", "refuse", inB),
      bash(home, "builder", "bash <<< 'vercel deploy --prod'", "refuse", inB),
      bash(home, "builder", "diff <(vercel deploy --prod) README.md", "refuse", inB),
      bash(home, "builder", "echo '#!/bin/sh' > .git/hooks/pre-commit", "refuse", inB),
      tool(home, "builder", "Write", { file_path: join(b, ".git/hooks/pre-commit") }, "refuse", inB),
      bash(home, "planner", "echo '[core]' >> .git/config", "refuse"),
      bash(home, "builder", "git commit -am wip", "refuse"),
      bash(home, "tester", "git -C . commit -am wip", "refuse", { cwd: home }),
      bash(home, "tester", "git restore packages/web/src/page.tsx", "refuse", inT),
      bash(home, "builder", "npx -c 'vercel deploy --prod'", "refuse", inB),
      bash(home, "builder", "pnpm exec -c 'vercel deploy --prod'", "refuse", inB),
      bash(home, "builder", "npm exec -c 'vercel deploy --prod'", "refuse", inB),
      bash(home, "builder", `${"echo $(".repeat(10)}echo hi${")".repeat(10)}`, "refuse", inB),
      bash(home, "builder", `${"echo $(".repeat(8)}echo hi${")".repeat(8)}`, "allow", inB),
    ]);
    // The protected-branch check itself: the planner's exact push and its cadence would refuse these too.
    await refusedSaying(home, "planner", "git push origin main", "nothing is pushed to main");
    await refusedSaying(home, "planner", "git -C . push origin HEAD:main", "nothing is pushed to main");
    await refusedSaying(home, "planner", "git push origin e9g/next:refs/heads/master", "nothing is pushed to master");
  });

  test("13: e9g check fails a guard that lost its protected-branch check", async () => {
    const copy = join(tmp("e9g-factory-"), "E9G-Factory");
    for (const part of ["bin", "lib", "plugin", "templates", "schema", "CONSTITUTION.md", "package.json"])
      cpSync(join(ROOT, part), join(copy, part), { recursive: true });
    const guardFile = join(copy, "lib", "guard.ts");
    const text = readFileSync(guardFile, "utf8");
    const check = "if (list(team.protectedBranches).includes(target)) refuse(`nothing is pushed to ${target}.`);";
    assert.ok(text.includes(check));
    writeFileSync(guardFile, text.replace(check, ""));
    // T3 Code's CLI, as e9g check's contract check asks it.
    const bin = tmp("e9g-bin-");
    writeFileSync(
      join(bin, "t3"),
      '#!/bin/sh\ncase "$1 $2" in "--version "*) echo 0.1.5 ;; "thread --help") echo "start send show" ;; *) exit 1 ;; esac\n'
    );
    chmodSync(join(bin, "t3"), 0o755);
    const home = makeRepo();
    const result = spawnSync(process.execPath, [join(copy, "bin", "e9g.ts"), "check", home], {
      cwd: home,
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin` },
      encoding: "utf8",
    });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /^FAIL {2}guard: planner: a push to a protected branch: expected refuse saying "nothing is pushed to main"/m);
  });
});
