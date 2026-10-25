// The watchdog: one launchd job (ca.e9g.watchdog) that looks after every registered team every 5 minutes. It uses
// no model. macOS doesn't let launchd jobs read ~/Documents, so it runs the installed copy in ~/.e9g and never
// touches a checkout. It reads T3 Code (its CLI and database), Docker, each team's health URLs and its run folder,
// and sends anything that needs a checkout to the team's planner as a message.
//
// Per team, in its run folder: watchdog.log, planner-thread, heartbeat/, outbox/, paused, complete.
//
//   e9g watchdog install | remove | run [<team>]
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { acquireSlot } from "../lock.ts";
import { E9G_HOME, entryOf, readRegistry, type RegistryEntry, teamsDir } from "../paths.ts";
import * as t3 from "../t3.ts";
import { die, which } from "../util.ts";

const LABEL = "ca.e9g.watchdog";
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const GLOBAL_LOG = join(E9G_HOME, "watchdog.log");
const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

function notify(title: string, text: string): void {
  const clean = (s: string) => String(s).replaceAll('"', "'");
  spawnSync("osascript", ["-e", `display notification "${clean(text)}" with title "${clean(title)}"`], { stdio: "ignore" });
}
const minutesSince = (path: string): number => (existsSync(path) ? (Date.now() - statSync(path).mtimeMs) / 60_000 : Number.POSITIVE_INFINITY);
async function answers(target: string): Promise<boolean> {
  const any = target.startsWith("any:");
  try {
    const response = await fetch(any ? target.slice(4) : target, { signal: AbortSignal.timeout(5000), redirect: "manual" });
    return any || response.status < 400;
  } catch {
    return false;
  }
}

// The team's lock in its run folder (which launchd can read): one watcher at a time, up to a minute's wait. The same
// slot as lib/lock.ts's, so a dead holder's lock is taken over safely, and a holder releases only its own.
const acquireRun = (run: string): Promise<(() => void) | null> => acquireSlot([join(run, ".watch.lock")], { waitMin: 1, holder: "watchdog" });

// A planner busy with a turn.
export const BUSY = ["running", "starting", "preparing", "queued"];

// Whether T3 Code answers, restarting it when it hasn't for two checks a minute or more apart: one slow answer
// isn't a crash, and a restart interrupts every member of every team.
async function t3Answers(glog: (text: string) => void): Promise<boolean> {
  const unanswered = join(E9G_HOME, ".stamp-t3-unanswered");
  if (await t3.serverUp()) {
    rmSync(unanswered, { force: true });
    return true;
  }
  const since = minutesSince(unanswered);
  if (since < 1) return false;
  if (since > 15) {
    writeFileSync(unanswered, "");
    glog("T3 Code isn't answering; the watchdog restarts it if it still isn't at its next check");
    return false;
  }
  glog(`T3 Code hasn't answered for ${Math.round(since)} min; restarting its service`);
  t3.restartService();
  for (let waited = 0; waited < 30_000; waited += 2000) {
    await new Promise((done) => setTimeout(done, 2000));
    if (await t3.serverUp()) {
      rmSync(unanswered, { force: true });
      return true;
    }
  }
  const mark = join(E9G_HOME, ".stamp-t3-down");
  if (minutesSince(mark) >= 60) {
    writeFileSync(mark, "");
    notify("E9G Factory", `T3 Code won't start, so every team is stopped. See ${GLOBAL_LOG}.`);
  }
  return false;
}

// Watches every team, or only one. `before` runs for that team inside its lock, ahead of the watch; a sentence it
// returns stops it there. Resolves to why the watch didn't happen, or null.
export async function watchOnce(only?: string, before?: (entry: RegistryEntry) => string | null): Promise<string | null> {
  mkdirSync(E9G_HOME, { recursive: true });
  const glog = (text: string) => appendFileSync(GLOBAL_LOG, `${stamp()} ${text}\n`);
  if (!(await t3Answers(glog))) return "T3 Code isn't answering (see ~/.e9g/watchdog.log)";
  const names = only
    ? [only]
    : existsSync(teamsDir)
      ? readdirSync(teamsDir)
          .filter((f) => f.endsWith(".json"))
          .map((f) => f.replace(/\.json$/, ""))
      : [];
  let skipped: string | null = null;
  for (const name of names) {
    const entry = readRegistry(name);
    if (!entry) continue;
    // One watcher per team at a time: launchd's run and e9g start can overlap, and both would start a planner.
    mkdirSync(entry.run, { recursive: true });
    const release = await acquireRun(entry.run);
    if (!release) {
      glog(`${name}: another watchdog run is busy with it; skipped`);
      skipped = "another watchdog run is busy with the team; try again in a minute";
      continue;
    }
    try {
      skipped = before?.(entry) ?? null;
      if (!skipped) await watchTeam(entry);
    } catch (error) {
      glog(`watching ${name} failed: ${(error as Error).message}`);
    } finally {
      release();
    }
  }
  return skipped;
}

async function watchTeam(entry: RegistryEntry): Promise<void> {
  const { run, title } = entry;
  const w: Partial<RegistryEntry["watchdog"]> = entry.watchdog ?? {};
  const log = (text: string) => appendFileSync(join(run, "watchdog.log"), `${stamp()} ${text}\n`);
  // true when <name> hasn't fired within <minutes>, and marks it fired.
  const oncePer = (name: string, minutes: number): boolean => {
    const mark = join(run, `.stamp-${name}`);
    if (minutesSince(mark) < minutes) return false;
    writeFileSync(mark, "");
    return true;
  };
  mkdirSync(join(run, "heartbeat"), { recursive: true });
  mkdirSync(join(run, "outbox"), { recursive: true });
  if (existsSync(join(run, "paused"))) return;

  if (entry.needsDocker && spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) {
    log("Docker isn't running; starting it");
    spawnSync("open", ["-a", "Docker"], { stdio: "ignore" });
    return;
  }

  const threadFile = join(run, "planner-thread");
  const plannerTitle = `${title} · planner`;
  const startPlanner = (why: string): void => {
    // A planner started by an earlier run whose id never came back (a slow CLI): adopt it, never start a second. Only
    // a thread on the planner's instance with the planner's title, and only when the database could be read.
    const retiredFile = join(run, "planner-thread.retired");
    const retired = existsSync(retiredFile) ? readFileSync(retiredFile, "utf8").split(/\s+/) : [];
    const live = t3.liveThreadsOn(entry.project, entry.plannerInstance, plannerTitle, 180);
    if (live === null) return log(`couldn't read T3 Code's database to look for a planner an earlier run started, so none was started (${why})`);
    const orphan = live.find((id) => !retired.includes(id));
    if (orphan) {
      writeFileSync(threadFile, `${orphan}\n`);
      return log(`adopted planner thread ${orphan}, which an earlier run started (${why})`);
    }
    const { id, error } = t3.threadStart(entry.project, entry.startPrompt, {
      instance: entry.plannerInstance,
      model: entry.model,
      title: plannerTitle,
    });
    if (id) {
      writeFileSync(threadFile, `${id}\n`);
      log(`started planner thread ${id} (${why})`);
    } else {
      log(`couldn't start a planner thread: ${error ?? "no id"}`);
      if (oncePer("planner-failed", 60)) notify(title, "The team couldn't start its planner. See its watchdog log.");
    }
  };
  const planner = existsSync(threadFile) ? readFileSync(threadFile, "utf8").trim() : "";
  if (!planner) return startPlanner("none recorded");
  const thread = t3.threadShow(planner);
  if (!thread || thread.archived) {
    // Only T3's database decides a planner is gone; a failed or slow CLI read leaves it alone until next time.
    if (t3.threadExists(planner) !== false) return log(`couldn't read planner ${planner}, but it isn't gone; leaving it`);
    return startPlanner(`previous thread ${planner} is gone or archived`);
  }
  const status = thread.status ?? "unknown";
  const pending = thread.pendingRequestCount ?? 0;

  // The environment: only the planner can restart it (it lives in the checkout), so tell it.
  let envNote = "";
  for (const target of entry.health ?? []) {
    if (!(await answers(target)))
      envNote = ` The team's environment is down (${target.replace(/^any:/, "")} isn't answering): run e9g env up before anything else.`;
  }
  if (envNote && oncePer("env-down-log", 30)) log("the team's environment is down");

  // The planner's own activity: its heartbeats and its thread's last update. Busy members don't count.
  const beats = readdirSync(join(run, "heartbeat"))
    .filter((f) => f.startsWith("planner-"))
    .map((f) => minutesSince(join(run, "heartbeat", f)));
  const updated = thread.updatedAt ? (Date.now() - Date.parse(thread.updatedAt)) / 60_000 : Number.POSITIVE_INFINITY;
  const quiet = Math.round(Math.min(updated, ...beats));
  const members = t3.childCounts(planner);
  const quietMembers = t3.quietChildren(planner, w.stuckAfterMin ?? 45);
  log(
    `planner ${status} (quiet ${quiet} min); members ${members.map((r) => `${r.instance}:${r.n}`).join(" ") || "none"}${quietMembers.length ? `; quiet members: ${quietMembers.join("; ")}` : ""}`
  );

  const tickText = (extra = "") => `tick (${new Date().toLocaleString("sv-SE").slice(0, 16)}${extra}).${envNote}`;
  if (BUSY.includes(status)) {
    if (quiet >= (w.stuckAfterMin ?? 45) && oncePer("stuck", 60)) {
      log(`planner ${planner} has been ${status} with nothing happening for ${quiet} min`);
      notify(title, `The planner looks stuck (${quiet} min without activity). Open T3 Code to look.`);
    }
    if (envNote && oncePer("env-down", 30) && t3.threadSend(planner, tickText())) log("queued an environment-down note");
  } else if (status === "waiting" || pending > 0) {
    if (oncePer("waiting", 60)) {
      notify(title, "The planner is waiting for an answer in T3 Code.");
      log("planner waiting on a person");
    }
  } else if (existsSync(join(run, "complete"))) {
    if (
      oncePer("tick", w.doneTickEveryMin ?? 1440) &&
      t3.threadSend(planner, tickText(", nightly: the work is complete; re-check the finish line and report only if something broke"))
    )
      log("nightly tick");
  } else if ((envNote && oncePer("env-down", 30)) || oncePer("tick", w.tickEveryMin ?? 10)) {
    log(t3.threadSend(planner, tickText()) ? `tick (planner was ${status})` : "couldn't send a tick");
  }
  if (quietMembers.length && oncePer("stuck-members", 60)) notify(title, `Members quiet for ${w.stuckAfterMin ?? 45}+ min: ${quietMembers.join("; ")}`);

  // Worktrees of members done with them: each holds a copy of node_modules and build output. Removed only when git
  // shows nothing in them to lose (no change, no untracked file, no commit on no branch), by git itself, which
  // refuses one with changes. Kept: any a member still uses, one with a marker in keep/, and those of interrupted,
  // failed or cancelled members for a week (T3 can resume them). Under launchd a checkout in ~/Documents can't be
  // read, so its worktrees wait for a run from a terminal (e9g watchdog run <team>).
  if (entry.worktreesDir && oncePer("prune", 60)) {
    const pruneAfter = w.pruneAfterMin ?? 60;
    let freed = 0;
    const kept: string[] = [];
    for (const path of t3.finishedWorktrees(entry.project, { completedAfterMin: pruneAfter, stoppedAfterMin: Math.max(pruneAfter, STOPPED_KEEP_MIN) })) {
      if (!path.startsWith(`${entry.worktreesDir}/`) || !existsSync(path) || existsSync(join(run, "keep", basename(path)))) continue;
      const work = workIn(path);
      if (work) kept.push(`${basename(path)}: ${work}`);
      else if (spawnSync("git", ["-C", entry.home, "worktree", "remove", path], { stdio: "ignore" }).status === 0) freed++;
      else kept.push(`${basename(path)}: git worktree remove refused`);
    }
    if (freed) log(`removed ${freed} finished worktrees`);
    if (kept.length && oncePer("prune-kept", 1440)) log(`kept ${kept.length} finished worktrees that may hold work: ${kept.join("; ")}`);
  }

  // Email the planner couldn't send.
  for (const draft of readdirSync(join(run, "outbox")).filter((f) => f.endsWith(".md"))) {
    const marker = join(run, "outbox", `${draft}.notified`);
    if (existsSync(marker)) continue;
    notify(title, `The team has a message for you: ${basename(draft, ".md")}. It's in ${join(run, "outbox")}.`);
    writeFileSync(marker, "");
    log(`notified about ${draft}`);
  }
  const logFile = join(run, "watchdog.log");
  const lines = readFileSync(logFile, "utf8").split("\n");
  if (lines.length > 5000) writeFileSync(logFile, lines.slice(-2000).join("\n"));
}

// How long the worktrees of interrupted, failed or cancelled members are kept.
const STOPPED_KEEP_MIN = 7 * 1440;

// What a finished member's worktree still holds that removing it would lose, or null when there's nothing.
function workIn(path: string): string | null {
  const status = spawnSync("git", ["-C", path, "status", "--porcelain"], { encoding: "utf8" });
  if (status.status !== 0) return "git couldn't read it";
  if (status.stdout.trim()) return "uncommitted or untracked files";
  if (spawnSync("git", ["-C", path, "symbolic-ref", "-q", "HEAD"], { stdio: "ignore" }).status !== 0) {
    const refs = spawnSync("git", ["-C", path, "for-each-ref", "--contains", "HEAD", "--count=1", "refs/heads", "refs/remotes"], { encoding: "utf8" });
    if (refs.status !== 0 || !refs.stdout.trim()) return "commits on a detached HEAD that no branch has";
  }
  return null;
}

// The plist runs the installed current version from ~/.e9g, which launchd can read.
export function ensureWatchdog(): void {
  if (!existsSync(PLIST)) install();
}

// The node that runs this, by a path that outlives an upgrade of it (Homebrew's /opt/homebrew/bin/node, not its
// versioned Cellar path, which brew upgrade removes), when one leads to the same binary.
function stableNode(): string {
  const same = (path: string | null): boolean => {
    try {
      return path !== null && realpathSync(path) === realpathSync(process.execPath);
    } catch {
      return false;
    }
  };
  return [which("node"), "/opt/homebrew/bin/node", "/usr/local/bin/node"].find(same) ?? process.execPath;
}

function install(): void {
  const node = stableNode();
  const entry = entryOf(join(E9G_HOME, "current"));
  if (!existsSync(entry)) die(`no installed version at ${dirname(dirname(entry))}; run e9g self-install first`);
  const path = [
    dirname(node),
    dirname(which("t3") ?? join(homedir(), ".local/bin/t3")),
    join(homedir(), ".local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  mkdirSync(dirname(PLIST), { recursive: true });
  writeFileSync(
    PLIST,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${node}</string><string>${entry}</string><string>watchdog</string><string>run</string></array>
  <key>WorkingDirectory</key><string>${E9G_HOME}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${[...new Set(path)].join(":")}</string><key>E9G_HOME</key><string>${E9G_HOME}</string><key>NODE_COMPILE_CACHE</key><string>${join(E9G_HOME, "current", ".cache")}</string><key>E9G_NODE_CACHE</key><string>1</string></dict>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${join(E9G_HOME, "watchdog.launchd.log")}</string>
  <key>StandardErrorPath</key><string>${join(E9G_HOME, "watchdog.launchd.log")}</string>
</dict>
</plist>
`
  );
  const domain = `gui/${process.getuid?.()}`;
  spawnSync("launchctl", ["bootout", `${domain}/${LABEL}`], { stdio: "ignore" });
  const loaded = spawnSync("launchctl", ["bootstrap", domain, PLIST], { encoding: "utf8" });
  if (loaded.status !== 0) die(`launchctl couldn't load ${PLIST}: ${loaded.stderr.trim()}`);
  console.info(`e9g: watchdog installed (${LABEL}, every 5 minutes, runs ${entry})`);
}

export const watchdogLoaded = (): boolean => spawnSync("launchctl", ["print", `gui/${process.getuid?.()}/${LABEL}`], { stdio: "ignore" }).status === 0;

export async function watchdog(argv: string[]): Promise<number> {
  switch (argv[0] ?? "run") {
    case "install":
      install();
      return 0;
    case "remove":
      spawnSync("launchctl", ["bootout", `gui/${process.getuid?.()}/${LABEL}`], { stdio: "ignore" });
      rmSync(PLIST, { force: true });
      console.info("e9g: watchdog removed");
      return 0;
    case "run":
      await watchOnce(argv[1]);
      return 0;
    default:
      die("usage: e9g watchdog install | remove | run [<team>]");
  }
}
