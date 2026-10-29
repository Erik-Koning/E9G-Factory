// A team on several machines (team.json tasks: store "mongo" with a lead): the lead, the always-on machine, runs the
// planner, the reviews and the merge queue; workers run builders and testers that claim from the same task graph.
// Code moves between them through the team's remote: a worker's claim builds its branch from the remote integration
// branch, its submit pushes the task's branch, the lead fetches that branch for review and merge, and pushes the
// integration branch after each merge. These run inside the factory's own commands, never as an agent's git command.
import { spawnSync } from "node:child_process";
import type { Team } from "../config.ts";
import { roleForBranch } from "../config.ts";
import { machineName } from "../machine.ts";

export const multiMachine = (team: Pick<Team, "tasks">): boolean => team.tasks.store === "mongo" && team.tasks.lead !== null;
// Every machine is the lead of a team on one machine.
export const isLead = (team: Pick<Team, "tasks">): boolean => !multiMachine(team) || machineName() === team.tasks.lead;
export const remoteOf = (team: Pick<Team, "push">): string => team.push?.remote ?? "origin";

const run = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
// What git said that matters: a rejection or an error rather than its "To <remote>" preamble.
const said = (result: ReturnType<typeof run>): string => {
  const lines = (result.stderr || result.stdout || "").trim().split("\n");
  return (lines.find((line) => /^\s*!|error|fatal|rejected|denied/i.test(line)) ?? lines[0] ?? "").trim();
};

// The remote's copy of a branch, fetched into its remote-tracking ref; null when the remote doesn't have it.
function fetchRemote(cwd: string, remote: string, branch: string): string | null {
  const fetched = run(cwd, "fetch", "--quiet", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`);
  if (fetched.status !== 0) return null;
  const tip = run(cwd, "rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`);
  return tip.status === 0 ? tip.stdout.trim() : null;
}

// The worktree that has `branch` checked out, if one does.
function holderOf(cwd: string, branch: string): string | undefined {
  const lines = run(cwd, "worktree", "list", "--porcelain").stdout.split("\n");
  const at = lines.indexOf(`branch refs/heads/${branch}`);
  return at > 0
    ? lines
        .slice(0, at)
        .reverse()
        .find((line) => line.startsWith("worktree "))
        ?.slice("worktree ".length)
    : undefined;
}
const dirty = (cwd: string): boolean => Boolean(run(cwd, "status", "--porcelain", "--untracked-files=normal").stdout.trim());

// The lead: a team branch a worker pushed, made locally, or moved forward to the remote's tip, so the reviewer and the
// merge queue see what was submitted. Only a member's branch (one its role's pattern names), never a protected one, and
// never backwards or sideways. A finished worktree that has it checked out is detached from it first (its files stay).
// `said` is what happened (null when there was nothing to do, or the team is on one machine); `stale` is true when the
// branch here couldn't be made the remote's, so what's reviewed or merged here isn't what was submitted.
export function syncBranch(
  home: string,
  team: Pick<Team, "tasks" | "push" | "roles" | "protectedBranches" | "branch">,
  branch: string
): { said: string | null; stale: boolean } {
  const nothing = { said: null, stale: false };
  if (!multiMachine(team)) return nothing;
  if (!roleForBranch(team as Team, branch) || team.protectedBranches.includes(branch) || branch === team.branch) return nothing;
  const remote = remoteOf(team);
  const tip = fetchRemote(home, remote, branch);
  if (!tip) return nothing;
  const local = run(home, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
  if (local.status === 0) {
    const mine = local.stdout.trim();
    if (mine === tip) return nothing;
    if (run(home, "merge-base", "--is-ancestor", mine, tip).status !== 0)
      return { said: `${branch} here has commits ${remote}'s doesn't (${mine.slice(0, 9)} vs ${tip.slice(0, 9)}), so it wasn't moved`, stale: true };
  }
  const holder = holderOf(home, branch);
  if (holder) {
    if (dirty(holder))
      return {
        said: `${branch} is checked out at ${holder}, which has uncommitted work, so it wasn't moved to ${remote}'s ${tip.slice(0, 9)}`,
        stale: true,
      };
    run(holder, "switch", "--detach", "--quiet");
  }
  const moved = run(home, "update-ref", `refs/heads/${branch}`, tip);
  return moved.status === 0
    ? { said: `${branch} is now ${remote}'s ${tip.slice(0, 9)}`, stale: false }
    : { said: `couldn't update ${branch}: ${said(moved)}`, stale: true };
}

// The lead, before a merge: the remote's integration branch has nothing this machine's doesn't (only the lead pushes
// it). Resolves to the problem, or null.
export function integrationDiverged(home: string, team: Pick<Team, "tasks" | "push" | "branch">): string | null {
  if (!multiMachine(team)) return null;
  const remote = remoteOf(team);
  const theirs = fetchRemote(home, remote, team.branch);
  if (!theirs) return null;
  if (run(home, "merge-base", "--is-ancestor", theirs, `refs/heads/${team.branch}`).status === 0) return null;
  return `${remote}'s ${team.branch} (${theirs.slice(0, 9)}) has commits this machine's doesn't: something other than the lead pushed it. The operator brings them into ${team.branch} here first`;
}

// The lead, after a merge: the integration branch goes to the remote, so workers build on it. `ok` is false when the
// push failed.
export function pushIntegration(home: string, team: Pick<Team, "tasks" | "push" | "branch">): { ok: boolean; said: string | null } {
  if (!multiMachine(team)) return { ok: true, said: null };
  const pushed = run(home, "push", "--quiet", remoteOf(team), `refs/heads/${team.branch}:refs/heads/${team.branch}`);
  return pushed.status === 0
    ? { ok: true, said: `pushed ${team.branch} to ${remoteOf(team)}` }
    : { ok: false, said: `couldn't push ${team.branch} to ${remoteOf(team)}: ${said(pushed)}` };
}

// A worker's claim: the member's worktree on the task's branch, made from the remote integration branch, or from the
// remote's copy of the task's branch when an earlier round left one. A finished worktree that still has the branch
// checked out is detached from it first (its files stay). Resolves to what happened, for the claim's output; `ok` is
// false when the member has to sort the branch out itself.
export function prepareBranch(
  worktree: string,
  team: Pick<Team, "tasks" | "push" | "branch">,
  branch: string,
  rework: boolean
): { ok: boolean; said: string } {
  const remote = remoteOf(team);
  if (run(worktree, "status", "--porcelain", "--untracked-files=normal").stdout.trim())
    return { ok: false, said: `your worktree has uncommitted work, so the branch wasn't made: make ${branch} from ${remote}/${team.branch} yourself` };
  // The integration branch is fetched either way: submit, the blast radius and the Stop hook measure against it.
  const integration = fetchRemote(worktree, remote, team.branch);
  let base: string | null;
  if (rework) {
    base = fetchRemote(worktree, remote, branch);
    if (!base)
      return {
        ok: false,
        said: `the earlier round's ${branch} isn't on ${remote}, so this machine can't continue it; release the task (e9g task release <id> --blocked "its branch isn't on the remote") so the machine that has it can`,
      };
  } else {
    base = integration;
    if (!base) return { ok: false, said: `couldn't fetch ${team.branch} from ${remote}; make ${branch} from the latest ${team.branch} yourself` };
  }
  // The branch held by another worktree (an earlier member's, finished): detached there if it has nothing uncommitted.
  const holder = holderOf(worktree, branch);
  if (holder && holder !== worktree) {
    if (dirty(holder)) return { ok: false, said: `${branch} is checked out at ${holder}, which has uncommitted work; finish or move it first` };
    run(holder, "switch", "--detach", "--quiet");
  }
  // A branch of this name here already, with work the base doesn't have (a member whose claim ran out before it handed
  // the task in, or a rework not yet pushed): continued, never reset.
  const local = run(worktree, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
  if (local.status === 0 && Number(run(worktree, "rev-list", "--count", `${base}..refs/heads/${branch}`).stdout.trim()) > 0) {
    const kept = run(worktree, "checkout", "--quiet", branch);
    return kept.status === 0
      ? { ok: true, said: `your worktree is on ${branch}, which has an earlier member's work on it (${local.stdout.trim().slice(0, 9)}); continue it` }
      : { ok: false, said: `couldn't check out ${branch}: ${said(kept)}` };
  }
  const made = run(worktree, "checkout", "--quiet", "-B", branch, base);
  return made.status === 0
    ? { ok: true, said: `your worktree is on ${branch}, from ${remote}'s ${rework ? "copy of it" : team.branch} at ${base.slice(0, 9)}` }
    : { ok: false, said: `couldn't make ${branch}: ${said(made)}` };
}

// A worker's submit: the task's branch goes to the remote, for the lead to review and merge.
export function pushTaskBranch(worktree: string, team: Pick<Team, "push">, branch: string): string | null {
  const pushed = run(worktree, "push", "--quiet", "--force-with-lease", remoteOf(team), `HEAD:refs/heads/${branch}`);
  return pushed.status === 0 ? null : `couldn't push ${branch} to ${remoteOf(team)}: ${said(pushed)}`;
}
