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
  truncated: boolean; // more source files that might import a changed one than are read for imports, so importers may be missing
}

// Listings, logs and diffs can be large; past this, git's output would be cut off, and the radius refused rather
// than worked out from part of it.
const MAX_BUFFER = 256 * 1024 * 1024;
// The files whose imports are read, and how many at most: only those whose text names a file they might import, and
// a repository with more of those than that is read in part, not slowly.
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
// Test files by each language's convention: foo.test.ts, foo_test.go, test_foo.py, foo_spec.rb, FooTest.java.
const TEST_NAME = /([._-](test|spec)\.[cm]?[jt]sx?|_test\.(go|py)|_spec\.rb|Tests?\.(java|kt|swift|cs))$|(^|\/)test_[^/]+\.py$/;
// A document in a test folder (its README) isn't a test.
const DOC = /\.(md|mdx|txt|rst)$/;
// UI: view files by their extension (a SvelteKit or Remix page under routes/ included); what styles every page (a
// theme, design tokens, the Tailwind config, a styles module); plain JavaScript components and server-side templates
// in a view folder (app/views/x.html.erb). Never what's under an api or server folder, nor a route handler.
const UI_FILE = /\.(tsx|jsx|vue|svelte|css|scss|sass|less|html|astro|svg)$/;
const STYLE = /(^|\/)(theme|themes|design-tokens)(\/|\.)|(^|\/)tailwind\.config\.|\.styles?\.[cm]?[jt]s$/;
const TEMPLATE = /\.(erb|haml|slim|hbs|handlebars|ejs|njk|liquid|twig|jinja2?|j2|pug|mustache)$/;
const UI_SEGMENT = /(^|\/)(app|pages|components|views|ui|styles|layouts|templates)(\/|$)/;
const COMPONENT = /(^|\/)(pages|components|views|ui|layouts)\/.*\.[cm]?js$/;
const SERVER = /(^|\/)(api|server)\/|(^|\/)\+?(route|server)\.[cm]?[jt]sx?$|\.server\.[cm]?[jt]sx?$/;

export const isTest = (path: string): boolean => (TEST_DIR.test(path) && !DOC.test(path)) || TEST_NAME.test(path);
const isUi = (path: string): boolean =>
  !isTest(path) &&
  !SERVER.test(path) &&
  (UI_FILE.test(path) || STYLE.test(path) || COMPONENT.test(path) || (UI_SEGMENT.test(path) && TEMPLATE.test(path)));
const isSource = (path: string): boolean => SOURCE_EXTENSIONS.includes(posix.extname(path));
const isString = (value: unknown): value is string => typeof value === "string";
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const sorted = (items: Iterable<string>): string[] => [...new Set(items)].sort();
const nul = (text: string): string[] => text.split("\0").filter(Boolean);

// The output of a git command in the checkout, given `input` on its standard input. One that fails, or whose output
// passes the buffer, throws an error naming it; git grep's 1 is nothing found, not a failure.
function gitOut(cwd: string, args: string[], input?: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: MAX_BUFFER, input });
  const nothingFound = args[0] === "grep" && result.status === 1;
  if (result.error || (result.status !== 0 && !nothingFound)) {
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
// history (what a review's approval and a submit need). `maxSources`: how many files are read for imports at most
// (MAX_SOURCES; a test's few).
export function blastRadius(
  cwd: string,
  options: { base: string; ref?: string; critical?: string[]; touches?: boolean; maxSources?: number }
): BlastRadius {
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
  const { importers, truncated } =
    full && changed.length ? importersOf(top, changed, tracked, options.maxSources ?? MAX_SOURCES) : { importers: [], truncated: false };

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

// What a file imports, as files in the checkout, and whether it's a barrel.
interface Imports {
  targets: Set<string>;
  barrel: boolean;
}

// The tracked source files that import a changed file, or import one that does: two levels, no further, since past
// that nearly everything imports nearly everything. A barrel isn't a level: what imports it is at its level, as if it
// imported what the barrel passes on. Only the files whose text names a file a level looks for are read (one git grep
// per level, and per barrel found), at most maxSources of them; truncated when there were more.
function importersOf(top: string, changed: string[], tracked: string[], maxSources: number): { importers: string[]; truncated: boolean } {
  // An import can name any tracked file (a stylesheet, a JSON file), or a changed one the checkout no longer has.
  const known = new Set([...tracked, ...changed]);
  const sources = new Set(tracked.filter(isSource));
  const lookup: Lookup = { top, known, packages: readPackages(top, tracked), aliases: new Map() };
  const read = new Map<string, Imports>();
  const seen = new Set(changed);
  let truncated = false;
  // The files not seen yet that import one of `files`. A file is read once, though it may be a candidate again.
  const importersAmong = (files: string[]): string[] => {
    const wanted = new Set(files);
    const found: string[] = [];
    for (const file of grepFiles(top, [...moduleNames(files, lookup.packages), ...exactAliasesOf(files, lookup)])) {
      if (seen.has(file) || !sources.has(file)) continue;
      let imports = read.get(file);
      if (!imports) {
        if (read.size >= maxSources) {
          truncated = true;
          continue;
        }
        imports = readImports(file, lookup);
        read.set(file, imports);
      }
      if ([...imports.targets].some((target) => wanted.has(target))) found.push(file);
    }
    return found;
  };
  const found: string[] = [];
  let frontier = changed;
  for (let level = 0; level < 2; level++) {
    const next: string[] = [];
    // A barrel's importers join its level, and so on through barrels of barrels; seen ends a cycle of them.
    let barrels = frontier;
    while (barrels.length) {
      const importers = importersAmong(barrels);
      for (const importer of importers) seen.add(importer);
      next.push(...importers);
      barrels = importers.filter((importer) => read.get(importer)?.barrel);
    }
    found.push(...next);
    frontier = next;
  }
  return { importers: sorted(found), truncated };
}

// The tracked source files in the checkout with one of `names` in them, as fixed strings, not patterns: one git grep
// rather than reading every file, since a file that names nothing it might import can't import it.
function grepFiles(top: string, names: string[]): string[] {
  if (!names.length) return [];
  const pathspecs = SOURCE_EXTENSIONS.map((extension) => `*${extension}`);
  return nul(gitOut(top, ["grep", "--no-color", "-l", "-z", "-F", "-f", "-", "--", ...pathspecs], names.join("\n")));
}

// What an import of one of `files` must have in it: the file's name up to its extensions (core for core.ts, imported
// as ./core or ./core.js); for an index file, its folder's name, /index, or the dots that name it from below (".",
// "..", "../.."); and the name of the workspace package it's in, since that imports it too.
const INDEX_IMPORTS = ['"', "'"].flatMap((quote) => [
  `${quote}.${quote}`,
  `${quote}./${quote}`,
  `${quote}..${quote}`,
  `${quote}../${quote}`,
  `/..${quote}`,
  `/../${quote}`,
]);
function moduleNames(files: string[], packages: Package[]): string[] {
  const names = new Set<string>();
  for (const file of files) {
    const name = posix.basename(file);
    const dot = name.indexOf(".", 1); // .eslintrc.js is .eslintrc
    const bare = dot === -1 ? name : name.slice(0, dot);
    if (bare === "index") {
      const folder = posix.basename(posix.dirname(file));
      for (const text of [folder === "." ? "" : folder, "/index", ...INDEX_IMPORTS]) names.add(text);
    } else names.add(bare);
    for (const pkg of packages) if (file.startsWith(`${pkg.folder}/`)) names.add(pkg.name);
  }
  names.delete(""); // git grep finds an empty string in every file
  return [...names];
}

// The exact (not wildcard) paths keys of the checkout's tsconfig.json and jsconfig.json files that go to one of
// `files`: "@app": ["src/main.ts"] names nothing of main.ts's name, so its importers are found by the key.
function exactAliasesOf(files: string[], lookup: Lookup): string[] {
  const stem = (path: string): string => path.replace(/(\/index)?\.[cm]?[jt]sx?$/, "");
  const wanted = new Set(files.map(stem));
  const keys = new Set<string>();
  for (const config of [...lookup.known].filter((file) => /(^|\/)[jt]sconfig\.json$/.test(file)))
    for (const alias of readAliases(lookup, config))
      if (!alias.wildcard && alias.targets.some((target) => wanted.has(stem(target)))) keys.add(alias.prefix);
  return [...keys];
}

// A file's imports, as the files they name, and whether it's a barrel. One that can't be read (deleted but not yet
// staged, a link to a folder, a submodule) imports nothing.
function readImports(file: string, lookup: Lookup): Imports {
  const text = readText(lookup.top, file);
  const targets = new Set<string>();
  if (text === undefined) return { targets, barrel: false };
  for (const specifier of specifiers(text)) {
    const target = resolveImport(file, specifier, lookup);
    if (target && target !== file) targets.add(target);
  }
  return { targets, barrel: isBarrel(text) };
}

// A barrel (a folder's index.ts, mostly) only passes on what other files export: with its comments gone (outside
// strings) and its export … from statements (export *, export * as x, export { a, type B }, export type { C }), only
// semicolons are left.
const COMMENT = /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
const RE_EXPORT = /(?<![\w$.])export\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["'][^"'\n]+["']/g;
function isBarrel(text: string): boolean {
  const code = text.replace(COMMENT, (_: string, literal: string | undefined) => literal ?? " ");
  const rest = code.replace(RE_EXPORT, "");
  return rest !== code && /^[\s;]*$/.test(rest);
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

// What resolving an import needs: the files there are, the workspace's packages, and the paths that apply in each
// folder, worked out once per folder.
interface Lookup {
  top: string;
  known: Set<string>;
  packages: Package[];
  aliases: Map<string, Alias[]>;
}

// The file an import names, or undefined for a package that isn't the workspace's or one that isn't in the checkout.
// A relative import is resolved against the importing file; anything else through the paths of the nearest
// tsconfig.json, then as a workspace package.
function resolveImport(from: string, specifier: string, lookup: Lookup): string | undefined {
  if (specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../")) {
    const path = inCheckout(posix.join(posix.dirname(from), specifier.replace(/[?#].*$/, "")));
    return path === undefined ? undefined : resolveFile(path, lookup.known);
  }
  for (const target of [...aliasTargets(specifier, aliasesIn(posix.dirname(from), lookup)), ...packageTargets(specifier, lookup.packages)]) {
    const file = resolveFile(target, lookup.known);
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

// One of a tsconfig.json's compilerOptions.paths, or of a package.json's exports: "@/*" is the prefix "@/" and an
// empty suffix, with a wildcard; a key without one matches only itself. Targets are relative to the checkout's top,
// "*" still in them.
interface Alias {
  prefix: string;
  suffix: string;
  wildcard: boolean;
  targets: string[];
}
function alias(key: string, targets: string[]): Alias {
  const star = key.indexOf("*");
  if (star === -1) return { prefix: key, suffix: "", wildcard: false, targets };
  return { prefix: key.slice(0, star), suffix: key.slice(star + 1), wildcard: true, targets };
}

// The paths that apply to a file in `folder`: those of the nearest tsconfig.json (or jsconfig.json) at or above it,
// as TypeScript finds it.
function aliasesIn(folder: string, lookup: Lookup): Alias[] {
  const dir = folder === "." ? "" : folder;
  const cached = lookup.aliases.get(dir);
  if (cached) return cached;
  const config = ["tsconfig.json", "jsconfig.json"].map((name) => posix.join(dir, name)).find((file) => lookup.known.has(file));
  const aliases = config !== undefined ? readAliases(lookup, config) : dir ? aliasesIn(posix.dirname(dir), lookup) : [];
  lookup.aliases.set(dir, aliases);
  return aliases;
}

// A tsconfig.json's paths, with those of what it extends, or none: without any, or when it isn't JSON even with its
// comments and trailing commas gone. Targets go through baseUrl, or without one, from the folder of the file that
// sets the paths.
function readAliases(lookup: Lookup, file: string): Alias[] {
  const { paths, baseUrl, pathsFrom } = compilerPaths(lookup, file, new Set());
  if (!paths) return [];
  const root = baseUrl ?? pathsFrom ?? ".";
  const aliases: Alias[] = [];
  for (const [key, value] of Object.entries(paths)) {
    if (!Array.isArray(value)) continue;
    const targets = value.filter(isString).map((target) => posix.join(root, target));
    aliases.push(alias(key, targets));
  }
  return aliases;
}

// What a tsconfig.json and the files it extends say of paths: the paths, the folder baseUrl names (relative to the file
// that sets it), and the folder of the file that sets the paths. A later file in extends wins over an earlier one, the
// file itself over them all. Only relative extends are read (./tsconfig.base, .json left out or not), not a package's
// (@tsconfig/node22/tsconfig.json); `chain`, the files extending this one, ends a cycle.
interface CompilerPaths {
  paths?: Record<string, unknown>;
  baseUrl?: string;
  pathsFrom?: string;
}
function compilerPaths(lookup: Lookup, file: string, chain: Set<string>): CompilerPaths {
  const config = chain.has(file) ? undefined : readJson(lookup.top, file);
  if (!isObject(config)) return {};
  const folder = posix.dirname(file);
  let found: CompilerPaths = {};
  for (const parent of [config["extends"]].flat()) {
    if (!isString(parent) || !/^\.\.?\//.test(parent)) continue;
    const path = inCheckout(posix.join(folder, parent));
    if (path) found = { ...found, ...compilerPaths(lookup, lookup.known.has(path) ? path : `${path}.json`, new Set(chain).add(file)) };
  }
  const options = config["compilerOptions"];
  if (!isObject(options)) return found;
  if (isString(options["baseUrl"])) found = { ...found, baseUrl: posix.join(folder, options["baseUrl"]) };
  if (isObject(options["paths"])) found = { ...found, paths: options["paths"], pathsFrom: folder };
  return found;
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

// A workspace package: its name, its folder, and where an import of it goes: its exports (from "." for the package
// itself and "./button" for a path in it), then its main and module.
interface Package {
  name: string;
  folder: string;
  exports: Alias[];
  main: string[];
}

// The workspace's packages: each tracked package.json with a name, in a folder that pnpm-workspace.yaml's packages or
// the root package.json's workspaces name.
function readPackages(top: string, tracked: string[]): Package[] {
  const globs = workspaceGlobs(top);
  const included = globs.filter((glob) => !glob.startsWith("!")).map(globRegex);
  const excluded = globs.filter((glob) => glob.startsWith("!")).map((glob) => globRegex(glob.slice(1)));
  const packages: Package[] = [];
  if (!included.length) return packages;
  for (const file of tracked) {
    const folder = posix.dirname(file);
    if (posix.basename(file) !== "package.json" || folder === "." || /(^|\/)node_modules\//.test(file)) continue;
    if (!included.some((glob) => glob.test(folder)) || excluded.some((glob) => glob.test(folder))) continue;
    const manifest = readJson(top, file);
    if (!isObject(manifest) || !isString(manifest["name"]) || !manifest["name"]) continue;
    const main = [manifest["main"], manifest["module"]].filter(isString).map((path) => posix.join(folder, path));
    packages.push({ name: manifest["name"], folder, exports: exportAliases(folder, manifest["exports"]), main });
  }
  return packages;
}

// The workspace's package folders, as globs: pnpm-workspace.yaml's packages list, and the root package.json's
// workspaces (a list, or Yarn's { packages }). One that starts with ! leaves folders out.
function workspaceGlobs(top: string): string[] {
  const globs: string[] = [];
  let listing = false; // in the packages: list
  for (const line of (readText(top, "pnpm-workspace.yaml") ?? "").split("\n")) {
    const text = line.replace(/(^|\s)#.*/, "").trimEnd();
    // A top-level key starts the list or ends it; each "- glob" in it is one.
    if (/^[^\s-]/.test(text)) listing = /^packages\s*:$/.test(text);
    else if (listing) {
      const item = /^\s*-\s*(["']?)(.+)\1$/.exec(text);
      if (item?.[2]) globs.push(item[2]);
    }
  }
  const manifest = readJson(top, "package.json");
  const workspaces = isObject(manifest) ? manifest["workspaces"] : undefined;
  const list = isObject(workspaces) ? workspaces["packages"] : workspaces;
  if (Array.isArray(list)) globs.push(...list.filter(isString));
  return globs;
}

// A workspace glob as a regular expression over folders: * is any name, ** any number of folders (none too), ? one
// character; a ./ before it or a / after it doesn't matter.
const GLOB: Record<string, string> = { "**/": "(?:.*/)?", "**": ".*", "*": "[^/]*", "?": "[^/]" };
function globRegex(glob: string): RegExp {
  const pattern = glob.replace(/^\.\//, "").replace(/\/+$/, "");
  const source = pattern.replace(/\*\*\/|\*\*|[*?]|[.+^${}()|[\]\\]/g, (token) => GLOB[token] ?? `\\${token}`);
  return new RegExp(`^${source}$`);
}

// A package's exports as Aliases from the import's path in the package ("." itself, "./button", "./icons/*") to
// files: a string is the package's own; an entry is a string, or its import, default or types condition, which may
// hold further conditions.
function exportAliases(folder: string, exports: unknown): Alias[] {
  const bare = isString(exports) || (isObject(exports) && !Object.keys(exports).some((key) => key.startsWith(".")));
  const entries = bare ? { ".": exports } : exports;
  if (!isObject(entries)) return [];
  const inFolder = (target: string): string => posix.join(folder, target);
  return Object.entries(entries).map(([key, value]) => alias(key, conditions(value).map(inFolder)));
}
const conditions = (value: unknown): string[] =>
  isString(value) ? [value] : isObject(value) ? ["import", "default", "types"].flatMap((condition) => conditions(value[condition])) : [];

// Where an import of a workspace package goes (the longest package name that is the import or starts it): through
// its exports, then for the package itself its main, module, index or src/index, and for a path in it
// (@acme/ui/src/Button) that path in its folder.
function packageTargets(specifier: string, packages: Package[]): string[] {
  let found: Package | undefined;
  for (const pkg of packages)
    if ((specifier === pkg.name || specifier.startsWith(`${pkg.name}/`)) && pkg.name.length > (found?.name.length ?? 0)) found = pkg;
  if (!found) return [];
  const subpath = `.${specifier.slice(found.name.length)}`;
  const fallback = subpath === "." ? [...found.main, found.folder, posix.join(found.folder, "src")] : [posix.join(found.folder, subpath)];
  return [...aliasTargets(subpath, found.exports), ...fallback.map((path) => inCheckout(path)).filter(isString)];
}

// A file in the checkout, or undefined when it can't be read; and one that's JSON, or undefined when it isn't, even
// with its comments and trailing commas gone (tsconfig.json has both).
function readText(top: string, file: string): string | undefined {
  try {
    return readFileSync(join(top, file), "utf8");
  } catch {
    return undefined;
  }
}
function readJson(top: string, file: string): unknown {
  const text = readText(top, file);
  try {
    return text === undefined ? undefined : JSON.parse(looseJson(text));
  } catch {
    return undefined;
  }
}

// JSON with comments and trailing commas: both go before it's parsed, outside strings only: "@/*" is a key, not the
// start of a comment.
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
