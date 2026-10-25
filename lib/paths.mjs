// Where E9G Factory keeps things on this machine, and how a command finds the team it belongs to.
//
//   ~/.e9g/                     (E9G_HOME) outside ~/Documents, which launchd jobs can't read, and without spaces,
//     bin/e9g                   because T3 Code passes each agent's launch flags as one string
//     versions/<version>/       installed releases of the factory; each team runs the one its team.json pins
//     teams/<name>.json         the registry: one file per team, written by `e9g register`
//     runs/<name>/              per team: the planner's thread, prompts, heartbeats, outbox, pause and watchdog log
//
//   <team checkout>/.e9g/       the team's own sources (team.json, brief, notes, adapters) and run/ (gitignored)
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FACTORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PACKAGE = JSON.parse(readFileSync(join(FACTORY_ROOT, "package.json"), "utf8"));
export const E9G_HOME = resolve(process.env.E9G_HOME ?? join(homedir(), ".e9g"));
export const binDir = join(E9G_HOME, "bin");
export const teamsDir = join(E9G_HOME, "teams");
export const versionsDir = join(E9G_HOME, "versions");
export const registryFile = (name) => join(teamsDir, `${name}.json`);
export const defaultRunDir = (name) => join(E9G_HOME, "runs", name);
export const versionDir = (version) => join(versionsDir, version);
export const pluginDir = (version) => join(versionDir(version), "plugin");

// The team's sources and its runtime folder inside its checkout.
export const teamDir = (home) => join(home, ".e9g");
export const teamFile = (home) => join(home, ".e9g", "team.json");
export const workDir = (home) => join(home, ".e9g", "run");
export const stateDir = (home) => join(home, ".e9g", "run", "state");
export const boardDir = (home) => join(home, ".e9g", "run", "board");
export const locksDir = (home) => join(home, ".e9g", "run", "locks");

// The checkout a command works for. An agent's T3 instance sets E9G_HOME_DIR (its own worktree is a branch copy,
// and a branch must not change the rules it runs under). A person runs commands inside the checkout, or names
// the team (--team), which the registry resolves.
export function findHome({ cwd = process.cwd(), team } = {}) {
  if (team) {
    const entry = readRegistry(team);
    if (!entry) throw new Error(`no team named ${team} is registered (e9g teams lists them)`);
    return entry.home;
  }
  if (process.env.E9G_HOME_DIR) return resolve(process.env.E9G_HOME_DIR);
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(teamFile(dir))) return realpathSync(dir);
    if (dirname(dir) === dir) return null;
  }
}

export function readRegistry(name) {
  const file = registryFile(name);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}
