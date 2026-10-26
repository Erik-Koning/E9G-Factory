// e9g check [<checkout>] [--run]: prove a team's setup before anything runs.
// - the rules load (problems and warnings);
// - the adapters exist, are executable, and (shell scripts) parse;
// - the checkout is on the integration branch, and .e9g/ is committed there, even where git ignores it: members'
//   worktrees are made from it;
// - the guard behaves as the rules say: a self-test generated from them (the factory's files, lanes, read-only
//   roles, protected branches, owned commands, every policy's examples, the team's own never rules, email);
// - each role's prompt compiles;
// - T3 Code meets the contract;
// - with --run: the environment starts, answers and stops, the gate passes on the integration branch, and the
//   finish command runs.
// Ends with a plain summary of what the team may and may not do.
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { instanceId, type Lane, type LoadedTeam, loadTeam, ROLES, type Team } from "../config.ts";
import { FACTORY_ROOT, findHome, versionDir } from "../paths.ts";
import { ALLOWED_EXAMPLES, policyStates } from "../policies.ts";
import { compile } from "../prompts.ts";
import * as t3 from "../t3.ts";
import { die, parseArgs } from "../util.ts";

// One self-test case: a tool call as a role would make it, and what the guard must do with it. `says`: what the
// refusal must say, where another check would refuse the call too (a push the planner may not make anyway), so the
// case proves the check it names.
export interface GuardCase {
  role: string;
  tool: string;
  input: Record<string, unknown>;
  expect: "allow" | "refuse";
  why: string;
  says?: string;
}
type Level = "ok" | "warn" | "FAIL";

const GUARD = join(FACTORY_ROOT, "plugin", "hooks", "guard.ts");

export function guardCases(team: Team): GuardCase[] {
  const home = team.home;
  const roles = Object.keys(team.roles);
  const builder = roles.includes("builder") ? "builder" : (roles.find((r) => r !== "planner") ?? "planner");
  const cases: GuardCase[] = [];
  const add = (role: string, tool: string, input: Record<string, unknown>, expect: GuardCase["expect"], why: string, says?: string) =>
    cases.push({ role, tool, input, expect, why, ...(says === undefined ? {} : { says }) });
  const bash = (role: string, command: string, expect: GuardCase["expect"], why?: string) => add(role, "Bash", { command }, expect, why ?? command);
  const planner = team.roles["planner"] as Lane;

  for (const role of roles) {
    add(role, "Write", { file_path: join(home, ".e9g/team.json") }, "refuse", "the team's rules");
    add(role, "Write", { file_path: join(home, ".claude/settings.json") }, "refuse", "Claude Code's project settings");
    add(role, "Write", { file_path: join(home, ".e9g/run/state/reviews/x.json") }, "refuse", "recorded state");
    add(role, "Read", { file_path: join(home, ".env.local") }, "refuse", "a secret file");
  }
  if (planner.write.some((rule) => new RegExp(rule).test(".e9g/lessons.md")))
    add("planner", "Write", { file_path: join(home, ".e9g/lessons.md") }, "allow", "the planner's lessons");
  for (const role of roles.filter((r) => team.roles[r]?.readOnly)) {
    add(role, "Write", { file_path: join(home, "README.md") }, "refuse", "a read-only role writing");
    bash(role, "git commit -am wip", "refuse", "a read-only role committing");
    add(role, "Write", { file_path: join(home, ".e9g/run/board/f-20260101-0000-check.md") }, "allow", "filing a finding");
  }
  const builderLane = team.roles[builder];
  if (builderLane?.write.includes("*") && !builderLane.deny.some((rule) => new RegExp(rule).test("src/e9g-check.ts")))
    add(builder, "Write", { file_path: join(home, "src/e9g-check.ts") }, "allow", "a builder writing in its lane");
  // The planner's own: anyone else is refused any push, and the planner any other push, before the branch counts.
  const guarded = team.protectedBranches[0];
  if (guarded) {
    const remote = team.push?.remote ?? "origin";
    const says = `nothing is pushed to ${guarded}`;
    add("planner", "Bash", { command: `git push ${remote} ${guarded}` }, "refuse", "a push to a protected branch", says);
    add("planner", "Bash", { command: `git -C . push ${remote} HEAD:${guarded}` }, "refuse", "a push to a protected branch behind git -C", says);
  }
  bash(builder, "git push --force origin topic", "refuse", "a force push");
  bash(builder, "cat .env", "refuse", "reading an env file");
  bash(builder, "e9g register", "refuse", "an operator's command");
  if (team.environment.script && builder !== "planner") {
    bash(builder, `${team.environment.script.split(/\s+/)[0] ?? ""} reset`, "refuse", "resetting the environment by its script");
    bash(builder, "e9g env status", "allow", "reading the environment's status");
  }
  if (builder !== "planner") {
    bash(builder, "e9g merge some/branch", "refuse", "merging, which only the planner does");
    bash(builder, "e9g verdict review some/branch approve", "refuse", "a reviewer's verdict");
  }
  for (const policy of policyStates(team))
    for (const example of policy.examples)
      bash(builder, example, policy.state === "deny" ? "refuse" : "allow", `policy ${policy.id} (${policy.state}): ${example}`);
  // Ordinary work, unless the team's own rules keep this role from it (a team may narrow e2e runs to its testers).
  const narrowed = (command: string) =>
    team.never.some(({ rule }) => new RegExp(rule).test(command)) ||
    team.commandOwners.some(({ rule, roles }) => new RegExp(rule).test(command) && !roles.includes(builder));
  for (const example of ALLOWED_EXAMPLES)
    if (narrowed(example)) bash(builder, example, "refuse", `ordinary work the team's own rules narrow: ${example}`);
    else bash(builder, example, "allow", `ordinary work: ${example}`);
  for (const rule of team.never) if (rule.example) bash(builder, rule.example, "refuse", `the team's rule: ${rule.reason}`);
  add(
    "planner",
    "mcp__t3-code__delegate_task",
    { target: { providerInstanceId: "someone-else" } },
    "refuse",
    "starting a member on another team's instance"
  );
  add("planner", "mcp__t3-code__delegate_task", { target: { providerInstanceId: instanceId(team, "planner") } }, "refuse", "starting a second planner");
  const building = roles.find((r) => team.roles[r]?.worktree);
  if (building)
    add(
      "planner",
      "mcp__t3-code__delegate_task",
      { target: { providerInstanceId: instanceId(team, building) } },
      "refuse",
      `starting a ${building} without a worktree of its own (isolation: "worktree")`
    );
  bash("planner", `git branch -m ${team.branch} e9g-check`, "refuse", "renaming the integration branch");
  bash("planner", 'gh issue create --title "e9g check" --body x', "refuse", "an issue the planner opens without its label");
  add(builder, "Monitor", { command: "cat .env", description: "e9g check" }, "refuse", "a command run through Monitor");
  if (builder !== "planner")
    add(builder, "mcp__t3-code__delegate_task", { target: { providerInstanceId: instanceId(team, builder) } }, "refuse", "a member starting members");
  if (planner.mcp.includes("mcp__claude_ai_Gmail__send_message")) {
    add("planner", "mcp__claude_ai_Gmail__send_message", { to: ["someone@example.com"] }, "refuse", "email to anyone but the operator");
    if (team.owner) {
      add(
        "planner",
        "mcp__claude_ai_Gmail__send_message",
        { to: [team.owner], subject: `[E9G-Planner] [${team.title}] e9g check` },
        "allow",
        "email to the operator"
      );
      add(
        "planner",
        "mcp__claude_ai_Gmail__send_message",
        { to: [team.owner], subject: `[${team.title}] e9g check` },
        "refuse",
        "email without the planner's label"
      );
    }
  }
  return cases;
}

// One case, as Claude Code would call the hook: JSON on stdin, the team's environment, exit 2 to refuse.
export function runGuard(team: Team, { role, tool, input }: GuardCase, run: string): Promise<{ outcome: string; said: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [GUARD], {
      // As the plugin's hooks.json runs it, compile cache included.
      env: {
        ...process.env,
        E9G_TEAM: team.name,
        E9G_HOME_DIR: team.home,
        E9G_RUN: run,
        E9G_ROLE: role,
        CLAUDE_PROJECT_DIR: team.home,
        E9G_SETUP: "",
        NODE_COMPILE_CACHE: join(FACTORY_ROOT, ".cache"),
        E9G_NODE_CACHE: "1",
      },
    });
    let said = "";
    child.stderr.on("data", (chunk: Buffer) => (said += chunk));
    child.on("close", (code) => done({ outcome: code === 2 ? "refuse" : code === 0 ? "allow" : `error ${code}`, said: said.trim() }));
    child.stdin.end(JSON.stringify({ tool_name: tool, tool_input: input, agent_type: `e9g:${role}`, cwd: team.home, session_id: "e9g-check" }));
  });
}

const executable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

// The program a #! line runs, past env and its options (env -S bash -eu, env -i, env -u NAME, env VAR=x); null when
// it doesn't name one.
export function interpreterOf(line: string): string | null {
  const words = (/^#!(.*)$/.exec(line)?.[1] ?? "").trim().split(/\s+/).filter(Boolean);
  if (basename(words[0] ?? "") !== "env") return words[0] ? basename(words[0]) : null;
  for (let i = 1; i < words.length; i++) {
    let word = words[i] ?? "";
    // Options that take the next word as their value.
    if (/^-[uPC]$/.test(word)) {
      i++;
      continue;
    }
    // A value attached to -S or --split-string= is the program and its arguments.
    const split = /^(?:-S|--split-string=)(.+)$/.exec(word);
    if (split) word = split[1] ?? "";
    else if (word.startsWith("-") || /^\w+=/.test(word)) continue;
    return basename(word);
  }
  return null;
}

// The shell a script runs under, from its #! line (a .sh file without one runs under sh). null: not a shell script
// (no #! line and not .sh, or another program such as node). undefined: a #! line that doesn't say which program.
const SHELLS = ["bash", "sh", "dash", "zsh", "ksh"];
export function shellOf(path: string): string | null | undefined {
  const first = readFileSync(path, "utf8").split("\n", 1)[0] ?? "";
  if (!first.startsWith("#!")) return path.endsWith(".sh") ? "sh" : null;
  const program = interpreterOf(first);
  if (program === null) return undefined;
  return SHELLS.includes(program) ? program : null;
}

// What an editor or a merge leaves beside a file: gate.sh~, gate.sh.orig, #gate.sh#.
const BACKUP = /(~|\.(bak|orig|rej|swp|swo|tmp))$|^#.*#$/;

const gitRun = (home: string, ...args: string[]) => spawnSync("git", args, { cwd: home, encoding: "utf8" });

export async function check(argv: string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, { booleans: ["run"] });
  const home = positional[0] ? resolve(positional[0]) : findHome();
  if (!home) die("run this in a team's checkout, or name it: e9g check <checkout>");
  const team = loadTeam(home, { strict: false });
  let failures = 0;
  const line = (level: Level, text: string) => {
    if (level === "FAIL") failures++;
    console.info(`${level.padEnd(4)}  ${text}`);
  };

  console.info(`Checking ${team.title} (${home})\n`);
  for (const problem of team.problems) line("FAIL", `team.json: ${problem}`);
  for (const warning of team.warnings) line("warn", `team.json: ${warning}`);
  if (team.problems.length) return summary(team, failures);
  line("ok", `team.json loads: ${Object.keys(team.roles).length} roles, integration branch ${team.branch}`);

  const scripts = [team.environment.script, team.gate.full, team.gate.quick, team.afterMerge]
    .filter((command) => command !== null)
    .map((command) => command.split(/\s+/)[0] ?? "")
    .filter((script) => /^\.{0,2}\/|^[\w.-]+\/[\w./-]+$/.test(script));
  for (const script of [...new Set(scripts)]) {
    const path = join(home, script);
    if (!existsSync(path)) line("FAIL", `${script} doesn't exist`);
    else if (!executable(path)) line("FAIL", `${script} isn't executable (chmod +x ${script})`);
    else line("ok", `${script} exists and is executable`);
  }
  // A script that doesn't parse fails on its first run, in the middle of a merge. The scripts team.json names, and the
  // shell scripts in .e9g/adapters/; not what else is there: a .DS_Store, an editor's backup, a node script.
  const isFile = (path: string) => existsSync(join(home, path)) && statSync(join(home, path)).isFile();
  const named = [...new Set(scripts.map((path) => path.replace(/^\.\//, "")))].filter(
    (path) => !path.startsWith("/") && !path.startsWith("../") && isFile(path)
  );
  const adapters: string[] = [];
  for (const name of existsSync(join(home, ".e9g", "adapters")) ? readdirSync(join(home, ".e9g", "adapters")).sort() : []) {
    const path = `.e9g/adapters/${name}`;
    if (name.startsWith(".") || named.includes(path) || !isFile(path)) continue;
    if (BACKUP.test(name)) {
      if (gitRun(home, "check-ignore", "-q", "--", path).status !== 0)
        line("warn", `${path} looks like an editor's backup: check skips it, and git add .e9g would commit it (delete it)`);
    } else if (shellOf(join(home, path)) !== null) adapters.push(path);
  }
  const files = [...named, ...adapters];
  for (const script of files) {
    const path = join(home, script);
    const shell = shellOf(path);
    if (shell === undefined) {
      line("warn", `${script}: its #! line doesn't say which shell runs it, so it isn't checked (${readFileSync(path, "utf8").split("\n", 1)[0]})`);
      continue;
    }
    if (!shell) continue;
    const parsed = spawnSync(shell, ["-n", path], { encoding: "utf8" });
    if (parsed.error) line("warn", `${script}: couldn't run ${shell} -n to check it`);
    else if (parsed.status !== 0) line("FAIL", `${script} isn't valid ${shell}: ${parsed.stderr.trim().split("\n")[0] ?? ""}`);
    else line("ok", `${script} parses (${shell} -n)`);
  }
  if (!existsSync(join(home, ".e9g", ".gitignore")) || !/^run\/?$/m.test(readFileSync(join(home, ".e9g", ".gitignore"), "utf8")))
    line("FAIL", ".e9g/.gitignore must ignore run/");
  for (const doc of team.docs) if (!existsSync(join(home, doc))) line("warn", `${doc} is listed in docs but doesn't exist`);
  if (!team.factory) line("warn", `factory: no pin, so the team runs whichever E9G Factory version registers it (add "factory": "<version>")`);
  else if (!existsSync(versionDir(team.factory)))
    line("warn", `factory: the team pins ${team.factory}, which isn't installed here (e9g versions); register refuses until it is`);
  committed(team, [".e9g/team.json", ".e9g/.gitignore", ...named], adapters, line);

  const run = mkdtempSync(join(tmpdir(), "e9g-check-"));
  const cases = guardCases(team);
  const wrong: string[] = [];
  // Eight at a time: each case is a fresh node process, as it is under Claude Code.
  for (let i = 0; i < cases.length; i += 8) {
    const batch = cases.slice(i, i + 8);
    const results = await Promise.all(batch.map((test) => runGuard(team, test, run)));
    batch.forEach((test, j) => {
      const { outcome, said } = results[j] ?? { outcome: "not run", said: "" };
      if (outcome !== test.expect || (test.says !== undefined && !said.includes(test.says)))
        wrong.push(
          `${test.role}: ${test.why}: expected ${test.expect}${test.says ? ` saying "${test.says}"` : ""}, got ${outcome}${said ? ` (${said.slice(0, 160)})` : ""}`
        );
    });
  }
  rmSync(run, { recursive: true, force: true });
  if (wrong.length) for (const text of wrong) line("FAIL", `guard: ${text}`);
  else line("ok", `guard: all ${cases.length} self-test cases behave as the rules say`);

  for (const role of Object.keys(team.roles)) {
    const text = compile(team, role);
    if (/\{\{\w+\}\}/.test(text)) line("FAIL", `the ${role} prompt has an unfilled placeholder`);
  }
  line("ok", `prompts compile for ${Object.keys(team.roles).join(", ")}`);

  const contract = t3.contract();
  if (contract.length) for (const problem of contract) line("warn", `T3 Code: ${problem}`);
  else line("ok", "T3 Code meets the contract");

  if (options["run"]) await live(team, line);
  return summary(team, failures);
}

// The team runs from its integration branch: the checkout stays on it, and members' worktrees are made from it, so
// the rules and the adapters must be committed there, as they are in the checkout. required (team.json, its
// .gitignore and the scripts team.json names) must be committed even when git ignores them; others (the adapters'
// shell scripts) only when it doesn't.
function committed(team: Team, required: string[], others: string[], line: (level: Level, text: string) => void): void {
  const home = team.home;
  if (gitRun(home, "rev-parse", "--verify", "--quiet", `refs/heads/${team.branch}`).status !== 0) {
    line("FAIL", `the integration branch ${team.branch} doesn't exist (git -C ${home} checkout -b ${team.branch} ${team.base})`);
    return;
  }
  const head = gitRun(home, "symbolic-ref", "--quiet", "--short", "HEAD").stdout.trim();
  if (head !== team.branch)
    line("FAIL", `the team's checkout is on ${head || "a detached HEAD"}, not its integration branch ${team.branch} (git checkout ${team.branch})`);
  else line("ok", `the team's checkout is on ${team.branch}`);
  // A link is committed as a link; what it points at, inside the checkout, must be committed too.
  const root = realpathSync(home);
  const withTargets = (paths: string[]): string[] => {
    const found = [...new Set(paths)].filter((path) => existsSync(join(home, path)));
    for (const path of [...found]) {
      if (!lstatSync(join(home, path)).isSymbolicLink()) continue;
      const target = relative(root, realpathSync(join(home, path)));
      if (target && !target.startsWith("..") && !isAbsolute(target) && !found.includes(target)) found.push(target);
    }
    return found;
  };
  const must = withTargets(required);
  const all = [...new Set([...must, ...withTargets(others)])];
  // What git ignores (untracked and matched by an ignore rule), with the rule; -v lists a negated (!) rule too, which
  // doesn't ignore.
  const ignored = new Map<string, string>();
  const listed = spawnSync("git", ["check-ignore", "--stdin", "-z", "-v"], {
    cwd: home,
    encoding: "utf8",
    input: all.map((path) => `${path}\0`).join(""),
  });
  const fields = (listed.stdout ?? "").split("\0");
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const [source = "", number, pattern, path] = fields.slice(i, i + 4);
    const where = isAbsolute(source) && !relative(root, source).startsWith("..") ? relative(root, source) : source;
    if (path && pattern && !pattern.startsWith("!")) ignored.set(path, `${where}:${number}: ${pattern}`);
  }
  // The rules and the scripts they name are the team: git ignoring them leaves members' worktrees without them.
  const hidden = must.filter((path) => ignored.has(path));
  for (const rule of new Set(hidden.map((path) => ignored.get(path)))) {
    const paths = hidden.filter((path) => ignored.get(path) === rule);
    const include = [...new Set(paths.map((path) => (path.startsWith(".e9g/") ? ".e9g/" : path)))].map((path) => `"!${path}"`).join(" and ");
    line(
      "FAIL",
      `ignored by git (${rule}), so not committed on ${team.branch} and missing from members' worktrees: ${paths.join(", ")}. Add ${include} to .gitignore after that rule, or git add -f ${paths.join(" ")}`
    );
  }
  // Whatever else git ignores isn't meant to be committed.
  const inside = all.filter((path) => !ignored.has(path));
  const modes = new Map<string, string>();
  for (const entry of gitRun(home, "ls-tree", "-r", "-z", team.branch, "--", ...inside).stdout.split("\0")) {
    const match = /^(\d+) \w+ \w+\t(.+)$/s.exec(entry);
    if (match?.[1] && match[2]) modes.set(match[2], match[1]);
  }
  const missing = inside.filter((path) => !modes.has(path));
  const add = [...new Set(missing.map((path) => (path.startsWith(".e9g/") ? ".e9g" : path)))].join(" ");
  if (missing.length)
    line(
      "FAIL",
      `not committed on ${team.branch}: ${missing.join(", ")}. Members' worktrees are made from it: git add ${add} && git commit -m "E9G team: ${team.name}"`
    );
  for (const path of inside.filter((path) => modes.has(path))) {
    // A link (120000) has no executable bit of its own; its target is checked in its place.
    if (modes.get(path) !== "120000" && executable(join(home, path)) && modes.get(path) !== "100755")
      line("FAIL", `${path} is committed without its executable bit (git add --chmod=+x ${path})`);
    else if (gitRun(home, "diff", "--quiet", team.branch, "--", path).status !== 0)
      line("warn", `${path} has changes not committed on ${team.branch}; members' worktrees get the committed copy`);
  }
  if (!missing.length && !hidden.length) line("ok", `the rules and adapters are committed on ${team.branch}`);
}

async function live(team: LoadedTeam, line: (level: Level, text: string) => void): Promise<void> {
  const home = team.home;
  const sh = (command: string, cwd: string, timeout = 20 * 60_000) => spawnSync("sh", ["-c", command], { cwd, encoding: "utf8", timeout });
  if (team.environment.script) {
    const up = sh(`${team.environment.script} up`, home);
    line(up.status === 0 ? "ok" : "FAIL", `environment up: ${(up.stdout + up.stderr).trim().split("\n").pop() ?? ""}`);
    const status = sh(`${team.environment.script} status`, home, 60_000);
    line(status.status === 0 ? "ok" : "FAIL", `environment status: ${(status.stdout + status.stderr).trim().split("\n").pop() ?? ""}`);
    for (const target of team.environment.health) {
      let answered = false;
      try {
        const response = await fetch(target.replace(/^any:/, ""), { signal: AbortSignal.timeout(10_000) });
        answered = target.startsWith("any:") || response.status < 400;
      } catch {}
      line(answered ? "ok" : "FAIL", `health ${target} ${answered ? "answers" : "doesn't answer"}`);
    }
    const down = sh(`${team.environment.script} down`, home, 120_000);
    line(down.status === 0 ? "ok" : "warn", "environment down");
  }
  if (team.gate.full) {
    const dir = mkdtempSync(join(tmpdir(), `e9g-gate-${team.name}-`));
    rmSync(dir, { recursive: true, force: true });
    if (spawnSync("git", ["worktree", "add", "--detach", dir, team.branch], { cwd: home, stdio: "ignore" }).status !== 0)
      line("FAIL", `couldn't make a worktree of ${team.branch}`);
    else {
      if (team.worktreeSetup) sh(team.worktreeSetup, dir);
      const gate = sh(team.gate.full, dir, 45 * 60_000);
      const tail = (gate.stdout + gate.stderr).trim().split("\n").slice(-3).join(" | ");
      line(gate.status === 0 ? "ok" : "FAIL", `gate on ${team.branch}: ${tail}`);
      spawnSync("git", ["worktree", "remove", "--force", dir], { cwd: home, stdio: "ignore" });
    }
  }
  if (team.finish) {
    const finish = sh(team.finish, home, 10 * 60_000);
    line("ok", `finish runs (exit ${finish.status}${finish.status === 0 ? ": already done" : ": not done yet, as expected before the team starts"})`);
  }
}

function summary(team: Team, failures: number): number {
  const states = policyStates(team);
  console.info("\nWhat this team may do:");
  for (const [role, lane] of Object.entries(team.roles)) {
    const writes = lane.write.length ? lane.write.map((rule) => (rule === "*" ? "anything" : rule)).join(", ") : "nothing (read-only)";
    console.info(
      `  - ${role}${role === "planner" ? "" : ` (up to ${lane.limit} at once)`}: ${ROLES[role]?.summary ?? ""}; writes ${writes}${lane.deny.length ? `, never ${lane.deny.join(", ")}` : ""}`
    );
  }
  console.info(
    `  - pushes: ${team.push ? `only the planner, ${team.push.branch} to ${team.push.remote}${team.push.everyMin ? `, at most every ${team.push.everyMin / 60} h` : ""}` : "none"}`
  );
  for (const policy of states.filter((p) => p.state === "allow"))
    console.info(`  - ${policy.summary}${policy.default === "deny" ? " (unlocked by the operator)" : ""}`);
  console.info("What it may not do:");
  for (const policy of states.filter((p) => p.state === "deny")) console.info(`  - ${policy.summary}`);
  for (const rule of team.never) console.info(`  - ${rule.reason}`);
  console.info("  - touch secrets, the machine's services, rewritten history, protected branches, or the factory's own files");
  console.info(failures ? `\n${failures} problem(s) to fix.` : "\nReady: e9g register, then e9g start.");
  return failures ? 1 : 0;
}
