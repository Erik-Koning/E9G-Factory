#!/usr/bin/env node
// e9g: E9G Factory's command line. `e9g help` lists the commands; README.md explains them.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { FACTORY_ROOT, findHome, PACKAGE, readRegistry, teamFile, versionDir } from "../lib/paths.mjs";

const HELP = `E9G Factory ${PACKAGE.version}: provision a software engineering team in any repository, on T3 Code.

Set up and run a team (the operator)
  e9g doctor                          is this machine ready? (tools, T3 Code's version and contract, watchdog)
  e9g init [<repo>] [options]         detect, make the team's checkout and .e9g/, and interview you to finish it
                                      --name --branch --base --checkout <dir> | --in-place --owner --no-interview
  e9g check [<checkout>] [--run]      prove the setup: rules, adapters, a guard self-test, prompts; --run also
                                      starts the environment and runs the gate
  e9g register [<checkout>]           T3 project, one instance per role, compiled prompts, the registry (alias: sync)
  e9g start <team>                    resume it and run the watchdog now (it starts the planner)
  e9g pause | resume <team>           stop or restart the watchdog's ticks for one team
  e9g rotate <team>                   a fresh planner thread (refused while members run)
  e9g status [<team>]  ·  e9g teams   planner, members, the watchdog's last lines  ·  every team
  e9g metrics [--team <t>] [--since]  agents, runs, requests, tokens and time per role
  e9g prompt <team> <role>            the text a role works under
  e9g upgrade <team> [<version>]      move a team to another installed factory version
  e9g unregister <team>               remove its T3 instances and registry entry (keeps its files)
  e9g watchdog install|remove|run     the one launchd job that looks after every team
  e9g self-install [--link] [--force] install this checkout's version into ~/.e9g  ·  e9g versions

Team members (the guard decides who may run which)
  e9g merge <branch> --queue [--closes N…] [--rebased-from <sha>] [--light]   the only way into the integration branch
  e9g verdict review <branch> approve|changes --note "…"   ·   e9g verdict ux <subject> pass|issues --note "…"
  e9g log [--label …] "<entry>"   e9g lock <name> [--slots N] [--wait-min M] -- <cmd>   e9g drain <role…>|off
  e9g gate [--quick]   e9g env up|down|restart|reset|status   e9g finish   e9g progress
  e9g pages run|shots|status|done
`;

const [command = "help", ...args] = process.argv.slice(2);

// A team pinned to another installed version runs that version's commands, so a person's `e9g` and an agent's
// behave the same. Agents already arrive on the right version (their instance sets E9G_VERSION).
function handOver() {
  if (
    process.env.E9G_HANDED_OVER ||
    ["help", "--help", "-h", "self-install", "versions", "doctor", "watchdog", "teams", "init", "--version"].includes(command)
  )
    return;
  let home = null;
  const named = args.find((arg) => !arg.startsWith("-"));
  if (named && readRegistry(named)) home = readRegistry(named).home;
  else if (["register", "sync", "check"].includes(command) && named && existsSync(teamFile(resolve(named)))) home = resolve(named);
  else home = findHome();
  if (!home || !existsSync(teamFile(home))) return;
  let pin;
  try {
    pin = JSON.parse(readFileSync(teamFile(home), "utf8")).factory;
  } catch {
    return;
  }
  if (!pin || pin === PACKAGE.version || !existsSync(versionDir(pin)) || realpathSync(versionDir(pin)) === realpathSync(FACTORY_ROOT)) return;
  const result = spawnSync(process.execPath, [join(versionDir(pin), "bin", "e9g.mjs"), command, ...args], {
    stdio: "inherit",
    env: { ...process.env, E9G_HANDED_OVER: "1" },
  });
  process.exit(result.status ?? 1);
}

const COMMANDS = {
  doctor: () => import("../lib/commands/doctor.mjs").then((m) => m.doctor(args)),
  init: () => import("../lib/commands/init.mjs").then((m) => m.init(args)),
  check: () => import("../lib/commands/check.mjs").then((m) => m.check(args)),
  register: () => import("../lib/commands/team.mjs").then((m) => m.register(args)),
  sync: () => import("../lib/commands/team.mjs").then((m) => m.register(args)),
  unregister: () => import("../lib/commands/team.mjs").then((m) => m.unregister(args)),
  start: () => import("../lib/commands/team.mjs").then((m) => m.start(args)),
  pause: () => import("../lib/commands/team.mjs").then((m) => m.pause(args)),
  resume: () => import("../lib/commands/team.mjs").then((m) => m.resume(args)),
  rotate: () => import("../lib/commands/team.mjs").then((m) => m.rotate(args)),
  status: () => import("../lib/commands/team.mjs").then((m) => m.status(args)),
  teams: () => import("../lib/commands/team.mjs").then((m) => m.teams(args)),
  prompt: () => import("../lib/commands/team.mjs").then((m) => m.prompt(args)),
  upgrade: () => import("../lib/commands/team.mjs").then((m) => m.upgrade(args)),
  metrics: () => import("../lib/commands/metrics.mjs").then((m) => m.run(args)),
  watchdog: () => import("../lib/commands/watchdog.mjs").then((m) => m.watchdog(args)),
  "self-install": () => import("../lib/commands/install.mjs").then((m) => m.selfInstall(args)),
  versions: () => import("../lib/commands/install.mjs").then((m) => m.versions(args)),
  merge: () => import("../lib/commands/merge.mjs").then((m) => m.run(args)),
  verdict: () => import("../lib/commands/tools.mjs").then((m) => m.verdict(args)),
  log: () => import("../lib/commands/tools.mjs").then((m) => m.log(args)),
  lock: () => import("../lib/commands/tools.mjs").then((m) => m.lock(args)),
  gate: () => import("../lib/commands/tools.mjs").then((m) => m.gate(args)),
  env: () => import("../lib/commands/tools.mjs").then((m) => m.env(args)),
  finish: () => import("../lib/commands/tools.mjs").then((m) => m.finish(args)),
  progress: () => import("../lib/commands/tools.mjs").then((m) => m.progress(args)),
  drain: () => import("../lib/commands/tools.mjs").then((m) => m.drain(args)),
  pages: () => import("../lib/commands/pages.mjs").then((m) => m.run(args)),
};

if (["help", "--help", "-h"].includes(command)) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (command === "--version") {
  console.info(PACKAGE.version);
  process.exit(0);
}
if (!COMMANDS[command]) {
  console.error(`e9g: no command ${command}\n`);
  process.stdout.write(HELP);
  process.exit(2);
}
handOver();
try {
  const code = await COMMANDS[command]();
  process.exitCode = typeof code === "number" ? code : 0;
} catch (error) {
  console.error(`e9g ${command}: ${error.message}`);
  process.exitCode = error.problems ? 2 : 1;
}
