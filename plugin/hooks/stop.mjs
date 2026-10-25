#!/usr/bin/env node
// Stop hook for builders and testers: a member that changed code can't end its turn with uncommitted work, a branch
// named outside its pattern, or a branch that fails the quick gate (the merge queue runs the full gate once, on the
// merged result). Gates run under the team's gate semaphore, so parallel builds don't starve each other into
// flaky failures. After three refusals the member may stop, and says so, so a stuck one reports back instead of
// looping. Each result is recorded for the planner. Inert outside a team and for other roles.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { FACTORY_ROOT, stateDir } from "../../lib/paths.mjs";
import { inTeam, teamSession } from "../../lib/session.mjs";
import { git } from "../../lib/util.mjs";

if (!inTeam()) process.exit(0);
const input = JSON.parse(readFileSync(0, "utf8"));
const { home, team, role } = teamSession({ cwd: input.cwd, agentType: input.agent_type });
if (!["builder", "tester"].includes(role)) process.exit(0);

// The worktree the member works in; the hook's own cwd can be elsewhere.
const cwd = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
const gates = join(stateDir(home), "gates");
mkdirSync(gates, { recursive: true });
const counterFile = join(gates, `${input.session_id}.refusals`);
const refusals = existsSync(counterFile) ? Number(readFileSync(counterFile, "utf8")) || 0 : 0;

function refuse(reason) {
  if (refusals >= 3) {
    // Letting it stop with work possibly uncommitted: keep its worktree from the watchdog's pruning.
    if (process.env.E9G_RUN) {
      mkdirSync(join(process.env.E9G_RUN, "keep"), { recursive: true });
      writeFileSync(join(process.env.E9G_RUN, "keep", basename(cwd)), `${new Date().toISOString()} ${reason.split("\n")[0]}\n`);
    }
    process.stderr.write(`Still not passing after three tries; stopping anyway. Say in your report that it fails: ${reason}`);
    process.exit(0);
  }
  writeFileSync(counterFile, String(refusals + 1));
  process.stderr.write(`Not done yet: ${reason}`);
  process.exit(2);
}

const branch = git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
const ahead = Number(git(cwd, "rev-list", "--count", `${team.branch}..HEAD`));
// A member that changed nothing is reporting a blocker; let it.
if (ahead === 0 && git(cwd, "status", "--porcelain") === "") process.exit(0);
if (git(cwd, "status", "--porcelain", "--untracked-files=no") !== "")
  refuse("commit your changes (git commit -- <paths>); nothing may be left uncommitted.");
const pattern = team.roles[role].branch;
if (pattern && !new RegExp(pattern).test(branch)) refuse(`name your branch to match ${pattern} (git branch -m …); it's ${branch}.`);

const gate = team.gate.quick;
if (!gate) process.exit(0);
// From the worktree's root: the member may have cd'ed into a package, and the gate's path is relative to the root.
const result = spawnSync(
  "node",
  [join(FACTORY_ROOT, "bin", "e9g.mjs"), "lock", "gate", "--slots", String(team.gate.concurrency), "--wait-min", "30", "--", "sh", "-c", gate],
  { cwd: git(cwd, "rev-parse", "--show-toplevel"), encoding: "utf8", timeout: 30 * 60 * 1000 }
);
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
const tail = output.split("\n").slice(-40).join("\n");
const passed = result.status === 0;
writeFileSync(
  join(gates, `${branch.replaceAll("/", "_")}.json`),
  JSON.stringify({ branch, sha: git(cwd, "rev-parse", "HEAD"), gate, passed, at: new Date().toISOString(), tail })
);
if (!passed) refuse(`the gate (${gate}) fails:\n${tail}`);
process.exit(0);
