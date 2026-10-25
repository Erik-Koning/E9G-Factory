// The operator's commands for a team's life: register (alias sync), unregister, start, pause, resume, rotate,
// status, teams, prompt and upgrade.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { instanceId, loadTeam, type RawTeam, type Team } from "../config.ts";
import {
  defaultRunDir,
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
import { compile, promptFile, writePrompt } from "../prompts.ts";
import * as t3 from "../t3.ts";
import { die, parseArgs, writeJson } from "../util.ts";
import { BUSY, ensureWatchdog, watchOnce } from "./watchdog.ts";

const quote = (text: string): string => (/[\s"']/.test(text) ? `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"` : text);

function homeFrom(arg: string | undefined): string {
  const home = arg ? realpathSync(resolve(arg)) : findHome();
  if (!home) die("run this in a team's checkout, or name it: e9g register <checkout>");
  return home;
}

// The factory version a team runs: its team.json pin ("dev" is the linked source checkout), else this one.
export function versionFor(team: Team): string {
  const version = team.factory ?? PACKAGE.version;
  if (!existsSync(versionDir(version)))
    die(
      `the team pins E9G Factory ${version}, which isn't installed (${versionDir(version)}); run e9g self-install${version === "dev" ? " --link" : ""} from that version's checkout`
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
  return { ...vars, E9G_TEAM: team.name, E9G_ROLE: role, E9G_HOME_DIR: home, E9G_RUN: run, E9G_VERSION: version };
}

export function register(argv: string[]): number {
  const { positional, options } = parseArgs(argv, { booleans: ["force"] });
  return registerTeam(homeFrom(positional[0]), { force: Boolean(options["force"]) });
}

// Registers the team in `home` to run `version` (else the one its team.json pins). Dies before changing anything
// when it can't.
function registerTeam(home: string, { force, version: target }: { force: boolean; version?: string }): number {
  const team = loadTeam(home);
  for (const warning of team.warnings) console.warn(`  note: ${warning}`);
  // Register doesn't write team.json (a change there would hold up every merge until it's committed).
  if (!team.factory && !target)
    console.warn(`  note: team.json pins no factory version, so the team runs whichever version registers it (e9g upgrade ${team.name} pins one)`);
  const problems = t3.contract();
  if (problems.length && !force) die(`T3 Code isn't ready:\n  - ${problems.join("\n  - ")}\n(e9g doctor explains; --force registers anyway)`);
  if (!existsSync(join(home, ".e9g", ".gitignore")))
    console.warn("  note: .e9g/.gitignore is missing; add one with run/ so the team's runtime stays out of git");

  const version = target ?? versionFor(team);
  const previous = readRegistry(team.name);
  if (previous && previous.home !== home)
    die(`a team named ${team.name} is already registered at ${previous.home}; pick another name or e9g unregister ${team.name}`);
  // One team per checkout: a renamed team would otherwise run beside the old one on the same files.
  const other = teamNames().find((name) => name !== team.name && readRegistry(name)?.home === home);
  if (other) die(`${home} is already registered as the team ${other}; e9g unregister ${other} first, or keep the name ${other}`);
  const run = previous?.run ?? defaultRunDir(team.name);
  mkdirSync(run, { recursive: true });
  const project = previous?.project ?? team.raw.t3ProjectId ?? t3.projectAdd(team.title, home);
  if (!project) die(`couldn't add ${home} as a T3 Code project; add it in T3 Code and put its id in team.json t3ProjectId`);

  const instances: Record<string, t3.ProviderInstance> = {};
  for (const role of Object.keys(team.roles)) {
    const prompt = writePrompt(team, role, run);
    const flags = [
      `--agent e9g:${role}`,
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
    startPrompt:
      team.startPrompt ??
      'Start the team, or pick it up where your log leaves off: read the documents your rules list, then work through "Each time you wake".',
    registeredAt: new Date().toISOString(),
  };
  writeJson(registryFile(team.name), entry);
  console.info(`e9g: registered ${team.name} (E9G Factory ${version}; T3 project ${project}; run folder ${run})`);
  console.info(
    `  roles: ${Object.keys(team.roles)
      .map((role) => `${role} (${instanceId(team, role)})`)
      .join(", ")}`
  );
  if (existsSync(join(run, "planner-thread")))
    console.info(`  a planner is running; it keeps the flags it started with until e9g rotate ${team.name} (members started from now get the new ones)`);
  else console.info(`  start it: e9g start ${team.name}`);
  return 0;
}

export function unregister(argv: string[]): number {
  const name = argv[0] ?? die("usage: e9g unregister <team>");
  const entry = readRegistry(name) ?? die(`no team named ${name}`);
  const removed = t3.removeInstances(name);
  rmSync(registryFile(name), { force: true });
  console.info(`e9g: unregistered ${name} (${removed} T3 instances removed; its run folder ${entry.run} and checkout are kept)`);
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
  const entry = entryFor(argv[0] ?? die("usage: e9g start <team>"));
  rmSync(join(entry.run, "paused"), { force: true });
  ensureWatchdog();
  await watchOnce(entry.name);
  return status([entry.name]);
}

export function pause(argv: string[]): number {
  const entry = entryFor(argv[0] ?? die("usage: e9g pause <team>"));
  mkdirSync(entry.run, { recursive: true });
  writeFileSync(join(entry.run, "paused"), new Date().toISOString());
  console.info(
    `e9g: ${entry.name} paused: the watchdog sends no ticks and starts nothing, and the planner can't start members or merge. Running members finish what they're doing.`
  );
  return 0;
}

export function resume(argv: string[]): number {
  const entry = entryFor(argv[0] ?? die("usage: e9g resume <team>"));
  rmSync(join(entry.run, "paused"), { force: true });
  console.info(`e9g: ${entry.name} resumed`);
  return 0;
}

// A fresh planner thread: after register changed the instances (a running thread keeps its old flags), or to
// clear a long context. Refused while the planner has members running (they report to it), while it's in the
// middle of a turn, and whenever T3 Code can't say which. The old one is retired inside the watchdog's lock for the
// team, so a watchdog run can't start or adopt a planner halfway through.
export async function rotate(argv: string[]): Promise<number> {
  const entry = entryFor(argv[0] ?? die("usage: e9g rotate <team>"));
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
    writeFileSync(join(entry.run, "planner-thread.retired"), `${old}\n`, { flag: "a" });
    rmSync(file);
    return null;
  });
  if (refused) die(`rotate: ${refused}`);
  const now = existsSync(file) ? readFileSync(file, "utf8").trim() : "not started (see the watchdog log)";
  console.info(`e9g: ${entry.name}'s planner was ${old || "none"}, now ${now}`);
  return 0;
}

export function status(argv: string[]): number {
  const names = argv.length ? argv : teamNames();
  if (!names.length) console.info("no teams registered yet: e9g init sets one up");
  for (const name of names) {
    const entry = entryFor(name);
    const planner = existsSync(join(entry.run, "planner-thread")) ? readFileSync(join(entry.run, "planner-thread"), "utf8").trim() : null;
    const thread = planner ? t3.threadShow(planner) : null;
    const flags = [existsSync(join(entry.run, "paused")) ? "paused" : null, existsSync(join(entry.run, "complete")) ? "complete" : null].filter(
      (flag) => flag !== null
    );
    console.info(`== ${name} (${entry.title}) ${flags.length ? flags.join(", ") : "active"} · factory ${entry.version} · ${entry.home}`);
    console.info(`   planner ${planner ?? "none"}${thread ? ` (${thread.status})` : ""}`);
    const counts = planner ? t3.childCounts(planner) : [];
    if (counts.length) console.info(`   members running: ${counts.map((row) => `${row.instance.replace(`e9g-${name}-`, "")} ${row.n}`).join(", ")}`);
    const log = join(entry.run, "watchdog.log");
    if (existsSync(log)) for (const line of readFileSync(log, "utf8").trim().split("\n").slice(-3)) console.info(`   ${line}`);
  }
  return 0;
}

export function teams(): number {
  for (const name of teamNames()) {
    const entry = readRegistry(name);
    if (entry) console.info(`${name.padEnd(20)} ${String(entry.version).padEnd(8)} ${entry.home}`);
  }
  return 0;
}

// e9g prompt <team|checkout> <role>: the text the role works under, compiled now.
export function prompt(argv: string[]): number {
  const [target, role] = argv;
  const home = (target ? readRegistry(target)?.home : undefined) ?? homeFrom(target);
  const team = loadTeam(home);
  if (!role || !team.roles[role]) die(`usage: e9g prompt <team> <role> (${Object.keys(team.roles).join(", ")})`);
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
  try {
    if ((JSON.parse(edited) as RawTeam).factory === version) return edited;
  } catch {}
  return `${JSON.stringify({ ...(JSON.parse(text) as RawTeam), factory: version }, null, 2)}\n`;
}

// e9g upgrade <team> [version] [--force]: register the team again on an installed version (this one by default),
// then move its pin there. It runs in the version it moves to, whose code compiles the prompts and writes the
// instances; the pin moves only once that worked.
export function upgrade(argv: string[]): number {
  const { positional, options } = parseArgs(argv, { booleans: ["force"] });
  const entry = entryFor(positional[0] ?? die("usage: e9g upgrade <team> [version] [--force]"));
  const version = positional[1] ?? PACKAGE.version;
  if (!existsSync(versionDir(version))) die(`E9G Factory ${version} isn't installed (e9g versions lists them)`);
  const force = Boolean(options["force"]);
  if (realpathSync(versionDir(version)) !== realpathSync(FACTORY_ROOT)) {
    if (process.env.E9G_UPGRADING === version) die(`E9G Factory ${version} at ${versionDir(version)} handed the upgrade back; run it from that version`);
    const result = spawnSync(process.execPath, [entryOf(versionDir(version)), "upgrade", entry.name, version, ...(force ? ["--force"] : [])], {
      stdio: "inherit",
      env: { ...process.env, E9G_HANDED_OVER: "1", E9G_UPGRADING: version },
    });
    return result.status ?? 1;
  }
  registerTeam(entry.home, { force, version });
  const file = teamFile(entry.home);
  writeFileSync(file, pinned(readFileSync(file, "utf8"), version));
  // The prompts' sources include team.json, so compile them again with the pin in it.
  const team = loadTeam(entry.home);
  for (const role of Object.keys(team.roles)) writePrompt(team, role, entry.run);
  console.info(`e9g: ${entry.name} now pins E9G Factory ${version}. Commit .e9g/team.json on the integration branch.`);
  return 0;
}
