// e9g self-install [--link] [--force]: install this checkout's version of the factory into ~/.e9g/versions/<version>,
// make it the current one, and put the e9g launcher on PATH (~/.local/bin, which T3 Code's service also has).
// --link also points ~/.e9g/versions/dev at this checkout, for teams that pin "dev" while the factory is being
// worked on (the watchdog never runs from it: launchd can't read ~/Documents).
//
// e9g versions: what's installed, which is current, and which teams pin each.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { binDir, E9G_HOME, FACTORY_ROOT, PACKAGE, readRegistry, versionDir, versionsDir } from "../paths.mjs";
import { die, hash, parseArgs, readJson } from "../util.mjs";
import { teamNames } from "./team.mjs";

const LAUNCHER = `#!/usr/bin/env bash
# E9G Factory's launcher, written by e9g self-install. An agent's T3 instance sets E9G_VERSION, so each team runs the
# factory version it pins; a person gets the current version, which hands a team's commands to its pinned one.
E9G_HOME="\${E9G_HOME:-$HOME/.e9g}"
root="$E9G_HOME/current"
if [ -n "\${E9G_VERSION:-}" ] && [ -d "$E9G_HOME/versions/$E9G_VERSION" ]; then root="$E9G_HOME/versions/$E9G_VERSION"; fi
exec "\${E9G_NODE:-$(command -v node || echo __NODE__)}" "$root/bin/e9g.mjs" "$@"
`;

// The files a release is made of: tracked and untracked-but-not-ignored, so an install matches the working tree.
function sourceFiles() {
  try {
    return execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: FACTORY_ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    die(`${FACTORY_ROOT} isn't a git checkout; install from a clone of the factory`);
  }
}

const link = (target, path) => {
  try {
    if (lstatSync(path)) rmSync(path, { force: true, recursive: false });
  } catch {}
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path);
};

export function selfInstall(argv) {
  const { options } = parseArgs(argv, { booleans: ["link", "force"] });
  const version = PACKAGE.version;
  const dest = versionDir(version);
  const files = sourceFiles().filter((file) => existsSync(join(FACTORY_ROOT, file)));
  const contentHash = hash(...files.map((file) => `${file}\0${readFileSync(join(FACTORY_ROOT, file), "utf8")}`));
  const built = readJson(join(dest, ".build.json"));
  if (built && built.hash === contentHash) {
    console.info(`e9g: ${version} is already installed (${dest})`);
  } else {
    if (built && !options.force)
      die(
        `${version} is already installed with different files; bump the version in package.json for a release, or pass --force to replace it (teams pinned to it get the new files on their next session)`
      );
    rmSync(dest, { recursive: true, force: true });
    for (const file of files) cpSync(join(FACTORY_ROOT, file), join(dest, file), { recursive: true });
    for (const script of ["bin/e9g.mjs", ...files.filter((f) => f.endsWith(".sh"))])
      if (existsSync(join(dest, script))) chmodSync(join(dest, script), 0o755);
    const axe = join(FACTORY_ROOT, "node_modules", "axe-core");
    if (existsSync(axe)) cpSync(axe, join(dest, "node_modules", "axe-core"), { recursive: true });
    else if (spawnSync("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: dest, stdio: "inherit" }).status !== 0)
      console.warn("e9g: couldn't install axe-core; e9g pages will report it missing");
    const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: FACTORY_ROOT, encoding: "utf8" }).stdout.trim();
    const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: FACTORY_ROOT, encoding: "utf8" }).stdout.trim() !== "";
    writeFileSync(
      join(dest, ".build.json"),
      `${JSON.stringify({ version, commit, dirty, hash: contentHash, source: FACTORY_ROOT, at: new Date().toISOString() }, null, 2)}\n`
    );
    console.info(`e9g: installed ${version} (${commit}${dirty ? ", with uncommitted changes" : ""}) at ${dest}`);
  }
  link(dest, join(E9G_HOME, "current"));
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "e9g"), LAUNCHER.replace("__NODE__", process.execPath));
  chmodSync(join(binDir, "e9g"), 0o755);
  link(join(binDir, "e9g"), join(homedir(), ".local", "bin", "e9g"));
  if (options.link) {
    link(FACTORY_ROOT, versionDir("dev"));
    console.info(`e9g: versions/dev → ${FACTORY_ROOT}`);
  }
  console.info(`e9g: current is ${version}; the launcher is ~/.local/bin/e9g`);
  // Point an installed watchdog at the new current version.
  const plist = join(homedir(), "Library", "LaunchAgents", "ca.e9g.watchdog.plist");
  if (existsSync(plist)) spawnSync(process.execPath, [join(dest, "bin", "e9g.mjs"), "watchdog", "install"], { stdio: "inherit" });
  return 0;
}

export function versions() {
  const current = existsSync(join(E9G_HOME, "current")) ? realpathSync(join(E9G_HOME, "current")) : null;
  const pins = {};
  for (const name of teamNames()) (pins[readRegistry(name)?.version] ??= []).push(name);
  if (!existsSync(versionsDir)) return (console.info("nothing installed yet: e9g self-install"), 0);
  for (const version of readdirSync(versionsDir)) {
    const dir = versionDir(version);
    const build = readJson(join(dir, ".build.json"), {});
    const isCurrent = current && existsSync(dir) && realpathSync(dir) === current;
    console.info(
      `${isCurrent ? "*" : " "} ${version.padEnd(10)} ${build.commit ?? (lstatSync(dir).isSymbolicLink() ? `→ ${realpathSync(dir)}` : "")}${build.dirty ? " (dirty)" : ""}  ${pins[version]?.length ? `teams: ${pins[version].join(", ")}` : ""}`
    );
  }
  return 0;
}
