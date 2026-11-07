#!/usr/bin/env node
// a6g: Anything Factory's command line. `a6g help` lists the commands; README.md explains them.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { entryOf, FACTORY_ROOT, findHome, PACKAGE, readRegistry, teamFile, VERSION_NAME, versionDir, versionsDir } from "../lib/paths.ts";

const HELP = `Anything Factory ${PACKAGE.version}: provision a software engineering team in any repository, on T3 Code.

Set up and run a team (the operator)
  a6g doctor                          is this machine ready? (tools, T3 Code's version and contract, watchdog)
  a6g init [<repo>] [options]         detect, make the team's checkout and .a6g/, and interview you to finish it
                                      --name --branch --base --checkout <dir> | --in-place --owner --no-interview
  a6g check [<checkout>] [--run]      prove the setup: rules, adapters, a guard self-test, prompts; --run also
                                      starts the environment and runs the gate
  a6g register [<checkout>] [--worker]   T3 project, one instance per role, compiled prompts, the registry (alias: sync);
                                      --worker on a machine other than a Mongo team's lead: builders and testers only
  a6g start <team>                    run the watchdog now (it starts the planner); a paused team stays paused
  a6g pause <team> [--after tasks | --after journeys [--journeys 3,7]] [--note "…"]
                                      stop a team now, or once the work (or journeys) under way is merged
  a6g resume <team> [--note "…"]      start it again; the note goes to the planner
  a6g budget <team> [--daily <$>] [--weekly <$>] [--total <$>] [--auto-resume] [--restart] [--clear]
                                      its spending limits (API-equivalent $): warned at 80%, paused at 100%
  a6g rotate <team>                   a fresh planner thread (refused while members run)
  a6g status [<team>]  ·  a6g teams   planner, members, environment, drain, the watchdog's last lines  ·  every team
  a6g metrics [--team <t>] [--since]  agents, runs, requests, tokens and time per role
  a6g prompt <team> <role>            the text a role works under
  a6g upgrade <team> [<version>] [--force]   move a team to another installed factory version
  a6g unregister <team>               remove its T3 instances and registry entry (keeps its files)
  a6g watchdog install|remove|run     the one launchd job that looks after every team
  a6g connect [email|whatsapp] [--test]  send you the watchdog's alerts and the planner's outbox: email through
                                      Resend (replies reach the planner), WhatsApp through your business number
  a6g connect heartbeat <url> [--test]  ping an outside check every watchdog run, so it tells you when this Mac stops
  a6g connect mongo [--machine <name>]  this machine's connection to a team's shared task graph (the string on stdin)
                                      ·  a6g disconnect email|whatsapp|heartbeat
  a6g self-install [--link] [--force] install this checkout's version into ~/.a6g  ·  a6g versions

Team members (the guard decides who may run which)
  a6g merge <branch> --queue [--closes N…] [--rebased-from <sha>] [--light]   the only way into the integration branch
  a6g verdict review <branch> approve|changes --sha <commit> --note "…"   ·   a6g verdict ux <subject> pass|issues --ref <commit> --note "…"
  a6g log [--label …] "<entry>"   a6g lock <name> [--slots N] [--wait-min M] -- <cmd>   a6g drain <role…>|off
  a6g gate [--quick]   a6g env up|down|restart|reset|status   a6g finish   a6g progress
  a6g pages run|shots|status|done
  a6g pr --title "…" --body-file <file>   the planner's pull request into the branch you promote (push.pullRequest)

The task graph (a6g task help lists every form)
  a6g task add|list|show|note|graph   anyone on the team: findings go to triage, the planner's work is proposed
  a6g task edit|score|status|import   the planner: shape, score (the gate and the matrix) and move tasks
  a6g task approve|reject|research|escalate <id>   the approver (or you), within team.json approval
  a6g task claim [<id>]  ·  release <id>  ·  submit <id>   builders and testers take the next task, and hand it in
  a6g request add|list|show|note|reject   stakeholders' feature requests (you add them; the planner promotes them)
  a6g cycle close --report-file <f> | list   a cycles team's cycles (team.json mode "cycles")
  a6g blast [<ref>] [--base <branch>] [--json]   what a change touches: importers, related files, tests, UI, critical paths
  a6g serve [--port 4600] [--host …]   your page for a team: the request form, proposals to approve, the board and graph
`;

const [command = "help", ...args] = process.argv.slice(2);

// A team pinned to another installed version runs that version's commands, so a person's `a6g` and an agent's
// behave the same. Agents already arrive on the right version (their instance sets A6G_VERSION). A source checkout
// (node bin/a6g.ts, anywhere outside ~/.a6g/versions) never hands over: it runs its own code, whatever the team pins.
const installed = (): boolean => {
  if (!existsSync(versionsDir)) return false;
  const root = realpathSync(FACTORY_ROOT);
  const versions = realpathSync(versionsDir);
  return root.startsWith(`${versions}${sep}`);
};
function handOver(): void {
  if (!installed()) return;
  if (
    process.env.A6G_HANDED_OVER ||
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
    env: { ...process.env, A6G_HANDED_OVER: "1" },
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
  budget: () => import("../lib/commands/team.ts").then((m) => m.budget(args)),
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
  pr: () => import("../lib/commands/pr.ts").then((m) => m.pr(args)),
  task: () => import("../lib/commands/task.ts").then((m) => m.task(args)),
  request: () => import("../lib/commands/request.ts").then((m) => m.request(args)),
  cycle: () => import("../lib/commands/cycle.ts").then((m) => m.cycle(args)),
  blast: () => import("../lib/commands/blast.ts").then((m) => m.blast(args)),
  serve: () => import("../lib/commands/serve.ts").then((m) => m.serve(args)),
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
  console.error(`a6g: no command ${command}\n`);
  process.stdout.write(HELP);
  process.exit(2);
}
handOver();
try {
  const code = await run();
  process.exitCode = typeof code === "number" ? code : 0;
} catch (error) {
  console.error(`a6g ${command}: ${(error as Error).message}`);
  process.exitCode = (error as { problems?: unknown }).problems ? 2 : 1;
}
