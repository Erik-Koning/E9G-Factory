// e9g self-install [--link] [--force]: install this checkout's version of the factory into ~/.e9g/versions/<version>,
// make it the current one, and put the e9g launcher on PATH (~/.local/bin, which T3 Code's service also has).
// --link also points ~/.e9g/versions/dev at this checkout, for teams that pin "dev" while the factory is being
// worked on (the watchdog never runs from it: launchd can't read ~/Documents). --force replaces an installed
// version whose files differ; the new copy is made beside it and renamed into place, so a hook never finds it half
// copied.
//
// e9g versions: what's installed, which is current, and which teams pin each.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { binDir, E9G_HOME, entryOf, FACTORY_ROOT, PACKAGE, readRegistry, versionDir, versionsDir } from "../paths.ts";
import { die, hash, parseArgs, readJson, which } from "../util.ts";
import { teamNames } from "./team.ts";

// What self-install records about an installed version (versions/<v>/.build.json).
interface Build {
  version: string;
  commit: string;
  dirty: boolean;
  hash: string;
  source: string;
  at: string;
}

const LAUNCHER = `#!/usr/bin/env bash
# E9G Factory's launcher, written by e9g self-install. An agent's T3 instance sets E9G_VERSION, so each team runs the
# factory version it pins; a person gets the current version, which hands a team's commands to its pinned one.
export E9G_HOME="\${E9G_HOME:-__E9G_HOME__}"
root="$E9G_HOME/current"
if [ -n "\${E9G_VERSION:-}" ] && [ -d "$E9G_HOME/versions/$E9G_VERSION" ]; then root="$E9G_HOME/versions/$E9G_VERSION"; fi
# Versions before 0.3.0 were JavaScript (bin/e9g.mjs). Node's compile cache keeps it from stripping the TypeScript
# again on every run; the factory drops it for anything it starts (lib/paths.ts).
entry="$root/bin/e9g.ts"
[ -f "$entry" ] || entry="$root/bin/e9g.mjs"
if [ -z "\${NODE_COMPILE_CACHE:-}" ]; then export NODE_COMPILE_CACHE="$root/.cache" E9G_NODE_CACHE=1; fi
exec "\${E9G_NODE:-$(command -v node || echo '__NODE__')}" "$entry" "$@"
`;

// The files a release is made of: tracked and untracked-but-not-ignored, so an install matches the working tree.
// Regular files only: a deleted file, or a symlink such as a worktree's linked node_modules, isn't part of it.
function sourceFiles(): string[] {
  let listed: string[];
  try {
    listed = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: FACTORY_ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    die(`${FACTORY_ROOT} isn't a git checkout; install from a clone of the factory`);
  }
  return listed.filter((file) => {
    try {
      return lstatSync(join(FACTORY_ROOT, file)).isFile();
    } catch {
      return false;
    }
  });
}

// A symlink made beside the old one and renamed over it, so the path always resolves.
const link = (target: string, path: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  rmSync(temporary, { force: true });
  symlinkSync(target, temporary);
  renameSync(temporary, path);
};

const within = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}${sep}`);
const real = (path: string): string => (existsSync(path) ? realpathSync(path) : resolve(path));
// A value inside the launcher's double quotes, and inside its single quotes.
const doubleQuoted = (text: string): string => text.replace(/[\\"$\x60]/g, "\\$&");
const singleQuoted = (text: string): string => text.replaceAll("'", "'\\''");

export function selfInstall(argv: string[]): number {
  const { options } = parseArgs(argv, { booleans: ["link", "force"] });
  const version = PACKAGE.version;
  const dest = versionDir(version);
  // An installed copy (run through the launcher) is never the source: replacing it would delete the files being
  // copied, and a home folder that's a git work tree would make it look like a checkout.
  if (within(real(FACTORY_ROOT), real(versionsDir)) || existsSync(join(FACTORY_ROOT, ".build.json")))
    die(`${FACTORY_ROOT} is an installed copy of E9G Factory; run self-install from a clone of the factory (node bin/e9g.ts self-install)`);
  const files = sourceFiles().filter((file) => existsSync(join(FACTORY_ROOT, file)));
  const contentHash = hash(...files.map((file) => `${file}\0${readFileSync(join(FACTORY_ROOT, file), "utf8")}`));
  const built = readJson<Build>(join(dest, ".build.json"));
  // The same files: nothing to copy, unless --force asks for the release to be made again (to record its commit).
  if (built && built.hash === contentHash && !options["force"]) {
    console.info(`e9g: ${version} is already installed (${dest})`);
  } else {
    if (built && !options["force"])
      die(
        `${version} is already installed with different files; bump the version in package.json for a release, or pass --force to replace it (teams pinned to it pick up the new files at once: hooks on their next tool call, commands on their next run)`
      );
    // Copy into a folder beside it, then swap: the old copy is renamed away, the new one into its place.
    const staging = join(versionsDir, `.${version}.installing-${process.pid}`);
    rmSync(staging, { recursive: true, force: true });
    for (const file of files) cpSync(join(FACTORY_ROOT, file), join(staging, file), { recursive: true });
    for (const script of ["bin/e9g.ts", ...files.filter((f) => f.endsWith(".sh"))])
      if (existsSync(join(staging, script))) chmodSync(join(staging, script), 0o755);
    const axe = join(FACTORY_ROOT, "node_modules", "axe-core");
    if (existsSync(axe)) cpSync(axe, join(staging, "node_modules", "axe-core"), { recursive: true });
    else if (spawnSync("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: staging, stdio: "inherit" }).status !== 0)
      console.warn("e9g: couldn't install axe-core; e9g pages will report it missing");
    const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: FACTORY_ROOT, encoding: "utf8" }).stdout.trim();
    const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: FACTORY_ROOT, encoding: "utf8" }).stdout.trim() !== "";
    writeFileSync(
      join(staging, ".build.json"),
      `${JSON.stringify({ version, commit, dirty, hash: contentHash, source: FACTORY_ROOT, at: new Date().toISOString() }, null, 2)}\n`
    );
    let old: string | null = null;
    try {
      lstatSync(dest);
      old = join(versionsDir, `.${version}.replaced-${process.pid}`);
      renameSync(dest, old);
    } catch {}
    renameSync(staging, dest);
    if (old) rmSync(old, { recursive: true, force: true });
    console.info(`e9g: installed ${version} (${commit}${dirty ? ", with uncommitted changes" : ""}) at ${dest}`);
  }
  link(dest, join(E9G_HOME, "current"));
  // The node the launcher falls back to when PATH has none: the name PATH finds it by (Homebrew's
  // /opt/homebrew/bin/node), not the versioned folder process.execPath resolves to, which an upgrade removes.
  const onPath = which("node");
  const node = onPath && real(onPath) === real(process.execPath) ? onPath : process.execPath;
  // A launcher for an E9G_HOME other than ~/.e9g remembers it.
  const home = E9G_HOME === join(homedir(), ".e9g") ? "$HOME/.e9g" : doubleQuoted(E9G_HOME);
  mkdirSync(binDir, { recursive: true });
  const launcher = join(binDir, "e9g");
  const temporary = `${launcher}.${process.pid}.tmp`;
  writeFileSync(
    temporary,
    LAUNCHER.replace("__E9G_HOME__", () => home).replace("__NODE__", () => singleQuoted(node))
  );
  chmodSync(temporary, 0o755);
  renameSync(temporary, launcher);
  const launcherDir = join(homedir(), ".local", "bin");
  link(launcher, join(launcherDir, "e9g"));
  if (options["link"]) {
    link(FACTORY_ROOT, versionDir("dev"));
    console.info(`e9g: versions/dev → ${FACTORY_ROOT}`);
  }
  console.info(`e9g: current is ${version}; the launcher is ${join(launcherDir, "e9g")}`);
  if (!(process.env.PATH ?? "").split(":").includes(launcherDir))
    console.warn(`e9g: ${launcherDir} isn't on your PATH: add it in your shell's profile (export PATH="$HOME/.local/bin:$PATH"), or run ${launcher}`);
  // Point an installed watchdog at the new current version.
  const plist = join(homedir(), "Library", "LaunchAgents", "ca.e9g.watchdog.plist");
  if (existsSync(plist)) spawnSync(process.execPath, [entryOf(dest), "watchdog", "install"], { stdio: "inherit" });
  return 0;
}

export function versions(): number {
  const current = existsSync(join(E9G_HOME, "current")) ? realpathSync(join(E9G_HOME, "current")) : null;
  const pins: Record<string, string[]> = {};
  for (const name of teamNames()) {
    const version = readRegistry(name)?.version;
    if (version) (pins[version] ??= []).push(name);
  }
  if (!existsSync(versionsDir)) return (console.info("nothing installed yet: e9g self-install"), 0);
  // Dot folders are installs in progress.
  for (const version of readdirSync(versionsDir).filter((name) => !name.startsWith("."))) {
    const dir = versionDir(version);
    const build = readJson<Partial<Build>>(join(dir, ".build.json"), {});
    const isCurrent = current && existsSync(dir) && realpathSync(dir) === current;
    // A link (versions/dev) can outlive the checkout it points at.
    const target = lstatSync(dir).isSymbolicLink() ? resolve(dirname(dir), readlinkSync(dir)) : null;
    const where = target ? `→ ${target}${existsSync(dir) ? "" : " (missing: link it again with self-install --link, or remove it)"}` : "";
    console.info(
      `${isCurrent ? "*" : " "} ${version.padEnd(10)} ${build.commit ?? where}${build.dirty ? " (dirty)" : ""}  ${pins[version]?.length ? `teams: ${pins[version].join(", ")}` : ""}`
    );
  }
  return 0;
}
