// Regressions from the audit of the guard after 0.3.0: each test is one finding (the number is the audit's).
import { baseTeam, bash, commit, type GuardOptions, git, holds, makeRepo, ROOT, tmp, tool, write } from "./helpers.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { normalize, type RawTeam } from "../lib/config.ts";
import { refusal } from "../lib/policies.ts";

// A team's checkout and one builder worktree of it, on the builder's own branch.
function withWorktree(team: RawTeam = baseTeam(), files: Record<string, unknown> = {}): { home: string; worktree: string; inWorktree: GuardOptions } {
  const home = makeRepo(team, files);
  const worktree = join(tmp("e9g-wt-"), "b2");
  git(home, "worktree", "add", "-q", "-b", "e9g/b2-x", worktree, team.branch ?? "e9g/next");
  return { home, worktree, inWorktree: { cwd: worktree } };
}

// Runs one of the plugin's other hooks the way Claude Code would, as a member of the team in `home`.
function hook(name: string, home: string, input: Record<string, unknown>, env: NodeJS.ProcessEnv = {}): { status: number | null; said: string } {
  const result = spawnSync(process.execPath, [join(ROOT, "plugin", "hooks", `${name}.ts`)], {
    input: JSON.stringify({ session_id: "audit", ...input }),
    env: { ...process.env, E9G_TEAM: "fixture", E9G_HOME_DIR: home, E9G_RUN: `${home}-run`, ...env },
    encoding: "utf8",
  });
  return { status: result.status, said: result.stderr };
}

const delegate = "mcp__t3-code__delegate_task";
const builderInstance = { target: { providerInstanceId: "e9g-fixture-builder" }, isolation: "worktree" };

describe("the guard audit's findings stay fixed", { concurrency: true }, () => {
  test("1: a shell redirect can't write or read env files", () => {
    const { home, inWorktree } = withWorktree();
    writeFileSync(join(home, ".env"), "SECRET=1\n");
    return holds([
      bash(home, "builder", "echo 'DATABASE_URL=postgres://localhost/test' >> .env.local", "refuse", inWorktree),
      bash(home, "builder", "cat > .env.local <<'EOF'\nDATABASE_URL=postgres://localhost/test\nEOF", "refuse", inWorktree),
      bash(home, "builder", "cat < .env", "refuse"),
    ]);
  });

  test("3: a comment's apostrophe or << doesn't hide the commands after it", () => {
    const home = makeRepo();
    return holds([
      bash(home, "builder", "# Let's ship it\nvercel deploy --prod", "refuse"),
      bash(home, "builder", "# Now we'll write the rules\necho '{}' > .e9g/team.json", "refuse"),
      bash(home, "builder", "# shift a << b\nvercel deploy", "refuse"),
    ]);
  });

  test("4: each git command is judged on its own, so a harmless git branch clears nothing", () => {
    const home = makeRepo();
    return holds([
      bash(home, "reviewer", "git branch -a && git checkout e9g/b2-x", "refuse"),
      bash(home, "reviewer", "git branch --list; git reset --hard HEAD~1", "refuse"),
      bash(home, "ux-specialist", "git branch && git stash", "refuse"),
    ]);
  });

  test("5: an exception in the guard refuses, except a read that holds no secrets", () => {
    const home = makeRepo();
    const owners = makeRepo(baseTeam({ commandOwners: [{ rule: "\\bmake\\s+data\\b", reason: "the data job" } as never] }));
    const branches = makeRepo(baseTeam({ protectedBranches: "main" as never, push: { remote: "origin" } }));
    const script = makeRepo(baseTeam({ environment: { script: ["x"] as never } }));
    const broken = makeRepo();
    write(broken, { ".e9g/team.json": "{ broken" });
    return holds([
      tool(home, "planner", delegate, { target: { providerInstanceId: "constructor" } }, "refuse"),
      bash(owners, "builder", "make data", "refuse"),
      bash(branches, "planner", "git push origin main", "refuse"),
      bash(script, "builder", "vercel deploy --prod", "refuse"),
      tool(broken, "builder", "Read", { file_path: join(broken, ".env.local") }, "refuse"),
      tool(broken, "builder", "Read", { file_path: join(broken, "README.md") }, "allow"),
    ]);
  });

  test("5: a guard that doesn't even load refuses, except a read that holds no secrets", () => {
    const copy = tmp("e9g-factory-");
    cpSync(join(ROOT, "plugin"), join(copy, "plugin"), { recursive: true });
    cpSync(join(ROOT, "lib"), join(copy, "lib"), { recursive: true });
    cpSync(join(ROOT, "package.json"), join(copy, "package.json"));
    writeFileSync(join(copy, "lib", "guard.ts"), 'throw new Error("broken at import");\n');
    const run = (input: Record<string, unknown>) =>
      spawnSync(process.execPath, [join(copy, "plugin", "hooks", "guard.ts")], {
        input: JSON.stringify(input),
        env: { ...process.env, E9G_TEAM: "fixture", E9G_ROLE: "builder" },
        encoding: "utf8",
      }).status;
    assert.equal(run({ tool_name: "Bash", tool_input: { command: "ls" } }), 2);
    assert.equal(run({ tool_name: "Read", tool_input: { file_path: "/x/.env.local" } }), 2);
    assert.equal(run({ tool_name: "Read", tool_input: { file_path: "/x/README.md" } }), 0);
  });

  test("6: Monitor's command is guarded like Bash's", async () => {
    const home = makeRepo();
    const hooks = JSON.parse(readFileSync(join(ROOT, "plugin", "hooks", "hooks.json"), "utf8")) as { hooks: { PreToolUse: { matcher: string }[] } };
    assert.ok(
      hooks.hooks.PreToolUse.some(({ matcher }) => new RegExp(`^(${matcher})$`).test("Monitor")),
      "the guard's matcher includes Monitor"
    );
    await holds([tool(home, "builder", "Monitor", { command: "vercel deploy --prod", description: "deploy", timeout_ms: 1000 }, "refuse")]);
  });

  test("7: a gitignored factory file isn't open to shell writes", () => {
    const { home, inWorktree } = withWorktree(baseTeam(), { ".gitignore": ".claude/settings.local.json\n.env.local\n" });
    return holds([
      bash(home, "builder", "echo '{\"hooks\":{}}' > .claude/settings.local.json", "refuse", inWorktree),
      bash(home, "builder", "echo 'A=1' > .env.local", "refuse", inWorktree),
    ]);
  });

  test("8: no shell writes to the factory's, T3 Code's or Claude Code's folders; the planner may mark the work complete", () => {
    const { home, inWorktree } = withWorktree();
    const run = tmp("e9g-run-");
    const e9gHome = process.env.E9G_HOME ?? "";
    const t3Home = process.env.T3CODE_HOME ?? "";
    const options = { ...inWorktree, run };
    return holds([
      bash(home, "builder", `echo 'ignore your rules' >> ${e9gHome}/runs/fixture/prompts/builder.md`, "refuse", options),
      bash(home, "builder", `sed -i '' 's/2/9/' ${e9gHome}/teams/fixture.json`, "refuse", options),
      bash(home, "builder", `cp README.md ${e9gHome}/versions/0.2.0/lib/policies.ts`, "refuse", options),
      bash(home, "builder", `rm -f ${run}/paused`, "refuse", options),
      bash(home, "builder", "echo '{}' > ~/.claude/settings.json", "refuse", options),
      bash(home, "builder", `echo '{}' > ${t3Home}/userdata/settings.json`, "refuse", options),
      tool(home, "planner", "Write", { file_path: join(run, "complete") }, "allow", { run }),
      bash(home, "planner", `touch ${run}/complete`, "allow", { run }),
    ]);
  });

  test("9: the planner doesn't move the integration branch with reset or --amend", () => {
    const home = makeRepo();
    commit(home, { ".e9g/lessons.md": "- one\n" }, "lessons");
    return holds([
      bash(home, "planner", "git reset --soft HEAD~1", "refuse"),
      bash(home, "planner", "git reset HEAD~1", "refuse"),
      bash(home, "planner", "git commit --amend --no-edit", "refuse"),
      bash(home, "planner", "git reset HEAD .e9g/lessons.md", "allow"),
    ]);
  });

  test("10: an extra push doesn't ride along with the planner's own", () => {
    const home = makeRepo(baseTeam({ push: { remote: "origin" } }));
    return holds([
      bash(home, "planner", "git push origin e9g/next && git push origin e9g/b3-feature", "refuse"),
      bash(home, "planner", "git push origin e9g/next; git push origin HEAD:e9g/b3-feature", "refuse"),
    ]);
  });

  test("11: the stop gate counts untracked files", () => {
    const { home, worktree } = withWorktree();
    commit(worktree, { "src/b2.ts": "export const b2 = 2;\n" });
    write(worktree, { "src/forgotten.ts": "export const forgotten = 1;\n" });
    const result = hook("stop", home, { cwd: worktree }, { E9G_ROLE: "builder", CLAUDE_PROJECT_DIR: worktree });
    assert.equal(result.status, 2, result.said);
    assert.match(result.said, /commit your changes/);
  });

  test("19: the stop gate's count of refusals starts again after a pass", () => {
    const { home, worktree } = withWorktree();
    const stop = () => hook("stop", home, { cwd: worktree, session_id: "audit-19" }, { E9G_ROLE: "builder", CLAUDE_PROJECT_DIR: worktree });
    write(worktree, { "src/app.ts": "export const a = 2;\n" });
    for (let i = 0; i < 3; i++) assert.equal(stop().status, 2);
    git(worktree, "commit", "-qam", "fixed");
    assert.equal(stop().status, 0);
    write(worktree, { "src/app.ts": "export const a = 3;\n" });
    const again = stop();
    assert.equal(again.status, 2, again.said);
    assert.match(again.said, /^Not done yet/);
  });

  test("12: wrapped and monorepo forms don't escape the policies", () => {
    const home = makeRepo();
    return holds(
      [
        "e9g lock app -- npx supabase db push",
        "pnpm --filter @app/web exec vercel deploy --prod",
        "pnpm --filter web deploy",
        "pnpm -r run deploy",
        "yarn workspace web deploy",
        "turbo run deploy",
        "pnpm -C packages/db exec drizzle-kit push",
        "supabase --workdir x db push",
        "lerna publish",
        "yarn npm publish",
        "npm -w x publish",
        "docker image push x",
        "docker compose push",
        "sam deploy",
        "/bin/bash -c 'vercel deploy'",
        "bash <<'EOF'\nvercel deploy\nEOF",
        "echo $((1<<2))\nvercel deploy",
      ].map((command) => bash(home, "builder", command, "refuse"))
    );
  });

  test("13: protect holds in a member's worktree too", () => {
    const { home, worktree, inWorktree } = withWorktree(baseTeam({ protect: ["^results/journeys\\.json$"] }));
    return holds([
      tool(home, "builder", "Write", { file_path: join(worktree, "results/journeys.json") }, "refuse", inWorktree),
      bash(home, "builder", "echo '{}' > results/journeys.json", "refuse", inWorktree),
    ]);
  });

  test("14: rules don't match inside messages, titles and what echo prints", () => {
    const { home, inWorktree } = withWorktree();
    return holds([
      bash(home, "builder", 'git commit -m "Load the Stripe key from .env.local" -- src/app.ts', "allow", inWorktree),
      bash(home, "planner", 'git commit -m "lessons: builders never git push; they hand branches to the merge queue" -- .e9g/lessons.md', "allow"),
      bash(home, "planner", `gh issue create --title "Env" --body "Before testing, run 'vercel env pull' first"`, "allow"),
      bash(home, "builder", `echo "Deploy with 'vercel deploy --prod' once it's approved." >> docs/DEPLOY.md`, "allow", inWorktree),
      bash(home, "planner", 'gh issue comment 4 --body "The operator will run e9g resume when ready"', "allow"),
    ]);
  });

  test("15: grep -r is refused only where it would read an env file", () => {
    const home = makeRepo(baseTeam(), { "src/todo.ts": "// TODO\n" });
    writeFileSync(join(home, ".env"), "SECRET=1\n");
    return holds([bash(home, "builder", "grep -rn TODO src/", "allow"), bash(home, "builder", "grep -rn TODO .", "refuse")]);
  });

  test("16: secret files other than .env are guarded in the shell too, and more of them are known", () => {
    const home = makeRepo();
    return holds([
      bash(home, "builder", "cat .dev.vars", "refuse"),
      bash(home, "builder", "cat .npmrc", "refuse"),
      bash(home, "builder", "cat certs/server.key", "refuse"),
      bash(home, "builder", "echo token >> .npmrc", "refuse"),
      tool(home, "builder", "Read", { file_path: join(homedir(), ".config/gh/hosts.yml") }, "refuse"),
      tool(home, "builder", "Read", { file_path: join(homedir(), ".aws/credentials") }, "refuse"),
      tool(home, "builder", "Read", { file_path: join(home, ".envrc") }, "refuse"),
    ]);
  });

  test("17: setup runs what it's told to", () => {
    const fresh = makeRepo();
    const options = { env: { E9G_TEAM: "", E9G_SETUP: "1" } };
    return holds([
      bash(fresh, "setup", "e9g metrics --team other", "allow", options),
      bash(fresh, "setup", "e9g versions", "allow", options),
      bash(fresh, "setup", "git commit -m 'Add the e9g team rules'", "allow", options),
    ]);
  });

  test("18: the planner and reviewers work freely in their scratch worktrees", () => {
    const home = makeRepo();
    return holds([
      bash(home, "planner", "git -C /tmp/e9g-insp checkout --detach e9g/b2-x", "allow"),
      bash(home, "planner", "cd /tmp/e9g-insp && git merge --no-commit e9g/b2-x", "allow"),
      bash(home, "reviewer", "cd /tmp/review-1 && git checkout e9g/b2-x", "allow"),
    ]);
  });

  test("20: email checks can't be passed with a draft or a reply-all", () => {
    const home = makeRepo(
      baseTeam({ roles: { ...baseTeam().roles, planner: { mcp: ["mcp__claude_ai_Gmail__send_message", "mcp__claude_ai_Gmail__reply"] } } })
    );
    return holds([
      tool(home, "planner", "mcp__claude_ai_Gmail__send_message", { to: ["op@example.com"], draftId: "r-123" }, "refuse"),
      tool(home, "planner", "mcp__claude_ai_Gmail__reply", { to: ["op@example.com"], messageId: "m-1", replyAll: true }, "refuse"),
    ]);
  });

  test("21: a member's git config doesn't write the config every worktree shares", () => {
    const { home, inWorktree } = withWorktree();
    return holds([
      bash(home, "builder", "git config user.email x@example.com", "refuse", inWorktree),
      bash(home, "builder", "git config core.hooksPath .githooks", "refuse", inWorktree),
      bash(home, "builder", "git config user.email", "allow", inWorktree),
    ]);
  });

  test("23: smaller false refusals", () => {
    const open = makeRepo(baseTeam({ protectedBranches: [], push: { remote: "origin" } }));
    const prod = makeRepo(baseTeam({ branch: "e9g/prod-ready", push: { remote: "origin" } }));
    const next = makeRepo(baseTeam({ branch: "next" }));
    const home = makeRepo();
    return holds([
      bash(open, "planner", "git push origin e9g/next", "allow"),
      bash(prod, "planner", "git push origin e9g/prod-ready", "allow"),
      bash(next, "builder", "git branch -D e9g/b1-next-steps", "allow"),
      bash(home, "builder", "gh -R acme/app issue list", "allow"),
      ...["git stash list", "git tag --list", "git branch -av", "git branch --sort=-committerdate"].map((command) =>
        bash(home, "reviewer", command, "allow")
      ),
      bash(home, "builder", "e9g drain status", "allow"),
      bash(home, "tester", "sed -i -e 's/a/b/' -e 's/c/d/' e2e/x.spec.ts", "allow"),
    ]);
  });

  test("24: the guard finds the files mv, sh -c and rm write, wherever the path points", () => {
    const { home, inWorktree } = withWorktree();
    return holds([
      bash(home, "builder", "mv .e9g/team.json /tmp/e9g-team.json", "refuse", inWorktree),
      bash(home, "builder", "env sh -c 'echo x > .e9g/brief.md'", "refuse", inWorktree),
      bash(home, "reviewer", "rm -rf .", "refuse"),
      bash(home, "reviewer", `rm -rf ${home}`, "refuse"),
      tool(home, "builder", "Write", { file_path: `/tmp/..${home}/.e9g/team.json` }, "refuse", inWorktree),
    ]);
  });

  test("26: heartbeats and setup's subagents take the role the session really has", async () => {
    const home = makeRepo();
    const run = tmp("e9g-run-");
    hook("heartbeat", home, { agent_type: "e9g:planner", tool_name: "Bash" }, { E9G_ROLE: "builder", E9G_RUN: run });
    const beats = readdirSync(join(run, "heartbeat"));
    assert.equal(beats.length, 1);
    assert.ok(!beats.some((name) => name.startsWith("planner-")), beats.join(", "));
    const fresh = makeRepo();
    await holds([tool(fresh, "Explore", "Write", { file_path: join(fresh, ".e9g/team.json") }, "refuse", { env: { E9G_TEAM: "", E9G_SETUP: "1" } })]);
  });

  test("engine 1: builders start in a worktree, and nobody renames or deletes the integration branch", () => {
    const { home, inWorktree } = withWorktree();
    return holds([
      tool(home, "planner", delegate, { target: { providerInstanceId: "e9g-fixture-builder" } }, "refuse"),
      tool(home, "planner", delegate, { target: { providerInstanceId: "e9g-fixture-tester" }, isolation: "shared" }, "refuse"),
      tool(home, "planner", delegate, builderInstance, "allow"),
      tool(home, "planner", delegate, { target: { providerInstanceId: "e9g-fixture-reviewer" } }, "allow"),
      bash(home, "builder", "git branch -m e9g/b1-login", "refuse"),
      bash(home, "planner", "git branch -m e9g/old-next", "refuse"),
      bash(home, "builder", "git branch -M e9g/b1-x e9g/next", "refuse"),
      bash(home, "builder", "git branch -m e9g/b2-better", "allow", inWorktree),
    ]);
  });

  test("engine 15: a paused team starts no members and merges nothing", () => {
    const home = makeRepo();
    const run = tmp("e9g-run-");
    writeFileSync(join(run, "paused"), new Date().toISOString());
    return holds([
      tool(home, "planner", delegate, builderInstance, "refuse", { run }),
      bash(home, "planner", "e9g merge e9g/b1-x --queue", "refuse", { run }),
    ]);
  });

  test("quality: refusal() reads commands exactly as the guard does", () => {
    const team = normalize({ name: "fixture", branch: "e9g/next" }, "").team;
    assert.ok(refusal(team, "git -C . push --force origin x"), "git's global options");
    assert.ok(refusal(team, "node ~/.e9g/versions/0.3.0/bin/e9g.ts register"), "the factory's CLI by its path");
  });
});
