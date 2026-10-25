// e9g doctor: is this machine ready to run teams? Checks the tools, T3 Code against the range this factory supports
// and against what its adapter reads, the launcher and the watchdog, disk space, and every registered team.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadTeam } from "../config.ts";
import { E9G_HOME, PACKAGE, readRegistry } from "../paths.ts";
import { promptStale } from "../prompts.ts";
import * as t3 from "../t3.ts";
import { which } from "../util.ts";
import { teamNames } from "./team.ts";
import { watchdogLoaded } from "./watchdog.ts";

const version = (command: string, args = ["--version"]): string | null => /(\d+\.\d+\.\d+)/.exec(spawnSync(command, args, { encoding: "utf8" }).stdout ?? "")?.[1] ?? null;

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
  (await t3.serverUp()) ? ok("T3 Code's server answers at 127.0.0.1:3773") : fail("T3 Code's server doesn't answer (t3 service restart)");

  // Agents run `e9g …`, so T3 Code's service must have the launcher's folder on its PATH.
  const plist = join(homedir(), "Library", "LaunchAgents", "com.t3tools.t3code.service.plist");
  const servicePath = existsSync(plist)
    ? spawnSync("plutil", ["-extract", "EnvironmentVariables.PATH", "raw", plist], { encoding: "utf8" }).stdout.trim()
    : "";
  const launcherDir = join(homedir(), ".local", "bin");
  if (!existsSync(join(E9G_HOME, "current"))) fail("E9G Factory isn't installed: e9g self-install (from a clone of the factory)");
  else ok(`E9G Factory ${PACKAGE.version} installed in ${E9G_HOME}`);
  if (!existsSync(join(launcherDir, "e9g"))) fail(`the launcher isn't at ${launcherDir}/e9g: e9g self-install`);
  else if (servicePath && !servicePath.split(":").includes(launcherDir))
    fail(`T3 Code's service PATH doesn't include ${launcherDir}, so agents can't run e9g`);
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
      fail(`the hooks would run ${hookNode} (${version(hookNode) ?? "unknown version"}), which can't run TypeScript: put Node 22.18 or newer first on T3 Code's PATH`);
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
      const stale = Object.keys(team.roles).filter((role) => promptStale(team, role, entry.run));
      stale.length
        ? warn(`${name}: prompts out of date for ${stale.join(", ")} (e9g register ${entry.home})`)
        : ok(`${name}: rules load, prompts current`);
      if (!existsSync(join(E9G_HOME, "versions", entry.version))) fail(`${name}: pins E9G Factory ${entry.version}, which isn't installed`);
    } catch (error) {
      fail(`${name}: ${String((error as Error).message).split("\n").slice(0, 3).join(" ")}`);
    }
  }

  for (const [level, text] of results) console.info(`${level.padEnd(4)}  ${text}`);
  return results.some(([level]) => level === "FAIL") ? 1 : 0;
}
