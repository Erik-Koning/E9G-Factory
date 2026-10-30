// The watchdog: one launchd job (ca.e9g.watchdog) that looks after every registered team every 5 minutes. It uses
// no model. macOS doesn't let launchd jobs read ~/Documents, so it runs the installed copy in ~/.e9g and never
// touches a checkout (E9G_LAUNCHD tells it it's that job). It reads T3 Code (its CLI and database), Docker, each
// team's health URLs and its run folder, and sends anything that needs a checkout to the team's planner as a
// message. What needs the operator also goes through every channel they've connected (e9g connect,
// lib/channels.ts), and their replies go to the planner. Run from a terminal (e9g watchdog run, e9g start) it also
// clears finished worktrees. A run of every team ends by pinging the heartbeat, if one is connected (lib/heartbeat.ts).
//
// Per team, in its run folder: watchdog.log, planner-thread, heartbeat/, outbox/, replies/, paused, complete.
//
//   e9g watchdog install | remove | run [<team>]
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { type Channel, channels, failingSend, outboxMessage, recordSend, type Replies, type Reply } from "../channels.ts";
import { type Contact, DEFAULT_CONTACT, type MessageKind, messageKind, nextAllowed, recordSent, registeredContact } from "../contact.ts";
import { HEARTBEAT_FILE, heartbeatSettings, hostOf, ping } from "../heartbeat.ts";
import { PLANNER_TAG } from "../labels.ts";
import { acquireSlot } from "../lock.ts";
import { E9G_HOME, entryOf, readRegistry, type RegistryEntry, teamsDir } from "../paths.ts";
import { operatorOnly } from "../session.ts";
import { machineName } from "../machine.ts";
import { claimRefusal } from "../tasks/model.ts";
import { journeyDue } from "../tasks/model.ts";
import { expireClaims } from "../tasks/ops.ts";
import { openStore } from "../tasks/store.ts";
import * as t3 from "../t3.ts";
import { die, readJson, which, writeFileAtomic, writeJson } from "../util.ts";

const LABEL = "ca.e9g.watchdog";
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const GLOBAL_LOG = join(E9G_HOME, "watchdog.log");
const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

function notify(title: string, text: string): void {
  const clean = (s: string) => String(s).replaceAll('"', "'");
  spawnSync("osascript", ["-e", `display notification "${clean(text)}" with title "${clean(title)}"`], { stdio: "ignore" });
}
const minutesSince = (path: string): number => (existsSync(path) ? (Date.now() - statSync(path).mtimeMs) / 60_000 : Number.POSITIVE_INFINITY);

// An alert through each connected channel too: the same one at most every 6 hours per channel (stamped in dir), so a
// night of waiting is a message and a reminder, not one an hour. A failed send is tried again with the next alert.
// Sent for a team, the operator can answer it. Returns what to log.
const RESEND_ALERT_MIN = 360;

// One send through a channel, recorded (lib/channels.ts) so the planner is told a channel works only while it does.
// A channel that throws counts as one that failed.
async function sendThrough(channel: Channel, subject: string, text: string, team?: string, id?: string): Promise<string | null> {
  let problem: string | null;
  try {
    problem = await channel.send(subject, text, team, id);
  } catch (error) {
    problem = (error as Error).message;
  }
  recordSend(channel.name, problem);
  return problem;
}

export async function alertChannels(reach: Channel[], dir: string, kind: string, subject: string, text: string, team?: string): Promise<string[]> {
  const said: string[] = [];
  for (const channel of reach) {
    const mark = join(dir, `.stamp-${channel.name}-${kind}`);
    if (minutesSince(mark) < RESEND_ALERT_MIN) continue;
    const problem = await sendThrough(channel, subject, `${text}\n\nSent by the E9G Factory watchdog on ${hostname()}.\n`, team);
    if (problem) said.push(`couldn't send the ${kind} alert by ${channel.name}: ${problem}`);
    else {
      writeFileSync(mark, "");
      said.push(`sent the ${kind} alert by ${channel.name}`);
    }
  }
  return said;
}

// Drafts in the planner's outbox: a notification on this Mac, and the message through each connected channel, once a
// draft has been left alone for a minute (so one written in steps goes whole). The team's contact setting says when
// (lib/contact.ts): in digest mode, ordinary drafts wait for the window and go as one message; "Urgent:" goes at once,
// one per window (another waits with the rest); "Done" always goes. A draft is released when it's due, which the Mac
// notification marks (with how it went), and only a release's first delivery counts against the window: a channel
// that failed sends it on its next run. One written before a channel was connected isn't sent by it; a failed send
// is tried again on later runs, for a day past its window, under an id that keeps a retry from arriving twice.
export async function sendOutbox(
  reach: Channel[],
  outbox: string,
  title: string,
  team: string,
  log: (text: string) => void,
  contact: Contact = DEFAULT_CONTACT,
  notifyMac: (text: string) => void = () => {}
): Promise<void> {
  const run = dirname(outbox);
  const now = Date.now();
  const digest = contact.mode === "digest" && contact.everyMin > 0;
  const open = (kind: MessageKind): boolean => nextAllowed(contact, run, kind, now) <= now;
  // A channel still owes this draft a send.
  const owes = (channel: Channel, path: string): boolean =>
    !existsSync(`${path}.sent-${channel.name}`) && statSync(path).mtimeMs >= Date.parse(channel.connectedAt);
  // The first urgent draft takes the window's one urgent message; any other goes with the ordinary ones.
  let urgentFree = open("urgent");
  const due: { draft: string; path: string; subject: string; text: string; as: MessageKind; delivered: boolean }[] = [];
  const unnotified: typeof due = [];
  for (const draft of readdirSync(outbox)
    .filter((f) => f.endsWith(".md"))
    .sort()) {
    const path = join(outbox, draft);
    const age = minutesSince(path);
    if (age < 1 || age > 1440 + (digest ? contact.everyMin : 0)) continue;
    const released = existsSync(`${path}.notified`);
    if (released && !reach.some((channel) => owes(channel, path))) continue;
    const { subject, text } = outboxMessage(title, draft, readFileSync(path, "utf8"));
    const kind = messageKind(subject);
    // Released: as it went (a marker from before this setting is empty, so its own kind). Otherwise, if it's due now.
    const marked = released ? readFileSync(`${path}.notified`, "utf8").trim() : "";
    const as: MessageKind | null = released
      ? marked === "done" || marked === "urgent" || marked === "normal"
        ? marked
        : kind
      : kind === "done"
        ? "done"
        : kind === "urgent" && urgentFree
          ? "urgent"
          : open("normal")
            ? "normal"
            : null;
    if (!as) continue;
    if (!released && as === "urgent") urgentFree = false;
    const item = { draft, path, subject, text, as, delivered: reach.some((channel) => existsSync(`${path}.sent-${channel.name}`)) };
    due.push(item);
    if (!released) unnotified.push(item);
  }

  // On this Mac, once for what's newly due: the only delivery when no channel is connected.
  if (unnotified.length) {
    notifyMac(
      unnotified.length === 1
        ? `The team has a message for you: ${basename(unnotified[0]?.draft ?? "", ".md")}. It's in ${outbox}.`
        : `The team has ${unnotified.length} messages for you. They're in ${outbox}.`
    );
    for (const { path, draft, as } of unnotified) {
      writeFileSync(`${path}.notified`, as);
      log(`notified about ${draft}`);
    }
  }

  const went = new Set<MessageKind>(reach.length ? [] : unnotified.map(({ as }) => as));
  for (const channel of reach) {
    const pending = due.filter(({ path }) => owes(channel, path));
    const together = digest ? pending.filter(({ as }) => as === "normal") : [];
    const sends = pending.filter((item) => !together.includes(item)).map((item) => [item]);
    if (together.length) sends.push(together);
    for (const items of sends) {
      const [first] = items;
      if (!first) continue;
      const one = items.length === 1;
      const subject = one
        ? first.subject
        : `${PLANNER_TAG} [${title}] ${items.length} messages: ${items.map((item) => strip(item.subject, title)).join("; ")}`;
      const text = one ? first.text : items.map((item, i) => `${i + 1}. ${strip(item.subject, title)}\n\n${item.text.trim()}`).join("\n\n---\n\n") + "\n";
      const names = items.map(({ draft }) => draft).join(", ");
      const problem = await sendThrough(
        channel,
        subject,
        text,
        team,
        one ? `${team}/${first.draft}` : `${team}/digest/${items.map(({ draft }) => draft).join("+")}`
      );
      if (problem) log(`couldn't send ${names} by ${channel.name}: ${problem}`);
      else {
        for (const { path } of items) writeFileSync(`${path}.sent-${channel.name}`, "");
        for (const { as, delivered } of items) if (!delivered) went.add(as);
        log(`sent ${names} by ${channel.name}`);
      }
    }
  }
  for (const kind of went) recordSent(run, kind);
}

// A subject without the labels the planner's messages carry.
const strip = (subject: string, title: string): string => subject.replace(PLANNER_TAG, "").replace(`[${title}]`, "").trim();

// A Mac notification, at most hourly, for each connected channel whose last send failed: otherwise the operator
// learns only from a log that the factory can't reach them.
function warnFailing(reach: Channel[], glog: (text: string) => void): void {
  for (const channel of reach) {
    const problem = failingSend(channel.name);
    const mark = join(E9G_HOME, `.stamp-failing-${channel.name}`);
    if (!problem || minutesSince(mark) < 60) continue;
    writeFileSync(mark, "");
    notify("E9G Factory", `Can't reach you by ${channel.name}: ${problem}. e9g connect ${channel.name} --test checks it.`);
    glog(`${channel.name} is failing: ${problem}`);
  }
}

// The operator's replies from the channels that take them, and those it read and passed over, which go into seen so
// they aren't read again.
async function readReplies(reach: Channel[], seen: Set<string>, glog: (text: string) => void): Promise<Reply[]> {
  const replies: Reply[] = [];
  for (const channel of reach) {
    if (!channel.replies) continue;
    let got: Replies;
    try {
      got = await channel.replies(seen);
    } catch (error) {
      got = { replies: [], ignored: [], problem: (error as Error).message };
    }
    const mark = join(E9G_HOME, `.stamp-replies-${channel.name}`);
    if (got.problem && minutesSince(mark) >= 60) {
      writeFileSync(mark, "");
      glog(`couldn't read the ${channel.name} replies: ${got.problem}`);
    }
    for (const { id, why } of got.ignored) {
      seen.add(id);
      glog(`passed over ${why}`);
    }
    replies.push(...got.replies);
  }
  const registered = (team: string): boolean => {
    try {
      return Boolean(readRegistry(team));
    } catch {
      return true; // a registry entry that doesn't read is the team loop's problem; the reply waits
    }
  };
  for (const reply of replies.filter((r) => !registered(r.team))) {
    seen.add(reply.id);
    glog(`passed over a ${reply.via} reply for ${reply.team}, which isn't a registered team`);
  }
  return replies.filter((reply) => !seen.has(reply.id));
}

// Each reply to the team's planner (tell sends a message to its thread), once: the marker in replies/ is written under
// the team's lock, so an overlapping run doesn't pass it on twice.
export function passReplies(replies: Reply[], run: string, tell: (text: string) => boolean, seen: Set<string>, log: (text: string) => void): void {
  for (const reply of replies) {
    const marker = join(run, "replies", reply.id);
    if (!existsSync(marker)) {
      const text = `The operator answered by ${reply.via}, to "${reply.subject}":\n\n${reply.text}\n\nThe watchdog checked it came from them. Record the answer on the question's ticket and act on it.`;
      if (!tell(text)) {
        log(`couldn't pass the operator's ${reply.via} reply to the planner; trying again next run`);
        continue;
      }
      mkdirSync(join(run, "replies"), { recursive: true });
      writeFileSync(marker, "");
      log(`passed the operator's ${reply.via} reply to "${reply.subject}" to the planner`);
    }
    seen.add(reply.id);
  }
}

export async function answers(target: string): Promise<boolean> {
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
async function t3Answers(glog: (text: string) => void, reach: Channel[]): Promise<boolean> {
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
    const text = `T3 Code won't start, so every team is stopped. See ${GLOBAL_LOG}.`;
    notify("E9G Factory", text);
    for (const said of await alertChannels(reach, E9G_HOME, "t3-down", "[E9G Factory] T3 Code won't start", text)) glog(said);
  }
  return false;
}

// Watches every team, or only one. `before` runs for that team inside its lock, ahead of the watch; a sentence it
// returns stops it there. Resolves to why the watch didn't happen, or null.
export async function watchOnce(only?: string, before?: (entry: RegistryEntry) => string | null): Promise<string | null> {
  mkdirSync(E9G_HOME, { recursive: true });
  const glog = (text: string) => appendFileSync(GLOBAL_LOG, `${stamp()} ${text}\n`);
  // Nothing about the channels stops the watchdog's own work: a bad settings file means no channels this run.
  let reach: Channel[] = [];
  try {
    reach = channels();
  } catch (error) {
    glog(`couldn't read how the operator is connected: ${(error as Error).message}`);
  }
  if (!(await t3Answers(glog, reach))) return "T3 Code isn't answering (see ~/.e9g/watchdog.log)";
  // Ids of replies already passed on or passed over; only those Resend still lists matter, so the newest few hundred.
  const seenFile = join(E9G_HOME, "replies-seen.json");
  let seen = new Set<string>();
  try {
    seen = new Set(readJson<string[]>(seenFile, []));
  } catch {}
  const replies = await readReplies(reach, seen, glog);
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
      if (!skipped)
        await watchTeam(
          entry,
          reach,
          replies.filter((reply) => reply.team === name),
          seen
        );
    } catch (error) {
      glog(`watching ${name} failed: ${(error as Error).message}`);
    } finally {
      release();
    }
  }
  if (reach.some((channel) => channel.replies)) writeJson(seenFile, [...seen].slice(-500));
  warnFailing(reach, glog);
  if (!only) await beat(glog);
  return skipped;
}

// The heartbeat (lib/heartbeat.ts), last, so a ping says a whole run got through; a run that watches one team (e9g
// start) doesn't ping. A failing ping is logged at most hourly: the service's own alert is what tells the operator.
async function beat(glog: (text: string) => void): Promise<void> {
  let settings: ReturnType<typeof heartbeatSettings> = null;
  try {
    settings = heartbeatSettings();
  } catch (error) {
    glog(`couldn't read ${HEARTBEAT_FILE}: ${(error as Error).message}`);
    return;
  }
  if (!settings) return;
  const problem = await ping(settings.url);
  const mark = join(E9G_HOME, ".stamp-heartbeat-failing");
  if (!problem) rmSync(mark, { force: true });
  else if (minutesSince(mark) >= 60) {
    writeFileSync(mark, "");
    glog(`couldn't ping the heartbeat at ${hostOf(settings.url)}: ${problem}`);
  }
}

async function watchTeam(entry: RegistryEntry, reach: Channel[], replies: Reply[], seen: Set<string>): Promise<void> {
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
  // What needs the operator: on this Mac, and through each channel they've connected.
  const alert = async (kind: string, text: string): Promise<void> => {
    notify(title, text);
    for (const said of await alertChannels(reach, run, kind, `[${title}] ${text}`, `${text}\n\ne9g status ${entry.name} shows the team.`, entry.name))
      log(said);
  };
  mkdirSync(join(run, "heartbeat"), { recursive: true });
  mkdirSync(join(run, "outbox"), { recursive: true });
  if (existsSync(join(run, "paused"))) return;

  // Claims whose lease ran out go back to approved, for another member (lib/tasks/ops.ts); and what's waiting, which
  // wakes an idle cycles team.
  let arrived = "";
  if (entry.tasks)
    try {
      const store = await openStore({ name: entry.name, tasks: entry.tasks }, run);
      try {
        const expired = await expireClaims(store, Date.now(), run);
        if (expired.length) log(`returned tasks whose claims ran out: ${expired.map((id) => `#${id}`).join(" ")}`);
        // What arrived or changed since the team went idle, so the same waiting work doesn't wake it every run.
        const idle = join(run, "idle");
        const since = existsSync(idle) ? new Date(statSync(idle).mtimeMs).toISOString() : "";
        const requests = (await store.requests.all()).filter((r) => r.status === "new" && r.updatedAt > since).length;
        // Anything the planner acts on: a finding or proposal, approved work, a hand-in to review, and a journey whose
        // last task just finished (it's due its verification).
        const all = await store.tasks.all();
        const tasks = all.filter(
          (t) =>
            t.updatedAt > since &&
            (["triage", "proposed", "approved", "review"].includes(t.status) ||
              (t.status === "done" && all.some((j) => j.id === t.parent && journeyDue(j, all))))
        ).length;
        arrived = [
          requests ? `${requests} new feature request${requests === 1 ? "" : "s"}` : "",
          tasks ? `${tasks} task${tasks === 1 ? "" : "s"} to triage, approve, build, review or verify` : "",
        ]
          .filter(Boolean)
          .join(" and ");
      } finally {
        await store.close();
      }
    } catch (error) {
      if (oncePer("tasks-unreadable", 60)) log(`couldn't read the task graph: ${(error as Error).message}`);
    }

  // A worker machine has no planner: the watchdog starts its builders while approved work is free.
  if (entry.worker) {
    try {
      await fillWorkerSlots(entry, log);
    } catch (error) {
      if (oncePer("worker-failed", 60)) log(`couldn't fill the worker's slots: ${(error as Error).message}`);
    }
    pruneWorktrees(entry);
    trimLog(run);
    return;
  }

  if (entry.needsDocker && spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) {
    log("Docker isn't running; starting it");
    spawnSync("open", ["-a", "Docker"], { stdio: "ignore" });
    return;
  }

  const threadFile = join(run, "planner-thread");
  const plannerTitle = `${title} · planner`;
  const startPlanner = async (why: string): Promise<void> => {
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
      if (oncePer("planner-failed", 60)) await alert("planner-failed", "The team couldn't start its planner. See its watchdog log.");
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
  passReplies(replies, run, (text) => t3.threadSend(planner, text), seen, log);

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
      await alert("stuck", `The planner looks stuck (${quiet} min without activity). Open T3 Code to look.`);
    }
    if (envNote && oncePer("env-down", 30) && t3.threadSend(planner, tickText())) log("queued an environment-down note");
  } else if (status === "waiting" || pending > 0) {
    if (oncePer("waiting", 60)) {
      log("planner waiting on a person");
      await alert("waiting", "The planner is waiting for an answer in T3 Code.");
    }
  } else if (existsSync(join(run, "idle"))) {
    // An idle cycles team: woken by new work, else ticked like a finished one.
    if (arrived) {
      rmSync(join(run, "idle"), { force: true });
      if (t3.threadSend(planner, tickText(`, new work: ${arrived}`))) log(`woke the idle planner: ${arrived}`);
    } else if (oncePer("tick", w.doneTickEveryMin ?? 1440) && t3.threadSend(planner, tickText(", nightly: the team is idle; check for new work")))
      log("nightly tick (idle)");
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

  pruneWorktrees(entry);

  // The planner's outbox: a notification on this Mac, and the message itself through each connected channel, as often
  // as the team's contact setting allows.
  await sendOutbox(reach, join(run, "outbox"), title, entry.name, log, registeredContact(entry.contact), (text) => notify(title, text));
  trimLog(run);
}

// The team's watchdog log, kept to its last 2,000 lines once it passes 5,000.
function trimLog(run: string): void {
  const logFile = join(run, "watchdog.log");
  if (!existsSync(logFile)) return;
  const lines = readFileSync(logFile, "utf8").split("\n");
  if (lines.length > 5000) writeFileSync(logFile, lines.slice(-2000).join("\n"));
}

// A worker machine: for each role it runs, as many members as its limit leaves room for and approved tasks it could
// claim, each in a worktree of the integration branch, told to claim (the claim makes its branch from the remote).
// T3 Code counts only the members a planner starts, so the watchdog keeps the threads it starts (worker-threads.json)
// and counts those still busy; and it starts at most one member per slot each half hour, so members that end without
// claiming anything aren't started again every five minutes.
export const WORKER_PROMPT =
  "Claim a task from the team's task graph and build it: run e9g task claim first, then work as your role's instructions say, and hand it in with e9g task submit.";
const WORKER_WINDOW_MIN = 30;
type WorkerThreads = Record<string, { id: string; at: string }[]>;
async function fillWorkerSlots(entry: RegistryEntry, log: (text: string) => void): Promise<void> {
  if (!entry.tasks || !entry.limits) return;
  const file = join(entry.run, "worker-threads.json");
  const started = readJson<WorkerThreads>(file, {});
  const store = await openStore({ name: entry.name, tasks: entry.tasks }, entry.run);
  let all: Awaited<ReturnType<typeof store.tasks.all>>;
  try {
    all = await store.tasks.all();
  } finally {
    await store.close();
  }
  const busy = (id: string): boolean => {
    const status = t3.threadShow(id)?.status ?? "";
    return BUSY.includes(status) || status === "waiting";
  };
  for (const role of Object.keys(entry.limits)) {
    const recent = (started[role] ?? []).filter(({ at }) => Date.now() - Date.parse(at) < WORKER_WINDOW_MIN * 60_000);
    const running = (started[role] ?? []).filter(({ id }) => busy(id));
    const limit = entry.limits[role] ?? 0;
    const claimable = all.filter((t) => claimRefusal(t, role, all) === null).length;
    const n = Math.min(limit - running.length, limit - recent.length, claimable);
    const kept = [...new Map([...running, ...recent].map((thread) => [thread.id, thread])).values()];
    for (let i = 0; i < n; i++) {
      const { id, error } = t3.threadStart(entry.project, WORKER_PROMPT, {
        instance: `e9g-${entry.name}-${role}`,
        model: entry.model,
        title: `${entry.title} · ${role} (${machineName()})`,
        worktree: entry.branch ?? "HEAD",
      });
      if (id) kept.push({ id, at: new Date().toISOString() });
      log(
        id
          ? `started a ${role} (${id}) for the ${claimable} approved task${claimable === 1 ? "" : "s"} it could claim`
          : `couldn't start a ${role}: ${error ?? "no id"}`
      );
    }
    started[role] = kept;
  }
  writeJson(file, started);
}

// How long the worktrees of interrupted, failed or cancelled members are kept.
const STOPPED_KEEP_MIN = 7 * 1440;

// What a finished member's worktree still holds that removing it would lose, or null when there's nothing.
// Worktrees of members done with them: each holds a copy of node_modules and build output. Removed only when git
// shows nothing in them to lose (no change, no untracked file, no commit on no branch), by git itself, which refuses
// one with changes. Kept: any a member still uses, one with a marker in keep/, and those of interrupted, failed or
// cancelled members for a week (T3 can resume them). At most hourly, from the watchdog and from the merge queue:
// under launchd a checkout in ~/Documents can't be read, but the merge queue runs where the planner does.
export function pruneWorktrees(entry: RegistryEntry): void {
  const { run } = entry;
  const log = (text: string) => appendFileSync(join(run, "watchdog.log"), `${stamp()} ${text}\n`);
  const oncePer = (name: string, minutes: number): boolean => {
    const mark = join(run, `.stamp-${name}`);
    if (minutesSince(mark) < minutes) return false;
    writeFileSync(mark, "");
    return true;
  };
  if (!entry.worktreesDir || existsSync(join(run, "paused"))) return;
  // The launchd job doesn't reach into a checkout: in ~/Documents that would ask macOS for access to the folder on
  // node's behalf. The merge queue and the operator's own commands prune instead.
  if (process.env.E9G_LAUNCHD) return;
  // Nor does any other process that can't read the checkout; it leaves the turn to one that can.
  if (spawnSync("git", ["-C", entry.home, "rev-parse", "--git-dir"], { stdio: "ignore" }).status !== 0) return;
  if (!oncePer("prune", 60)) return;
  const pruneAfter = entry.watchdog?.pruneAfterMin ?? 60;
  let freed = 0;
  const kept: string[] = [];
  for (const path of t3.finishedWorktrees(entry.project, { completedAfterMin: pruneAfter, stoppedAfterMin: Math.max(pruneAfter, STOPPED_KEEP_MIN) })) {
    if (!path.startsWith(`${entry.worktreesDir}/`) || !existsSync(path) || existsSync(join(run, "keep", basename(path)))) continue;
    const work = workIn(path);
    if (work) kept.push(`${basename(path)}: ${work}`);
    else if (spawnSync("git", ["-C", entry.home, "-c", "status.showUntrackedFiles=all", "worktree", "remove", path], { stdio: "ignore" }).status === 0)
      freed++;
    else kept.push(`${basename(path)}: git worktree remove refused`);
  }
  if (freed) log(`removed ${freed} finished worktrees`);
  if (kept.length && oncePer("prune-kept", 1440)) log(`kept ${kept.length} finished worktrees that may hold work: ${kept.join("; ")}`);
  // For e9g status and e9g doctor: nothing deletes these, so the operator has to see them.
  writeFileAtomic(join(run, "worktrees-kept.json"), `${JSON.stringify({ at: new Date().toISOString(), kept }, null, 2)}\n`);
}

// The worktrees the last prune kept because they may hold work ("t3-1a2b: uncommitted or untracked files").
export function keptWorktrees(run: string): string[] {
  try {
    const { kept } = JSON.parse(readFileSync(join(run, "worktrees-kept.json"), "utf8")) as { kept?: unknown };
    return Array.isArray(kept) ? kept.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function workIn(path: string): string | null {
  // Untracked files count whatever the repository's or the user's git settings say (status.showUntrackedFiles=no).
  const status = spawnSync("git", ["-C", path, "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"], { encoding: "utf8" });
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
  <dict><key>PATH</key><string>${[...new Set(path)].join(":")}</string><key>E9G_HOME</key><string>${E9G_HOME}</string><key>NODE_COMPILE_CACHE</key><string>${join(E9G_HOME, "current", ".cache")}</string><key>E9G_NODE_CACHE</key><string>1</string><key>E9G_LAUNCHD</key><string>1</string></dict>
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
  // Right after a bootout, launchd can still be tearing the job down and refuse it ("5: Input/output error").
  let loaded = spawnSync("launchctl", ["bootstrap", domain, PLIST], { encoding: "utf8" });
  for (let tries = 0; loaded.status !== 0 && tries < 5; tries++) {
    spawnSync("sleep", ["1"]);
    loaded = spawnSync("launchctl", ["bootstrap", domain, PLIST], { encoding: "utf8" });
  }
  if (loaded.status !== 0) die(`launchctl couldn't load ${PLIST}: ${loaded.stderr.trim()}`);
  console.info(`e9g: watchdog installed (${LABEL}, every 5 minutes, runs ${entry})`);
}

export const watchdogLoaded = (): boolean => spawnSync("launchctl", ["print", `gui/${process.getuid?.()}/${LABEL}`], { stdio: "ignore" }).status === 0;

export async function watchdog(argv: string[]): Promise<number> {
  switch (argv[0] ?? "run") {
    case "install":
      operatorOnly("watchdog install");
      install();
      return 0;
    case "remove":
      operatorOnly("watchdog remove");
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
