// The guard's rules, run before every tool call an agent on an E9G team makes (plugin/hooks/guard.ts is the hook,
// which fails closed around this). It keeps each role in its lane, keeps the whole team away from what its policies
// deny (deploys, hosted data, publishing, payments, messages, secrets), and enforces what the planner would otherwise
// only remember: members per role, who records verdicts, who merges, the push cadence, a pause.
// Rules come from the team's .e9g/team.json in its checkout, never a worktree's copy, so a branch can't change the
// rules it runs under. In setup (E9G_SETUP=1) the setup agent may write only .e9g/.
// Each shell command is judged on its own, where it runs (cd, git -C, GIT_DIR): the planner's and the read-only roles'
// git rules hold in the team's checkout, not in the /tmp worktrees they inspect branches in. A shell write outside a
// lane passes only where git ignores it, asked once for all of a call's paths.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { FACTORY_PATH, factoryWrite, instanceId, type Lane, laneAllows, normalize as normalizeTeam, roleForInstance, type Team } from "./config.ts";
import { E9G_HOME } from "./paths.ts";
import { issueCreateLabels, PLANNER_LABEL, PLANNER_TAG } from "./labels.ts";
import { brokenRule, commandRules, END, isSecretFile, isSecretWord, OPERATOR_COMMANDS, START } from "./policies.ts";
import { type HookInput, inSetup, inTeam, setupRole, teamSession } from "./session.ts";
import {
  expandPath,
  fileWords,
  gitGlobals,
  lines,
  NAMES_ONLY,
  operands,
  parseShell,
  type ShellCommand,
  stripGlob,
  unwrap,
  withoutExcludes,
} from "./shell.ts";
import { runningByInstance, T3_HOME, TOOLS } from "./t3.ts";
import { escapeRegex } from "./util.ts";

// What the guard says when it refuses a call; the hook turns it into exit 2.
export class Refusal extends Error {
  role: string;
  constructor(role: string, reason: string) {
    super(reason);
    this.name = "Refusal";
    this.role = role;
  }
}

const WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
const SETUP_COMMANDS = ["check", "register", "start", "doctor", "prompt", "teams", "status", "metrics", "versions", "help"];
// git subcommands a read-only role doesn't run in the checkout, and those that move the branch checked out.
const GIT_WRITES = [
  "checkout",
  "switch",
  "stash",
  "reset",
  "restore",
  "clean",
  "commit",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "pull",
  "am",
  "apply",
  "tag",
  "branch",
  "push",
  "mv",
  "rm",
];
const GIT_MOVES = ["commit", "merge", "rebase", "cherry-pick", "revert", "am", "pull", "reset"];
const SECRET = "agents never read or write them. The team's environment has what it needs.";

const inside = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`);
const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : typeof value === "string" ? [value] : []);
const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

// A path with its symlinks and .. resolved, as far as it exists (/tmp/../x; /tmp is /private/tmp on macOS).
function canonical(path: string): string {
  const absolute = resolve(path);
  const rest: string[] = [];
  for (let dir = absolute; ; dir = dirname(dir)) {
    try {
      return join(realpathSync(dir), ...rest);
    } catch {}
    if (dirname(dir) === dir) return absolute;
    rest.unshift(basename(dir));
  }
}

function gitOut(dir: string, ...args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}
const currentBranch = (dir: string): string | null => gitOut(dir, "symbolic-ref", "--short", "-q", "HEAD");

// git reset moves the branch when it's given a mode or a commit other than the one checked out; with only paths
// (git reset -- a.md, git reset HEAD a.md) it unstages.
function resetMoves(rest: string[], dir: string): boolean {
  if (rest.some((arg) => /^--(soft|mixed|hard|merge|keep)$/.test(arg))) return true;
  const dash = rest.indexOf("--");
  const first = (dash < 0 ? rest : rest.slice(0, dash)).find((arg) => !arg.startsWith("-"));
  if (first === undefined) return false;
  const commit = gitOut(dir, "rev-parse", "--verify", "-q", `${first}^{commit}`);
  if (commit === null) return /[~^@]/.test(first);
  return commit !== gitOut(dir, "rev-parse", "--verify", "-q", "HEAD");
}

// The listing forms of git branch, git tag and git stash, which change nothing.
function listsOnly(sub: string, rest: string[]): boolean {
  if (sub === "stash") return /^(list|show)$/.test(rest[0] ?? "");
  if (sub !== "branch" && sub !== "tag") return false;
  let listing = false;
  let positional = 0;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg === "--list" || arg === "-l") listing = true;
    else if (sub === "branch" && /^-[arvl]+$/.test(arg)) listing ||= arg.includes("l");
    else if (sub === "tag" && /^-n\d*$/.test(arg)) listing = true;
    else if (
      /^--(all|remotes|verbose|show-current|ignore-case|color|no-color|column|no-column|omit-empty|abbrev|no-abbrev)(=.*)?$/.test(arg) ||
      arg === "-i"
    )
      continue;
    else if (/^--(sort|format|contains|no-contains|merged|no-merged|points-at)=/.test(arg)) continue;
    else if (/^--(sort|format|points-at)$/.test(arg)) i++;
    else if (/^--(contains|no-contains|merged|no-merged)$/.test(arg)) {
      if (rest[i + 1] !== undefined && !rest[i + 1]?.startsWith("-")) i++;
    } else if (arg.startsWith("-")) return false;
    else positional++;
  }
  return positional === 0 || listing;
}

// git config that writes the repository's .git/config, which the team's checkout and every worktree share.
function configWrites(rest: string[]): boolean {
  if (rest.includes("--worktree")) return false;
  const file = rest.findIndex((arg) => arg === "-f" || arg === "--file");
  const named = file >= 0 ? rest[file + 1] : rest.find((arg) => arg.startsWith("--file="))?.slice(7);
  if (named !== undefined && !/(^|\/)\.git(\/|$)/.test(named)) return false;
  if (rest.includes("--blob") || rest.some((arg) => arg.startsWith("--blob="))) return false;
  const verb = rest.find((arg) => !arg.startsWith("-"));
  if (verb && /^(set|unset|rename-section|remove-section|edit)$/.test(verb) && rest.indexOf(verb) === rest.findIndex((arg) => !arg.startsWith("-")))
    return true;
  if (rest.some((arg) => /^(--(add|unset|unset-all|replace-all|rename-section|remove-section|edit)|-e)$/.test(arg))) return true;
  if (rest.some((arg) => /^(--(get|get-all|get-regexp|get-urlmatch|get-color|get-colorbool|list|show-origin|show-scope)|-l)$/.test(arg))) return false;
  return operands(rest, ["-f", "--file", "--type", "--default", "--comment", "-t"]).filter((arg) => !/^(get|list)$/.test(arg)).length >= 2;
}

// A path a command writes: whether it deletes it, and whether it's a folder it makes.
interface Target {
  path: string;
  deletes: boolean;
  folder: boolean;
}

// The paths a command writes: redirect targets, tee, sed -i and perl -i files, what cp, mv, ln and install write
// (into a folder: the file of the same name in it) and mv's sources, the operands of rm, touch, truncate and mkdir,
// git rm and git mv, and what git restore and git checkout -- … put back. Approximate on purpose: it catches the
// ordinary ways round the file tools, and the merge queue checks every lane again.
function writeTargets(words: string[], command: ShellCommand): Target[] {
  const targets: Target[] = [];
  const add = (paths: string[], { deletes = false, folder = false } = {}, cwd = command.cwd) => {
    for (const word of paths) {
      const path = expandPath(word, cwd);
      if (path && !path.startsWith("/dev/")) targets.push({ path, deletes, folder });
    }
  };
  // cp a b dir/, mv a dir, cp -t dir a b: each source lands in the folder under its own name.
  const copies = (files: string[], into: string | undefined, plain: boolean, cwd: string) => {
    if (into !== undefined)
      return add(
        files.map((file) => join(into, basename(file))),
        {},
        cwd
      );
    const destination = files.pop();
    if (destination === undefined) return;
    const at = expandPath(destination, cwd);
    const folder = !plain && files.length > 0 && (files.length > 1 || destination.endsWith("/") || (at !== null && isDirectory(at)));
    add(folder ? files.map((file) => join(destination, basename(file))) : [destination], {}, cwd);
  };
  add(command.redirects);
  const verb = basename(words[0] ?? "");
  const rest = words.slice(1);
  if (verb === "tee") add(operands(rest));
  else if (/^(rm|rmdir|unlink|shred)$/.test(verb)) add(operands(rest), { deletes: true });
  else if (verb === "touch") add(operands(rest, ["-t", "-d", "-r", "-A"]));
  else if (verb === "truncate") add(operands(rest, ["-s", "--size", "-r", "--reference"]));
  else if (verb === "mkdir") add(operands(rest, ["-m", "--mode"]), { folder: true });
  else if (verb === "sed" || verb === "perl") add(inPlaceFiles(verb, rest));
  else if (/^(cp|mv|ln|install)$/.test(verb)) {
    const files = operands(rest, ["-t", "--target-directory", "-S", "--suffix", "-m", "--mode", "-o", "--owner", "-g", "--group"]);
    const t = rest.findIndex((arg) => arg === "-t" || arg === "--target-directory");
    const into = t >= 0 ? rest[t + 1] : rest.find((arg) => arg.startsWith("--target-directory="))?.slice(19);
    // -T, and ln -n: the destination is the name itself, never a folder to put things in.
    const plain = rest.some((arg) => arg === "-T" || arg === "--no-target-directory" || (verb === "ln" && /^-[a-zA-Z]*[nh]/.test(arg)));
    const sources = verb === "mv" ? (into === undefined ? files.slice(0, -1) : [...files]) : [];
    copies(files, into, plain, command.cwd);
    add(sources, { deletes: true });
  } else if (verb === "git") {
    const { args, dirs } = gitGlobals(words);
    let dir = command.cwd;
    for (const d of dirs) dir = expandPath(d, dir) ?? dir;
    const [sub = "", ...more] = args;
    if (sub === "rm") add(operands(more), { deletes: !more.includes("--cached") }, dir);
    else if (sub === "mv") {
      const files = operands(more);
      add(files.slice(0, -1), { deletes: true }, dir);
      copies(files, undefined, false, dir);
    } else if (sub === "restore" || (sub === "checkout" && more.includes("--"))) targets.push(...restored(sub, more, dir));
  }
  return targets;
}

// What git restore or git checkout [<commit>] -- <paths> writes: a file it names, and in a folder it names (git
// restore ., git checkout -- e2e) the files that differ from what it puts back (git diff), so a tester can discard its
// own changes. --staged alone writes only the index.
function restored(sub: string, more: string[], dir: string): Target[] {
  let source: string | null = null;
  let staged = false;
  let worktree = false;
  const paths: string[] = [];
  if (sub === "restore") {
    for (let i = 0; i < more.length; i++) {
      const arg = more[i] as string;
      const [option = "", inline] = arg.startsWith("--") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
      if (arg === "--") {
        paths.push(...more.slice(i + 1));
        break;
      }
      if (option === "-s" || option === "--source") source = inline ?? more[++i] ?? null;
      else if (/^-s./.test(arg)) source = arg.slice(2);
      else if (option === "--staged") staged = true;
      else if (option === "--worktree") worktree = true;
      else if (/^-[a-zA-Z]+$/.test(arg)) {
        staged ||= arg.includes("S");
        worktree ||= arg.includes("W");
      } else if (!arg.startsWith("-")) paths.push(arg);
    }
    if (staged && !worktree) return [];
  } else {
    const dash = more.indexOf("--");
    source = more.slice(0, dash).find((arg) => !arg.startsWith("-")) ?? null;
    paths.push(...more.slice(dash + 1));
  }
  const files: Target[] = [];
  const folders: string[] = [];
  for (const path of paths) {
    const absolute = expandPath(path, dir);
    // A glob or a pathspec with magic (':(glob)…') names files the way a folder does.
    if (absolute && !isDirectory(absolute) && !/[*?[]/.test(path) && !path.startsWith(":")) files.push({ path: absolute, deletes: false, folder: false });
    else folders.push(path);
  }
  if (!folders.length) return files;
  // What it puts back: the commit it names, else HEAD for --staged, else the index.
  const from = source ?? (staged ? "HEAD" : null);
  const top = gitOut(dir, "rev-parse", "--show-toplevel");
  const changed = top === null ? null : gitOut(dir, "diff", "--name-only", "-z", "--no-renames", ...(from === null ? [] : [from]), "--", ...folders);
  if (top === null || changed === null)
    return [...files, ...folders.flatMap((path) => expandPath(path, dir) ?? []).map((path) => ({ path, deletes: false, folder: true }))];
  return [
    ...files,
    ...changed
      .split("\0")
      .filter(Boolean)
      .map((rel) => ({ path: join(top, rel), deletes: false, folder: false })),
  ];
}

// The files sed -i or perl -i edit in place: the operands that aren't its script (-e and -f values, or the first
// operand without them), nor BSD sed's backup suffix (sed -i '' …).
function inPlaceFiles(verb: string, args: string[]): string[] {
  let inPlace = false;
  let script = false;
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--") {
      files.push(...args.slice(i + 1));
      break;
    }
    if (/^--in-place(=|$)/.test(arg)) inPlace = true;
    else if (/^--(expression|file)$/.test(arg)) {
      script = true;
      i++;
    } else if (/^--(expression|file)=/.test(arg)) script = true;
    else if (/^-[a-zA-Z]/.test(arg)) {
      for (let k = 1; k < arg.length; k++) {
        const letter = arg[k] as string;
        if (letter === "i" || (verb === "sed" && letter === "I")) {
          inPlace = true;
          if (k === arg.length - 1 && verb === "sed" && (args[i + 1] === "" || /^\.\w*$/.test(args[i + 1] ?? ""))) i++;
          break;
        }
        if (letter === "e" || (verb === "sed" ? letter === "f" : letter === "E")) {
          script = true;
          if (k === arg.length - 1) i++;
          break;
        }
      }
    } else if (!arg.startsWith("-")) files.push(arg);
  }
  if (!inPlace) return [];
  if (!script) files.shift();
  return files;
}

// --- Searches ----------------------------------------------------------------------------------------------------

// A glob a search takes files in with, or keeps them out with (rg -g, grep --include and --exclude, the Grep tool's
// glob), as a regex over a file's name or its path in the search.
interface Glob {
  take: boolean;
  match: RegExp;
}
// What a search reads that git would skip: the folders it searches, its globs, and whether it reads ignored and hidden
// files when no glob decides. grep -r reads them all; rg and the Grep tool skip them, unless told otherwise.
interface Search {
  paths: string[];
  globs: Glob[];
  ignored: boolean;
  hidden: boolean;
}

// A glob as a regex: * and ? within a folder, ** across them, [ … ] and {a,b}.
function globSource(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    const close = c === "[" ? glob.indexOf("]", i + 2) : c === "{" ? glob.indexOf("}", i) : -1;
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        out += "(?:.*/)?";
      } else out += ".*";
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "[" && close > 0) {
      out += `[${glob
        .slice(i + 1, close)
        .replace(/^!/, "^")
        .replace(/\\/g, "\\\\")}]`;
      i = close;
    } else if (c === "{" && close > 0) {
      out += `(?:${glob
        .slice(i + 1, close)
        .split(",")
        .map(globSource)
        .join("|")})`;
      i = close;
    } else if (c === "\\" && i + 1 < glob.length) out += escapeRegex(glob[++i] as string);
    else out += escapeRegex(c);
  }
  return out;
}
const glob = (pattern: string, { take = !pattern.startsWith("!"), icase = false } = {}): Glob => ({
  take,
  match: new RegExp(`^${globSource(pattern.replace(/^!/, "").replace(/^\//, ""))}$`, icase ? "i" : ""),
});

// grep -r: the folders and files it searches (its working directory when it names none), and its --include and
// --exclude globs. It reads ignored and hidden files alike.
function grepSearch(words: string[]): Search | null {
  if (!/^[ef]?grep$/.test(basename(words[0] ?? ""))) return null;
  let recursive = false;
  let pattern = false;
  const found: string[] = [];
  const globs: Glob[] = [];
  const rest = words.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    const [option = "", inline] = arg.startsWith("--") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    if (arg === "--") {
      found.push(...rest.slice(i + 1));
      break;
    }
    if (/^--(recursive|dereference-recursive)$/.test(arg)) recursive = true;
    else if (/^--(regexp|file)$/.test(option)) {
      pattern = true;
      if (inline === undefined) i++;
    } else if (option === "--include" || option === "--exclude") globs.push(glob(inline ?? rest[++i] ?? "", { take: option === "--include" }));
    else if (/^--(exclude-dir|context|after-context|before-context|max-count|label|binary-files|devices|directories)$/.test(arg)) i++;
    else if (arg.startsWith("--")) continue;
    else if (/^-./.test(arg)) {
      const at = arg.slice(1).search(/[efABCmdD]/);
      const flags = at < 0 ? arg.slice(1) : arg.slice(1, at + 1);
      if (/[rR]/.test(flags)) recursive = true;
      if (at >= 0) {
        if (/[ef]/.test(arg[at + 1] ?? "")) pattern = true;
        if (at + 2 === arg.length) i++;
      }
    } else found.push(arg);
  }
  if (!recursive) return null;
  if (!pattern) found.shift();
  return { paths: found.length ? found : ["."], globs, ignored: true, hidden: true };
}

// rg with what overrides its skipping of ignored and hidden files: globs that take files in (-g, --glob, --iglob),
// -u/-uu, --no-ignore… and --hidden. rg --files lists names and reads nothing.
const RG_VALUED =
  /^--(after-context|before-context|context|color|colors|context-separator|encoding|engine|field-context-separator|field-match-separator|hostname-bin|hyperlink-format|ignore-file|max-columns|max-count|max-depth|maxdepth|max-filesize|path-separator|pre|pre-glob|replace|sort|sortr|threads|type|type-add|type-clear|type-not|dfa-size-limit|regex-size-limit|generate)$/;
function rgSearch(words: string[]): Search | null {
  if (basename(words[0] ?? "") !== "rg") return null;
  let pattern = false;
  let unrestricted = 0;
  let ignored = false;
  let hidden = false;
  let names = false;
  const found: string[] = [];
  const globs: Glob[] = [];
  const rest = words.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    const [option = "", inline] = arg.startsWith("--") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    if (arg === "--") {
      found.push(...rest.slice(i + 1));
      break;
    }
    if (option === "--glob" || option === "--iglob") globs.push(glob(inline ?? rest[++i] ?? "", { icase: option === "--iglob" }));
    else if (option === "--regexp" || option === "--file") {
      pattern = true;
      if (inline === undefined) i++;
    } else if (option.startsWith("--no-ignore")) ignored = true;
    else if (option === "--hidden") hidden = true;
    else if (option === "--unrestricted") unrestricted++;
    else if (option === "--files") names = true;
    else if (arg.startsWith("--")) {
      if (inline === undefined && RG_VALUED.test(option)) i++;
    } else if (/^-./.test(arg))
      for (let k = 1; k < arg.length; k++) {
        const flag = arg[k] as string;
        if (flag === "u") unrestricted++;
        else if (flag === ".") hidden = true;
        else if ("ABCdEefgjMmrTt".includes(flag)) {
          const value = arg.slice(k + 1) || (rest[++i] ?? "");
          if (flag === "g") globs.push(glob(value));
          if (flag === "e" || flag === "f") pattern = true;
          break;
        }
      }
    else found.push(arg);
  }
  ignored ||= unrestricted >= 1;
  hidden ||= unrestricted >= 2;
  if (names || (!ignored && !hidden && !globs.some((g) => g.take))) return null;
  if (!pattern) found.shift();
  return { paths: found.length ? found : ["."], globs, ignored, hidden };
}

// git grep --no-index (or --untracked --no-exclude-standard) searches the files git doesn't track, ignored ones too.
function gitGrepSearch(words: string[], cwd: string): Search | null {
  if (basename(words[0] ?? "") !== "git") return null;
  const { args, dirs } = gitGlobals(words);
  const [sub, ...rest] = args;
  if (sub !== "grep") return null;
  const untracked =
    (rest.includes("--no-index") && !rest.includes("--exclude-standard")) || (rest.includes("--untracked") && rest.includes("--no-exclude-standard"));
  if (!untracked) return null;
  let dir = cwd;
  for (const d of dirs) dir = expandPath(d, dir) ?? dir;
  let pattern = false;
  const found: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg === "--") {
      found.push(...rest.slice(i + 1));
      break;
    }
    if (/^-[ef]$/.test(arg)) {
      pattern = true;
      i++;
    } else if (/^(-[ABCm]|--max-count|--max-depth|--threads|--context|--after-context|--before-context)$/.test(arg)) i++;
    else if (!arg.startsWith("-")) found.push(arg);
  }
  if (!pattern) found.shift();
  return { paths: (found.length ? found : ["."]).map((path) => expandPath(path, dir) ?? path), globs: [], ignored: true, hidden: true };
}

// The secret files in a folder (or the file itself), below node_modules and .git; null when the folder is too big to
// look through.
function secretsUnder(path: string): string[] | null {
  try {
    if (!statSync(path).isDirectory()) return isSecretFile(path) ? [path] : [];
  } catch {
    return [];
  }
  const found: string[] = [];
  const queue = [path];
  let seen = 0;
  while (queue.length) {
    const dir = queue.shift() as string;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++seen > 20_000) return null;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!/^(node_modules|\.git)$/.test(entry.name)) queue.push(full);
      } else if (isSecretFile(full)) found.push(full);
    }
  }
  return found;
}
// What a folder too big to look through is judged by: the names secret files usually have.
const USUAL_SECRETS = [".env", ".env.local", ".env.production", ".envrc", ".dev.vars", ".npmrc", "server.key", "cert.pem"];

// The first secret file a search reads, or null. The last glob that matches a file decides; when none does, a search
// with globs that take files in skips it, and one without reads it unless git would skip it (ignored or hidden).
function secretRead(search: Search, at: string): string | null {
  const found = secretsUnder(at);
  const files = found ?? USUAL_SECRETS.map((name) => join(at, name));
  const unsure: string[] = [];
  for (const file of files) {
    const rel = relative(at, file) || basename(file);
    const decided = [...search.globs].reverse().find((g) => g.match.test(basename(file)) || g.match.test(rel));
    if (decided) {
      if (decided.take) return file;
    } else if (!search.globs.some((g) => g.take) && (search.hidden || !rel.split("/").some((part) => part.startsWith(".")))) unsure.push(file);
  }
  if (search.ignored) return unsure[0] ?? null;
  const dir = isDirectory(at) ? at : dirname(at);
  const skipped = new Set(
    checkIgnore(
      dir,
      unsure.map((file) => relative(dir, file))
    )
  );
  return unsure.find((file) => !skipped.has(relative(dir, file))) ?? null;
}

// The paths git ignores, of those given (relative to `dir`): one git check-ignore for them all. None when git can't
// say (no repository).
function checkIgnore(dir: string, paths: string[]): string[] {
  if (!paths.length) return [];
  let out = "";
  try {
    out = execFileSync("git", ["check-ignore", "--stdin", "-z"], {
      cwd: dir,
      input: paths.join("\0"),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch (error) {
    // Exit 1: none of them is ignored.
    out = String((error as { stdout?: unknown }).stdout ?? "");
  }
  return out.split("\0").filter(Boolean);
}

// The commands only some roles run: [regex over a command line, roles allowed, reason].
function ownedCommands(team: Team): [RegExp, string[], string][] {
  const e9g = (subcommands: string) => new RegExp(`${START}e9g\\s+(?:${subcommands})${END}`);
  // The environment script itself, called by its path (scripts/loop/env.sh reset), is the planner's too.
  const script =
    String(team.environment.script ?? "")
      .split(/\s+/)[0]
      ?.split("/")
      .pop() ?? "";
  return [
    [e9g("merge|log|drain\\s+(?!status(?:$|\\s))\\S+"), ["planner"], "the planner merges, keeps the log and drains the environment."],
    [e9g("env\\s+(?:up|reset|restart|down)"), ["planner"], "only the planner starts, resets or stops the team's environment."],
    [e9g("pages\\s+run"), ["planner"], "the planner records page results; use e9g pages shots to check anything yourself."],
    [e9g("verdict\\s+review"), ["reviewer"], "only a reviewer records a review (Article 4)."],
    [e9g("verdict\\s+ux"), ["ux-specialist"], "only the UX specialist records a UX verdict (Article 4)."],
    ...(script
      ? [
          [
            new RegExp(`${START}${escapeRegex(script)}\\s+(?:up|reset|restart|down)${END}`),
            ["planner"],
            "only the planner starts, resets or stops the team's environment (e9g env …).",
          ] as [RegExp, string[], string],
        ]
      : []),
    ...(Array.isArray(team.commandOwners) ? team.commandOwners : []).map(({ rule, roles, reason }): [RegExp, string[], string] => [
      new RegExp(rule),
      list(roles),
      reason ?? "that command belongs to another role.",
    ]),
  ];
}

// Judges one tool call; throws a Refusal to refuse it.
export function check(input: HookInput): void {
  const tool = input.tool_name ?? "";
  const args = (input.tool_input ?? {}) as Record<string, unknown>;
  const setup = !inTeam() && inSetup();
  let role = setup ? setupRole(input.agent_type) : "";
  const refuse = (reason: string): never => {
    throw new Refusal(role, reason);
  };
  const start = resolve(input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  const shown = (path: string): string => (inside(path, start) ? relative(start, path) || "." : path);

  // --- Reading -------------------------------------------------------------------------------------------------

  const fileReads = (): string[] | null =>
    tool === "Read" ? [String(args.file_path ?? "")] : tool === "Grep" ? [args.path, args.glob].filter((p) => p !== undefined).map(String) : null;
  const secretPath = (path: string): boolean => {
    if (!path) return false;
    if (isSecretFile(path) || isSecretFile(stripGlob(path))) return true;
    return !/[*?[]/.test(path) && isSecretFile(canonical(isAbsolute(path) ? path : resolve(start, path)));
  };
  const checkRead = (path: string): void => {
    if (secretPath(path)) refuse(`${path} holds secrets; ${SECRET}`);
  };
  // A search that reads what git would skip mustn't reach a secret file.
  const checkSearch = (search: Search, cwd: string, say: (file: string) => string): void => {
    for (const path of search.paths) {
      const at = expandPath(path, cwd);
      if (at === null) return refuse(say(path));
      const file = secretRead(search, at);
      if (file !== null) refuse(say(shown(file)));
    }
  };
  // The Grep tool's glob overrides what it skips, ignored and hidden files alike.
  const checkGrep = (): void => {
    const pattern = typeof args.glob === "string" ? args.glob.trim() : "";
    const globs = pattern ? pattern.split(/\s+/).map((g) => glob(g)) : [];
    if (!globs.some((g) => g.take)) return;
    checkSearch(
      { paths: [String(args.path ?? start)], globs, ignored: false, hidden: false },
      start,
      (file) => `the glob ${pattern} takes in ${file}, which holds secrets: a glob overrides what Grep skips. Narrow it (such as *.ts or src/**/*.tsx).`
    );
  };
  const checkReads = (): void => {
    for (const path of fileReads() ?? []) checkRead(path);
    if (tool === "Grep") checkGrep();
  };

  // --- The team ------------------------------------------------------------------------------------------------

  let session: { home: string; team: Team; run: string | null; role: string };
  try {
    if (setup) {
      const home = resolve(process.env.E9G_HOME_DIR ?? process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd());
      session = { home, team: normalizeTeam({ name: "setup", branch: "setup" }, home).team, run: null, role };
    } else session = teamSession({ cwd: input.cwd, agentType: input.agent_type });
  } catch (error) {
    // A team whose rules don't load can still read what holds no secrets, never write or run anything.
    if (fileReads()) return checkReads();
    return refuse(
      `the team's rules don't load, so nothing runs until the operator fixes them: ${String((error as Error).message)
        .split("\n")
        .slice(0, 4)
        .join(" ")}`
    );
  }
  const team = session.team;
  role = session.role;
  const home = canonical(session.home);
  const root = canonical(process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd());
  const work = join(home, ".e9g", "run");
  const run = session.run ? canonical(session.run) : null;
  const lane: Lane | undefined = Object.hasOwn(team.roles, role) ? team.roles[role] : undefined;
  // A role the team doesn't have (a native subagent such as Explore, a misconfigured instance, a subagent of the
  // setup agent) writes nothing.
  const readOnly = setup ? role !== "setup" : !lane || lane.readOnly;
  const paused = (): boolean => run !== null && existsSync(join(run, "paused"));
  const PAUSED = "the operator paused the team: merge nothing and start no members until e9g resume. Finish your turn.";
  const nonEmpty = (path: string | undefined): path is string => Boolean(path);
  const scratch = [...new Set(["/tmp", "/private/tmp", process.env.TMPDIR].filter(nonEmpty).map(canonical))];
  // The factory's, T3 Code's and Claude Code's own folders on this machine, and the team's run folder.
  const machine = [
    E9G_HOME,
    join(homedir(), ".e9g"),
    T3_HOME,
    join(homedir(), ".t3"),
    join(homedir(), ".claude"),
    process.env.CLAUDE_CONFIG_DIR,
    run ?? undefined,
  ]
    .filter(nonEmpty)
    .map(canonical);

  // --- Files ---------------------------------------------------------------------------------------------------

  // Inside the team's run folder in its checkout (.e9g/run/): state and locks belong to the factory's commands; the
  // board's tickets to the planner; anyone may add a finding (f-*.md) or use scratch/ and shots/.
  function checkWork(absolute: string): void {
    const rel = relative(work, absolute);
    if (/^(state|locks|merge)(\/|$)/.test(rel)) refuse(`.e9g/run/${rel} is written by the factory's commands only.`);
    if (/^board\//.test(rel)) {
      if (role === "planner" || /^board\/f-[\w.-]+\.md$/.test(rel)) return;
      refuse("only the planner edits tickets; file what you found as a new board/f-<yyyymmdd-hhmm>-<slug>.md.");
    }
    if (/^(scratch|shots)(\/|$)/.test(rel)) return;
    refuse(`.e9g/run/${rel} isn't yours to write; use .e9g/run/scratch/ or /tmp.`);
  }

  const outsideLane = (rel: string): never => refuse(`the ${role || "unnamed"} role doesn't write ${rel}; it's outside its lane (Article 6).`);

  // Every check of a path a call writes. A shell write outside the role's lane still passes when git ignores the path
  // (a build's output): that's asked of git for all of a command's paths at once, so this returns the path (relative
  // to the checkout) when only that question is left. A folder is in the lane when what's in it is.
  function checkPath(path: string, { viaShell = false, deletes = false, folder = false } = {}): string | null {
    const absolute = canonical(path);
    if (isSecretFile(path) || isSecretFile(absolute)) refuse(`${path} is a secrets file; ${SECRET}`);
    if (deletes && (inside(root, absolute) || inside(home, absolute))) refuse(`that deletes the whole checkout (${absolute}).`);
    if (inside(absolute, work)) {
      checkWork(absolute);
      return null;
    }
    const ours = inside(absolute, root) || inside(absolute, home);
    if (!ours) {
      if (role === "planner" && run && (inside(absolute, join(run, "outbox")) || absolute === join(run, "complete"))) return null;
      if (machine.some((dir) => inside(absolute, dir)))
        refuse(`${absolute} belongs to the factory, T3 Code or Claude Code on this machine; the team never writes there.`);
      if (scratch.some((dir) => inside(absolute, dir))) return null;
      if (viaShell) return null; // a shell write outside the checkout (a build cache, a log): the guard only watches lanes
      refuse(`${absolute} is outside your checkout.`);
    }
    for (const rule of team.protect)
      for (const base of [home, root])
        if (inside(absolute, base) && new RegExp(rule).test(relative(base, absolute)))
          refuse(`${relative(base, absolute)} is written by the team's scripts only.`);
    // A member in its own worktree never changes the team's checkout: that's the planner's, and holds the live rules.
    if (!setup && !inside(root, home) && inside(absolute, home))
      refuse(`${absolute} is in the team's checkout, which only the planner changes; work in your own worktree (${root}).`);
    const rel = relative(root, absolute);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      if (viaShell) return null;
      refuse(`${absolute} is outside your checkout.`);
    }
    if (setup) {
      if (role !== "setup") refuse("a subagent of the setup agent writes nothing; the setup agent writes .e9g/ itself.");
      if (!/^\.e9g\//.test(rel)) refuse("setup writes only the team's .e9g/ folder; the repository itself is the team's to change, once it runs.");
      return null;
    }
    // A folder that holds factory files (rm -rf .e9g) is one of them.
    if (factoryWrite(team, role, rel) || (rel !== "" && !FACTORY_PATH.test(rel) && FACTORY_PATH.test(`${rel}/`)))
      refuse(`${rel} is the team's rules or the factory's own files, which the operator changes (Article 12).`);
    // .git/config and .git/hooks hold for the team's checkout and every worktree, like git config (checkGit).
    if (/^\.git\/(config|hooks)(\/|$)/.test(rel)) refuse(`${rel} is git's own configuration, which the team's checkout and every worktree share.`);
    // The checkout's root itself changes only by a deletion, refused above; what's written in it has its own path.
    if (rel === "") return null;
    if (laneAllows(team, role, folder || isDirectory(absolute) ? `${rel}/` : rel)) return null;
    if (viaShell) return rel;
    return outsideLane(rel);
  }

  // The paths git ignores of those given (relative to the checkout), node_modules and .git always.
  function ignoredOf(rels: string[]): Set<string> {
    const skipped = new Set(rels.filter((rel) => /^(\.git|node_modules)(\/|$)/.test(rel)));
    // A directory that doesn't exist yet only matches "dir/" patterns with its slash.
    const ask = rels.filter((rel) => !skipped.has(rel)).flatMap((rel) => [rel, `${rel}/`]);
    for (const path of checkIgnore(root, ask)) skipped.add(path.replace(/\/$/, ""));
    return skipped;
  }

  function checkWrite(path: string): void {
    if (!path) refuse("the tool call names no file.");
    checkPath(isAbsolute(path) ? path : resolve(start, path));
  }

  // --- Commands ------------------------------------------------------------------------------------------------

  // When the branch was last pushed, from git's own record (the remote-tracking ref's reflog says "update by push"),
  // so a push that failed or was refused doesn't count.
  function minutesSincePush(remote: string, branch: string): number {
    const lines = gitOut(home, "log", "-g", "--format=%ct %gs", `refs/remotes/${remote}/${branch}`) ?? "";
    const pushed = lines.split("\n").find((line) => /update by push/.test(line));
    if (pushed) return (Date.now() / 1000 - Number(pushed.split(" ")[0])) / 60;
    // Before the reflog has one: the stamp older versions of the guard wrote.
    const stamp = run && join(run, "last-push");
    return stamp && existsSync(stamp) ? (Date.now() - statSync(stamp).mtimeMs) / 60_000 : Number.POSITIVE_INFINITY;
  }

  // Every git push on its own: where each refspec lands, then only the planner's one exact push, at its cadence.
  function checkPush(rest: string[], dir: string): void {
    const positional: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i] as string;
      if (/^(-o|--push-option|--repo|--receive-pack|--exec)$/.test(arg)) i++;
      else if (arg === "--") {
        positional.push(...rest.slice(i + 1));
        break;
      } else if (!arg.startsWith("-")) positional.push(arg);
    }
    const specs = positional.slice(1);
    for (const spec of specs.length ? specs : ["HEAD"]) {
      const plain = spec.replace(/^\+/, "");
      let target = plain.includes(":") ? plain.slice(plain.lastIndexOf(":") + 1) : plain;
      if (target === "HEAD" || target === "@") target = currentBranch(dir) ?? target;
      target = target.replace(/^refs\/heads\//, "");
      if (list(team.protectedBranches).includes(target)) refuse(`nothing is pushed to ${target}.`);
    }
    if (setup) refuse("setup pushes nothing.");
    const push = team.push;
    if (role !== "planner" || !push) refuse(`${push ? "only the planner pushes" : "this team pushes nothing"}; everything stays on this machine.`);
    if (!push) return;
    if (rest.length !== 2 || rest[0] !== push.remote || rest[1] !== push.branch)
      refuse(`the planner pushes only ${push.branch}: git push ${push.remote} ${push.branch}.`);
    if (push.everyMin) {
      const minutes = minutesSincePush(push.remote, push.branch);
      if (minutes < push.everyMin)
        refuse(`${push.branch} was pushed ${(minutes / 60).toFixed(1)} h ago; pushes are at most every ${(push.everyMin / 60).toFixed(1)} h.`);
    }
  }

  // `env`: the repositories GIT_DIR and GIT_WORK_TREE point git at, set for this command or exported before it.
  function checkGit(words: string[], cwd: string, env: string[]): void {
    const { args: gitArgs, dirs, trees } = gitGlobals(words);
    let dir = cwd;
    for (const d of dirs) dir = expandPath(d, dir) ?? dir;
    const places = [dir, ...[...trees, ...env].map((tree) => expandPath(tree, dir) ?? dir)].map(canonical);
    const inTeamCheckout = places.some((place) => inside(place, home));
    const inCheckout = inTeamCheckout || places.some((place) => inside(place, root));
    const [sub = "", ...rest] = gitArgs;
    const integration = (ref: string | undefined): boolean => ref === team.branch || ref === `refs/heads/${team.branch}`;
    // On the integration branch: as git says in any of the places it works on, or, where git can't say, in the team's
    // checkout.
    const onIntegration = (): boolean =>
      places.some((place) => {
        const current = currentBranch(place);
        return current === null ? inside(place, home) : current === team.branch;
      });

    if (sub === "push") checkPush(rest, dir);

    // Nobody on the team renames, deletes or resets the integration branch: it changes only through e9g merge.
    // git branch -m <new> renames the branch checked out, which in the team's checkout is the integration branch;
    // a copy (git branch -c) changes only its destination.
    let moved = false;
    if (sub === "branch") {
      let flags = "";
      const positional: string[] = [];
      for (const arg of rest) {
        if (/^--(delete|move|force|copy)$/.test(arg)) flags += { "--delete": "d", "--move": "m", "--force": "f", "--copy": "c" }[arg] ?? "";
        else if (/^-[a-zA-Z]+$/.test(arg)) flags += arg.slice(1);
        else if (!arg.startsWith("-")) positional.push(arg);
      }
      if (/[dD]/.test(flags) && positional.some(integration)) moved = true;
      if (/[mM]/.test(flags) && (positional.slice(0, 2).some(integration) || (positional.length === 1 && onIntegration()))) moved = true;
      if (/[cC]/.test(flags) && integration(positional[positional.length === 1 ? 0 : 1])) moved = true;
      if (/f/.test(flags) && !/[mMcC]/.test(flags) && integration(positional[0])) moved = true;
    }
    if (sub === "update-ref" && rest.some(integration)) moved = true;
    if (/^(checkout|switch|worktree)$/.test(sub) && rest.some((arg, i) => /^(-B|-C|--force-create)$/.test(rest[i - 1] ?? "") && integration(arg)))
      moved = true;
    if (moved) refuse(`${team.branch} changes only through e9g merge; nobody on the team renames, deletes or resets it.`);

    const ends = rest.some((arg) => arg === "--abort" || arg === "--quit");
    // Only the planner commits on the integration branch (its own lane's files); everyone else works on a branch.
    if (!setup && role !== "planner" && GIT_MOVES.includes(sub) && !ends && (sub !== "reset" || resetMoves(rest, dir)) && onIntegration())
      refuse(`only the planner commits on ${team.branch}; work on your own branch in your own worktree.`);

    // In the team's checkout the planner keeps the integration branch checked out and clean: the merge queue
    // fast-forwards it while the planner works, and every member's rules are read from it.
    if (role === "planner" && inTeamCheckout) {
      if (sub === "pull" || (/^(merge|rebase|cherry-pick|revert|am)$/.test(sub) && !ends))
        refuse(`${team.branch} changes only through e9g merge, and a builder rebases its own branch.`);
      if (sub === "reset" && resetMoves(rest, dir))
        refuse(`git reset with a commit or a mode changes ${team.branch}, which changes only through e9g merge; unstage with git reset -- <paths>.`);
      // git takes a start of an option for the whole of it: --am and --amen are --amend.
      if (sub === "commit" && rest.some((arg) => /^--am(e(nd?)?)?$/.test(arg)))
        refuse(`--amend rewrites ${team.branch}'s last commit, which changes only through e9g merge; make a new commit.`);
      if (sub === "switch" || (sub === "checkout" && rest[0] !== "--") || (sub === "stash" && !listsOnly(sub, rest)))
        refuse(
          `the team's checkout stays on ${team.branch}; inspect other branches with git show, git diff or git worktree add --detach /tmp/<name> <branch>.`
        );
    }

    if (readOnly && inCheckout && GIT_WRITES.includes(sub) && !listsOnly(sub, rest))
      refuse(
        `the ${role || "unnamed"} role changes nothing in the checkout; inspect branches with git show, git diff, or git worktree add --detach /tmp/<name> <branch>.`
      );

    if (sub === "config" && configWrites(rest))
      refuse(
        "git config writes the repository's .git/config, which the team's checkout and every worktree share; use git -c <key>=<value> for one command, or git config --worktree."
      );
  }

  function checkSecrets(command: ShellCommand): void {
    for (const path of [...command.redirects, ...command.reads])
      if (isSecretFile(path) || isSecretFile(stripGlob(path))) refuse(`${path} is a secrets file; ${SECRET}`);
    // What only lists names reads nothing in them (ls -la .env*).
    if (NAMES_ONLY.test(basename(unwrap(command.words).at(-1)?.[0] ?? ""))) return;
    const exists = (word: string): boolean => {
      const path = expandPath(word, command.cwd);
      return path !== null && existsSync(path);
    };
    for (const word of withoutExcludes(fileWords(command)))
      for (const part of new Set([word, ...word.split(/[=:]/)]))
        if (part && !/\s/.test(part) && (isSecretWord(part, exists) || isSecretWord(stripGlob(part), exists))) refuse(`${part} holds secrets; ${SECRET}`);
  }

  // A search that reads past what git skips (grep -r, rg -g '*' or -uu, git grep --no-index) mustn't reach a secret.
  function checkSearches(words: string[], cwd: string): void {
    const grep = grepSearch(words);
    if (grep)
      checkSearch(
        grep,
        cwd,
        (file) =>
          `grep -r reads every file, ignored ones too, and ${file} holds secrets; search with rg or git grep, which skip ignored files, or grep -r only the folders that matter.`
      );
    const rg = rgSearch(words);
    if (rg)
      checkSearch(
        rg,
        cwd,
        (file) =>
          `this rg reads files it otherwise skips (a glob that takes them in, -u, --no-ignore or --hidden), and ${file} holds secrets; narrow the glob (-g '*.ts'), keep secrets out (-g '!.env*'), or leave out -u, --no-ignore and --hidden.`
      );
    const gitGrep = gitGrepSearch(words, cwd);
    if (gitGrep)
      checkSearch(
        gitGrep,
        cwd,
        (file) => `git grep --no-index reads ignored files too, and ${file} holds secrets; leave out --no-index to search what git tracks.`
      );
  }

  function checkCommand(raw: string): void {
    const commands = parseShell(raw, start);
    const rules = setup ? commandRules(team).filter(({ rule }) => rule !== OPERATOR_COMMANDS) : commandRules(team);
    const owned = setup ? [] : ownedCommands(team);
    // Shell writes outside the lane, which pass only if git ignores them; and where GIT_DIR or GIT_WORK_TREE was
    // exported to.
    const unsure: string[] = [];
    const exported: string[] = [];
    for (const command of commands) {
      const broken = brokenRule(rules, command);
      if (broken) refuse(broken.reason);
      for (const line of lines(command)) for (const [rule, roles, reason] of owned) if (rule.test(line) && !roles.includes(role)) refuse(reason);
      checkSecrets(command);
      // The command that actually runs, its wrappers (timeout, env, e9g lock … --) taken off.
      const words = unwrap(command.words).at(-1) ?? [];
      const git = basename(words[0] ?? "") === "git";
      const gitEnv = command.words.flatMap((word) => /^GIT_(DIR|WORK_TREE)=(.+)$/.exec(word)?.[2] ?? []);
      if (!git) exported.push(...gitEnv);
      if (words[0] === "e9g") {
        const sub = words[1];
        if (setup && sub !== undefined && !sub.startsWith("-") && !SETUP_COMMANDS.includes(sub))
          refuse(`setup runs e9g ${SETUP_COMMANDS.slice(0, -1).join(", ")} and help only.`);
        if (!setup && sub === "merge" && paused()) refuse(PAUSED);
      }
      if (git) checkGit(words, command.cwd, [...exported, ...gitEnv]);
      if (role === "planner" && basename(words[0] ?? "") === "gh") {
        const labels = issueCreateLabels(words);
        if (labels && !labels.includes(PLANNER_LABEL))
          refuse(
            `the issues the planner opens carry the label ${PLANNER_LABEL}: add --label ${PLANNER_LABEL} (once, if the repository doesn't have it yet: gh label create ${PLANNER_LABEL} --color 5319E7 --description "Opened by an E9G team's planner").`
          );
      }
      checkSearches(words, command.cwd);
      // A string in a program's code may be prose, whose > writes nothing: only the commands in it are judged.
      if (!command.inCode)
        for (const { path, ...target } of writeTargets(words, command)) {
          const rel = checkPath(path, { viaShell: true, ...target });
          if (rel !== null) unsure.push(rel);
        }
    }
    if (unsure.length) {
      const skipped = ignoredOf(unsure);
      const outside = unsure.find((rel) => !skipped.has(rel));
      if (outside !== undefined) outsideLane(outside);
    }
  }

  // --- Outside tools -------------------------------------------------------------------------------------------

  function checkMcp(): void {
    if (tool.startsWith(TOOLS.prefix)) {
      if (role !== "planner") refuse("only the planner starts and manages members (Article 2).");
      if (tool === TOOLS.delegate) checkDelegate();
      return;
    }
    const allowed = setup ? [] : (lane?.mcp ?? []);
    if (!allowed.includes(tool)) refuse(`the team doesn't use ${tool}; outside tools stay off${allowed.length ? ` except ${allowed.join(", ")}` : ""}.`);
    if (/__(send_message|create_draft|send_email|send|reply|forward)$/.test(tool)) {
      const owner = (team.owner ?? "").toLowerCase();
      // A draft's recipients and a reply-all's thread aren't in the call, so they can't be checked.
      if (args.draftId !== undefined || args.draft_id !== undefined)
        refuse(`send the message itself, to the operator (${owner || "no owner is set in team.json"}); a draft's recipients aren't checked.`);
      if (args.replyAll === true || args.reply_all === true)
        refuse("no reply-all: it keeps the thread's other recipients. Send a new message to the operator.");
      const recipients =
        JSON.stringify([args.to, args.cc, args.bcc])
          .toLowerCase()
          .match(/[^\s"',<>[\]]+@[^\s"',<>[\]]+/g) ?? [];
      if (!owner || !recipients.length || recipients.some((address) => address !== owner))
        refuse(`email from the team goes only to the operator (${owner || "no owner is set in team.json"}).`);
      // A new message's subject carries the planner's label, so the operator can filter on it (a reply keeps its thread's).
      if (/__(send_message|create_draft|send_email|send)$/.test(tool) && !String(args.subject ?? "").startsWith(PLANNER_TAG))
        refuse(`the planner's email subjects start with ${PLANNER_TAG}: "${PLANNER_TAG} [${team.title}] <short subject>".`);
    }
  }

  // The planner's limits, enforced: one of this team's instances, in a worktree for the roles that build, no more
  // members of a role than team.json allows, none of a draining role while the environment resets, and nothing at
  // all while the operator has the team paused.
  function checkDelegate(): void {
    if (paused()) refuse(PAUSED);
    const target = args.target;
    const named = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
    const instance =
      named(typeof target === "object" && target !== null ? (target as Record<string, unknown>).providerInstanceId : undefined) ??
      named(args.providerInstanceId);
    const childRole = instance ? roleForInstance(team, instance) : null;
    const known = Object.keys(team.roles)
      .filter((r) => r !== "planner")
      .map((r) => instanceId(team, r));
    if (!childRole) return refuse(`start members only on this team's instances (${known.join(", ")}); ${instance ?? "none"} gives no role.`);
    if (childRole === "planner") refuse("there is one planner.");
    const child = team.roles[childRole];
    if (child?.worktree && args.isolation !== "worktree")
      refuse(
        `start a ${childRole} with isolation: "worktree" (a top-level argument of delegate_task), so it works in a worktree of its own; without it, it would work in the team's checkout.`
      );
    const drain = join(work, "state", "drain");
    if (existsSync(drain) && readFileSync(drain, "utf8").split(/\s+/).includes(childRole))
      refuse(`the environment is draining for a reset; start no ${childRole} until e9g drain off.`);
    const limit = child?.limit ?? 0;
    const ids = [
      instanceId(team, childRole),
      ...Object.entries(team.legacyInstances ?? {})
        .filter(([, r]) => r === childRole)
        .map(([id]) => id),
    ];
    const counts = runningByInstance(ids);
    if (!counts) return; // T3's database unreadable: don't stop the team on the guard's own blind spot
    const running = Object.values(counts).reduce((sum, n) => sum + n, 0);
    if (running >= limit) refuse(`${running} ${childRole} members are running and the limit is ${limit}; start the next one when one finishes.`);
  }

  // -------------------------------------------------------------------------------------------------------------

  if (tool === "Bash" || tool === "Monitor") checkCommand(String(args.command ?? ""));
  else if (WRITE_TOOLS.includes(tool)) checkWrite(String(args.file_path ?? args.notebook_path ?? ""));
  else if (tool === "Read" || tool === "Grep") checkReads();
  else if (tool.startsWith("mcp__")) checkMcp();
}
