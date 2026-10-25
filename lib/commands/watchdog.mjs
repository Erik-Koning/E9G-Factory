// The watchdog: one launchd job (ca.e9g.watchdog) that looks after every registered team every 5 minutes. It uses
// no model. macOS doesn't let launchd jobs read ~/Documents, so it runs the installed copy in ~/.e9g and never
// touches a checkout. It reads T3 Code (its CLI and database), Docker, each team's health URLs and its run folder,
// and sends anything that needs a checkout to the team's planner as a message.
//
// Per team, in its run folder: watchdog.log, planner-thread, heartbeat/, outbox/, paused, complete.
//
//   e9g watchdog install | remove | run [<team>]
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { E9G_HOME, readRegistry, teamsDir } from "../paths.mjs";
import * as t3 from "../t3.mjs";
import { die, which } from "../util.mjs";

const LABEL = "ca.e9g.watchdog";
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const GLOBAL_LOG = join(E9G_HOME, "watchdog.log");
const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

function notify(title, text) {
  const clean = (s) => String(s).replaceAll('"', "'");
  spawnSync("osascript", ["-e", `display notification "${clean(text)}" with title "${clean(title)}"`], { stdio: "ignore" });
}
const minutesSince = (path) => (existsSync(path) ? (Date.now() - statSync(path).mtimeMs) / 60_000 : Number.POSITIVE_INFINITY);
async function answers(target) {
  const any = target.startsWith("any:");
  try {
    const response = await fetch(any ? target.slice(4) : target, { signal: AbortSignal.timeout(5000), redirect: "manual" });
    return any || response.status < 400;
  } catch {
    return false;
  }
}

export async function watchOnce(only) {
  mkdirSync(E9G_HOME, { recursive: true });
  const glog = (text) => appendFileSync(GLOBAL_LOG, `${stamp()} ${text}\n`);
  if (!(await t3.serverUp())) {
    glog("T3 Code isn't answering; restarting its service");
    t3.restartService();
    await new Promise((done) => setTimeout(done, 20_000));
    if (!(await t3.serverUp())) {
      const mark = join(E9G_HOME, ".stamp-t3-down");
      if (minutesSince(mark) >= 60) {
        writeFileSync(mark, "");
        notify("E9G Factory", `T3 Code won't start, so every team is stopped. See ${GLOBAL_LOG}.`);
      }
      return;
    }
  }
  const names = only
    ? [only]
    : existsSync(teamsDir)
      ? readdirSync(teamsDir)
          .filter((f) => f.endsWith(".json"))
          .map((f) => f.replace(/\.json$/, ""))
      : [];
  for (const name of names) {
    try {
      await watchTeam(readRegistry(name));
    } catch (error) {
      glog(`watching ${name} failed: ${error.message}`);
    }
  }
}

async function watchTeam(entry) {
  const { run, title } = entry;
  const w = entry.watchdog ?? {};
  const log = (text) => appendFileSync(join(run, "watchdog.log"), `${stamp()} ${text}\n`);
  // true when <name> hasn't fired within <minutes>, and marks it fired.
  const oncePer = (name, minutes) => {
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
  const startPlanner = (why) => {
    const { id, error } = t3.threadStart(entry.project, entry.startPrompt, {
      instance: entry.plannerInstance,
      model: entry.model,
      title: `${title} · planner`,
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
  if (["running", "starting", "preparing", "queued"].includes(status)) {
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
  } else if (envNote || oncePer("tick", w.tickEveryMin ?? 10)) {
    log(t3.threadSend(planner, tickText()) ? `tick (planner was ${status})` : "couldn't send a tick");
  }
  if (quietMembers.length && oncePer("stuck-members", 60)) notify(title, `Members quiet for ${w.stuckAfterMin ?? 45}+ min: ${quietMembers.join("; ")}`);

  // Worktrees of members that finished a while ago: their work is committed (the stop gate sees to that), and
  // each holds a copy of node_modules and build output. The merge queue prunes git's records of them.
  if (entry.worktreesDir && oncePer("prune", 60)) {
    let freed = 0;
    for (const path of t3.finishedWorktrees(entry.project, w.pruneAfterMin ?? 60)) {
      if (!path.startsWith(`${entry.worktreesDir}/`) || !existsSync(path)) continue;
      rmSync(path, { recursive: true, force: true });
      freed++;
    }
    if (freed) log(`removed ${freed} finished worktrees`);
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

// The plist runs the installed current version from ~/.e9g, which launchd can read.
export function ensureWatchdog() {
  if (!existsSync(PLIST)) install();
}

function install() {
  const node = process.execPath;
  const entry = join(E9G_HOME, "current", "bin", "e9g.mjs");
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
  <dict><key>PATH</key><string>${[...new Set(path)].join(":")}</string><key>E9G_HOME</key><string>${E9G_HOME}</string></dict>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${join(E9G_HOME, "watchdog.launchd.log")}</string>
  <key>StandardErrorPath</key><string>${join(E9G_HOME, "watchdog.launchd.log")}</string>
</dict>
</plist>
`
  );
  const domain = `gui/${process.getuid()}`;
  spawnSync("launchctl", ["bootout", `${domain}/${LABEL}`], { stdio: "ignore" });
  const loaded = spawnSync("launchctl", ["bootstrap", domain, PLIST], { encoding: "utf8" });
  if (loaded.status !== 0) die(`launchctl couldn't load ${PLIST}: ${loaded.stderr.trim()}`);
  console.info(`e9g: watchdog installed (${LABEL}, every 5 minutes, runs ${entry})`);
}

export const watchdogLoaded = () => spawnSync("launchctl", ["print", `gui/${process.getuid()}/${LABEL}`], { stdio: "ignore" }).status === 0;

export async function watchdog(argv) {
  switch (argv[0] ?? "run") {
    case "install":
      install();
      return 0;
    case "remove":
      spawnSync("launchctl", ["bootout", `gui/${process.getuid()}/${LABEL}`], { stdio: "ignore" });
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
