// e9g doctor: is this machine ready to run teams? Checks the tools, T3 Code against the range this factory supports
// and against what its adapter reads, the launcher and the watchdog, disk space, and every registered team.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadTeam } from "../config.ts";
import { E9G_HOME, entryOf, type FactoryPackage, PACKAGE, readRegistry, versionDir } from "../paths.ts";
import { promptFile, promptStale } from "../prompts.ts";
import * as t3 from "../t3.ts";
import { readJson, which } from "../util.ts";
import { teamNames } from "./team.ts";
import { keptWorktrees, watchdogLoaded } from "./watchdog.ts";

const version = (command: string, args = ["--version"]): string | null =>
  /(\d+\.\d+\.\d+)/.exec(spawnSync(command, args, { encoding: "utf8" }).stdout ?? "")?.[1] ?? null;

const SOURCES = /sources ([0-9a-f]{16}) -->/;
// A prompt's sources hash includes the factory version that compiled it, so a team pinned to another version is
// judged by that version's own code: its e9g prompt, compiled now, against the registered copy.
function pinnedStale(pin: string, name: string, run: string, roles: string[]): string[] | null {
  const root = versionDir(pin);
  const stale: string[] = [];
  for (const role of roles) {
    const compiled = spawnSync(process.execPath, [entryOf(root), "prompt", name, role], {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, E9G_HANDED_OVER: "1", NODE_COMPILE_CACHE: join(root, ".cache"), E9G_NODE_CACHE: "1" },
    });
    const now = SOURCES.exec(compiled.stdout ?? "")?.[1];
    if (!now) return null;
    const file = promptFile(run, role);
    if (SOURCES.exec(existsSync(file) ? readFileSync(file, "utf8").slice(0, 400) : "")?.[1] !== now) stale.push(role);
  }
  return stale;
}

export async function doctor(): Promise<number> {
  const results: ["ok" | "warn" | "FAIL", string][] = [];
  const ok = (text: string) => results.push(["ok", text]);
  const warn = (text: string) => results.push(["warn", text]);
  const fail = (text: string) => results.push(["FAIL", text]);

  // The factory is TypeScript that Node runs as it is: 22.18, 23.6 or newer strips the types itself.
  ok(`node ${process.versions.node} runs the factory's TypeScript`);
  for (const tool of ["git", "sqlite3"]) (which(tool) ? ok : fail)(`${tool}${which(tool) ? "" : " is missing"}`);

  const claude = version("claude");
  if (!claude) fail("Claude Code (claude) isn't on PATH");
  else (t3.satisfies(claude, PACKAGE.e9g.claudeCode) ? ok : warn)(`Claude Code ${claude} (this factory is tested with ${PACKAGE.e9g.claudeCode})`);

  const t3Version = t3.installedVersion();
  const contract = t3.contract();
  if (!t3Version) fail("T3 Code (t3) isn't on PATH: https://github.com/pingdotgg/t3code");
  else if (contract.length) for (const problem of contract) fail(problem);
  else ok(`T3 Code ${t3Version}: in range ${t3.SUPPORTED}, and its database, CLI and settings are what this factory reads`);
  (await t3.serverUp())
    ? ok(`T3 Code's server answers at ${t3.serverUrl()}`)
    : fail(`T3 Code's server doesn't answer at ${t3.serverUrl()} (t3 service restart)`);
  // The factory no longer turns this on for you: it's a setting of the whole of T3 Code.
  if (existsSync(t3.SETTINGS) && t3.readSettings().autoResumeLimitedThreads !== true)
    warn("T3 Code doesn't resume threads that hit a usage limit (autoResumeLimitedThreads), so a team stops at a limit until you resume it");

  // Agents run `e9g …`, so T3 Code's service must have the launcher's folder on its PATH.
  const plist = join(homedir(), "Library", "LaunchAgents", "com.t3tools.t3code.service.plist");
  const servicePath = existsSync(plist)
    ? spawnSync("plutil", ["-extract", "EnvironmentVariables.PATH", "raw", plist], { encoding: "utf8" }).stdout.trim()
    : "";
  const launcherDir = join(homedir(), ".local", "bin");
  const current = readJson<FactoryPackage>(join(E9G_HOME, "current", "package.json"));
  if (!current) fail("E9G Factory isn't installed: e9g self-install (from a clone of the factory)");
  else ok(`E9G Factory ${current.version} is the current version in ${E9G_HOME}`);
  if (!existsSync(join(launcherDir, "e9g"))) fail(`the launcher isn't at ${launcherDir}/e9g: e9g self-install`);
  else if (!existsSync(plist))
    warn(`T3 Code's service isn't a launchd job here (${plist}), so whether its agents can run e9g and the hooks' node can't be checked`);
  else if (!servicePath)
    warn(`T3 Code's service sets no PATH (${plist}), so its agents may get launchd's default one, without ${launcherDir} (e9g) or node`);
  else if (!servicePath.split(":").includes(launcherDir)) fail(`T3 Code's service PATH doesn't include ${launcherDir}, so agents can't run e9g`);
  else ok("agents can run e9g (the launcher is on T3 Code's PATH)");
  // The hooks run the first node on that PATH, which may not be the one running this.
  if (servicePath) {
    const probe = spawnSync("node", ["-e", "process.stdout.write(String(process.features.typescript ?? false))"], {
      encoding: "utf8",
      env: { ...process.env, PATH: servicePath },
    });
    const hookNode = spawnSync("sh", ["-c", "command -v node"], { encoding: "utf8", env: { ...process.env, PATH: servicePath } }).stdout.trim();
    if (probe.status !== 0) fail(`T3 Code's service PATH has no node, so the factory's hooks can't run`);
    else if (probe.stdout === "false")
      fail(
        `the hooks would run ${hookNode} (${version(hookNode) ?? "unknown version"}), which can't run TypeScript: put Node 22.18 or newer first on T3 Code's PATH`
      );
    else ok(`the hooks run ${hookNode}, which runs TypeScript`);
  }
  watchdogLoaded() ? ok("the watchdog is loaded (ca.e9g.watchdog)") : warn("the watchdog isn't loaded: e9g watchdog install (e9g start does it too)");

  const gh = spawnSync("gh", ["auth", "status"], { encoding: "utf8" });
  gh.status === 0 ? ok("gh is signed in (for GitHub boards)") : warn("gh isn't signed in; teams with a GitHub board need it");
  const df = spawnSync("df", ["-k", homedir()], { encoding: "utf8" }).stdout.trim().split("\n").pop()?.split(/\s+/);
  const freeGb = df ? Math.round(Number(df[3]) / 1024 / 1024) : null;
  if (freeGb !== null) (freeGb >= 20 ? ok : warn)(`${freeGb} GB free (each member's worktree holds a copy of dependencies and build output)`);

  for (const name of teamNames()) {
    const entry = readRegistry(name);
    if (!entry) continue;
    try {
      const team = loadTeam(entry.home);
      if (team.environment.needsDocker && spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0)
        warn(`${name}: needs Docker, which isn't running`);
      // Its agents run the registered version; e9g register would compile with the pinned one.
      const pin = team.factory ?? PACKAGE.version;
      if (!existsSync(versionDir(entry.version))) fail(`${name}: its agents run E9G Factory ${entry.version}, which isn't installed`);
      if (pin !== entry.version) warn(`${name}: pins E9G Factory ${pin} but is registered with ${entry.version} (e9g register ${entry.home})`);
      const roles = Object.keys(team.roles);
      if (pin !== PACKAGE.version && !existsSync(versionDir(pin))) {
        fail(`${name}: pins E9G Factory ${pin}, which isn't installed`);
        continue;
      }
      const stale = pin === PACKAGE.version ? roles.filter((role) => promptStale(team, role, entry.run)) : pinnedStale(pin, name, entry.run, roles);
      if (stale === null) warn(`${name}: rules load; its prompts are ${pin}'s, which doctor couldn't compile to compare (e9g prompt ${name} <role>)`);
      else if (stale.length) warn(`${name}: prompts out of date for ${stale.join(", ")} (e9g register ${entry.home})`);
      else ok(`${name}: rules load, prompts current${pin === PACKAGE.version ? "" : ` (judged by ${pin})`}`);
      const kept = keptWorktrees(entry.run);
      if (kept.length) warn(`${name}: ${kept.length} finished worktrees are kept because they may hold work (e9g status ${name} lists them)`);
    } catch (error) {
      fail(
        `${name}: ${String((error as Error).message)
          .split("\n")
          .slice(0, 3)
          .join(" ")}`
      );
    }
  }

  for (const [level, text] of results) console.info(`${level.padEnd(4)}  ${text}`);
  return results.some(([level]) => level === "FAIL") ? 1 : 0;
}
