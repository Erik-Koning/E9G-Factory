// The operator's commands for a team's life: register (alias sync), unregister, start, pause, resume, rotate,
// status, teams, prompt and upgrade.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { instanceId, loadTeam, type RawTeam, type Team } from "../config.ts";
import {
  defaultRunDir,
  A6G_HOME,
  entryOf,
  FACTORY_ROOT,
  findHome,
  PACKAGE,
  pluginDir,
  readRegistry,
  type RegistryEntry,
  registryFile,
  teamFile,
  teamsDir,
  versionDir,
} from "../paths.ts";
import { readHold, readLimits } from "../holds.ts";
import { describeSpend, type Spend } from "../tasks/spend.ts";
import { compile, promptFile, writePrompt } from "../prompts.ts";
import { operatorOnly } from "../session.ts";
import * as t3 from "../t3.ts";
import { die, parseArgs, readJson, writeJson } from "../util.ts";
import { acquireSlot } from "../lock.ts";
import { answers, applyTeamControls, BUSY, ensureWatchdog, keptWorktrees, reportTeamState, watchOnce } from "./watchdog.ts";
import { machineName } from "../machine.ts";
import { isLead, multiMachine } from "../tasks/machines.ts";
import {
  budgetControl,
  type Control,
  describeHold,
  type HoldScope,
  holdOf,
  type Limits,
  limitsOf,
  pauseControl,
  resumeControl,
} from "../tasks/controls.ts";
import { nowIso, OPERATOR, Refused } from "../tasks/model.ts";
import { openStore, type Store } from "../tasks/store.ts";
import { settingsOf } from "../tasks/teams.ts";

const quote = (text: string): string => (/[\s"']/.test(text) ? `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"` : text);

function homeFrom(arg: string | undefined): string {
  const home = arg ? realpathSync(resolve(arg)) : findHome();
  if (!home) die("run this in a team's checkout, or name it: a6g register <checkout>");
  return home;
}

// The factory version a team runs: its team.json pin ("dev" is the linked source checkout), else this one.
export function versionFor(team: Team): string {
  const version = team.factory ?? PACKAGE.version;
  if (!existsSync(versionDir(version)))
    die(
      `the team pins Anything Factory ${version}, which isn't installed (${versionDir(version)}); run a6g self-install${version === "dev" ? " --link" : ""} from that version's checkout`
    );
  return version;
}

// A member's environment: team.json's vars, then the factory's own, so a var never decides who a member is or where
// its team lives.
export function memberEnvironment(
  team: Team,
  role: string,
  { home, run, version }: { home: string; run: string; version: string }
): Record<string, string> {
  const vars = Object.fromEntries(
    Object.entries(team.vars).map(([key, value]) => [key, String(value).replaceAll("${home}", home).replaceAll("${run}", run)])
  );
  // A6G_HOME too: a member's hooks guard the factory's folder wherever the operator keeps it.
  return { ...vars, A6G_TEAM: team.name, A6G_ROLE: role, A6G_HOME: A6G_HOME, A6G_HOME_DIR: home, A6G_RUN: run, A6G_VERSION: version };
}

export async function register(argv: string[]): Promise<number> {
  operatorOnly("register");
  const { positional, options } = parseArgs(argv, { booleans: ["force", "worker"] });
  const home = homeFrom(positional[0]);
  const code = registerTeam(home, { force: Boolean(options["force"]), worker: Boolean(options["worker"]) });
  if (code === 0) await publishTeam(home);
  return code;
}

// Registers the team in `home` to run `version` (else the one its team.json pins). Dies before changing anything
// when it can't.
// A team whose task graph is in Mongo shows in the web app: the lead publishes its settings there (the app reads no
// team.json). A failure is said, and changes nothing else: register again once Mongo answers.
async function publishTeam(home: string): Promise<void> {
  const team = loadTeam(home);
  if (team.board.type !== "tasks" || team.tasks.store !== "mongo" || !isLead(team)) return;
  try {
    const store = await openStore(team, readRegistry(team.name)?.run ?? defaultRunDir(team.name));
    try {
      await store.publish(settingsOf(team, PACKAGE.version));
      console.info(`  published ${team.name}'s settings for the web app`);
    } finally {
      await store.close();
    }
  } catch (error) {
    console.warn(`  couldn't publish ${team.name}'s settings for the web app: ${(error as Error).message.split("\n")[0]}`);
  }
}

function registerTeam(home: string, { force, version: target, worker = false }: { force: boolean; version?: string; worker?: boolean }): number {
  const team = loadTeam(home);
  for (const warning of team.warnings) console.warn(`  note: ${warning}`);
  // Register doesn't write team.json (a change there would hold up every merge until it's committed).
  if (!team.factory && !target)
    console.warn(`  note: team.json pins no factory version, so the team runs whichever version registers it (a6g upgrade ${team.name} pins one)`);
  const problems = t3.contract();
  if (problems.length && !force) die(`T3 Code isn't ready:\n  - ${problems.join("\n  - ")}\n(a6g doctor explains; --force registers anyway)`);
  if (!existsSync(join(home, ".a6g", ".gitignore")))
    console.warn("  note: .a6g/.gitignore is missing; add one with run/ so the team's runtime stays out of git");

  // A worker machine of a team on several machines runs builders only: the lead runs the rest, the team's environment
  // with it, which testers test against.
  if (worker && !(multiMachine(team) && !isLead(team)))
    die(
      `--worker is for a machine other than the lead of a team whose tasks are in Mongo (team.json tasks.lead${team.tasks.lead ? ` is ${team.tasks.lead}, and this is ${machineName()}` : " isn't set"})`
    );
  if (!worker && !isLead(team))
    die(`this team's lead is ${team.tasks.lead} and this is ${machineName()}: register it here with --worker, or make this machine the lead`);

  const version = target ?? versionFor(team);
  const previous = readRegistry(team.name);
  if (previous && previous.home !== home)
    die(`a team named ${team.name} is already registered at ${previous.home}; pick another name or a6g unregister ${team.name}`);
  // One team per checkout: a renamed team would otherwise run beside the old one on the same files.
  const other = teamNames().find((name) => name !== team.name && readRegistry(name)?.home === home);
  if (other) die(`${home} is already registered as the team ${other}; a6g unregister ${other} first, or keep the name ${other}`);
  const run = previous?.run ?? defaultRunDir(team.name);
  mkdirSync(run, { recursive: true });
  const project = previous?.project ?? team.raw.t3ProjectId ?? t3.projectAdd(team.title, home);
  if (!project) die(`couldn't add ${home} as a T3 Code project; add it in T3 Code and put its id in team.json t3ProjectId`);

  const instances: Record<string, t3.ProviderInstance> = {};
  const roles = Object.keys(team.roles).filter((role) => !worker || role === "builder");
  for (const role of roles) {
    const prompt = writePrompt(team, role, run);
    const flags = [
      `--agent a6g:${role}`,
      `--plugin-dir ${quote(pluginDir(version))}`,
      `--append-system-prompt-file ${quote(prompt)}`,
      `--setting-sources ${team.isolation === "strict" ? "project" : "user,project"}`,
      // The planner keeps the account's connectors for its email; everyone else gets only T3 Code's tools.
      team.isolation === "strict" && role !== "planner" ? "--strict-mcp-config" : null,
    ].filter((flag) => flag !== null);
    instances[instanceId(team, role)] = t3.instance({
      displayName: `${team.title} · ${role}`,
      launchArgs: flags.join(" "),
      environment: memberEnvironment(team, role, { home, run, version }),
      compactAt: role === "planner" ? team.plannerCompactAt : null,
    });
  }
  t3.writeTeam({ team: team.name, instances, project, setup: team.worktreeSetup, branchPrefix: team.branchPrefix });

  mkdirSync(teamsDir, { recursive: true });
  const entry: RegistryEntry = {
    name: team.name,
    title: team.title,
    home,
    run,
    project,
    version,
    plannerInstance: instanceId(team, "planner"),
    model: team.model,
    health: team.environment.health,
    needsDocker: team.environment.needsDocker,
    worktreesDir: t3.worktreesDir(home),
    watchdog: team.watchdog,
    contact: team.contact,
    ...(team.board.type === "tasks" ? { tasks: team.tasks } : {}),
    mode: team.mode,
    ...(worker ? { worker: true, branch: team.branch, limits: Object.fromEntries(roles.map((role) => [role, team.roles[role]?.limit ?? 0])) } : {}),
    startPrompt:
      team.startPrompt ??
      'Start the team, or pick it up where your log leaves off: read the documents your rules list, then work through "Each time you wake".',
    registeredAt: new Date().toISOString(),
  };
  writeJson(registryFile(team.name), entry);
  console.info(`a6g: registered ${team.name} (Anything Factory ${version}; T3 project ${project}; run folder ${run})`);
  console.info(
    `  roles${worker ? " (a worker: builders only; testers test on the lead, where the environment runs)" : ""}: ${roles.map((role) => `${role} (${instanceId(team, role)})`).join(", ")}`
  );
  if (existsSync(join(run, "planner-thread")))
    console.info(`  a planner is running; it keeps the flags it started with until a6g rotate ${team.name} (members started from now get the new ones)`);
  else console.info(`  start it: a6g start ${team.name}`);
  return 0;
}

export function unregister(argv: string[]): number {
  operatorOnly("unregister");
  const name = argv[0] ?? die("usage: a6g unregister <team>");
  const entry = readRegistry(name) ?? die(`no team named ${name}`);
  const removed = t3.removeInstances(name);
  rmSync(registryFile(name), { force: true });
  console.info(`a6g: unregistered ${name} (${removed} T3 instances removed; its run folder ${entry.run} and checkout are kept)`);
  return 0;
}

const entryFor = (name: string): RegistryEntry => readRegistry(name) ?? die(`no team named ${name} (registered: ${teamNames().join(", ") || "none"})`);
export const teamNames = (): string[] =>
  existsSync(teamsDir)
    ? readdirSync(teamsDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, ""))
    : [];

export async function start(argv: string[]): Promise<number> {
  operatorOnly("start");
  const entry = entryFor(argv[0] ?? die("usage: a6g start <team>"));
  // A pause the operator or the budget recorded stays until a6g resume, which is the operator's alone: start only starts
  // the watch (the setup agent runs it too). A paused file with no pause recorded (an earlier version's) it lifts.
  if (entry.tasks && !entry.worker) {
    let hold: ReturnType<typeof holdOf> = null;
    try {
      const store = await openStore({ name: entry.name, tasks: entry.tasks }, entry.run);
      try {
        hold = holdOf(await store.controls.all());
      } finally {
        await store.close();
      }
    } catch (error) {
      console.error(`a6g: couldn't read the team's controls (${(error as Error).message.split("\n")[0]}); a pause recorded there still holds`);
    }
    if (hold) {
      console.info(
        `a6g: ${entry.name} is paused (${hold.by === "budget" ? "by its budget" : "by the operator"}, ${describeHold(hold)}): a6g resume ${entry.name} starts it again`
      );
      return status([entry.name]);
    }
  }
  rmSync(join(entry.run, "paused"), { force: true });
  ensureWatchdog();
  const why = await watchOnce(entry.name);
  if (why) {
    console.error(`a6g: ${entry.name} wasn't started: ${why}. When T3 Code doesn't answer, \`t3 service restart\`, then a6g start ${entry.name} again.`);
    await status([entry.name]);
    return 1;
  }
  return status([entry.name]);
}

const PAUSE_USAGE = 'usage: a6g pause <team> [--after tasks | --after journeys [--journeys 3,7]] [--note "…"]';

// The operator's control, recorded in the team's store and applied in its run folder at once (the web app's wait for
// the watchdog's next minute). On a worker machine it's recorded only: the lead applies it.
async function recordControl(entry: RegistryEntry, make: (store: Store) => Promise<Omit<Control, "id" | "version">>): Promise<Control> {
  const tasks = entry.tasks ?? die(`${entry.name} keeps its tickets on a GitHub board, which has no controls`);
  const store = await openStore({ name: entry.name, tasks }, entry.run);
  let control: Control;
  try {
    control = await store.controls.create(await make(store));
  } catch (error) {
    if (error instanceof Refused) die(error.message);
    throw error;
  } finally {
    await store.close();
  }
  mkdirSync(entry.run, { recursive: true });
  // Under the watchdog's lock, so a run applying the same control at the same moment doesn't tell the planner twice;
  // then the web app's view of the team, at once. Busy for a minute, it's left to the watchdog's next minute.
  const release = await acquireSlot([join(entry.run, ".watch.lock")], { waitMin: 1, holder: "a6g" });
  if (!release) {
    console.info("a6g: the watchdog is busy with the team; it applies this within a minute");
    return control;
  }
  try {
    await applyTeamControls(
      entry,
      (text) => appendFileSync(join(entry.run, "watchdog.log"), `${new Date().toISOString().replace(/\.\d+Z$/, "Z")} ${text}\n`),
      (text) => console.error(`a6g: ${text}`)
    );
    await reportTeamState(entry);
  } finally {
    release();
  }
  return control;
}

// This machine alone: a worker's own pause (its builders), or the operator's when the task graph can't be reached.
function pauseHere(entry: RegistryEntry, paused: boolean): void {
  mkdirSync(entry.run, { recursive: true });
  if (paused) writeFileSync(join(entry.run, "paused"), new Date().toISOString());
  else rmSync(join(entry.run, "paused"), { force: true });
}

// a6g pause <team>: nothing starts or merges from now; running members finish their turn. --after tasks: the work under
// way finishes, reviewed and merged, then the team pauses; --after journeys: the journeys under way (or --journeys)
// finish, verification and polish included, then it pauses. Either way the operator gets a report when it does, and
// work stays stopped until a6g resume. A team whose tickets are on a GitHub board can only pause now.
export async function pause(argv: string[]): Promise<number> {
  operatorOnly("pause");
  const { positional, options } = parseArgs(argv);
  const entry = entryFor(positional[0] ?? die(PAUSE_USAGE));
  const after = typeof options["after"] === "string" ? options["after"].replace(/s$/, "") : undefined;
  if (after !== undefined && after !== "task" && after !== "journey") die(PAUSE_USAGE);
  const scope: HoldScope = after === "task" ? "tasks" : after === "journey" ? "journeys" : "now";
  const journeys =
    typeof options["journeys"] === "string"
      ? options["journeys"]
          .split(",")
          .map((id) => id.trim().replace(/^#/, ""))
          .filter(Boolean)
      : undefined;
  if (journeys && scope !== "journeys") die("--journeys goes with --after journeys");
  const note = typeof options["note"] === "string" ? options["note"] : "";
  if (!entry.tasks || entry.worker) {
    if (scope !== "now")
      die(
        entry.worker
          ? `pause the team after its work from its lead; here, a6g pause ${entry.name} stops this machine's members`
          : `${entry.name} keeps its tickets on a GitHub board, so it can only pause now (a6g pause ${entry.name})`
      );
    pauseHere(entry, true);
    if (entry.worker) {
      console.info(`a6g: this machine's members of ${entry.name} are paused; the rest of the team isn't (a6g pause on its lead pauses it all)`);
      return 0;
    }
  } else
    try {
      await recordControl(entry, async (store) => pauseControl(await store.tasks.all(), entry.name, { scope, journeys, by: OPERATOR, note }));
    } catch (error) {
      // Stopping must work whatever else doesn't: now is a file on this machine, recorded once the graph is reachable.
      if (scope !== "now") throw error;
      pauseHere(entry, true);
      console.error(
        `a6g: couldn't record the pause in the task graph (${(error as Error).message.split("\n")[0]}): paused on this machine; run a6g pause ${entry.name} again once it's reachable, so the web app and other machines know`
      );
    }
  const hold = readHold(entry.run);
  console.info(
    scope === "now"
      ? `a6g: ${entry.name} paused: the watchdog sends no ticks and starts nothing, and the planner can't start members or merge. Running members finish what they're doing.`
      : `a6g: ${entry.name} is pausing after ${hold ? describeHold(hold) : scope}: that work finishes and merges, nothing else is claimed, and once nothing in it can move the team pauses and you get a report. a6g status ${entry.name} shows what's left.`
  );
  return 0;
}

const BUDGET_USAGE = "usage: a6g budget <team> [--daily <$>] [--weekly <$>] [--total <$>] [--auto-resume | --no-auto-resume] [--restart] [--clear]";

// a6g budget <team>: the team's spending limits, in API-equivalent dollars (lib/budget.ts enforces them: a warning at
// four fifths, a pause after the work under way at the limit, a pause now a tenth past it). With no limit given, what
// they are and what's spent. A limit left out keeps its value and 0 removes it; --restart counts the total from now;
// --auto-resume starts a team the budget paused for a day or week again when the next one starts; --clear removes all.
export async function budget(argv: string[]): Promise<number> {
  operatorOnly("budget");
  const { positional, options } = parseArgs(argv, { booleans: ["auto-resume", "no-auto-resume", "restart", "clear"] });
  const entry = entryFor(positional[0] ?? die(BUDGET_USAGE));
  if (!entry.tasks) die(`${entry.name} keeps its tickets on a GitHub board, which has no budget`);
  // The limits in force are the store's (the web app may have changed them a moment ago, and a worker never applies
  // them); the run folder's copy only when the store can't be reached.
  let current = readLimits(entry.run);
  try {
    const store = await openStore({ name: entry.name, tasks: entry.tasks }, entry.run);
    try {
      current = limitsOf(await store.controls.all());
    } finally {
      await store.close();
    }
  } catch (error) {
    console.error(`a6g: couldn't read the budget from the task graph (${(error as Error).message.split("\n")[0]}); showing this machine's copy`);
  }
  const amount = (key: "daily" | "weekly" | "total"): number | null => {
    const given = options[key];
    if (typeof given !== "string") return current?.[key] ?? null;
    const n = Number(given.replace(/^\$/, ""));
    if (!Number.isFinite(n) || n < 0 || n > 1_000_000) die(`--${key}: dollars, from 0 (none) to 1,000,000`);
    return n === 0 ? null : Math.round(n * 100) / 100;
  };
  const asked = ["daily", "weekly", "total", "auto-resume", "no-auto-resume", "restart", "clear"].some((key) => options[key] !== undefined);
  if (!asked) {
    const spend = readJson<Spend | null>(join(entry.run, "spend.json"), null);
    const money = (n: number | null | undefined) => (n ? `$${n}` : "none");
    console.info(
      current
        ? `${entry.name}'s budget: ${money(current.daily)} a day, ${money(current.weekly)} a week, ${money(current.total)} in all since ${current.since.slice(0, 10)}${current.autoResume ? "; a new day or week resumes a team it paused" : ""}`
        : `${entry.name} has no budget (${BUDGET_USAGE.replace("usage: ", "")})`
    );
    if (spend) console.info(describeSpend(spend, current));
    return 0;
  }
  let limits: Limits | null = null;
  if (!options["clear"]) {
    limits = {
      daily: amount("daily"),
      weekly: amount("weekly"),
      total: amount("total"),
      since: options["restart"] || !current ? nowIso() : current.since,
      autoResume: options["auto-resume"] ? true : options["no-auto-resume"] ? false : (current?.autoResume ?? false),
    };
    if (limits.daily === null && limits.weekly === null && limits.total === null) limits = null;
  }
  await recordControl(entry, async () => budgetControl(entry.name, OPERATOR, limits));
  const money = (n: number | null) => (n ? `$${n}` : "none");
  console.info(
    limits
      ? `a6g: ${entry.name}'s budget is ${money(limits.daily)} a day, ${money(limits.weekly)} a week, ${money(limits.total)} in all since ${limits.since.slice(0, 10)}; the watchdog holds the team to it from its next run`
      : `a6g: ${entry.name} has no budget now`
  );
  return 0;
}

// a6g resume <team> [--note "…"]: work starts again; the note goes to the planner, as the operator's feedback.
export async function resume(argv: string[]): Promise<number> {
  operatorOnly("resume");
  const { positional, options } = parseArgs(argv);
  const entry = entryFor(positional[0] ?? die('usage: a6g resume <team> [--note "…"]'));
  const note = typeof options["note"] === "string" ? options["note"] : "";
  if (!entry.tasks || entry.worker) pauseHere(entry, false);
  else
    try {
      await recordControl(entry, async () => resumeControl(entry.name, OPERATOR, note));
    } catch (error) {
      pauseHere(entry, false);
      rmSync(join(entry.run, "hold.json"), { force: true });
      console.error(
        `a6g: couldn't record the resume in the task graph (${(error as Error).message.split("\n")[0]}): this machine carries on, but claims still see the pause there until a6g resume ${entry.name} reaches it`
      );
      return 1;
    }
  console.info(`a6g: ${entry.name} resumed${note && entry.tasks ? "; the planner has your note" : ""}`);
  return 0;
}

// A fresh planner thread: after register changed the instances (a running thread keeps its old flags), or to
// clear a long context. Refused while the planner has members running (they report to it), while it's in the
// middle of a turn, and whenever T3 Code can't say which. The old one is retired inside the watchdog's lock for the
// team, so a watchdog run can't start or adopt a planner halfway through.
export async function rotate(argv: string[]): Promise<number> {
  operatorOnly("rotate");
  const entry = entryFor(argv[0] ?? die("usage: a6g rotate <team>"));
  const file = join(entry.run, "planner-thread");
  let old = "";
  const refused = await watchOnce(entry.name, () => {
    old = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
    if (!old) return null;
    const busy = t3.runningChildren(old);
    if (busy === null) return "T3 Code's database couldn't be read, so it isn't known whether the planner's members are running; try again";
    if (busy) return `the planner has ${busy} members running; they report to it, so rotate once they've finished`;
    const thread = t3.threadShow(old);
    if (!thread && t3.threadExists(old) !== false) return `T3 Code couldn't say what planner ${old} is doing; try again`;
    if (thread && !thread.archived && BUSY.includes(thread.status ?? ""))
      return `the planner is in the middle of a turn (${thread.status}); rotate once it's idle`;
    // Waiting on a person: an answer would resume the old planner beside the new one.
    if (thread && !thread.archived && (thread.status === "waiting" || (thread.pendingRequestCount ?? 0) > 0))
      return "the planner is waiting for an answer in T3 Code; answer it (or dismiss the request), then rotate";
    writeFileSync(join(entry.run, "planner-thread.retired"), `${old}\n`, { flag: "a" });
    rmSync(file);
    return null;
  });
  if (refused) die(`rotate: ${refused}`);
  const now = existsSync(file) ? readFileSync(file, "utf8").trim() : "not started (see the watchdog log)";
  console.info(`a6g: ${entry.name}'s planner was ${old || "none"}, now ${now}`);
  return 0;
}

// Where each team stands: paused or active, its planner and the members running, whether its environment answers
// (team.json's health URLs) and what's drained, the worktrees kept for their work, and the watchdog's last lines.
export async function status(argv: string[]): Promise<number> {
  const names = argv.length ? argv : teamNames();
  if (!names.length) console.info("no teams registered yet: a6g init sets one up");
  for (const name of names) {
    const entry = entryFor(name);
    const planner = existsSync(join(entry.run, "planner-thread")) ? readFileSync(join(entry.run, "planner-thread"), "utf8").trim() : null;
    const thread = planner ? t3.threadShow(planner) : null;
    const hold = readHold(entry.run);
    const pausing = hold !== null && !hold.settledAt && hold.scope !== "now";
    const flags = [
      existsSync(join(entry.run, "paused")) ? "paused" : pausing ? "pausing" : null,
      existsSync(join(entry.run, "complete")) ? "complete" : null,
    ].filter((flag) => flag !== null);
    console.info(`== ${name} (${entry.title}) ${flags.length ? flags.join(", ") : "active"} · factory ${entry.version} · ${entry.home}`);
    console.info(`   planner ${planner ?? "none"}${thread ? ` (${thread.status})` : ""}`);
    const counts = planner ? t3.childCounts(planner) : [];
    console.info(
      `   members running: ${counts.length ? counts.map((row) => `${row.instance.replace(`a6g-${name}-`, "")} ${row.n}`).join(", ") : planner ? "none" : "-"}`
    );
    const health = entry.health ?? [];
    if (health.length) {
      const up = await Promise.all(health.map((target) => answers(target)));
      const state = up.every(Boolean) ? "up" : up.some(Boolean) ? "partly up" : "down";
      console.info(
        `   environment: ${state} (${health.map((target, i) => `${target.replace(/^any:/, "")} ${up[i] ? "answers" : "doesn't answer"}`).join(", ")})`
      );
    } else console.info("   environment: no health URLs in team.json, so not checked");
    if (hold && pausing)
      console.info(
        `   pausing after ${describeHold(hold)} (asked ${hold.since.slice(0, 16)}): left ${hold.left.join("; ") || "nothing, so it pauses at the watchdog's next run"}${hold.stuck.length ? `; stopped: ${hold.stuck.join("; ")}` : ""}`
      );
    else if (hold?.settledAt && hold.scope !== "now")
      console.info(`   paused after ${describeHold(hold)} at ${hold.settledAt.slice(0, 16)}: a6g resume ${name} carries on`);
    const spend = readJson<Spend | null>(join(entry.run, "spend.json"), null);
    if (spend) console.info(`   ${describeSpend(spend, readLimits(entry.run))}`);
    const drain = join(entry.home, ".a6g", "run", "state", "drain");
    if (existsSync(drain)) console.info(`   draining: ${readFileSync(drain, "utf8").trim()} (a6g drain off, from the team's checkout)`);
    const kept = keptWorktrees(entry.run);
    if (kept.length)
      console.info(
        `   kept ${kept.length} finished worktrees that may hold work (nothing deletes them; look, then git worktree remove): ${kept.join("; ")}`
      );
    const log = join(entry.run, "watchdog.log");
    if (existsSync(log)) for (const line of readFileSync(log, "utf8").trim().split("\n").slice(-3)) console.info(`   ${line}`);
  }
  return 0;
}

// Every registered team on a line: its version, whether it runs, and its checkout (a6g status says more).
export function teams(): number {
  for (const name of teamNames()) {
    const entry = readRegistry(name);
    if (!entry) continue;
    const hold = readHold(entry.run);
    const state = existsSync(join(entry.run, "paused"))
      ? "paused"
      : hold && !hold.settledAt && hold.scope !== "now"
        ? "pausing"
        : existsSync(join(entry.run, "complete"))
          ? "complete"
          : "active";
    console.info(`${name.padEnd(20)} ${String(entry.version).padEnd(8)} ${state.padEnd(9)} ${entry.home}`);
  }
  return 0;
}

// a6g prompt <team|checkout> <role>: the text the role works under, compiled now.
export function prompt(argv: string[]): number {
  const [target, role] = argv;
  const home = (target ? readRegistry(target)?.home : undefined) ?? homeFrom(target);
  const team = loadTeam(home);
  if (!role || !team.roles[role]) die(`usage: a6g prompt <team> <role> (${Object.keys(team.roles).join(", ")})`);
  process.stdout.write(compile(team, role));
  const entry = readRegistry(team.name);
  if (entry) console.error(`\n(the registered copy is ${promptFile(entry.run, role)})`);
  return 0;
}

// team.json with its pin set to version, changing only that line (or adding one after "name"), so the commit is one
// line and the operator's formatting stays; a file that doesn't allow that is written out whole.
export function pinned(text: string, version: string): string {
  const pin = `"factory": ${JSON.stringify(version)}`;
  const edited = /"factory"\s*:\s*"[^"\n]*"/.test(text)
    ? text.replace(/"factory"\s*:\s*"[^"\n]*"/, pin)
    : text.replace(/^([ \t]*)"name"\s*:\s*"[^"\n]*",[ \t]*\n/m, (line, indent: string) => `${line}${indent}${pin},\n`);
  const wanted = { ...(JSON.parse(text) as RawTeam), factory: version };
  // Only when the edit changed nothing else (a "factory" inside vars, before the top-level one, mustn't be it).
  try {
    if (isDeepStrictEqual(JSON.parse(edited), wanted)) return edited;
  } catch {}
  return `${JSON.stringify(wanted, null, 2)}\n`;
}

// a6g upgrade <team> [version] [--force]: register the team again on an installed version (this one by default),
// then move its pin there. It runs in the version it moves to, whose code compiles the prompts and writes the
// instances; the pin moves only once that worked.
export async function upgrade(argv: string[]): Promise<number> {
  operatorOnly("upgrade");
  const { positional, options } = parseArgs(argv, { booleans: ["force"] });
  const entry = entryFor(positional[0] ?? die("usage: a6g upgrade <team> [version] [--force]"));
  const version = positional[1] ?? PACKAGE.version;
  if (!existsSync(versionDir(version))) die(`Anything Factory ${version} isn't installed (a6g versions lists them)`);
  const force = Boolean(options["force"]);
  if (realpathSync(versionDir(version)) !== realpathSync(FACTORY_ROOT)) {
    if (process.env.A6G_UPGRADING === version)
      die(`Anything Factory ${version} at ${versionDir(version)} handed the upgrade back; run it from that version`);
    const result = spawnSync(process.execPath, [entryOf(versionDir(version)), "upgrade", entry.name, version, ...(force ? ["--force"] : [])], {
      stdio: "inherit",
      env: { ...process.env, A6G_HANDED_OVER: "1", A6G_UPGRADING: version },
    });
    return result.status ?? 1;
  }
  registerTeam(entry.home, { force, version, worker: Boolean(entry.worker) });
  await publishTeam(entry.home);
  const file = teamFile(entry.home);
  writeFileSync(file, pinned(readFileSync(file, "utf8"), version));
  // The prompts' sources include team.json, so compile them again with the pin in it.
  const team = loadTeam(entry.home);
  for (const role of Object.keys(team.roles)) writePrompt(team, role, entry.run);
  console.info(`a6g: ${entry.name} now pins Anything Factory ${version}. Commit .a6g/team.json on the integration branch.`);
  return 0;
}
