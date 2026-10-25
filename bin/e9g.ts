#!/usr/bin/env node
// e9g: E9G Factory's command line. `e9g help` lists the commands; README.md explains them.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { entryOf, FACTORY_ROOT, findHome, PACKAGE, readRegistry, teamFile, VERSION_NAME, versionDir, versionsDir } from "../lib/paths.ts";

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
  e9g upgrade <team> [<version>] [--force]   move a team to another installed factory version
  e9g unregister <team>               remove its T3 instances and registry entry (keeps its files)
  e9g watchdog install|remove|run     the one launchd job that looks after every team
  e9g connect [email|whatsapp] [--test]  send you the watchdog's alerts and the planner's outbox: email through
                                      Resend (replies reach the planner), WhatsApp through your business number
                                      ·  e9g disconnect email|whatsapp
  e9g self-install [--link] [--force] install this checkout's version into ~/.e9g  ·  e9g versions

Team members (the guard decides who may run which)
  e9g merge <branch> --queue [--closes N…] [--rebased-from <sha>] [--light]   the only way into the integration branch
  e9g verdict review <branch> approve|changes --sha <commit> --note "…"   ·   e9g verdict ux <subject> pass|issues --ref <commit> --note "…"
  e9g log [--label …] "<entry>"   e9g lock <name> [--slots N] [--wait-min M] -- <cmd>   e9g drain <role…>|off
  e9g gate [--quick]   e9g env up|down|restart|reset|status   e9g finish   e9g progress
  e9g pages run|shots|status|done
`;

const [command = "help", ...args] = process.argv.slice(2);

// A team pinned to another installed version runs that version's commands, so a person's `e9g` and an agent's
// behave the same. Agents already arrive on the right version (their instance sets E9G_VERSION). A source checkout
// (node bin/e9g.ts, anywhere outside ~/.e9g/versions) never hands over: it runs its own code, whatever the team pins.
const installed = (): boolean => {
  if (!existsSync(versionsDir)) return false;
  const root = realpathSync(FACTORY_ROOT);
  const versions = realpathSync(versionsDir);
  return root.startsWith(`${versions}${sep}`);
};
function handOver(): void {
  if (!installed()) return;
  if (
    process.env.E9G_HANDED_OVER ||
    ["help", "--help", "-h", "self-install", "versions", "doctor", "watchdog", "teams", "init", "upgrade", "connect", "disconnect", "--version"].includes(
      command
    )
  )
    return;
  let home: string | null = null;
  const named = args.find((arg) => !arg.startsWith("-"));
  const entry = named ? readRegistry(named) : null;
  if (entry) home = entry.home;
  else if (["register", "sync", "check"].includes(command) && named && existsSync(teamFile(resolve(named)))) home = resolve(named);
  else home = findHome();
  if (!home || !existsSync(teamFile(home))) return;
  let pin: string | undefined;
  try {
    pin = (JSON.parse(readFileSync(teamFile(home), "utf8")) as { factory?: string }).factory;
  } catch {
    return;
  }
  if (!pin || !VERSION_NAME.test(pin)) return;
  if (pin === PACKAGE.version || !existsSync(versionDir(pin)) || realpathSync(versionDir(pin)) === realpathSync(FACTORY_ROOT)) return;
  const result = spawnSync(process.execPath, [entryOf(versionDir(pin)), command, ...args], {
    stdio: "inherit",
    env: { ...process.env, E9G_HANDED_OVER: "1" },
  });
  process.exit(result.status ?? 1);
}

// Each command resolves to its exit code (or nothing, for 0).
const COMMANDS: Record<string, () => Promise<number | void>> = {
  doctor: () => import("../lib/commands/doctor.ts").then((m) => m.doctor()),
  init: () => import("../lib/commands/init.ts").then((m) => m.init(args)),
  check: () => import("../lib/commands/check.ts").then((m) => m.check(args)),
  register: () => import("../lib/commands/team.ts").then((m) => m.register(args)),
  sync: () => import("../lib/commands/team.ts").then((m) => m.register(args)),
  unregister: () => import("../lib/commands/team.ts").then((m) => m.unregister(args)),
  start: () => import("../lib/commands/team.ts").then((m) => m.start(args)),
  pause: () => import("../lib/commands/team.ts").then((m) => m.pause(args)),
  resume: () => import("../lib/commands/team.ts").then((m) => m.resume(args)),
  rotate: () => import("../lib/commands/team.ts").then((m) => m.rotate(args)),
  status: () => import("../lib/commands/team.ts").then((m) => m.status(args)),
  teams: () => import("../lib/commands/team.ts").then((m) => m.teams()),
  prompt: () => import("../lib/commands/team.ts").then((m) => m.prompt(args)),
  upgrade: () => import("../lib/commands/team.ts").then((m) => m.upgrade(args)),
  metrics: () => import("../lib/commands/metrics.ts").then((m) => m.run(args)),
  watchdog: () => import("../lib/commands/watchdog.ts").then((m) => m.watchdog(args)),
  connect: () => import("../lib/commands/connect.ts").then((m) => m.connect(args)),
  disconnect: () => import("../lib/commands/connect.ts").then((m) => m.disconnect(args)),
  "self-install": () => import("../lib/commands/install.ts").then((m) => m.selfInstall(args)),
  versions: () => import("../lib/commands/install.ts").then((m) => m.versions()),
  merge: () => import("../lib/commands/merge.ts").then((m) => m.run(args)),
  verdict: () => import("../lib/commands/tools.ts").then((m) => m.verdict(args)),
  log: () => import("../lib/commands/tools.ts").then((m) => m.log(args)),
  lock: () => import("../lib/commands/tools.ts").then((m) => m.lock(args)),
  gate: () => import("../lib/commands/tools.ts").then((m) => m.gate(args)),
  env: () => import("../lib/commands/tools.ts").then((m) => m.env(args)),
  finish: () => import("../lib/commands/tools.ts").then((m) => m.finish()),
  progress: () => import("../lib/commands/tools.ts").then((m) => m.progress()),
  drain: () => import("../lib/commands/tools.ts").then((m) => m.drain(args)),
  pages: () => import("../lib/commands/pages.ts").then((m) => m.run(args)),
};

if (["help", "--help", "-h"].includes(command)) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (command === "--version") {
  console.info(PACKAGE.version);
  process.exit(0);
}
const run = COMMANDS[command];
if (!run) {
  console.error(`e9g: no command ${command}\n`);
  process.stdout.write(HELP);
  process.exit(2);
}
handOver();
try {
  const code = await run();
  process.exitCode = typeof code === "number" ? code : 0;
} catch (error) {
  console.error(`e9g ${command}: ${(error as Error).message}`);
  process.exitCode = (error as { problems?: unknown }).problems ? 2 : 1;
}
