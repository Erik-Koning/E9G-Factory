// e9g merge <branch> [--closes 12,13] [--rebased-from <approved sha>] [--light] [--no-after] [--queue]
//
// The only way into a team's integration branch. The planner runs it.
// --queue returns at once: the merge runs in the background, one at a time, and the planner is woken with the
// result (its next wake's context shows it too). Without --queue it runs in the foreground.
//
// 1. Lane: the branch's diff stays in the lane of the role its name belongs to (team.json roles.<role>.branch),
//    changes no protected path (team.json protect), and adds no symlink.
// 2. Approval: a branch whose role is in review.required needs a reviewer's approval of its exact tip (e9g verdict
//    review), or --rebased-from <the approved commit> when the tip is that same change rebased (git range-diff
//    finds every commit unchanged). A branch that removes lines matching review.removedPattern (an assertion) needs
//    one too.
// 3. Merges in a scratch worktree (.e9g/run/merge) and runs the full gate there, under the gate semaphore.
// 4. Fast-forwards the integration branch and closes the tickets (--closes and the number in the branch name).
// 5. Outside the merge lock, under the app lock: the team's afterMerge command (rebuild, restart, recheck), with
//    BEFORE and AFTER (the commits the branch moved between) and E9G_LIGHT=1 / JOURNEYS=0 with --light.
// Any git command that fails refuses the merge. Nothing merges while the operator has paused the team.
// Exit codes: 0 merged, 2 refused (lane, approval or state), 3 conflict, 4 gate failed, 75 timed out waiting for the
// merge lock or a gate slot (nothing ran; queue it again).
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { FACTORY_PATH, factoryWrite, laneAllows, roleForBranch, type Team } from "../config.ts";
import { acquire, TIMED_OUT, withLock } from "../lock.ts";
import { entryOf, FACTORY_ROOT, readRegistry, stateDir, workDir } from "../paths.ts";
import { inTeam, teamSession } from "../session.ts";
import { threadSend } from "../t3.ts";
import { list, localTime, parseArgs, readJson, text as optionText, writeJson } from "../util.ts";
import { pruneWorktrees } from "./watchdog.ts";

// What a merge left in .e9g/run/state/merges/<branch>.json, and a reviewer's verdict in state/reviews/.
export interface MergeRecord {
  branch: string;
  result: string;
  message: string;
  sha: string;
  at: string;
}
export interface Verdict {
  kind: string;
  name: string;
  verdict: string;
  sha: string;
  note: string;
  by: string;
  at: string;
}
type Recorder = (result: string, message: string, sha?: string) => void;

export const usage = "e9g merge <branch> [--closes 12,13] [--rebased-from <approved sha>] [--light] [--no-after] [--queue]";

// How long a merge waits for a lock: the merge lock and the app lock two hours, a gate slot one. E9G_MERGE_WAIT_MIN
// sets all three (the tests use it).
const waitMin = (minutes: number): number => Number(process.env.E9G_MERGE_WAIT_MIN) || minutes;

// Diffs and listings can be large; past this, git's output is cut off, and the merge is refused rather than checked
// on part of it.
const MAX_BUFFER = 256 * 1024 * 1024;

// The paths in a diff that a role may not change: outside its lane, the factory's own files, or the paths only the
// team's scripts write (team.json protect).
export function outsideLane(team: Team, role: string, paths: string[]): string[] {
  return paths.filter(
    (path) => factoryWrite(team, role, path) || !laneAllows(team, role, path) || team.protect.some((rule) => new RegExp(rule).test(path))
  );
}

// The lines a unified diff removes, read hunk by hunk: a removed line that itself starts with "-" counts, and a
// file header ("--- a/x") doesn't.
export function removedLines(diff: string): string[] {
  const removed: string[] = [];
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of diff.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith("-")) {
        removed.push(line.slice(1));
        oldLeft--;
      } else if (line.startsWith("+")) newLeft--;
      else if (!line.startsWith("\\")) {
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLeft = Number(hunk[1] ?? 1);
      newLeft = Number(hunk[2] ?? 1);
    }
  }
  return removed;
}

// Why a symlink a branch adds or changes can't merge, or null. Members' branches merge none: a link can point a
// path the lane allows at the factory's files, or anywhere outside the checkout.
export function symlinkProblem(team: Team, role: string, path: string, target: string): string | null {
  const resolved = posix.normalize(posix.join(posix.dirname(path), target));
  if (role !== "planner") return `${path} is a symlink (to ${target}); branches from the ${role} don't merge symlinks`;
  if (FACTORY_PATH.test(path) || FACTORY_PATH.test(resolved) || factoryWrite(team, role, resolved))
    return `${path} is a symlink into the factory's own files (${target})`;
  if (posix.isAbsolute(target) || resolved === ".." || resolved.startsWith("../")) return `${path} is a symlink outside the checkout (${target})`;
  return null;
}

// The ticket a branch's name gives: the number in the first part after the prefix (e9g/b12-x/v2-y closes 12).
export function ticketOf(branch: string, prefix: string): string | undefined {
  const rest = branch.startsWith(`${prefix}/`) ? branch.slice(prefix.length + 1) : branch.includes("/") ? branch.slice(branch.indexOf("/") + 1) : branch;
  return /^[a-z]*(\d+)-/.exec(rest.split("/")[0] ?? "")?.[1];
}

class GitFailed extends Error {}

export async function run(argv: string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, { booleans: ["queue", "light", "no-journeys", "no-after", "skip-after"], repeat: ["closes"] });
  const branch = positional[0];
  if (!branch) {
    console.error(`usage: ${usage}`);
    return 2;
  }
  // --closes 12,13, --closes 12 --closes 13, or --closes 12 13 (the numbers after it).
  const closes = [...list(options["closes"]), ...positional.slice(1)].flatMap((value) => String(value).split(/[,\s#]+/)).filter((n) => /^\d+$/.test(n));
  if (inTeam() && process.env.E9G_ROLE !== "planner") {
    console.error("merge: only the planner merges");
    return 2;
  }
  const { home, team, run: runDir } = teamSession();
  const state = stateDir(home);
  const safe = branch.replaceAll("/", "_");
  const recordFile = join(state, "merges", `${safe}.json`);
  mkdirSync(join(state, "merges"), { recursive: true });

  // The record is kept here and always written whole: the planner's context hook moves a record it has shown to
  // <branch>.seen.json at any moment, so it's never read back.
  const kept: { last: MergeRecord | null } = { last: null };
  const record: Recorder = (result, message, sha = "") => {
    kept.last = { branch, result, message, sha, at: new Date().toISOString() };
    writeJson(recordFile, kept.last);
    appendFileSync(join(state, "merges.log"), `${localTime()} ${branch} ${result} ${message}\n`);
  };
  // A queued merge wakes the planner once, with the whole result.
  const wake = () => {
    const last = kept.last;
    if (!process.env.E9G_MERGE_QUEUED || !runDir || !last) return;
    const planner = existsSync(join(runDir, "planner-thread")) ? readFileSync(join(runDir, "planner-thread"), "utf8").trim() : "";
    if (planner) threadSend(planner, `merge-queue: ${branch} ${last.result}${last.sha ? ` at ${last.sha}` : ""}. ${last.message}`.trim());
  };

  // Belt and braces with the guard: while the operator has paused the team, nothing merges.
  if (inTeam() && runDir && existsSync(join(runDir, "paused"))) {
    record("refused", "the operator paused the team; nothing merges until they resume it (e9g resume)");
    console.error("merge: the operator paused the team; nothing merges until they resume it");
    return 2;
  }

  // The queued run itself (E9G_MERGE_QUEUED) merges in the foreground, whatever form of --queue it was given.
  const queue = options["queue"];
  if (queue !== undefined && !["false", "0", "no"].includes(String(queue)) && !process.env.E9G_MERGE_QUEUED) {
    const rest = argv.filter((arg) => !/^--queue(=.*)?$/.test(arg));
    const log = openSync(join(state, "merges", `${safe}.log`), "w");
    spawn(process.execPath, [entryOf(FACTORY_ROOT), "merge", ...rest], {
      cwd: home,
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, E9G_MERGE_QUEUED: "1" },
    }).unref();
    closeSync(log);
    console.info(`merge: ${branch} queued. The result comes as a message and in your next wake's context; the log is .e9g/run/state/merges/${safe}.log.`);
    return 0;
  }

  const release = await acquire(home, "merge", {
    slots: 1,
    waitMin: waitMin(120),
    holder: `merge ${branch}`,
    onWait: (text) => console.error(`merge: ${text}`),
  });
  if (!release) {
    record("timed-out", `another merge held the merge lock for ${waitMin(120)} min; nothing was merged, queue it again`);
    console.error(`merge: another merge held the merge lock for ${waitMin(120)} min; nothing was merged`);
    wake();
    return TIMED_OUT;
  }
  let code: number;
  let before: string | null = null;
  try {
    ({ code, before = null } = await mergeLocked({ home, team, branch, closes, rebasedFrom: optionText(options["rebased-from"]), record, safe, state }));
  } catch (error) {
    if (!(error instanceof GitFailed)) throw error;
    record("refused", `${error.message}; nothing was merged`);
    console.error(`merge: ${error.message}; nothing was merged`);
    code = 2;
  } finally {
    release();
  }

  const light = Boolean(options["light"] || options["no-journeys"]);
  if (code === 0 && team.afterMerge && !options["no-after"] && !options["skip-after"]) {
    const after = spawnSync("git", ["rev-parse", "HEAD"], { cwd: home, encoding: "utf8" }).stdout.trim();
    const output: string[] = [];
    let busy = false;
    const status = await withLock(home, "app", ["sh", "-c", team.afterMerge], {
      slots: 1,
      waitMin: waitMin(120),
      cwd: home,
      env: { BEFORE: before ?? "", AFTER: after, E9G_LIGHT: light ? "1" : "0", JOURNEYS: light ? "0" : "1" },
      stdio: ["ignore", "pipe", "pipe"],
      onOutput: (chunk) => {
        process.stdout.write(chunk);
        output.push(String(chunk));
      },
      onTimeout: () => (busy = true),
    });
    const summary = output
      .join("")
      .split("\n")
      .filter((line) => /^(journeys|after|pages):/.test(line))
      .slice(-3)
      .join(" ");
    const outcome = busy ? `didn't run, the app lock stayed busy for ${waitMin(120)} min` : status === 0 ? "ok" : `FAILED, exit ${status}`;
    const last = kept.last;
    if (last) {
      kept.last = { ...last, message: `${last.message} after merge: ${outcome} ${summary}`.trim() };
      writeJson(recordFile, kept.last);
    }
  }
  wake();
  // The queue runs where the planner does, which can read a checkout the launchd watchdog can't (~/Documents).
  if (process.env.E9G_MERGE_QUEUED) {
    const entry = readRegistry(team.name);
    try {
      if (entry && entry.home === home) pruneWorktrees(entry);
    } catch (error) {
      console.error(`merge: pruning finished worktrees failed: ${(error as Error).message}`);
    }
  }
  return code;
}

async function mergeLocked({
  home,
  team,
  branch,
  closes,
  rebasedFrom,
  record,
  safe,
  state,
}: {
  home: string;
  team: Team;
  branch: string;
  closes: string[];
  rebasedFrom: string | undefined;
  record: Recorder;
  safe: string;
  state: string;
}): Promise<{ code: number; before?: string }> {
  const g = (...args: string[]) => spawnSync("git", args, { cwd: home, encoding: "utf8", maxBuffer: MAX_BUFFER });
  // The output of a git command that has to work; anything else (an error, an exit code, output past the buffer)
  // refuses the merge, rather than checking nothing.
  const raw = (...args: string[]): string => {
    const result = g(...args);
    if (result.error || result.status !== 0)
      throw new GitFailed(`git ${args.join(" ")} failed: ${(result.error?.message ?? result.stderr ?? "").trim().split("\n")[0] ?? ""}`.trim());
    return result.stdout;
  };
  const out = (...args: string[]): string => raw(...args).trim();
  const commit = (ref: string): string | null => {
    const result = g("rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`);
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const fail = (code: number, result: string, message: string) => {
    record(result, message);
    console.error(`merge: ${message}`);
    return { code };
  };
  const integration = team.branch;
  const scratch = join(workDir(home), "merge");
  const cleanup = () => {
    if (g("worktree", "remove", "--force", scratch).status !== 0) rmSync(scratch, { recursive: true, force: true });
    g("worktree", "prune");
  };

  if (out("rev-parse", "--abbrev-ref", "HEAD") !== integration) return fail(2, "refused", `the team's checkout must be on ${integration}`);
  if (out("status", "--porcelain", "--untracked-files=no") !== "")
    return fail(2, "refused", `${integration} has uncommitted changes; commit or discard them first`);
  const tip = commit(`refs/heads/${branch}`);
  if (!tip) return fail(2, "refused", `no branch ${branch}`);
  if (Number(out("rev-list", "--count", `${integration}..${tip}`)) === 0) return fail(2, "refused", `${branch} has nothing that ${integration} doesn't`);

  const role = roleForBranch(team, branch);
  if (!role)
    return fail(
      2,
      "refused",
      `${branch} isn't a team branch (${Object.entries(team.roles)
        .filter(([, l]) => l.branch)
        .map(([r, l]) => `${r}: ${l.branch}`)
        .join(", ")})`
    );
  // --no-renames lists both sides of a rename, so a move can't hide a deletion outside the lane. -z gives each path
  // as it is: git quotes unusual ones otherwise, and a quoted path matches no lane rule.
  const paths = (...args: string[]): string[] =>
    raw("diff", "--name-only", "--no-renames", "-z", ...args)
      .split("\0")
      .filter(Boolean);
  const changed = paths(`${integration}...${tip}`);
  const outside = outsideLane(team, role, changed);
  if (outside.length) return fail(2, "refused", `${branch} (${role}) changes files outside its lane: ${outside.join(" ")}`);
  // Each file's new mode: 120000 is a symlink, which the paths alone don't show.
  const entries = raw("diff", "--raw", "--no-renames", "-z", "--no-abbrev", `${integration}...${tip}`).split("\0");
  for (let i = 0; i + 1 < entries.length; i += 2) {
    const [, mode, , blob] = (entries[i] ?? "").split(" ");
    const path = entries[i + 1] ?? "";
    if (mode !== "120000" || !blob) continue;
    const problem = symlinkProblem(team, role, path, out("cat-file", "blob", blob));
    if (problem) return fail(2, "refused", `${branch} (${role}): ${problem}`);
  }

  let required = team.review.required.includes(role);
  const removedPattern = team.review.removedPattern;
  if (!required && removedPattern) {
    const pattern = new RegExp(removedPattern);
    required = removedLines(raw("diff", "--no-renames", "--no-color", "--no-ext-diff", "--no-textconv", `${integration}...${tip}`)).some((line) =>
      pattern.test(line)
    );
  }
  if (required) {
    const review = readJson<Verdict>(join(state, "reviews", `${safe}.json`));
    if (!review) return fail(2, "refused", `${branch} has no review; start a reviewer (it records one with e9g verdict review)`);
    if (review.verdict !== "approve") return fail(2, "refused", `the review of ${branch} asks for changes: ${review.note}`);
    if (review.sha !== tip) {
      const approved = review.sha.slice(0, 9);
      if (!rebasedFrom || commit(rebasedFrom) !== review.sha)
        return fail(
          2,
          "refused",
          `the approval is for ${approved} but ${branch} is at ${tip.slice(0, 9)}: have it reviewed again, or pass --rebased-from ${approved} if it's only a rebase`
        );
      if (g("cat-file", "-e", `${review.sha}^{commit}`).status !== 0)
        return fail(
          2,
          "refused",
          `the approved commit ${approved} is gone from the repository, so the rebase can't be compared; have ${branch} reviewed again`
        );
      // range-diff skips merge commits, so a "rebase" that merged the integration branch in could carry new code in
      // the merge itself. A rebase has none.
      const oldRange = `${out("merge-base", review.sha, integration)}..${review.sha}`;
      const newRange = `${out("merge-base", tip, integration)}..${tip}`;
      if (out("rev-list", "--merges", oldRange) || out("rev-list", "--merges", newRange))
        return fail(
          2,
          "refused",
          `${branch} has merge commits, so it isn't a plain rebase of ${approved}; rebase it without merges, or have it reviewed again`
        );
      // Every commit in both ranges paired with one unchanged ("=") on the other side, and nothing else.
      const commits = Number(out("rev-list", "--count", oldRange));
      const lines = out("range-diff", "--no-color", oldRange, newRange).split("\n").filter(Boolean);
      const same = lines.filter((line) => /^\s*\d+:\s+[0-9a-f]+\s+=\s+\d+:\s+[0-9a-f]+(\s|$)/.test(line)).length;
      if (!commits || Number(out("rev-list", "--count", newRange)) !== commits || lines.length !== commits || same !== commits)
        return fail(2, "refused", `${branch} isn't only a rebase of the approved ${approved} (git range-diff shows changes); have it reviewed again`);
    }
  }

  const before = out("rev-parse", integration);
  cleanup();
  if (g("worktree", "add", "--detach", "--quiet", scratch, integration).status !== 0) return fail(2, "refused", "couldn't make the scratch worktree");
  try {
    // The commit that was checked and approved, not whatever the branch points at by now.
    const merged = spawnSync("git", ["merge", "--no-ff", "--no-edit", "-m", `Merge ${branch} into ${integration}`, tip], {
      cwd: scratch,
      encoding: "utf8",
    });
    if (merged.status !== 0) {
      spawnSync("git", ["merge", "--abort"], { cwd: scratch });
      return fail(3, "conflict", `${branch} conflicts with ${integration}; rebase it onto ${integration}`);
    }
    if (team.gate.full) {
      const gateLog = join(state, "merges", `${safe}.gate.log`);
      const fd = openSync(gateLog, "w");
      let busy = false;
      const status = await withLock(home, "gate", ["sh", "-c", team.gate.full], {
        slots: team.gate.concurrency,
        waitMin: waitMin(60),
        cwd: scratch,
        stdio: ["ignore", fd, fd],
        onTimeout: () => (busy = true),
      });
      closeSync(fd);
      if (busy)
        return fail(
          TIMED_OUT,
          "timed-out",
          `no gate slot came free in ${waitMin(60)} min (other gates held all ${team.gate.concurrency}), so the gate never ran; nothing was merged, queue ${branch} again`
        );
      const log = readFileSync(gateLog, "utf8");
      process.stdout.write(log);
      if (status !== 0) {
        const said = log
          .split("\n")
          .filter((line) => /fail|error/i.test(line))
          .slice(0, 3)
          .join(" ")
          .slice(0, 300);
        return fail(
          4,
          "gate-failed",
          `the gate fails on ${branch} merged into ${integration}; nothing was merged. ${said ? `It says: ${said} ` : ""}(full output: .e9g/run/state/merges/${safe}.gate.log)`
        );
      }
    }
    const result = out("-C", scratch, "rev-parse", "HEAD");

    // The gate took a while: the team's checkout must still be on the integration branch and clean.
    if (out("rev-parse", "--abbrev-ref", "HEAD") !== integration || out("status", "--porcelain", "--untracked-files=no") !== "")
      return fail(2, "refused", `the team's checkout moved off ${integration} or has uncommitted changes; nothing was merged, queue ${branch} again`);
    // Files in the checkout that git doesn't track but the merge would write: git won't overwrite them.
    const incoming = new Set(paths("HEAD", result));
    const untracked = raw("ls-files", "--others", "--exclude-standard", "-z")
      .split("\0")
      .filter((path) => incoming.has(path));
    if (untracked.length)
      return fail(
        2,
        "refused",
        `the team's checkout has untracked files that ${branch} adds: ${untracked.slice(0, 10).join(" ")}; nothing was merged. They aren't in git: move them out of the way, then queue ${branch} again`
      );
    // The planner may have committed its own files meanwhile; those merge without another gate.
    const forward = g("merge", "--ff-only", "--quiet", result);
    if (forward.status !== 0) {
      if (out("rev-parse", integration) === before)
        return fail(
          2,
          "refused",
          `${integration} couldn't be fast-forwarded to the merged result (${forward.stderr.trim().split("\n")[0] ?? ""}); nothing was merged`
        );
      const moved = paths(before, integration);
      const notPlanner = outsideLane(team, "planner", moved);
      if (notPlanner.length)
        return fail(3, "conflict", `${integration} moved while ${branch} was being merged (${notPlanner.join(" ")}); nothing was merged, queue it again`);
      if (g("merge", "--no-ff", "--no-edit", "--quiet", "-m", `Merge ${branch} into ${integration}`, result).status !== 0) {
        // Never leave the team's checkout mid-merge: every later merge would be refused for its changes.
        g("merge", "--abort");
        return fail(
          3,
          "conflict",
          `${integration} moved while ${branch} was being merged, and the planner's commits conflict with it; nothing was merged, queue it again`
        );
      }
    }
  } finally {
    cleanup();
  }
  const sha = g("rev-parse", "--short", "HEAD").stdout.trim();

  // Close what the branch did: --closes, plus the number in the branch's name (e9g/b89-… closes 89).
  const fromName = ticketOf(branch, team.branchPrefix);
  const closed: string[] = [];
  for (const n of [...new Set([...closes, ...(fromName ? [fromName] : [])])]) {
    if (team.board.type === "files") {
      const board = join(workDir(home), "board");
      for (const name of existsSync(board) ? readdirSync(board).filter((file) => file.startsWith(`${n}-`) && file.endsWith(".md")) : []) {
        const file = join(board, name);
        const lines = readFileSync(file, "utf8").split("\n");
        const at = lines.slice(0, 5).findIndex((line) => /^status:/.test(line));
        if (at >= 0) lines[at] = "status: done";
        writeFileSync(file, lines.join("\n"));
        closed.push(n);
      }
    } else {
      const label = team.board.label;
      spawnSync("gh", ["issue", "edit", n, "--remove-label", `${label}:building`, "--remove-label", `${label}:review`], { cwd: home, stdio: "ignore" });
      const close = spawnSync("gh", ["issue", "close", n, "--comment", `Merged into ${integration} at ${sha} (e9g merge, ${branch}).`], {
        cwd: home,
        stdio: "ignore",
      });
      if (close.status === 0) closed.push(n);
    }
  }
  const note = `${integration} was ${before.slice(0, 7)}.${closed.length ? ` Closed: ${[...new Set(closed)].join(" ")}.` : ""}`;
  record("merged", note, sha);
  console.info(`merge: ${integration} is now ${sha} (was ${before.slice(0, 7)}).${closed.length ? ` Closed: ${[...new Set(closed)].join(" ")}.` : ""}`);
  return { code: 0, before };
}
