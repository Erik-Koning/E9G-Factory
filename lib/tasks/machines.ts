// A team on several machines (team.json tasks: store "mongo" with a lead): the lead, the always-on machine, runs the
// planner, the reviews and the merge queue; workers run builders and testers that claim from the same task graph.
// Code moves between them through the team's remote: a worker's claim builds its branch from the remote integration
// branch, its submit pushes the task's branch, the lead reviews and merges the remote's copy of it, and pushes the
// integration branch after each merge. These run inside the factory's own commands, never as an agent's git command.
import { spawnSync } from "node:child_process";
import type { Team } from "../config.ts";
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

// The ref a member's branch is reviewed and merged from. On a team on several machines that's the remote's copy, where
// every submit pushes it, fetched now: the lead never keeps its own copies of members' branches, so there's nothing
// to bring up to date or to hold back. On one machine, the branch itself.
export function branchRef(
  home: string,
  team: Pick<Team, "tasks" | "push">,
  branch: string
): { ok: true; ref: string; said: string | null } | { ok: false; said: string } {
  if (!multiMachine(team)) return { ok: true, ref: `refs/heads/${branch}`, said: null };
  const remote = remoteOf(team);
  const tip = fetchRemote(home, remote, branch);
  if (!tip) return { ok: false, said: `${branch} isn't on ${remote}: on a team on several machines it's reviewed and merged as the submit pushed it` };
  return { ok: true, ref: `refs/remotes/${remote}/${branch}`, said: `${remote}/${branch} is at ${tip.slice(0, 9)}` };
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
  const ahead = local.status === 0 && Number(run(worktree, "rev-list", "--count", `${base}..refs/heads/${branch}`).stdout.trim()) > 0;
  // A rework continues a local copy only when it holds the remote's (the latest round) too: one that went its own way
  // would push over a round another machine made.
  if (ahead && rework && run(worktree, "merge-base", "--is-ancestor", base, `refs/heads/${branch}`).status !== 0)
    return {
      ok: false,
      said: `${branch} here and ${remote}'s copy have gone different ways (${local.stdout.trim().slice(0, 9)} vs ${base.slice(0, 9)}); the remote's has the latest round, so start from it (git checkout -B ${branch} ${remote}/${branch}) and bring over anything of yours`,
    };
  if (ahead) {
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
// It replaces the remote's copy only if that's still what the claim fetched (git's lease, on the remote-tracking ref):
// a round another machine pushed meanwhile is never pushed over.
export function pushTaskBranch(worktree: string, team: Pick<Team, "push">, branch: string): string | null {
  const pushed = run(worktree, "push", "--quiet", `--force-with-lease=refs/heads/${branch}`, remoteOf(team), `HEAD:refs/heads/${branch}`);
  return pushed.status === 0 ? null : `couldn't push ${branch} to ${remoteOf(team)}: ${said(pushed)}`;
}

// A worker's own checkout of the team, brought up to the remote's integration branch when it's clean and only behind:
// the team's rules (team.json, the adapters) reach the worker the next time a member claims there.
export function refreshCheckout(home: string, team: Pick<Team, "tasks" | "push" | "branch">): string | null {
  const remote = remoteOf(team);
  const tip = fetchRemote(home, remote, team.branch);
  if (!tip || dirty(home)) return null;
  if (run(home, "symbolic-ref", "--quiet", "--short", "HEAD").stdout.trim() !== team.branch) return null;
  const moved = run(home, "merge", "--quiet", "--ff-only", tip);
  return moved.status === 0 ? null : `the checkout couldn't move to ${remote}'s ${team.branch}: ${said(moved)}`;
}
