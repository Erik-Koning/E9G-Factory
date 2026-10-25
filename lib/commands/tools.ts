// The commands team members run: verdict, log, lock, gate, env, finish, progress and drain. Each works for the
// team the caller belongs to (its instance sets E9G_HOME_DIR) or the checkout a person runs it in.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withLock } from "../lock.ts";
import { stateDir } from "../paths.ts";
import { inTeam, teamSession } from "../session.ts";
import { git, list, localTime, minutes, parseArgs, text as optionText, writeJson } from "../util.ts";

// On a team, some commands are the planner's alone (the guard says so too; this holds when it's bypassed).
const plannerOnly = (what: string): boolean => {
  if (!inTeam() || process.env.E9G_ROLE === "planner") return false;
  console.error(`${what}: only the planner does this`);
  return true;
};
// Runs a team command with sh. Arguments go to it as "$@", so nothing in them is run as shell.
const runIn = (cwd: string, command: string, args: string[] = []): number =>
  spawnSync("sh", ["-c", args.length ? `${command} "$@"` : command, "sh", ...args], { cwd, stdio: "inherit" }).status ?? 1;

// The full id of the commit `ref` names, or null.
const commitOf = (home: string, ref: string): string | null => {
  const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], { cwd: home, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
};

const VERDICT_USAGE =
  'usage: e9g verdict review <branch> approve|changes --sha <the commit you reviewed> [--note "…"] | ux <subject> pass|issues --ref <the commit you audited> [--note "…"] | show review|ux <name>';

// e9g verdict review <branch> approve|changes --sha <commit> [--note "…"]
// e9g verdict ux <subject> pass|issues --ref <commit> [--note "…"]
// e9g verdict show review|ux <name>
// Pinned to the exact commit judged, never to whatever a name points at when it's recorded: a review names the
// commit the reviewer read, refused when the branch has moved past it (the merge queue accepts only an approval of
// the tip it merges), and a UX verdict names the commit the specialist audited and counts only for that source.
export function verdict(argv: string[]): number {
  const { positional, options } = parseArgs(argv);
  const [kind, name, value] = positional;
  const { home } = teamSession();
  const file = (k: string, n: string): string => join(stateDir(home), k === "review" ? "reviews" : "ux", `${n.replaceAll("/", "_")}.json`);
  if (kind === "show") {
    const path = file(name ?? "", value ?? "");
    console.info(existsSync(path) ? readFileSync(path, "utf8").trim() : "none");
    return 0;
  }
  const kinds: Record<string, { values: string[]; owner: string }> = {
    review: { values: ["approve", "changes"], owner: "reviewer" },
    ux: { values: ["pass", "issues"], owner: "ux-specialist" },
  };
  const spec = kinds[kind ?? ""];
  if (!kind || !spec || !name || !value || !spec.values.includes(value)) {
    console.error(VERDICT_USAGE);
    return 2;
  }
  // Belt and braces with the guard: on a team, only the role that owns a verdict records it.
  const owner = spec.owner;
  if (inTeam() && process.env.E9G_ROLE !== owner) {
    console.error(`verdict: only the ${owner} records a ${kind} verdict`);
    return 2;
  }
  const given = optionText(options[kind === "review" ? "sha" : "ref"]);
  if (!given) {
    console.error(`verdict: say which commit you judged with ${kind === "review" ? "--sha" : "--ref"}\n${VERDICT_USAGE}`);
    return 2;
  }
  const sha = commitOf(home, given);
  if (!sha) {
    console.error(`verdict: ${given} isn't a commit in ${home}`);
    return 2;
  }
  if (kind === "review") {
    const tip = commitOf(home, `refs/heads/${name}`);
    if (!tip) {
      console.error(`verdict: no branch ${name}`);
      return 2;
    }
    if (tip !== sha) {
      console.error(
        `verdict: ${name} is at ${tip.slice(0, 9)}, not ${sha.slice(0, 9)}: it has moved since the commit you reviewed. Review what changed (git log ${sha.slice(0, 9)}..${name}) and record the verdict for ${tip.slice(0, 9)}.`
      );
      return 2;
    }
  }
  const record = {
    kind,
    name,
    verdict: value,
    sha,
    note: optionText(options["note"]) ?? "",
    by: process.env.E9G_ROLE ?? "operator",
    at: new Date().toISOString(),
  };
  writeJson(file(kind, name), record);
  console.info(`${kind} ${name}: ${value} at ${record.sha.slice(0, 9)}`);
  return 0;
}

// e9g log [--label "merge 27"] "What changed, what's running, what's next."
// Prepends one entry to the planner's log (.e9g/run/state/log.md, newest first) with the real local time.
export function log(argv: string[]): number {
  if (plannerOnly("log")) return 2;
  const { positional, options } = parseArgs(argv);
  const text = positional.join(" ").trim();
  if (!text) {
    console.error('usage: e9g log [--label "merge 27"] "<entry>"');
    return 2;
  }
  const { home, team } = teamSession();
  const file = join(stateDir(home), "log.md");
  mkdirSync(stateDir(home), { recursive: true });
  const previous = existsSync(file) ? readFileSync(file, "utf8") : `# ${team.title}: planner's log (newest first)\n`;
  const [heading, ...rest] = previous.split("\n\n");
  const label = optionText(options["label"]);
  const entry = `**${localTime()}${label ? `, ${label}` : ""}.** ${text}`;
  writeFileSync(file, [heading, entry, ...rest].join("\n\n"));
  console.info(entry.slice(0, 120));
  return 0;
}

// e9g lock <name> [--slots N] [--wait-min M] -- <command> [args…]
// The wait takes minutes or a duration (30, 30m, 2h). Exits 75 when no slot came free in time.
export async function lock(argv: string[]): Promise<number> {
  const usage = "usage: e9g lock <name> [--slots N] [--wait-min M] -- <command> [args…]";
  const { positional, options } = parseArgs(argv);
  const command = list(options["--"]);
  const name = positional[0] ?? "";
  if (!name || !command.length) {
    console.error(usage);
    return 2;
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    console.error(`lock: a lock's name is letters, digits, dots, dashes and underscores, not ${name}\n${usage}`);
    return 2;
  }
  const slots = Number(optionText(options["slots"]) ?? 1);
  let waitMin: number;
  try {
    waitMin = minutes(optionText(options["wait-min"]), 60);
  } catch (error) {
    console.error(`lock: --wait-min: ${(error as Error).message}\n${usage}`);
    return 2;
  }
  if (!Number.isInteger(slots) || slots < 1 || options["slots"] === true) {
    console.error(`lock: --slots takes a whole number of at least 1\n${usage}`);
    return 2;
  }
  if (!(waitMin > 0) || options["wait-min"] === true) {
    console.error(`lock: --wait-min takes a wait longer than nothing (30, 30m, 2h)\n${usage}`);
    return 2;
  }
  const { home } = teamSession();
  return withLock(home, name, command, { slots, waitMin });
}

// e9g gate [--quick]: the team's checks in the checkout you're in (a worktree, or the team's own checkout).
export async function gate(argv: string[]): Promise<number> {
  const { options } = parseArgs(argv, { booleans: ["quick"] });
  const { home, team } = teamSession();
  const command = options["quick"] ? team.gate.quick : team.gate.full;
  if (!command) {
    console.error("gate: the team has no gate (team.json gate.full)");
    return 2;
  }
  const cwd = git(process.cwd(), "rev-parse", "--show-toplevel");
  return withLock(home, "gate", ["sh", "-c", command], { slots: team.gate.concurrency, waitMin: 60, cwd });
}

// e9g env up|reset|restart|down|status: the team's environment script, run from the team's checkout.
export function env(argv: string[]): number {
  const sub = argv[0] ?? "status";
  if (sub !== "status" && plannerOnly(`env ${sub}`)) return 2;
  const { home, team } = teamSession();
  if (!team.environment.script) {
    console.info("env: the team has no environment script (team.json environment.script)");
    return sub === "status" ? 0 : 2;
  }
  return runIn(home, team.environment.script, [sub, ...argv.slice(1)]);
}

// e9g finish / e9g progress: the team's finish line and its status, run from the team's checkout.
export function finish(): number {
  const { home, team } = teamSession();
  if (!team.finish) {
    console.error("finish: the team has no finish command (team.json finish)");
    return 2;
  }
  return runIn(home, team.finish);
}
export function progress(): number {
  const { home, team } = teamSession();
  if (!team.progress) {
    console.info("progress: the team has no progress command (team.json progress)");
    return 0;
  }
  return runIn(home, team.progress);
}

// e9g drain <role…> | off: no new members of those roles start (the guard refuses them) until drained off.
export function drain(argv: string[]): number {
  if (argv.length && argv[0] !== "status" && plannerOnly("drain")) return 2;
  const { home } = teamSession();
  const file = join(stateDir(home), "drain");
  if (!argv.length || argv[0] === "status") {
    console.info(existsSync(file) ? `draining: ${readFileSync(file, "utf8").trim()}` : "not draining");
    return 0;
  }
  if (argv[0] === "off") {
    rmSync(file, { force: true });
    console.info("drain: off");
    return 0;
  }
  mkdirSync(stateDir(home), { recursive: true });
  writeFileSync(file, `${argv.join(" ")}\n`);
  console.info(`drain: no new ${argv.join(", ")} until e9g drain off`);
  return 0;
}
