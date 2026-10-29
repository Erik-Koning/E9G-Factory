#!/usr/bin/env node
// Stop hook for builders and testers: a member that changed code can't end its turn with uncommitted work (untracked
// files included), a branch named outside its pattern, or a branch that fails the quick gate (the merge queue runs
// the full gate once, on the merged result). Gates run under the team's gate semaphore, so parallel builds don't
// starve each other into flaky failures. After three refusals in a row the member may stop, and says so, so a stuck
// one reports back instead of looping; any stop starts the count again. Each result is recorded for the planner.
// Inert outside a team and for other roles.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { TIMED_OUT } from "../../lib/lock.ts";
import { FACTORY_ROOT, stateDir } from "../../lib/paths.ts";
import { type HookInput, inTeam, teamSession } from "../../lib/session.ts";
import { isLead, multiMachine, remoteOf } from "../../lib/tasks/machines.ts";
import { git, gitOk } from "../../lib/util.ts";

// hooks.json gives this hook 1800 s. The wait for a gate slot and the gate itself share less than that, so the hook
// always answers before Claude Code gives up on it.
const WAIT_MIN = 10;
const GATE_MS = 27 * 60_000;

if (!inTeam()) process.exit(0);
const input = JSON.parse(readFileSync(0, "utf8")) as HookInput;
const { home, team, role } = teamSession({ cwd: input.cwd, agentType: input.agent_type });
if (!["builder", "tester"].includes(role)) process.exit(0);

// The worktree the member works in; the hook's own cwd can be elsewhere.
const cwd = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
const gates = join(stateDir(home), "gates");
mkdirSync(gates, { recursive: true });
const counterFile = join(gates, `${input.session_id}.refusals`);
const refusals = existsSync(counterFile) ? Number(readFileSync(counterFile, "utf8")) || 0 : 0;

// The member may stop: the next refusal is the first again.
function pass(): never {
  rmSync(counterFile, { force: true });
  process.exit(0);
}

function refuse(reason: string): never {
  if (refusals >= 3) {
    // Letting it stop with work possibly uncommitted: keep its worktree from the watchdog's pruning.
    if (process.env.E9G_RUN) {
      mkdirSync(join(process.env.E9G_RUN, "keep"), { recursive: true });
      writeFileSync(join(process.env.E9G_RUN, "keep", basename(cwd)), `${new Date().toISOString()} ${reason.split("\n")[0]}\n`);
    }
    rmSync(counterFile, { force: true });
    // Its task goes back as blocked, with why, rather than sitting claimed until the lease runs out.
    if (claimed)
      spawnSync(
        process.execPath,
        [join(FACTORY_ROOT, "bin", "e9g.ts"), "task", "release", claimed, `--blocked=stopped without handing it in: ${reason.split("\n")[0]}`],
        {
          cwd,
          stdio: "ignore",
          timeout: 60_000,
        }
      );
    process.stderr.write(
      `Still not passing after three tries; stopping anyway.${claimed ? ` Task ${claimed} went back as blocked.` : ""} Say in your report that it fails: ${reason}`
    );
    process.exit(0);
  }
  writeFileSync(counterFile, String(refusals + 1));
  process.stderr.write(`Not done yet: ${reason}`);
  process.exit(2);
}

// A claimed task is handed in (submitted) or handed back (released) before the member stops, so it never sits claimed
// by nobody until its lease runs out. Only a claim the task graph still shows counts.
const claimed = await heldTask();
async function heldTask(): Promise<string | null> {
  const run = process.env.E9G_RUN;
  if (!run || team.board.type !== "tasks") return null;
  try {
    const worktree = realpathSync(git(cwd, "rev-parse", "--show-toplevel"));
    const { claimMark } = await import("../../lib/tasks/ops.ts");
    if (!existsSync(claimMark(run, worktree))) return null;
    const { openStore } = await import("../../lib/tasks/store.ts");
    const store = await openStore(team, run);
    try {
      const { machineName } = await import("../../lib/machine.ts");
      const { heldHere } = await import("../../lib/tasks/model.ts");
      return (await store.tasks.all()).find((t) => t.status === "building" && heldHere(t.claim, worktree, machineName()))?.id ?? null;
    } finally {
      await store.close();
    }
  } catch {
    return null;
  }
}

const branch = git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
// On a worker machine, against the remote's integration branch (its own copy is stale; the claim fetched the remote's).
const remoteBase = `refs/remotes/${remoteOf(team)}/${team.branch}`;
const base = multiMachine(team) && !isLead(team) && gitOk(cwd, "rev-parse", "--verify", "--quiet", remoteBase) ? remoteBase : team.branch;
const ahead = Number(git(cwd, "rev-list", "--count", `${base}..HEAD`));
// Untracked files count as uncommitted work; ignored ones don't.
const dirty = git(cwd, "status", "--porcelain", "--untracked-files=normal") !== "";
// A member that changed nothing is reporting a blocker; let it, once it has handed its task back.
if (ahead === 0 && !dirty) {
  if (claimed) refuse(`hand task ${claimed} back with the reason: e9g task release ${claimed} --blocked "<why>".`);
  pass();
}
if (dirty) refuse("commit your changes (git commit -- <paths>), new files included; nothing may be left uncommitted.");
const pattern = team.roles[role]?.branch;
if (pattern && !new RegExp(pattern).test(branch)) refuse(`name your branch to match ${pattern} (git branch -m …); it's ${branch}.`);

const gate = team.gate.quick;
if (!gate) {
  if (claimed) refuse(`hand in task ${claimed}: e9g task submit ${claimed} (or e9g task release ${claimed} --blocked "<why>").`);
  pass();
}
// From the worktree's root: the member may have cd'ed into a package, and the gate's path is relative to the root.
const result = spawnSync(
  "node",
  [join(FACTORY_ROOT, "bin", "e9g.ts"), "lock", "gate", "--slots", String(team.gate.concurrency), "--wait-min", String(WAIT_MIN), "--", "sh", "-c", gate],
  { cwd: git(cwd, "rev-parse", "--show-toplevel"), encoding: "utf8", timeout: GATE_MS }
);
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
const tail = output.split("\n").slice(-40).join("\n");
const passed = result.status === 0;
writeFileSync(
  join(gates, `${branch.replaceAll("/", "_")}.json`),
  JSON.stringify({ branch, sha: git(cwd, "rev-parse", "HEAD"), gate, passed, at: new Date().toISOString(), tail })
);
if (result.signal || (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT")
  refuse(`the gate (${gate}) didn't finish within ${GATE_MS / 60_000} minutes; make it faster or ask the planner.\n${tail}`);
if (result.status === TIMED_OUT) refuse(`no gate slot came free in ${WAIT_MIN} minutes; try stopping again.`);
if (!passed) refuse(`the gate (${gate}) fails:\n${tail}`);
if (claimed) refuse(`hand in task ${claimed}: e9g task submit ${claimed} (or e9g task release ${claimed} --blocked "<why>").`);
pass();
