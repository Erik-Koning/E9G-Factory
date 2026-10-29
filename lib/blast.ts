// The blast radius of a change (e9g blast): the files it touches, the files that import them, the files that usually
// change with them, the tests among all of those, whether it touches UI and how much, and which of the team's
// critical paths it reaches. Reviewers and testers start from it, and a review's approval reads ui and uiLines to ask
// for screenshots of a UI change that isn't trivial.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";

export interface BlastRadius {
  base: string; // the base it was compared with
  ref: string; // the ref examined
  changed: string[]; // files changed in base...ref (git diff --name-only --no-renames -z), repo-relative
  importers: string[]; // tracked JS/TS files that import a changed file, up to two levels, excluding changed
  related: string[]; // files that usually change together with a changed file (git history), excluding changed and importers
  tests: string[]; // test files among changed ∪ importers ∪ related, plus tracked test files whose name stem matches a changed file's stem
  ui: boolean; // any changed file is UI
  uiFiles: string[]; // the changed UI files
  uiLines: number; // lines added + removed in the UI files (git diff --numstat base...ref)
  critical: string[]; // the critical regexes (as given) that match a changed file or one of its importers
  truncated: boolean; // more source files than are read for imports, so importers may be missing
}

// Listings, logs and diffs can be large; past this, git's output would be cut off, and the radius refused rather
// than worked out from part of it.
const MAX_BUFFER = 256 * 1024 * 1024;
// The files whose imports are read, and how many at most: a repository bigger than that is read in part, not slowly.
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte"];
const MAX_SOURCES = 20_000;
// How far back the base's history is read for files that change together; the commits too big to say anything
// about that (a formatter run, a rename sweep); and how often two files must have changed together to count: in at
// least 3 commits, and in at least 30% of the changed file's own.
const HISTORY = 400;
const MAX_COMMIT_FILES = 50;
const MIN_SHARED = 3;
const MIN_SHARE_PERCENT = 30;

const TEST_DIR = /(^|\/)(__tests__|e2e|tests?|spec)\//;
const TEST_NAME = /[._-](test|spec)\.[cm]?[jt]sx?$/;
// UI: view files by their extension (a SvelteKit or Remix page under routes/ included); what styles every page (a
// theme, design tokens, the Tailwind config, a styles module); plain JavaScript components and server-side templates
// in a view folder (app/views/x.html.erb). Never what's under an api or server folder, nor a route handler.
const UI_FILE = /\.(tsx|jsx|vue|svelte|css|scss|sass|less|html|astro|svg)$/;
const STYLE = /(^|\/)(theme|themes|design-tokens)(\/|\.)|(^|\/)tailwind\.config\.|\.styles?\.[cm]?[jt]s$/;
const TEMPLATE = /\.(erb|haml|slim|hbs|handlebars|ejs|njk|liquid|twig|jinja2?|j2|pug|mustache)$/;
const UI_SEGMENT = /(^|\/)(app|pages|components|views|ui|styles|layouts|templates)(\/|$)/;
const COMPONENT = /(^|\/)(pages|components|views|ui|layouts)\/.*\.[cm]?js$/;
const SERVER = /(^|\/)(api|server)\/|(^|\/)\+?(route|server)\.[cm]?[jt]sx?$|\.server\.[cm]?[jt]sx?$/;

const isTest = (path: string): boolean => TEST_DIR.test(path) || TEST_NAME.test(path);
const isUi = (path: string): boolean =>
  !isTest(path) &&
  !SERVER.test(path) &&
  (UI_FILE.test(path) || STYLE.test(path) || COMPONENT.test(path) || (UI_SEGMENT.test(path) && TEMPLATE.test(path)));
const isSource = (path: string): boolean => SOURCE_EXTENSIONS.includes(posix.extname(path));
const sorted = (items: Iterable<string>): string[] => [...new Set(items)].sort();
const nul = (text: string): string[] => text.split("\0").filter(Boolean);

// The output of a git command in the checkout. One that fails, or whose output passes the buffer, throws an error
// naming it.
function gitOut(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: MAX_BUFFER });
  if (result.error || result.status !== 0) {
    const why = (result.error?.message ?? result.stderr ?? "").trim().split("\n")[0] ?? "";
    throw new Error(`git ${args.join(" ")} failed${why ? `: ${why}` : ""}`);
  }
  return result.stdout;
}

// The full id of the commit `name` names. Everything after works on ids, so a name can't be read as an option.
function commitOf(top: string, name: string): string {
  const args = ["rev-parse", "--verify", "--quiet", "--end-of-options", `${name}^{commit}`];
  const result = spawnSync("git", args, { cwd: top, encoding: "utf8" });
  if (result.error) throw new Error(`git ${args.join(" ")} failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${name} isn't a commit in ${top}`);
  return result.stdout.trim();
}

// `touches` alone: what changed, the UI and the critical paths, without reading every source file for imports or the
// history (what a review's approval and a submit need).
export function blastRadius(cwd: string, options: { base: string; ref?: string; critical?: string[]; touches?: boolean }): BlastRadius {
  const top = gitOut(cwd, ["rev-parse", "--show-toplevel"]).trim();
  const git = (...args: string[]): string => gitOut(top, args);
  const base = options.base;
  const ref = options.ref ?? "HEAD";
  const baseCommit = commitOf(top, base);
  const refCommit = commitOf(top, ref);
  const range = `${baseCommit}...${refCommit}`;

  const changed = sorted(nul(git("diff", "--name-only", "--no-renames", "-z", range)));
  const full = !options.touches;
  const tracked = full ? nul(git("ls-files", "-z")) : [];
  const importers = full && changed.length ? importersOf(top, changed, tracked) : [];
  const truncated = tracked.filter(isSource).length > MAX_SOURCES;

  let related: string[] = [];
  if (full && changed.length) {
    const log = git("-c", "core.quotePath=false", "log", "--format=%x00%H", "--name-only", "--no-renames", "-n", String(HISTORY), baseCommit);
    const atRef = new Set(nul(git("ls-tree", "-r", "-z", "--name-only", refCommit)));
    const near = new Set([...changed, ...importers]);
    related = sorted(coChanged(log, changed).filter((file) => !near.has(file) && atRef.has(file)));
  }

  const stems = new Set(changed.map(stem).filter(Boolean));
  const tests = sorted([...[...changed, ...importers, ...related].filter(isTest), ...tracked.filter((file) => isTest(file) && stems.has(stem(file)))]);

  const uiFiles = changed.filter(isUi);
  let uiLines = 0;
  if (uiFiles.length) {
    const ui = new Set(uiFiles);
    // added<TAB>removed<TAB>path, with "-" for both on a binary file.
    for (const record of nul(git("diff", "--numstat", "--no-renames", "-z", range))) {
      const [added = "", removed = "", ...path] = record.split("\t");
      if (ui.has(path.join("\t"))) uiLines += (Number(added) || 0) + (Number(removed) || 0);
    }
  }

  const critical = sorted(
    (options.critical ?? []).filter((source) => {
      let rule: RegExp;
      try {
        rule = new RegExp(source);
      } catch {
        return false; // the team's loader reports a rule that isn't a regular expression; it matches nothing here
      }
      // Reached: a changed file is on the path, or (when imports are read) imports into it from there.
      return [...changed, ...importers].some((file) => rule.test(file));
    })
  );

  return { base, ref, changed, importers, related, tests, ui: uiFiles.length > 0, uiFiles, uiLines, critical, truncated };
}

// The tracked source files that import a changed file, or import one that does: two levels, no further, since past
// that nearly everything imports nearly everything.
function importersOf(top: string, changed: string[], tracked: string[]): string[] {
  // An import can name any tracked file (a stylesheet, a JSON file), or a changed one the checkout no longer has.
  const known = new Set([...tracked, ...changed]);
  const aliases = readAliases(top);
  const importedBy = new Map<string, Set<string>>();
  for (const file of tracked.filter(isSource).slice(0, MAX_SOURCES)) {
    let text: string;
    try {
      text = readFileSync(join(top, file), "utf8");
    } catch {
      continue; // deleted but not yet staged, a link to a folder, a submodule
    }
    for (const specifier of specifiers(text)) {
      const target = resolveImport(file, specifier, known, aliases);
      if (!target || target === file) continue;
      const by = importedBy.get(target) ?? new Set<string>();
      by.add(file);
      importedBy.set(target, by);
    }
  }
  const seen = new Set(changed);
  const found: string[] = [];
  let frontier = changed;
  for (let level = 0; level < 2; level++) {
    const next: string[] = [];
    for (const file of frontier)
      for (const importer of importedBy.get(file) ?? [])
        if (!seen.has(importer)) {
          seen.add(importer);
          next.push(importer);
        }
    found.push(...next);
    frontier = next;
  }
  return sorted(found);
}

// What a file imports, read with regular expressions rather than parsed: import … from "x", import "x",
// export … from "x", import("x") and require("x"). The first stops at what ends or leaves a statement (; = parens
// and quotes), so it can't run on into the code after it.
const IMPORT_PATTERNS = [
  /(?<![\w$.])(?:import|export)(?![\w$])[^;"'`()=]*?(?<![\w$])from\s*["']([^"'\n]+)["']/g,
  /(?<![\w$.])import\s*["']([^"'\n]+)["']/g,
  /(?<![\w$.])(?:import|require)\s*\(\s*["']([^"'\n]+)["']\s*[,)]/g,
];
function specifiers(text: string): Set<string> {
  const found = new Set<string>();
  for (const pattern of IMPORT_PATTERNS) for (const match of text.matchAll(pattern)) if (match[1]) found.add(match[1]);
  return found;
}

// TypeScript's ESM style imports ./x.js for x.ts (and .mjs for .mts, and so on).
const TS_FOR_JS: Record<string, string[]> = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };

// The file an import names, or undefined for a package or one that isn't in the checkout. A relative import is
// resolved against the importing file; anything else only through tsconfig.json's paths.
function resolveImport(from: string, specifier: string, known: Set<string>, aliases: Alias[]): string | undefined {
  if (specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../")) {
    const path = inCheckout(posix.join(posix.dirname(from), specifier.replace(/[?#].*$/, "")));
    return path === undefined ? undefined : resolveFile(path, known);
  }
  for (const target of aliasTargets(specifier, aliases)) {
    const file = resolveFile(target, known);
    if (file) return file;
  }
  return undefined;
}

// The file a path names, as TypeScript and bundlers find it: the path itself, with an extension, the folder's index,
// or the .ts behind a .js.
function resolveFile(path: string, known: Set<string>): string | undefined {
  const extension = posix.extname(path);
  const folder = path ? `${path}/` : ""; // "" is the checkout's top
  const candidates = [
    ...(path ? [path, ...SOURCE_EXTENSIONS.map((ext) => `${path}${ext}`)] : []),
    ...SOURCE_EXTENSIONS.map((ext) => `${folder}index${ext}`),
    ...(TS_FOR_JS[extension] ?? []).map((ext) => `${path.slice(0, -extension.length)}${ext}`),
  ];
  return candidates.find((candidate) => known.has(candidate));
}

// A path relative to the checkout's top, normalized, or undefined when it leaves the checkout.
function inCheckout(path: string): string | undefined {
  const normal = posix.normalize(path).replace(/\/+$/, "");
  if (posix.isAbsolute(normal) || normal === ".." || normal.startsWith("../")) return undefined;
  return normal === "." ? "" : normal;
}

// One of tsconfig.json's compilerOptions.paths: "@/*" is the prefix "@/" and an empty suffix, with a wildcard; a key
// without one matches only itself. Targets are relative to the checkout's top (through baseUrl), "*" still in them.
interface Alias {
  prefix: string;
  suffix: string;
  wildcard: boolean;
  targets: string[];
}

// The checkout's tsconfig.json paths, or none: without the file, or when it isn't JSON even with its comments and
// trailing commas gone.
function readAliases(top: string): Alias[] {
  let config: unknown;
  try {
    config = JSON.parse(looseJson(readFileSync(join(top, "tsconfig.json"), "utf8")));
  } catch {
    return [];
  }
  const compilerOptions = (config as { compilerOptions?: unknown } | null)?.compilerOptions;
  if (!compilerOptions || typeof compilerOptions !== "object") return [];
  const { baseUrl, paths } = compilerOptions as { baseUrl?: unknown; paths?: unknown };
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) return [];
  const root = typeof baseUrl === "string" ? baseUrl : ".";
  const aliases: Alias[] = [];
  for (const [key, value] of Object.entries(paths as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const star = key.indexOf("*");
    const targets = value.filter((target): target is string => typeof target === "string").map((target) => posix.join(root, target));
    aliases.push({
      prefix: star === -1 ? key : key.slice(0, star),
      suffix: star === -1 ? "" : key.slice(star + 1),
      wildcard: star !== -1,
      targets,
    });
  }
  return aliases;
}

// Where an import goes through the paths, as TypeScript picks them: a key that is the import exactly, or else the
// matching wildcard key with the longest prefix, its "*" replaced by what the wildcard matched.
function aliasTargets(specifier: string, aliases: Alias[]): string[] {
  const exact = aliases.find((alias) => !alias.wildcard && alias.prefix === specifier);
  let best = exact;
  let matched = "";
  if (!best)
    for (const alias of aliases) {
      const fits =
        alias.wildcard &&
        specifier.length >= alias.prefix.length + alias.suffix.length &&
        specifier.startsWith(alias.prefix) &&
        specifier.endsWith(alias.suffix);
      if (fits && (!best || alias.prefix.length > best.prefix.length)) {
        best = alias;
        matched = specifier.slice(alias.prefix.length, specifier.length - alias.suffix.length);
      }
    }
  if (!best) return [];
  return best.targets.map((target) => inCheckout(target.replace("*", matched))).filter((target): target is string => target !== undefined);
}

// tsconfig.json is JSON with comments and trailing commas. Both go before it's parsed, outside strings only: "@/*" is
// a key, not the start of a comment.
function looseJson(text: string): string {
  const STRING = /("(?:[^"\\\n]|\\.)*")/.source;
  return text
    .replace(new RegExp(`${STRING}|//[^\\n]*|/\\*[\\s\\S]*?\\*/`, "g"), (_: string, literal: string | undefined) => literal ?? " ")
    .replace(new RegExp(`${STRING}|,(?=\\s*[}\\]])`, "g"), (_: string, literal: string | undefined) => literal ?? "");
}

// The files that changed in the same commits as a changed file, read from `git log --name-only` (each commit is a
// NUL, its id, then the files it touched, one per line), skipping commits too big to mean anything.
function coChanged(log: string, changed: string[]): string[] {
  const wanted = new Set(changed);
  const commits = new Map<string, number>();
  const together = new Map<string, Map<string, number>>();
  for (const entry of log.split("\0").slice(1)) {
    const files = [...new Set(entry.split("\n").slice(1).filter(Boolean))];
    if (!files.length || files.length > MAX_COMMIT_FILES) continue;
    for (const file of files) {
      if (!wanted.has(file)) continue;
      commits.set(file, (commits.get(file) ?? 0) + 1);
      const counts = together.get(file) ?? new Map<string, number>();
      together.set(file, counts);
      for (const other of files) if (other !== file) counts.set(other, (counts.get(other) ?? 0) + 1);
    }
  }
  const related: string[] = [];
  for (const [file, counts] of together) {
    const own = commits.get(file) ?? 0;
    for (const [other, shared] of counts) if (shared >= MIN_SHARED && shared * 100 >= own * MIN_SHARE_PERCENT) related.push(other);
  }
  return related;
}

// A file's name without its extensions or a test suffix (invoice.test.ts and invoice-spec.js are both invoice), and
// an index file's is its folder's name (billing/index.ts is billing): what a test of it is usually called.
function stem(path: string): string {
  const name = posix.basename(path);
  const dot = name.indexOf(".");
  let bare = (dot === -1 ? name : name.slice(0, dot)).replace(/[_-](test|spec)$/, "");
  if (bare === "index") bare = posix.basename(posix.dirname(path));
  return bare === "." ? "" : bare.toLowerCase();
}
