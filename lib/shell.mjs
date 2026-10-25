// A small reader for shell command lines, for the guard: enough of sh's quoting to tell commands from data.
// It splits a line into simple commands (on ; & && || |, newlines, parentheses and braces, $( … ) and backticks,
// and if/then/do/else words), strips the quotes from each word, drops here-document bodies, keeps redirect targets
// apart from the words, and reads the strings given to sh -c, bash -c and eval as commands of their own.
// It isn't a shell: it's meant to read what an honest agent writes the way a person would.

const KEYWORDS = /^(if|then|do|else|elif|while|until|!|time)$/;

// Here-document bodies are data, not commands: `cat <<'EOF' > notes.md` … `EOF`.
function dropHereDocs(text) {
  const lines = text.split("\n");
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    kept.push(lines[i]);
    for (const [, , mark] of lines[i].matchAll(/<<-?\s*(['"]?)([\w.-]+)\1/g)) {
      while (i + 1 < lines.length && lines[i + 1].trim() !== mark) i++;
      i++;
    }
  }
  return kept.join("\n");
}

function tokenize(text) {
  const commands = [];
  let words = [];
  let redirects = [];
  let word = "";
  let quoted = false;
  let pending = null; // "out" after > or >>, "in" after <
  const endWord = () => {
    if (word || quoted) {
      if (pending === "out") redirects.push(word);
      else if (pending !== "in") words.push(word);
      pending = null;
    }
    word = "";
    quoted = false;
  };
  const endCommand = () => {
    endWord();
    pending = null;
    if (words.length || redirects.length) commands.push({ words, redirects });
    words = [];
    redirects = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      word += text.slice(i + 1, end < 0 ? text.length : end);
      quoted = true;
      i = end < 0 ? text.length : end;
    } else if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\" && j + 1 < text.length) {
          word += text[j + 1];
          j += 2;
        } else word += text[j++];
      }
      quoted = true;
      i = j;
    } else if (c === "\\") {
      word += text[i + 1] ?? "";
      i++;
    } else if (c === "$" && text[i + 1] === "{") {
      // ${VAR} is part of a word.
      const end = text.indexOf("}", i);
      word += text.slice(i, end < 0 ? text.length : end + 1);
      i = end < 0 ? text.length : end;
    } else if (c === "$" && text[i + 1] === "(") {
      endCommand();
      i++;
    } else if (c === "`" || c === "\n" || c === ";" || c === "(" || c === ")" || c === "{" || c === "}") {
      endCommand();
    } else if (c === "&" && text[i + 1] === ">") {
      // &> and &>> send both streams to a file.
      endWord();
      i += text[i + 2] === ">" ? 2 : 1;
      pending = "out";
    } else if (c === "&" || c === "|") {
      endCommand();
    } else if (c === ">" || c === "<") {
      // [n]> [n]>> >| write a file; >&n and <&n duplicate a descriptor; < reads one.
      if (/^\d+$/.test(word) && !quoted) word = "";
      else endWord();
      let j = i + 1;
      if (text[j] === ">" || text[j] === "|") j++;
      if (text[j] === "&") {
        j++;
        while (/[\d-]/.test(text[j] ?? "")) j++;
        i = j - 1;
        continue;
      }
      pending = c === ">" ? "out" : "in";
      i = j - 1;
    } else if (/\s/.test(c)) {
      endWord();
    } else word += c;
  }
  endCommand();
  for (const command of commands) while (KEYWORDS.test(command.words[0] ?? "")) command.words.shift();
  return commands.filter((command) => command.words.length || command.redirects.length);
}

export function parseShell(source, depth = 0) {
  // Command substitutions inside double quotes run too: read their insides as commands of their own as well.
  const inner = [...source.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)].map((match) => match[1] ?? match[2]);
  const commands = tokenize(dropHereDocs([source.replace(/\\\n/g, " "), ...inner].join("\n")));
  if (depth > 2) return commands;
  const nested = [];
  for (const { words } of commands) {
    const at = words.findIndex((word, i) => (/^(ba|z)?sh$/.test(words[0] ?? "") && i > 0 && /^-\w*c\w*$/.test(word)) || (i === 0 && word === "eval"));
    if (at >= 0 && words[at + 1] !== undefined) nested.push(...parseShell(words.slice(at + 1).join(" "), depth + 1));
  }
  return [...commands, ...nested];
}

// The commands as one line, separated by " ; ", with quotes gone: what the guard's rules are matched against.
// Separators inside a word were quoted data (a commit message, a grep pattern), so they're blanked; the strings sh -c
// and eval run were already read as commands of their own.
export const flatten = (commands) => commands.map((command) => command.words.map((word) => word.replace(/[;&|`()\n]/g, " ")).join(" ")).join(" ; ");
