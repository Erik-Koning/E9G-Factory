// The commands team members run: verdict, log, lock, gate, env, finish, progress and drain. Each works for the
// team the caller belongs to (its instance sets E9G_HOME_DIR) or the checkout a person runs it in.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withLock } from "../lock.mjs";
import { stateDir } from "../paths.mjs";
import { inTeam, teamSession } from "../session.mjs";
import { git, localTime, parseArgs, writeJson } from "../util.mjs";

const runIn = (cwd, command, env = {}) => spawnSync("sh", ["-c", command], { cwd, stdio: "inherit", env: { ...process.env, ...env } }).status ?? 1;

// e9g verdict review <branch> approve|changes [--note "…"]
// e9g verdict ux <subject> pass|issues [--note "…"] [--ref <commit>]
// e9g verdict show review|ux <name>
// Pinned to the exact commit judged: the merge queue accepts only an approval of the tip it merges, and a UX
// verdict counts only for the source it saw.
export function verdict(argv) {
  const { positional, options } = parseArgs(argv);
  const [kind, name, value] = positional;
  const { home, team } = teamSession();
  const file = (k, n) => join(stateDir(home), k === "review" ? "reviews" : "ux", `${n.replaceAll("/", "_")}.json`);
  if (kind === "show") {
    const path = file(name, value ?? "");
    console.info(existsSync(path) ? readFileSync(path, "utf8").trim() : "none");
    return 0;
  }
  const allowed = { review: ["approve", "changes"], ux: ["pass", "issues"] }[kind];
  if (!allowed || !name || !allowed.includes(value)) {
    console.error(
      'usage: e9g verdict review <branch> approve|changes [--note "…"] | ux <subject> pass|issues [--note "…"] [--ref <commit>] | show review|ux <name>'
    );
    return 2;
  }
  // Belt and braces with the guard: on a team, only the role that owns a verdict records it.
  const owner = { review: "reviewer", ux: "ux-specialist" }[kind];
  if (inTeam() && process.env.E9G_ROLE !== owner) {
    console.error(`verdict: only the ${owner} records a ${kind} verdict`);
    return 2;
  }
  const ref = kind === "review" ? name : (options.ref ?? team.branch);
  const record = {
    kind,
    name,
    verdict: value,
    sha: git(home, "rev-parse", ref),
    note: options.note === true ? "" : (options.note ?? ""),
    by: process.env.E9G_ROLE ?? "operator",
    at: new Date().toISOString(),
  };
  writeJson(file(kind, name), record);
  console.info(`${kind} ${name}: ${value} at ${record.sha.slice(0, 9)}`);
  return 0;
}

// e9g log [--label "merge 27"] "What changed, what's running, what's next."
// Prepends one entry to the planner's log (.e9g/run/state/log.md, newest first) with the real local time.
export function log(argv) {
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
  const entry = `**${localTime()}${options.label && options.label !== true ? `, ${options.label}` : ""}.** ${text}`;
  writeFileSync(file, [heading, entry, ...rest].join("\n\n"));
  console.info(entry.slice(0, 120));
  return 0;
}

// e9g lock <name> [--slots N] [--wait-min M] -- <command> [args…]
export async function lock(argv) {
  const { positional, options } = parseArgs(argv);
  const command = options["--"];
  if (!positional[0] || !command?.length) {
    console.error("usage: e9g lock <name> [--slots N] [--wait-min M] -- <command> [args…]");
    return 2;
  }
  const { home } = teamSession();
  return withLock(home, positional[0], command, { slots: Number(options.slots ?? 1), waitMin: Number(options["wait-min"] ?? 60) });
}

// e9g gate [--quick]: the team's checks in the checkout you're in (a worktree, or the team's own checkout).
export async function gate(argv) {
  const { options } = parseArgs(argv, { booleans: ["quick"] });
  const { home, team } = teamSession();
  const command = options.quick ? team.gate.quick : team.gate.full;
  if (!command) {
    console.error("gate: the team has no gate (team.json gate.full)");
    return 2;
  }
  const cwd = git(process.cwd(), "rev-parse", "--show-toplevel");
  return withLock(home, "gate", ["sh", "-c", command], { slots: team.gate.concurrency, waitMin: 60, cwd });
}

// e9g env up|reset|restart|down|status: the team's environment script, run from the team's checkout.
export function env(argv) {
  const sub = argv[0] ?? "status";
  const { home, team } = teamSession();
  if (!team.environment.script) {
    console.info("env: the team has no environment script (team.json environment.script)");
    return sub === "status" ? 0 : 2;
  }
  return runIn(
    home,
    `${team.environment.script} ${sub} ${argv
      .slice(1)
      .map((arg) => JSON.stringify(arg))
      .join(" ")}`
  );
}

// e9g finish / e9g progress: the team's finish line and its status, run from the team's checkout.
export function finish() {
  const { home, team } = teamSession();
  if (!team.finish) {
    console.error("finish: the team has no finish command (team.json finish)");
    return 2;
  }
  return runIn(home, team.finish);
}
export function progress() {
  const { home, team } = teamSession();
  if (!team.progress) {
    console.info("progress: the team has no progress command (team.json progress)");
    return 0;
  }
  return runIn(home, team.progress);
}

// e9g drain <role…> | off: no new members of those roles start (the guard refuses them) until drained off.
export function drain(argv) {
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
