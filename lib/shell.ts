// A small reader for shell command lines, for the guard: enough of sh's quoting to tell commands from data.
// - It splits a script into simple commands (on ; & && || |, newlines, parentheses and braces, and if/then/do/else
//   words), strips the quotes from each word, and skips comments.
// - It keeps redirect targets apart from the words: the files a command writes, and the files it reads.
// - It follows each command's directory through cd, pushd and popd; a cd inside ( … ) or $( … ) ends with it, and
//   one to a folder that doesn't exist moves only the commands its && guards.
// - It reads as commands of their own: $( … ), backticks and <( … ), in a ${ … } too; the strings sh -c, bash -c,
//   eval, npx -c, watch and the other runners run (concurrently, nodemon --exec, ssh, tmux, git rebase -x, …); the
//   strings quoted in node -e and python -c code; and here-documents, here-strings and echo or printf fed to a shell.
//   Other here-documents are data, apart from the $( … ) in an unquoted one. $(( … )), (( … )) and $[ … ] are
//   arithmetic.
// Then, for the rules: each command with its wrappers taken off (unwrap), git's global options and the factory's CLI
// by its path read as the plain command (normalize), and its free text left out (withoutText).
// It isn't a shell: it's meant to read what an honest agent writes the way a person would.
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";

const KEYWORDS = /^(if|then|do|else|elif|while|until|!)$/;
const SHELLS = /^(ba|z|da|k)?sh$/;
// Shells inside substitutions inside shells: an honest command never nests this deep, so deeper is refused.
const MAX_DEPTH = 8;
// What a word holds where a command substitution was: its output, which nobody can know beforehand.
const SUBSTITUTED = "$(…)";

// One simple command: its words with the quotes gone, the files its redirects write and read, and where it runs.
// inCode: it was read from a string quoted in a program's code (node -e, python -c), so it's a command that code may
// run, or just text: its > may be prose.
export interface ShellCommand {
  words: string[];
  redirects: string[];
  reads: string[];
  cwd: string;
  inCode: boolean;
}

// While a command is read: the here-strings it's fed, and the command its output is piped to.
interface Reading extends ShellCommand {
  stdin: string[];
  next: Reading | null;
}

// What ends a simple command.
type Separator = ";" | "&&" | "||" | "|" | "&" | "(" | ")";

// Where the commands run at one level of ( … ): the folder, cd -'s folder, pushd's stack, and the folder to go back
// to when the and-list ends, after a cd to a folder that doesn't exist (yet).
interface Place {
  dir: string;
  old: string | null;
  stack: string[];
  back: { dir: string; old: string | null; stack: string[] } | null;
}

export function parseShell(source: string, cwd = process.cwd()): ShellCommand[] {
  const out: Reading[] = [];
  read(source, resolve(cwd), 0, out, false);
  return out.map(({ words, redirects, reads, cwd: dir, inCode }) => ({ words, redirects, reads, cwd: dir, inCode }));
}

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

function read(text: string, start: string, depth: number, out: Reading[], inCode: boolean): void {
  if (depth > MAX_DEPTH) throw new Error("the command nests shells and substitutions too deeply to read");
  const places: Place[] = [{ dir: start, old: null, stack: [], back: null }];
  const place = (): Place => places[places.length - 1] as Place;
  const here = (): string => place().dir;
  // Folders earlier commands make (mkdir, git worktree add), which a later cd finds though they don't exist yet.
  const made = new Set<string>();
  const fresh = (): Reading => ({ words: [], redirects: [], reads: [], cwd: start, inCode, stdin: [], next: null });
  const inner = (script: string, dir = here(), code = inCode) => read(script, dir, depth + 1, out, code);
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

  // cd, pushd and popd move the commands after them. A cd that fails leaves the shell where it was, so one to a folder
  // that doesn't exist (and that no earlier command made) moves only the commands its && guards. In a pipeline or in
  // the background a cd runs in a subshell and moves nothing.
  const move = (words: string[], after: Separator) => {
    const [verb = "", ...args] = words;
    const p = place();
    if (verb === "mkdir") for (const arg of operands(args, ["-m", "--mode"])) addMade(arg, p.dir);
    if (verb === "git") {
      const [sub, action, ...more] = gitGlobals(words).args;
      if (sub === "worktree" && action === "add") addMade(operands(more, ["-b", "-B", "--reason"])[0], p.dir);
    }
    if (!/^(cd|pushd|popd)$/.test(verb) || after === "|" || after === "&" || (verb !== "cd" && args.includes("-n"))) return;
    const [first] = args.filter((arg) => arg !== "--" && !/^-[LPe@]+$/.test(arg));
    let to: string | null;
    if (verb === "popd") to = p.stack[p.stack.length - 1] ?? null;
    else if (first === undefined) to = verb === "cd" ? homedir() : (p.stack[p.stack.length - 1] ?? null);
    else if (first === "-" && verb === "cd") to = p.old;
    // pushd +N turns the stack, which isn't followed.
    else if (/^[+-]\d+$/.test(first)) to = null;
    else to = expandPath(first, p.dir);
    if (to === null) return;
    // To a folder that isn't there (yet): only until the and-list ends, which after ; or || is at once.
    if (!made.has(to) && !isDir(to) && p.back === null) p.back = { dir: p.dir, old: p.old, stack: [...p.stack] };
    if (verb === "popd") p.stack.pop();
    else if (verb === "pushd" && first === undefined) p.stack[p.stack.length - 1] = p.dir;
    else if (verb === "pushd") p.stack.push(p.dir);
    p.old = p.dir;
    p.dir = to;
  };
  const addMade = (word: string | undefined, dir: string) => {
    const path = word === undefined ? null : expandPath(word, dir);
    if (path) made.add(path);
  };

  const endCommand = (after: Separator = ";") => {
    endWord();
    pending = null;
    const done = command;
    command = fresh();
    const from = piped;
    piped = null;
    for (;;) {
      const first = done.words[0] ?? "";
      if (first === "time") done.words = options(done.words.slice(1), ["-f", "-o", "--format", "--output"]);
      else if (KEYWORDS.test(first)) done.words.shift();
      else break;
    }
    if (done.words.length || done.redirects.length || done.reads.length) {
      done.cwd = here();
      out.push(done);
      if (from) from.next = done;
      if (after === "|") piped = done;
      move(done.words, after);
      for (const script of scriptsOf(done.words)) inner(script, done.cwd);
      for (const string of codeStrings(done.words)) inner(string, done.cwd, true);
      if (readsCommands(done.words)) {
        for (const string of done.stdin) inner(string, done.cwd);
        if (from && /^(echo|printf)$/.test(basename(from.words[0] ?? ""))) for (const script of printed(from.words)) inner(script, done.cwd);
      }
    }
    // The and-list ends: a cd to a folder that didn't exist held only for the commands its && guarded.
    const p = place();
    if (after !== "&&" && after !== "|" && after !== "(" && p.back !== null) {
      Object.assign(p, p.back);
      p.back = null;
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
    if (arithmetic) {
      for (const script of substitutions(text.slice(at + 3, end - 1))) inner(script);
      word += text.slice(at, end + 1);
    } else {
      inner(text.slice(at + 2, end));
      word += SUBSTITUTED;
    }
    return end;
  };
  // A part of a word that only expands (${X:-…}, $[ … ], (( … ))): the commands substituted in it are read on their
  // own, and the word holds an unknown value when there were any.
  const expansion = (from: number, end: number) => {
    const found = substitutions(text.slice(from, end + 1));
    for (const script of found) inner(script);
    word += found.length ? SUBSTITUTED : text.slice(from, end + 1);
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
    } else if (c === "$" && next === "'") {
      // $'…': \ escapes anything, \' included.
      let j = i + 2;
      for (; j < text.length && text[j] !== "'"; j++) {
        if (text[j] === "\\" && j + 1 < text.length) {
          const e = text[++j] as string;
          word += e === "n" ? "\n" : e === "t" ? "\t" : e;
        } else word += text[j];
      }
      quoted = true;
      i = j;
    } else if (c === "$" && next === "(") {
      i = dollar(i);
    } else if (c === "$" && next === "{") {
      const end = closeBrace(text, i + 2);
      expansion(i, end);
      i = end;
    } else if (c === "$" && next === "[") {
      // $[ … ] is arithmetic, whose << is a shift.
      const end = closeBracket(text, i + 2);
      expansion(i, end);
      i = end;
    } else if (c === "(" && next === "(" && !word && !quoted && closeArithmetic(text, i) >= 0) {
      // (( … )) is arithmetic too: a command of one word.
      const end = closeArithmetic(text, i);
      expansion(i, end);
      i = end;
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
      endCommand(";");
      i = bodies(i + 1) - 1;
    } else if (c === ";") {
      endCommand(";");
    } else if (c === "(") {
      endCommand("(");
      places.push({ ...place(), stack: [...place().stack] });
    } else if (c === ")") {
      endCommand(")");
      if (places.length > 1) places.pop();
    } else if (c === "{" && !word && !quoted && (next === undefined || /\s/.test(next))) {
      // A { … } group; inside a word ({a,b}, {}) a brace is part of it.
      endCommand("(");
    } else if (c === "}" && !word && !quoted) {
      endCommand(";");
    } else if (c === "&" && next === ">") {
      // &> and &>> send both streams to a file.
      endWord();
      i += text[i + 2] === ">" ? 2 : 1;
      pending = "out";
    } else if ((c === "&" || c === "|") && next === c) {
      endCommand(c === "&" ? "&&" : "||");
      i++;
    } else if (c === "|") {
      endCommand("|");
      if (next === "&") i++;
    } else if (c === "&") {
      endCommand("&");
    } else if (c === "<" && next === "<" && text[i + 2] === "<") {
      // A here-string: the next word is data the command reads.
      if (/^\d+$/.test(word) && !quoted) word = "";
      else endWord();
      pending = "string";
      i += 2;
    } else if (c === "<" && next === "<" && command.words[0] === "let") {
      // let's arguments are arithmetic, whose << is a shift (sh reads a here-document there, whose body never runs:
      // the guard reads on as commands, the stricter of the two).
      word += "<<";
      i++;
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
  endCommand(";");
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

const upTo = (text: string, index: number): number => (index < 0 ? text.length : index);

// The ) that closes a $( or ( whose inside starts at `start`, past quotes, comments, nested parentheses and
// here-documents (a body may hold a lone ")"). The text's end when it never closes.
function closeParen(text: string, start: number): number {
  let depth = 1;
  const marks: string[] = [];
  for (let i = start; i < text.length; i++) {
    const c = text[i] as string;
    if (c === "\\") i++;
    else if (c === "'") i = upTo(text, text.indexOf("'", i + 1));
    else if (c === '"') i = closeDouble(text, i + 1);
    else if (c === "`") i = closeBacktick(text, i + 1);
    else if (c === "#" && (i === start || /[\s;&|()]/.test(text[i - 1] ?? ""))) i = upTo(text, text.indexOf("\n", i)) - 1;
    else if (c === "$" && text[i + 1] === "(") i = closeDollar(text, i).end;
    else if (c === "$" && text[i + 1] === "{") i = closeBrace(text, i + 2);
    else if (c === "$" && text[i + 1] === "[") i = closeBracket(text, i + 2);
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

// The } that closes a ${ whose inside starts at `start`, past quotes, nested ${ … }, $( … ) and backticks.
function closeBrace(text: string, start: number): number {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === "'") i = upTo(text, text.indexOf("'", i + 1));
    else if (c === '"') i = closeDouble(text, i + 1);
    else if (c === "`") i = closeBacktick(text, i + 1);
    else if (c === "$" && text[i + 1] === "(") i = closeDollar(text, i).end;
    else if (c === "$" && text[i + 1] === "{") {
      depth++;
      i++;
    } else if (c === "}" && --depth === 0) return i;
  }
  return text.length;
}

// The ] that closes a $[ whose inside starts at `start`.
function closeBracket(text: string, start: number): number {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "$" && text[i + 1] === "(") i = closeDollar(text, i).end;
    else if (text[i] === "[") depth++;
    else if (text[i] === "]" && --depth === 0) return i;
  }
  return text.length;
}

// The last ) of a (( … )) that opens at `at`, or -1 when it's two subshells: ((cd a && ls); pwd).
function closeArithmetic(text: string, at: number): number {
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    if (text[i] === "$" && text[i + 1] === "(") i = closeDollar(text, i).end;
    else if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text[i - 1] === ")" ? i : -1;
  }
  return -1;
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

// The $( … ) and backticks in a text that only expands (an unquoted here-document's body, a ${ … }), which run.
function substitutions(text: string): string[] {
  const found: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "$" && text[i + 1] === "(") {
      const { end, arithmetic } = closeDollar(text, i);
      if (!arithmetic) found.push(text.slice(i + 2, end));
      else found.push(...substitutions(text.slice(i + 3, end - 1)));
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

// What echo or printf prints, as the scripts a shell reading it runs: echo's words past its flags (-n, -e), and
// printf's format and each of its arguments on its own; \n starts a new line.
function printed(words: string[]): string[] {
  const [name = "", ...args] = words;
  const lines = (text: string): string => text.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
  if (basename(name) === "echo") {
    let i = 0;
    while (i < args.length && /^-[neE]+$/.test(args[i] as string)) i++;
    return [lines(args.slice(i).join(" "))];
  }
  const rest = args[0] === "-v" ? args.slice(2) : args;
  const [format = "", ...values] = rest[0] === "--" ? rest.slice(1) : rest;
  return [lines(format.replace(/%[-+ #0-9.*]*[a-zA-Z%]/g, " ")), ...values.map(lines)];
}

// The strings a command runs as shell code: sh -c, bash -c and zsh -c anywhere in it (env sh -c, xargs bash -c,
// find -exec sh -c, /bin/bash -c), eval, npx -c and npm exec -c/--call, pnpm's shell mode, and watch; and the
// commands runners take as their arguments (runnerScripts).
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
  for (const variant of unwrap(words)) scripts.push(...runnerScripts(variant));
  return scripts;
}

// The value of an option given as -x value, --long value or --long=value: every one of them.
function valuesOf(args: string[], names: string[]): string[] {
  const found: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const [option = "", inline] = arg.startsWith("--") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    if (!names.includes(option)) continue;
    if (inline !== undefined) found.push(inline);
    else if (args[i + 1] !== undefined) found.push(args[++i] as string);
  }
  return found;
}

// The commands a runner runs through a shell, from its arguments: concurrently's, nodemon --exec, ssh's remote
// command, tmux's (new, split-window, send-keys, …), git rebase -x, git submodule foreach and git bisect run, flock -c,
// script -c, su -c, watchexec's and parallel's.
function runnerScripts(words: string[]): string[] {
  const [first = "", ...rest] = words;
  const name = basename(first);
  switch (name) {
    case "concurrently":
      // concurrently "pnpm dev" "npm:test": each argument is a command, npm:<script> a package script.
      return operands(rest, ["-n", "--names", "-c", "--prefix-colors", "-p", "--prefix", "-s", "--success", "-m", "--max-processes"]).map((arg) =>
        arg.replace(/^(npm|pnpm|yarn|bun):(\S+)$/, "$1 run $2")
      );
    case "nodemon":
      return valuesOf(rest, ["-x", "--exec"]);
    case "ssh": {
      const [, ...command] = operands(rest, [
        "-B",
        "-b",
        "-c",
        "-D",
        "-E",
        "-e",
        "-F",
        "-I",
        "-i",
        "-J",
        "-L",
        "-l",
        "-m",
        "-O",
        "-o",
        "-p",
        "-Q",
        "-R",
        "-S",
        "-W",
        "-w",
      ]);
      return command.length ? [command.join(" ")] : [];
    }
    case "tmux": {
      // Each of its arguments on its own: tmux new -d -s web 'pnpm dev', tmux send-keys -t web 'pnpm test' Enter.
      const at = rest.findIndex((arg, i) => !arg.startsWith("-") && !/^-[LSfT]$/.test(rest[i - 1] ?? ""));
      const sub = rest[at] ?? "";
      if (
        !/^(new|new-session|new-window|neww|split-window|splitw|respawn-pane|respawnp|respawn-window|respawnw|run-shell|run|send-keys|send|display-popup|popup)$/.test(
          sub
        )
      )
        return [];
      return operands(rest.slice(at + 1), ["-s", "-n", "-t", "-c", "-e", "-F", "-x", "-y", "-l", "-f", "-N", "-T", "-w", "-h", "-b", "-B", "-S"]);
    }
    case "git": {
      const [sub = "", ...args] = gitGlobals(words).args;
      if (sub === "rebase") return valuesOf(args, ["-x", "--exec"]);
      if (sub === "submodule" && args[0] === "foreach") return [options(args.slice(1)).join(" ")];
      if (sub === "bisect" && args[0] === "run") return [args.slice(1).join(" ")];
      return [];
    }
    case "flock":
    case "script":
    case "su":
      return valuesOf(rest, ["-c", "--command"]);
    case "parallel":
      // parallel 'pnpm --filter {} test' ::: web api, or the commands themselves: parallel ::: 'pnpm lint' 'pnpm test'.
      return operands(rest, ["-j", "--jobs", "-S", "--sshlogin", "--joblog", "--tmpdir", "-a", "--arg-file", "--delay", "--timeout"]).filter(
        (arg) => !/^:{3,4}\+?$/.test(arg)
      );
    case "watchexec": {
      const dash = rest.indexOf("--");
      const command =
        dash >= 0
          ? rest.slice(dash + 1)
          : operands(rest, [
              "-w",
              "--watch",
              "-e",
              "--exts",
              "-f",
              "--filter",
              "-i",
              "--ignore",
              "-s",
              "--signal",
              "-d",
              "--debounce",
              "--shell",
              "-E",
              "--env",
            ]);
      return command.length ? [command.join(" ")] : [];
    }
    default:
      return [];
  }
}

// The code a program runs from its arguments (node -e, python -c, perl -e, …), as the strings quoted in it: a shell
// command that code may hand to execSync or os.system ('vercel deploy --prod'). Reading every quoted string is a
// seatbelt, not a parser of each language.
const CODE: [RegExp, RegExp][] = [
  [/^(node|nodejs|bun)$/, /^(-[a-zA-Z]*[ep]|--eval|--print)$/],
  [/^(python[\d.]*|pypy[\d.]*)$/, /^-[a-zA-Z]*c$/],
  [/^(perl|ruby)$/, /^-[a-zA-Z]*[eE]$/],
  [/^php$/, /^-r$/],
];
function codeStrings(words: string[]): string[] {
  const strings: string[] = [];
  for (const variant of unwrap(words)) {
    const [first = "", ...rest] = variant;
    const name = basename(first);
    const code: string[] = [];
    if (name === "deno" && rest[0] === "eval") code.push(...operands(rest.slice(1)).slice(0, 1));
    const flags = CODE.find(([program]) => program.test(name))?.[1];
    if (flags)
      rest.forEach((arg, i) => {
        if (flags.test(arg) && rest[i + 1] !== undefined) code.push(rest[i + 1] as string);
        else if (/^--(eval|print)=/.test(arg) && /^(node|nodejs|bun)$/.test(name)) code.push(arg.slice(arg.indexOf("=") + 1));
      });
    for (const text of code) strings.push(...quotedIn(text));
  }
  return strings;
}

// The strings quoted in code ('…', "…", `…`), with their escapes read.
export function quotedIn(code: string): string[] {
  const found: string[] = [];
  for (let i = 0; i < code.length; i++) {
    const quote = code[i];
    if (quote !== "'" && quote !== '"' && quote !== "`") continue;
    let text = "";
    let j = i + 1;
    for (; j < code.length && code[j] !== quote; j++) {
      if (code[j] === "\\" && j + 1 < code.length) {
        const e = code[++j] as string;
        text += e === "n" ? "\n" : e === "t" ? "\t" : e;
      } else text += code[j];
    }
    if (text.trim()) found.push(text);
    i = j;
  }
  return found;
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
    case "source":
    case ".":
      // source and . run a script with its arguments: . .e9g/adapters/env.sh reset runs env.sh reset.
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
    case "arch":
      return options(rest, ["-arch", "-d", "-e"]);
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

// The factory's CLI called by its path (~/.e9g/bin/e9g, node …/bin/e9g.ts) reads as e9g, past the runtime's own
// options (node --no-warnings --import x …/e9g.ts, deno run -A …/e9g.ts, bun run …/e9g.ts).
const RUNTIMES = /^(node|nodejs|bun|tsx|ts-node|deno)$/;
function e9gCli(words: string[]): string[] {
  const e9g = (word: string | undefined) => /^e9g(\.ts|\.mjs|\.js)?$/.test(basename(word ?? ""));
  if (RUNTIMES.test(basename(words[0] ?? "")))
    for (let i = 1; i < words.length; i++) {
      const word = words[i] as string;
      if (e9g(word)) return ["e9g", ...words.slice(i + 1)];
      const previous = words[i - 1] as string;
      // An option, the value of one before it (--import tsx), or deno run / bun run.
      if (word.startsWith("-") || (i > 1 && /^-/.test(previous) && !previous.includes("=")) || (i === 1 && word === "run")) continue;
      break;
    }
  if (e9g(words[0]) && words[0] !== "e9g") return ["e9g", ...words.slice(1)];
  return words;
}

// The command as written, then with each wrapper taken off, one at a time: timeout 600 npx vercel deploy is also
// npx vercel deploy and vercel deploy, and e9g lock app -- pnpm --filter web deploy is also pnpm deploy. The last
// variant is the command that actually runs.
export function unwrap(words: string[]): string[][] {
  const variants: string[][] = [];
  for (let current: string[] | null = words; current?.length && variants.length < 16; ) {
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
// what echo and printf print. A rule never matches inside it, unless it's one that reads free text (a live key); a
// command substitution in it was read on its own.
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
// the plain command, without its free text (withText: with it, for the rules that read free text: a team's own,
// which name data such as a project id or a setting, and the policies' rules for data such as a live key). Separators
// inside a word were quoted data, so they're blanked.
export function lines(command: ShellCommand, { withText = false } = {}): string[] {
  const found = new Set<string>();
  for (const words of unwrap(command.words))
    found.add((withText ? normalize(words) : withoutText(normalize(words))).map((word) => word.replace(/[;&|`()\n]/g, " ")).join(" "));
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

// Commands that name files without reading what's in them: ls .env* lists names.
export const NAMES_ONLY = /^(ls|stat|test|\[|\[\[)$/;

// A command's words past those that only keep files out: --exclude=.env*, -g '!.env*', a word starting with !, git's
// ':!.env' pathspecs and zip's -x list. What's left may name a file the command reads.
export function withoutExcludes(words: string[]): string[] {
  const kept: string[] = [];
  const zip = /^(zip|7z|7za)$/.test(basename(words[0] ?? ""));
  for (let i = 0; i < words.length; i++) {
    const word = words[i] as string;
    const [option = "", inline] = word.startsWith("--") ? word.split(/=(.*)/s, 2) : [word, undefined];
    if (/^(!|:!|:\^|:\([^)]*\bexclude\b)/.test(word)) continue;
    if (/^--(exclude|exclude-dir|ignore|ignore-pattern)$/.test(option)) {
      if (inline === undefined) i++;
      continue;
    }
    if (/^(-g|--glob|--iglob)$/.test(option) && (inline ?? words[i + 1] ?? "").startsWith("!")) {
      if (inline === undefined) i++;
      continue;
    }
    if (zip && /^-x/.test(word)) {
      while (i + 1 < words.length && !/^-/.test(words[i + 1] as string)) i++;
      continue;
    }
    kept.push(word);
  }
  return kept;
}
