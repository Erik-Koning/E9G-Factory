// A small reader for shell command lines, for the guard: enough of sh's quoting to tell commands from data.
// - It splits a script into simple commands (on ; & && || |, newlines, parentheses and braces, and if/then/do/else
//   words), strips the quotes from each word, and skips comments.
// - It keeps redirect targets apart from the words: the files a command writes, and the files it reads.
// - It follows each command's directory through cd; a cd inside ( … ) or $( … ) ends with it.
// - It reads as commands of their own: $( … ), backticks and <( … ); the strings sh -c, bash -c, eval, npx -c and
//   watch run; and here-documents and echo fed to a shell. Other here-documents are data, apart from the $( … ) in
//   an unquoted one. $(( … )) is arithmetic.
// Then, for the rules: each command with its wrappers taken off (unwrap), git's global options and the factory's CLI
// by its path read as the plain command (normalize), and its free text left out (withoutText).
// It isn't a shell: it's meant to read what an honest agent writes the way a person would.
import { homedir } from "node:os";
import { basename, resolve } from "node:path";

const KEYWORDS = /^(if|then|do|else|elif|while|until|!|time)$/;
const SHELLS = /^(ba|z|da|k)?sh$/;
// Shells inside substitutions inside shells: an honest command never nests this deep, so deeper is refused.
const MAX_DEPTH = 8;
// What a word holds where a command substitution was: its output, which nobody can know beforehand.
const SUBSTITUTED = "$(…)";

// One simple command: its words with the quotes gone, the files its redirects write and read, and where it runs.
export interface ShellCommand {
  words: string[];
  redirects: string[];
  reads: string[];
  cwd: string;
}

// While a command is read: the here-strings it's fed, and the command its output is piped to.
interface Reading extends ShellCommand {
  stdin: string[];
  next: Reading | null;
}

export function parseShell(source: string, cwd = process.cwd()): ShellCommand[] {
  const out: Reading[] = [];
  read(source, resolve(cwd), 0, out);
  return out.map(({ words, redirects, reads, cwd: dir }) => ({ words, redirects, reads, cwd: dir }));
}

function read(text: string, start: string, depth: number, out: Reading[]): void {
  if (depth > MAX_DEPTH) throw new Error("the command nests shells and substitutions too deeply to read");
  const dirs = [start];
  const here = (): string => dirs[dirs.length - 1] ?? start;
  const fresh = (): Reading => ({ words: [], redirects: [], reads: [], cwd: start, stdin: [], next: null });
  const inner = (script: string, dir = here()) => read(script, dir, depth + 1, out);
  let command = fresh();
  let piped: Reading | null = null;
  let word = "";
  let quoted = false;
  let pending: "out" | "in" | "string" | null = null; // after > or >>, after <, after <<<
  let docs: { mark: string; literal: boolean; command: Reading }[] = [];

  const endWord = () => {
    if (word || quoted) {
      if (pending === "out") command.redirects.push(word);
      else if (pending === "in") command.reads.push(word);
      else if (pending === "string") command.stdin.push(word);
      else command.words.push(word);
      pending = null;
    }
    word = "";
    quoted = false;
  };
  const endCommand = (pipe = false) => {
    endWord();
    pending = null;
    const done = command;
    command = fresh();
    const from = piped;
    piped = null;
    while (KEYWORDS.test(done.words[0] ?? "")) done.words.shift();
    if (!done.words.length && !done.redirects.length && !done.reads.length) return;
    done.cwd = here();
    out.push(done);
    if (from) from.next = done;
    if (pipe) piped = done;
    if (done.words[0] === "cd" || done.words[0] === "pushd") {
      const to = done.words.slice(1).find((w) => !/^-[LPe@]+$/.test(w));
      const dir = to === undefined ? homedir() : expandPath(to, here());
      if (dir) dirs[dirs.length - 1] = dir;
    }
    for (const script of scriptsOf(done.words)) inner(script, done.cwd);
    if (readsCommands(done.words)) {
      for (const string of done.stdin) inner(string, done.cwd);
      if (from && /^(echo|printf)$/.test(from.words[0] ?? "")) inner(from.words.slice(1).join(" "), done.cwd);
    }
  };
  // Here-document bodies start on the line after their <<: commands when a shell reads them, else data.
  const bodies = (from: number): number => {
    let at = from;
    for (const doc of docs) {
      const lines: string[] = [];
      while (at < text.length) {
        const end = text.indexOf("\n", at);
        const line = text.slice(at, end < 0 ? text.length : end);
        at = end < 0 ? text.length : end + 1;
        if (line.trim() === doc.mark) break;
        lines.push(line);
      }
      const body = lines.join("\n");
      let fed = false;
      for (let c: Reading | null = doc.command; c; c = c.next) fed ||= readsCommands(c.words);
      if (fed) inner(body, doc.command.cwd);
      else if (!doc.literal) for (const script of substitutions(body)) inner(script, doc.command.cwd);
    }
    docs = [];
    return at;
  };
  // Inside "…": \ escapes only " \ $ ` and a newline, and $( … ) and backticks still run.
  const doubleQuoted = (from: number): number => {
    let j = from;
    while (j < text.length && text[j] !== '"') {
      const d = text[j] as string;
      if (d === "\\" && j + 1 < text.length) {
        const e = text[j + 1] as string;
        if (e !== "\n") word += /["\\$`]/.test(e) ? e : `\\${e}`;
        j += 2;
      } else if (d === "$" && text[j + 1] === "(") {
        j = dollar(j) + 1;
      } else if (d === "`") {
        const end = closeBacktick(text, j + 1);
        inner(text.slice(j + 1, end));
        word += SUBSTITUTED;
        j = end + 1;
      } else {
        word += d;
        j++;
      }
    }
    return Math.min(j, text.length);
  };
  // $( … ) at `at`: its commands are read on their own and the word holds their output; $(( … )) is arithmetic.
  const dollar = (at: number): number => {
    const { end, arithmetic } = closeDollar(text, at);
    if (arithmetic) word += text.slice(at, end + 1);
    else {
      inner(text.slice(at + 2, end));
      word += SUBSTITUTED;
    }
    return end;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    const next = text[i + 1];
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      word += text.slice(i + 1, end < 0 ? text.length : end);
      quoted = true;
      i = end < 0 ? text.length : end;
    } else if (c === '"') {
      i = doubleQuoted(i + 1);
      quoted = true;
    } else if (c === "\\") {
      if (next !== "\n") word += next ?? "";
      i++;
    } else if (c === "#" && !word && !quoted) {
      // A comment runs to the end of the line; an apostrophe or a << in it means nothing.
      const end = text.indexOf("\n", i);
      i = (end < 0 ? text.length : end) - 1;
    } else if (c === "$" && next === "(") {
      i = dollar(i);
    } else if (c === "$" && next === "{") {
      // ${VAR} is part of a word.
      const end = text.indexOf("}", i);
      word += text.slice(i, end < 0 ? text.length : end + 1);
      i = end < 0 ? text.length : end;
    } else if (c === "`") {
      const end = closeBacktick(text, i + 1);
      inner(text.slice(i + 1, end).replace(/\\`/g, "`"));
      word += SUBSTITUTED;
      i = end;
    } else if ((c === "<" || c === ">") && next === "(" && !word) {
      // <( … ) and >( … ) run commands and stand for a file.
      const end = closeParen(text, i + 2);
      inner(text.slice(i + 2, end));
      word += SUBSTITUTED;
      i = end;
    } else if (c === "\n") {
      endCommand();
      i = bodies(i + 1) - 1;
    } else if (c === ";" || c === "(" || c === ")") {
      endCommand();
      if (c === "(") dirs.push(here());
      else if (c === ")" && dirs.length > 1) dirs.pop();
    } else if ((c === "{" && !word && !quoted && (next === undefined || /\s/.test(next))) || (c === "}" && !word && !quoted)) {
      // A { … } group; inside a word ({a,b}, {}) a brace is part of it.
      endCommand();
    } else if (c === "&" && next === ">") {
      // &> and &>> send both streams to a file.
      endWord();
      i += text[i + 2] === ">" ? 2 : 1;
      pending = "out";
    } else if ((c === "&" || c === "|") && next === c) {
      endCommand();
      i++;
    } else if (c === "|") {
      endCommand(true);
      if (next === "&") i++;
    } else if (c === "&") {
      endCommand();
    } else if (c === "<" && next === "<" && text[i + 2] === "<") {
      // A here-string: the next word is data the command reads.
      if (/^\d+$/.test(word) && !quoted) word = "";
      else endWord();
      pending = "string";
      i += 2;
    } else if (c === "<" && next === "<") {
      if (/^\d+$/.test(word) && !quoted) word = "";
      else endWord();
      const doc = readMark(text, i + 2);
      docs.push({ mark: doc.mark, literal: doc.literal, command });
      i = doc.end - 1;
    } else if (c === ">" || c === "<") {
      // [n]> [n]>> >| <> write a file; >&n and <&n duplicate a descriptor; < reads one.
      if (/^\d+$/.test(word) && !quoted) word = "";
      else endWord();
      let j = i + 1;
      const writes = c === ">" || text[j] === ">";
      if (text[j] === ">" || text[j] === "|") j++;
      if (text[j] === "&" && /[\d-]/.test(text[j + 1] ?? "")) {
        j++;
        while (/[\d-]/.test(text[j] ?? "")) j++;
        i = j - 1;
        continue;
      }
      if (text[j] === "&") j++;
      pending = writes ? "out" : "in";
      i = j - 1;
    } else if (/\s/.test(c)) {
      endWord();
    } else word += c;
  }
  endCommand();
}

// A here-document's delimiter after << or <<-: quoting any of it makes the body literal (no $( … ) runs in it).
function readMark(text: string, from: number): { mark: string; literal: boolean; end: number } {
  let j = from;
  if (text[j] === "-") j++;
  while (text[j] === " " || text[j] === "\t") j++;
  let mark = "";
  let literal = false;
  while (j < text.length && !/[\s;&|<>()]/.test(text[j] as string)) {
    const c = text[j] as string;
    if (c === "'" || c === '"') {
      const end = text.indexOf(c, j + 1);
      mark += text.slice(j + 1, end < 0 ? text.length : end);
      literal = true;
      j = end < 0 ? text.length : end + 1;
    } else if (c === "\\") {
      mark += text[j + 1] ?? "";
      literal = true;
      j += 2;
    } else {
      mark += c;
      j++;
    }
  }
  return { mark, literal, end: j };
}

// Past the bodies of the here-documents opened on the line before `from`.
function skipBodies(text: string, from: number, marks: string[]): number {
  let at = from;
  for (const mark of marks) {
    while (at < text.length) {
      const end = text.indexOf("\n", at);
      const line = text.slice(at, end < 0 ? text.length : end);
      at = end < 0 ? text.length : end + 1;
      if (line.trim() === mark) break;
    }
  }
  return at;
}

// The ) that closes a $( or ( whose inside starts at `start`, past quotes, comments, nested parentheses and
// here-documents (a body may hold a lone ")"). The text's end when it never closes.
function closeParen(text: string, start: number): number {
  let depth = 1;
  const marks: string[] = [];
  const upTo = (index: number): number => (index < 0 ? text.length : index);
  for (let i = start; i < text.length; i++) {
    const c = text[i] as string;
    if (c === "\\") i++;
    else if (c === "'") i = upTo(text.indexOf("'", i + 1));
    else if (c === '"') i = closeDouble(text, i + 1);
    else if (c === "`") i = closeBacktick(text, i + 1);
    else if (c === "#" && (i === start || /[\s;&|()]/.test(text[i - 1] ?? ""))) i = upTo(text.indexOf("\n", i)) - 1;
    else if (c === "$" && text[i + 1] === "(") i = closeDollar(text, i).end;
    else if (c === "<" && text[i + 1] === "<") {
      if (text[i + 2] === "<") i += 2;
      else {
        const doc = readMark(text, i + 2);
        marks.push(doc.mark);
        i = doc.end - 1;
      }
    } else if (c === "\n" && marks.length) {
      i = skipBodies(text, i + 1, marks) - 1;
      marks.length = 0;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return text.length;
}

function closeDouble(text: string, start: number): number {
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === '"') return i;
    else if (c === "$" && text[i + 1] === "(") i = closeDollar(text, i).end;
    else if (c === "`") i = closeBacktick(text, i + 1);
  }
  return text.length;
}

function closeBacktick(text: string, start: number): number {
  for (let i = start; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "`") return i;
  }
  return text.length;
}

// After a $( at `at`: the index of its closing ), and whether it was $(( … )) arithmetic, whose << is a shift.
function closeDollar(text: string, at: number): { end: number; arithmetic: boolean } {
  if (text[at + 2] === "(") {
    let depth = 2;
    for (let i = at + 3; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) {
        if (text[i - 1] === ")") return { end: i, arithmetic: true };
        break; // $( (…) …): a subshell in a substitution
      }
    }
  }
  return { end: closeParen(text, at + 2), arithmetic: false };
}

// The $( … ) and backticks in an unquoted here-document's body, which run.
function substitutions(text: string): string[] {
  const found: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "$" && text[i + 1] === "(") {
      const { end, arithmetic } = closeDollar(text, i);
      if (!arithmetic) found.push(text.slice(i + 2, end));
      i = end;
    } else if (text[i] === "`") {
      const end = closeBacktick(text, i + 1);
      found.push(text.slice(i + 1, end));
      i = end;
    }
  }
  return found;
}

// A shell that reads its commands from stdin: no -c, and no script file (bash -s takes arguments after it).
function readsCommands(words: string[]): boolean {
  const shell = unwrap(words).find((variant) => SHELLS.test(basename(variant[0] ?? "")));
  if (!shell) return false;
  const args = shell.slice(1);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (/^-[a-zA-Z]*s[a-zA-Z]*$/.test(arg)) return true;
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg)) return false;
    if (/^[-+][oO]$/.test(arg)) i++;
    else if (arg === "--") return i + 1 >= args.length;
    else if (!/^[-+]/.test(arg)) return false;
  }
  return true;
}

// The strings a command runs as shell code: sh -c, bash -c and zsh -c anywhere in it (env sh -c, xargs bash -c,
// find -exec sh -c, /bin/bash -c), eval, npx -c and npm exec -c/--call, pnpm's shell mode, and watch.
function scriptsOf(words: string[]): string[] {
  const scripts: string[] = [];
  words.forEach((word, i) => {
    const name = basename(word);
    const rest = words.slice(i + 1);
    if (SHELLS.test(name)) {
      for (let j = 0; j < rest.length; j++) {
        const arg = rest[j] as string;
        if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg)) {
          scripts.push(rest[j + 1] ?? "");
          break;
        }
        if (/^[-+][oO]$/.test(arg)) j++;
        else if (!/^[-+]/.test(arg)) break;
      }
    } else if (name === "eval") scripts.push(rest.join(" "));
    else if (
      /^(npx|bunx|npm|pnpm)$/.test(name) &&
      (name !== "npm" || /^(exec|x)$/.test(rest[0] ?? "")) &&
      (name !== "pnpm" || /^(exec|dlx)$/.test(rest[0] ?? ""))
    ) {
      const at = rest.findIndex((arg) => /^(-c|--call|--shell-mode)$/.test(arg) || arg.startsWith("--call="));
      if (at >= 0) scripts.push(rest[at]?.startsWith("--call=") ? (rest[at] ?? "").slice(7) : rest.slice(at + 1).join(" "));
    } else if (name === "watch" && i === 0) scripts.push(options(rest, ["-n", "--interval"]).join(" "));
  });
  return scripts;
}

// A word as a path from `cwd`: ~ and the variables set in this environment expanded, and a glob's wildcards
// dropped (.e9g/* is judged as .e9g/, .env* as .env). Null when it can't be known: a $( … ), an unset variable.
export function expandPath(word: string, cwd: string): string | null {
  const path = word
    .replace(/^~(?=\/|$)/, homedir())
    .replace(/\$(?:\{(\w+)\}|(\w+))/g, (whole: string, braced?: string, bare?: string) => process.env[braced ?? bare ?? ""] ?? whole);
  if (/[$`]/.test(path) || path === "") return null;
  return resolve(cwd, stripGlob(path));
}
export const stripGlob = (path: string): string => path.replace(/\*+|\?|\[[^\]/]*\]/g, "");

// Leading options of a command, skipped: the rest from its first operand (or from after --). `valued` are the
// options that take the next word as their value.
export function options(args: string[], valued: string[] = []): string[] {
  let i = 0;
  while (i < args.length) {
    const arg = args[i] as string;
    if (arg === "--") return args.slice(i + 1);
    if (!/^-./.test(arg)) break;
    i += valued.includes(arg) ? 2 : 1;
  }
  return args.slice(i);
}

// A command's operands: its words that aren't options or their values; everything after --.
export function operands(args: string[], valued: string[] = []): string[] {
  const found: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--") return [...found, ...args.slice(i + 1)];
    if (valued.includes(arg)) i++;
    else if (!/^-./.test(arg)) found.push(arg);
  }
  return found;
}

const PNPM = ["--filter", "-F", "--filter-prod", "-C", "--dir", "--reporter", "--workspace-concurrency", "--resume-from", "--test-pattern", "--loglevel"];

// The command a wrapper runs, or null when the command isn't a wrapper.
function peel(words: string[]): string[] | null {
  let i = 0;
  while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i] as string)) i++;
  if (i > 0) return words.slice(i);
  const [first = "", ...rest] = words;
  const name = basename(first);
  switch (name) {
    case "env":
      return options(rest, ["-u", "--unset", "-C", "--chdir", "-S", "--split-string", "-P"]);
    case "nohup":
    case "builtin":
    case "chronic":
    case "unbuffer":
      return rest;
    case "time":
      return options(rest, ["-f", "-o", "--format", "--output"]);
    case "nice":
      return options(rest, ["-n", "--adjustment"]);
    case "ionice":
      return options(rest, ["-c", "-n", "-p", "--class", "--classdata"]);
    case "stdbuf":
      return options(rest, ["-i", "-o", "-e"]);
    case "caffeinate":
      return options(rest, ["-t", "-w"]);
    case "exec":
      return options(rest, ["-a"]);
    case "command":
      return rest.some((arg) => /^-[a-zA-Z]*[vV]/.test(arg)) ? null : options(rest);
    case "sudo":
    case "doas":
      return options(rest, ["-u", "-g", "-C", "-h", "-p", "-r", "-t", "-U", "-D"]);
    case "xargs":
      return options(rest, ["-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a", "-J", "-R", "-S"]);
    case "timeout":
    case "gtimeout":
      return options(rest, ["-s", "--signal", "-k", "--kill-after"]).slice(1);
    case "npx":
    case "bunx":
      return options(rest, ["-p", "--package", "-c", "--call"]);
    case "npm": {
      const after = options(rest, ["-w", "--workspace", "--prefix", "-C", "--loglevel", "--userconfig", "--cache", "--registry"]);
      const [verb = "", ...more] = after;
      if (/^(exec|x)$/.test(verb)) return options(more, ["-p", "--package", "-w", "--workspace", "-c", "--call"]);
      if (/^(run|run-script|rum|urn)$/.test(verb)) return ["npm", "run", ...options(more, ["-w", "--workspace"])];
      return ["npm", ...after];
    }
    case "pnpm": {
      const after = options(rest, PNPM);
      const [verb = "", ...more] = after;
      if (verb === "exec") return options(more, [...PNPM, "-c"]);
      if (verb === "dlx") return options(more, ["--package", "--allow-build", "-c"]);
      if (verb === "run" || verb === "run-script") return ["pnpm", "run", ...options(more, PNPM)];
      return ["pnpm", ...after];
    }
    case "yarn": {
      const after = options(rest, ["--cwd"]);
      const [verb = "", ...more] = after;
      if (verb === "workspace") return ["yarn", ...more.slice(1)];
      if (verb === "workspaces" && more[0] === "foreach") return ["yarn", ...options(more.slice(1), ["--include", "--exclude", "-j", "--jobs", "--from"])];
      if (verb === "npm") return ["npm", ...more];
      if (verb === "dlx") return options(more, ["-p", "--package"]);
      if (verb === "exec") return more;
      if (verb === "run") return ["yarn", "run", ...options(more)];
      return ["yarn", ...after];
    }
    case "bun": {
      const after = options(rest, ["--filter", "-F", "--cwd", "--config"]);
      const [verb = "", ...more] = after;
      if (verb === "x") return options(more, ["-p", "--package"]);
      if (verb === "run") return ["bun", "run", ...options(more, ["--filter", "-F", "--cwd"])];
      return ["bun", ...after];
    }
    case "e9g": {
      // e9g lock <name> [--slots N] [--wait-min M] -- <command>
      const dash = rest.indexOf("--");
      return rest[0] === "lock" && dash >= 0 ? rest.slice(dash + 1) : null;
    }
    case "find": {
      const at = rest.findIndex((arg) => /^-(exec|execdir|ok|okdir)$/.test(arg));
      if (at < 0) return null;
      const tail = rest.slice(at + 1);
      const end = tail.findIndex((arg) => arg === ";" || arg === "+");
      return end < 0 ? tail : tail.slice(0, end);
    }
    default:
      if (SHELLS.test(name)) {
        // bash scripts/env.sh reset runs scripts/env.sh reset; -c and -s are read by scriptsOf and readsCommands.
        let j = 0;
        while (j < rest.length && /^[-+]/.test(rest[j] as string)) {
          if (/^-[a-zA-Z]*[cs]/.test(rest[j] as string)) return null;
          j += /^[-+][oO]$/.test(rest[j] as string) ? 2 : 1;
        }
        return j < rest.length ? rest.slice(j) : null;
      }
      return null;
  }
}

// The factory's CLI called by its path (~/.e9g/bin/e9g, node …/bin/e9g.ts) reads as e9g.
function e9gCli(words: string[]): string[] {
  const e9g = (word: string | undefined) => /^e9g(\.ts|\.mjs)?$/.test(basename(word ?? ""));
  if (/^(node|bun|tsx)$/.test(basename(words[0] ?? "")) && e9g(words[1])) return ["e9g", ...words.slice(2)];
  if (e9g(words[0]) && words[0] !== "e9g") return ["e9g", ...words.slice(1)];
  return words;
}

// The command as written, then with each wrapper taken off, one at a time: timeout 600 npx vercel deploy is also
// npx vercel deploy and vercel deploy, and e9g lock app -- pnpm --filter web deploy is also pnpm deploy. The last
// variant is the command that actually runs.
export function unwrap(words: string[]): string[][] {
  const variants: string[][] = [];
  for (let current: string[] | null = words; current?.length && variants.length < 16;) {
    const cli = e9gCli(current);
    if (variants.some((seen) => seen.length === cli.length && seen.every((word, i) => word === cli[i]))) break;
    variants.push(cli);
    current = peel(cli);
  }
  return variants;
}

// git's global options, which don't change what it does: git -C dir / -c key=val / --git-dir …. The directories
// (-C, in order) and the repository or work tree it names, and the subcommand with its arguments.
export function gitGlobals(words: string[]): { args: string[]; dirs: string[]; trees: string[] } {
  const dirs: string[] = [];
  const trees: string[] = [];
  let i = 1;
  for (; i < words.length; i++) {
    const word = words[i] as string;
    const [option = "", value] = word.split(/=(.*)/s, 2);
    if (word === "-C") dirs.push(words[++i] ?? "");
    else if (word === "-c" || /^--(namespace|config-env|attr-source|exec-path|super-prefix)$/.test(word)) i++;
    else if (/^--(git-dir|work-tree)$/.test(word)) trees.push(words[++i] ?? "");
    else if (/^--(git-dir|work-tree)$/.test(option) && value !== undefined) trees.push(value);
    else if (
      !/^(-p|-P|--paginate|--no-pager|--bare|--no-replace-objects|--literal-pathspecs|--(no)?glob-pathspecs|--icase-pathspecs|--no-optional-locks|--no-lazy-fetch|--no-advice|--(namespace|config-env|attr-source|exec-path|super-prefix|list-cmds)=.*)$/.test(
        word
      )
    )
      break;
  }
  return { args: words.slice(i), dirs, trees };
}

// Each command read as the plain command the rules name: git without its global options.
export const normalize = (words: string[]): string[] => (basename(words[0] ?? "") === "git" ? ["git", ...gitGlobals(words).args] : words);

// Free text: messages, titles and bodies (git commit -m, gh issue create --body), the e9g log's entry and notes, and
// what echo and printf print. A rule never matches inside it; a command substitution in it was read on its own.
const GIT_TEXT = /^(commit|merge|tag|stash|notes|commit-tree)$/;
const GH_TEXT = ["-b", "--body", "-t", "--title", "--subject", "--notes", "--description"];
const E9G_TEXT = ["--note", "--label"];
export function withoutText(words: string[]): string[] {
  const [name = "", sub = ""] = words;
  if (name === "echo" || name === "printf") return [name];
  if (name === "e9g" && sub === "log") return ["e9g", "log"];
  const git = name === "git" && GIT_TEXT.test(sub);
  const valued = git ? ["-m", "--message"] : name === "gh" ? GH_TEXT : name === "e9g" ? E9G_TEXT : null;
  if (!valued) return words;
  const kept: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i] as string;
    const option = word.split("=", 1)[0] ?? "";
    if (valued.includes(word) || (git && /^-[a-zA-Z]+m$/.test(word))) {
      kept.push(word);
      i++;
    } else if (word.startsWith("--") && word.includes("=") && valued.includes(option)) kept.push(option);
    else if (git && /^-m./.test(word)) kept.push("-m");
    else kept.push(word);
  }
  return kept;
}

// The lines the guard's rules are matched against for one command: as written and with each wrapper off, read as
// the plain command, without its free text. Separators inside a word were quoted data, so they're blanked.
export function lines(command: ShellCommand): string[] {
  const found = new Set<string>();
  for (const words of unwrap(command.words))
    found.add(
      withoutText(normalize(words))
        .map((word) => word.replace(/[;&|`()\n]/g, " "))
        .join(" ")
    );
  return [...found];
}

// The words a command names files with (its free text left out): the innermost command's, and the wrappers' own.
export function fileWords(command: ShellCommand): string[] {
  const variants = unwrap(command.words);
  const first = variants[0] ?? [];
  const last = variants[variants.length - 1] ?? [];
  const suffix = last.length <= first.length && last.every((word, i) => word === first[first.length - last.length + i]);
  return [...(suffix ? first.slice(0, first.length - last.length) : []), ...withoutText(normalize(last))];
}
