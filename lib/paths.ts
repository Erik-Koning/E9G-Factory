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
import type { Team } from "./config.ts";

// The launcher, the hooks and the watchdog start Node with its compile cache on (NODE_COMPILE_CACHE), so the .ts
// files aren't stripped of their types again on every call. It's for the factory's own process: what the factory
// starts (a gate, the team's scripts, T3 Code) runs without it.
if (process.env.E9G_NODE_CACHE) {
  delete process.env.NODE_COMPILE_CACHE;
  delete process.env.E9G_NODE_CACHE;
}

export const FACTORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export interface FactoryPackage {
  version: string;
  e9g: { t3code: string; claudeCode: string };
}
export const PACKAGE = JSON.parse(readFileSync(join(FACTORY_ROOT, "package.json"), "utf8")) as FactoryPackage;
export const E9G_HOME = resolve(process.env.E9G_HOME ?? join(homedir(), ".e9g"));
export const binDir = join(E9G_HOME, "bin");
export const teamsDir = join(E9G_HOME, "teams");
export const versionsDir = join(E9G_HOME, "versions");
export const registryFile = (name: string): string => join(teamsDir, `${name}.json`);
export const defaultRunDir = (name: string): string => join(E9G_HOME, "runs", name);
export const versionDir = (version: string): string => join(versionsDir, version);
// What a team may pin (team.json "factory"): a release's version, or "dev". Never a path.
export const VERSION_NAME = /^(dev|\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?)$/;
export const pluginDir = (version: string): string => join(versionDir(version), "plugin");

// The team's sources and its runtime folder inside its checkout.
export const teamDir = (home: string): string => join(home, ".e9g");
export const teamFile = (home: string): string => join(home, ".e9g", "team.json");
export const workDir = (home: string): string => join(home, ".e9g", "run");
export const stateDir = (home: string): string => join(home, ".e9g", "run", "state");
export const boardDir = (home: string): string => join(home, ".e9g", "run", "board");
export const locksDir = (home: string): string => join(home, ".e9g", "run", "locks");

// The checkout a command works for. An agent's T3 instance sets E9G_HOME_DIR (its own worktree is a branch copy,
// and a branch must not change the rules it runs under). A person runs commands inside the checkout, or names
// the team (--team), which the registry resolves.
export function findHome({ cwd = process.cwd(), team }: { cwd?: string; team?: string | undefined } = {}): string | null {
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

// A team's registry entry, written by `e9g register`.
export interface RegistryEntry {
  name: string;
  title: string;
  home: string;
  run: string;
  project: string;
  version: string;
  plannerInstance: string;
  model: string;
  health: string[];
  needsDocker: boolean;
  worktreesDir: string;
  watchdog: Team["watchdog"];
  // Missing in entries registered before the setting existed: priority (registeredContact).
  contact?: Team["contact"];
  startPrompt: string;
  registeredAt: string;
}

export function readRegistry(name: string): RegistryEntry | null {
  const file = registryFile(name);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as RegistryEntry) : null;
}

// A version's command line: bin/e9g.ts, or bin/e9g.mjs in versions before the move to TypeScript.
export function entryOf(root: string): string {
  const ts = join(root, "bin", "e9g.ts");
  return existsSync(ts) ? ts : join(root, "bin", "e9g.mjs");
}
