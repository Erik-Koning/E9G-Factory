// The shell reader on its own (lib/shell.ts): how it splits, quotes and nests, where each command runs, and what the
// rules then read.
import { tmp } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { lines, parseShell, quotedIn, unwrap, withoutExcludes, withoutText } from "../lib/shell.ts";

const words = (source: string, cwd = "/w"): string[][] => parseShell(source, cwd).map((command) => command.words);
// Whether one of the commands read from a script is this one.
const reads = (source: string, ...command: string[]) =>
  assert.ok(
    words(source).some((found) => found.join(" ") === command.join(" ")),
    `${JSON.stringify(source)} reads ${JSON.stringify(command)}: ${JSON.stringify(words(source))}`
  );
const readsNot = (source: string, ...command: string[]) =>
  assert.ok(!words(source).some((found) => found.join(" ") === command.join(" ")), `${JSON.stringify(source)} doesn't read ${JSON.stringify(command)}`);
// Where the last command starting with `word` runs.
const cwdOf = (source: string, word: string, cwd: string): string | undefined =>
  parseShell(source, cwd).findLast((command) => command.words[0] === word)?.cwd;

describe("parseShell: commands and words", () => {
  test("splits on ; && || | & and new lines, and drops if/then/do words", () => {
    assert.deepEqual(words("a 1; b && c || d | e & f\ng"), [["a", "1"], ["b"], ["c"], ["d"], ["e"], ["f"], ["g"]]);
    assert.deepEqual(words("if true; then pnpm test; fi"), [["true"], ["pnpm", "test"], ["fi"]]);
    assert.deepEqual(words("(cd a && ls) && { pwd; }"), [["cd", "a"], ["ls"], ["pwd"]]);
    assert.deepEqual(words("ls {a,b}/c"), [["ls", "{a,b}/c"]]);
  });

  test("strips quotes the way sh does", () => {
    assert.deepEqual(words(`echo 'a b' "c \\"d\\" $HOME" e\\ f ''`), [["echo", "a b", 'c "d" $HOME', "e f", ""]]);
    assert.deepEqual(words("echo $'it\\'s'\nvercel deploy"), [
      ["echo", "it's"],
      ["vercel", "deploy"],
    ]);
  });

  test("skips comments, whose apostrophes and << mean nothing", () => {
    assert.deepEqual(words("# Let's ship it\nvercel deploy"), [["vercel", "deploy"]]);
    assert.deepEqual(words("echo a#b # it's a << comment\nls"), [["echo", "a#b"], ["ls"]]);
  });

  test("keeps redirect targets apart: the files written and read, not descriptors", () => {
    const [command] = parseShell("cmd > out.txt 2>&1 < in.txt >> log &> all", "/w");
    assert.deepEqual(command?.words, ["cmd"]);
    assert.deepEqual(command?.redirects, ["out.txt", "log", "all"]);
    assert.deepEqual(command?.reads, ["in.txt"]);
  });

  test("time and its -p come off the command", () => {
    assert.deepEqual(words("time -p vercel deploy --prod"), [["vercel", "deploy", "--prod"]]);
  });
});

describe("parseShell: what runs inside other commands", () => {
  test("$( … ), backticks, <( … ) and >( … ), in double quotes too", () => {
    reads("echo $(vercel whoami)", "vercel", "whoami");
    reads("echo `vercel whoami`", "vercel", "whoami");
    reads('echo "$(vercel whoami) and `id`"', "id");
    reads("diff <(vercel deploy) b", "vercel", "deploy");
    reads("tee >(vercel deploy) < x", "vercel", "deploy");
    assert.deepEqual(words("echo $(date)")[1], ["echo", "$(…)"]);
  });

  test("${ … } is read with what's nested in it", () => {
    reads("echo ${X:-$(vercel deploy --prod)}", "vercel", "deploy", "--prod");
    reads('echo "${X:-$(vercel deploy --prod)}"', "vercel", "deploy", "--prod");
    reads("y=${X:-`vercel deploy`}", "vercel", "deploy");
    reads("echo ${A:-${B:-$(vercel deploy)}} after", "vercel", "deploy");
    assert.deepEqual(words("echo ${HOME} ${X:-a b}"), [["echo", "${HOME}", "${X:-a b}"]]);
  });

  test("arithmetic is a word, and its << a shift, not a here-document", () => {
    reads("echo $((1<<2))\nvercel deploy", "vercel", "deploy");
    reads("(( x = 1 << 4 ))\nvercel deploy --prod", "vercel", "deploy", "--prod");
    reads("echo $[1<<2]\nvercel deploy --prod", "vercel", "deploy", "--prod");
    reads("let x=1<<2\nvercel deploy --prod", "vercel", "deploy", "--prod");
    reads("echo $(( $(vercel deploy) + 1 ))", "vercel", "deploy");
    assert.deepEqual(words("for (( i=0; i<3; i++ )); do echo $i; done"), [["for", "(( i=0; i<3; i++ ))"], ["echo", "$i"], ["done"]]);
    // Two subshells, not arithmetic.
    reads("((cd a && vercel deploy); pwd)", "vercel", "deploy");
  });

  test("here-documents: data, unless a shell reads them; an unquoted body's substitutions run", () => {
    readsNot("cat <<'EOF' > a.md\nvercel deploy\nEOF", "vercel", "deploy");
    reads("cat <<'EOF' > a.md\nbody\nEOF\nvercel deploy", "vercel", "deploy");
    reads("cat <<EOF > a.md\nRun $(vercel whoami)\nEOF", "vercel", "whoami");
    readsNot("cat <<'EOF' > a.md\nRun $(vercel whoami)\nEOF", "vercel", "whoami");
    reads("bash <<'EOF'\nvercel deploy\nEOF", "vercel", "deploy");
    reads("cat <<-EOF | sh\n\tvercel deploy\n\tEOF", "vercel", "deploy");
  });

  test("here-strings, echo and printf fed to a shell", () => {
    reads("bash <<< 'vercel deploy'", "vercel", "deploy");
    readsNot("cat <<< 'vercel deploy'", "vercel", "deploy");
    reads("echo 'vercel deploy --prod' | sh", "vercel", "deploy", "--prod");
    reads("echo -n 'vercel deploy --prod' | sh", "vercel", "deploy", "--prod");
    reads("echo -e 'true\\nvercel deploy' | bash", "vercel", "deploy");
    reads("printf '%s\\n' 'vercel deploy --prod' | bash", "vercel", "deploy", "--prod");
    reads("printf 'vercel deploy\\n' | sh", "vercel", "deploy");
    readsNot("echo 'vercel deploy' | cat", "vercel", "deploy");
  });

  test("the strings shells, eval and package runners run", () => {
    reads("sh -c 'vercel deploy'", "vercel", "deploy");
    reads("/bin/bash -lc 'vercel deploy'", "vercel", "deploy");
    reads("xargs -I{} sh -c 'vercel deploy {}'", "vercel", "deploy", "{}");
    reads("eval vercel deploy", "vercel", "deploy");
    reads("npx -c 'vercel deploy'", "vercel", "deploy");
    reads("npm exec -c 'vercel deploy'", "vercel", "deploy");
    reads("npm exec --call='vercel deploy'", "vercel", "deploy");
    reads("pnpm exec -c 'vercel deploy'", "vercel", "deploy");
    reads("watch -n 5 vercel deploy", "vercel", "deploy");
  });

  test("the commands runners take as arguments", () => {
    reads(`concurrently "pnpm dev" "vercel deploy --prod"`, "vercel", "deploy", "--prod");
    reads(`npx concurrently -n web,api 'vercel deploy'`, "vercel", "deploy");
    reads(`concurrently "npm:deploy"`, "npm", "run", "deploy");
    reads(`nodemon --exec 'vercel deploy'`, "vercel", "deploy");
    reads(`ssh -i key build-box 'vercel deploy --prod'`, "vercel", "deploy", "--prod");
    reads(`tmux new -d -s web 'vercel deploy --prod'`, "vercel", "deploy", "--prod");
    reads(`tmux send-keys -t web 'vercel deploy' Enter`, "vercel", "deploy");
    reads(`git rebase -x 'npm publish' HEAD~1`, "npm", "publish");
    reads(`git submodule foreach --recursive 'npm publish'`, "npm", "publish");
    reads(`flock /tmp/l -c 'vercel deploy'`, "vercel", "deploy");
    reads(`su -c 'vercel deploy'`, "vercel", "deploy");
    reads(`watchexec -e ts -- vercel deploy`, "vercel", "deploy");
    reads(`parallel ::: 'vercel deploy'`, "vercel", "deploy");
    readsNot("ssh build-box", "build-box");
  });

  test("the strings quoted in code a program runs are commands it may run, marked as read from code", () => {
    reads(`node -e "require('child_process').execSync('vercel deploy --prod')"`, "vercel", "deploy", "--prod");
    reads(`python3 -c "import os; os.system('vercel deploy --prod')"`, "vercel", "deploy", "--prod");
    reads(`perl -e 'system("vercel deploy")'`, "vercel", "deploy");
    reads(`node --eval="execSync('vercel deploy')"`, "vercel", "deploy");
    reads(`deno eval "Deno.run({cmd: ['sh', '-c', 'vercel deploy']})"`, "vercel", "deploy");
    const [, prose] = parseShell(`node -e "console.log('a > b')"`, "/w");
    assert.deepEqual(prose, { words: ["a"], redirects: ["b"], reads: [], cwd: "/w", inCode: true });
    assert.equal(parseShell(`node -e "console.log(1)"`, "/w")[0]?.inCode, false);
    assert.deepEqual(quotedIn(`run("a \\"b\\"", 'c\\nd', \`e\`)`), ['a "b"', "c\nd", "e"]);
  });

  test("nesting deeper than an honest command does is refused (MAX_DEPTH)", () => {
    const nested = (depth: number) => `${"echo $(".repeat(depth)}echo hi${")".repeat(depth)}`;
    assert.doesNotThrow(() => parseShell(nested(8)));
    assert.throws(() => parseShell(nested(9)), /nests shells and substitutions too deeply/);
  });
});

describe("parseShell: where each command runs", () => {
  const base = tmp("e9g-shell-");
  mkdirSync(join(base, "web/src"), { recursive: true });
  const web = join(base, "web");

  test("cd moves the commands after it; one in ( … ) or $( … ) ends with it", () => {
    assert.equal(cwdOf("cd web && git status", "git", base), web);
    assert.equal(cwdOf("cd web; git status", "git", base), web);
    assert.equal(cwdOf("cd web/src\ncd ..\ngit status", "git", base), web);
    assert.equal(cwdOf("(cd web && pnpm test); git status", "git", base), base);
    assert.equal(cwdOf("echo $(cd web); git status", "git", base), base);
    assert.equal(cwdOf("cd", "cd", base), base);
    assert.equal(cwdOf("cd; git status", "git", base), homedir());
  });

  test("a cd that fails leaves the shell where it was: after ; or || only to a folder that exists", () => {
    assert.equal(cwdOf("cd /tmp/e9g-does-not-exist; git reset --hard HEAD~1", "git", base), base);
    assert.equal(cwdOf("cd /tmp/e9g-does-not-exist || git reset --hard", "git", base), base);
    // After &&, the commands it guards run there if they run at all, until the and-list ends.
    assert.equal(cwdOf("cd /tmp/e9g-does-not-exist && git reset --hard", "git", base), "/tmp/e9g-does-not-exist");
    assert.equal(cwdOf("cd /tmp/e9g-does-not-exist && true; git reset --hard", "git", base), base);
    // A folder an earlier command made is found, though it doesn't exist yet.
    assert.equal(cwdOf("git worktree add --detach /tmp/e9g-new b && cd /tmp/e9g-new; git status", "git", base), "/tmp/e9g-new");
    assert.equal(cwdOf("mkdir -p fresh; cd fresh; git init", "git", base), join(base, "fresh"));
  });

  test("a cd in a pipeline or in the background moves nothing", () => {
    assert.equal(cwdOf("cd web | cat; git status", "git", base), base);
    assert.equal(cwdOf("cd web & git status", "git", base), base);
  });

  test("cd - and pushd and popd", () => {
    assert.equal(cwdOf("cd web && cd - && git merge x", "git", base), base);
    assert.equal(cwdOf("cd /tmp && cd - && git merge x", "git", base), base);
    assert.equal(cwdOf("pushd web >/dev/null; popd >/dev/null; git checkout x", "git", base), base);
    assert.equal(cwdOf("pushd web; pushd src; popd; git status", "git", base), web);
    assert.equal(cwdOf("pushd -n web; git status", "git", base), base);
    // cd - with no earlier folder known stays put.
    assert.equal(cwdOf("cd -; git status", "git", base), base);
  });
});

describe("unwrap, lines and free text", () => {
  test("unwrap takes the wrappers off, one at a time", () => {
    assert.deepEqual(unwrap(["timeout", "600", "npx", "vercel", "deploy"]), [
      ["timeout", "600", "npx", "vercel", "deploy"],
      ["npx", "vercel", "deploy"],
      ["vercel", "deploy"],
    ]);
    for (const [wrapped, inner] of [
      ["env FOO=1 nohup nice -n 5 vercel deploy", "vercel deploy"],
      ["e9g lock app -- pnpm --filter web exec vercel deploy", "vercel deploy"],
      ["find . -name x -exec vercel deploy {} ;", "vercel deploy {}"],
      ["xargs -n1 vercel deploy", "vercel deploy"],
      ["arch -arm64 e9g pause fixture", "e9g pause fixture"],
      ["source .e9g/adapters/env.sh reset", ".e9g/adapters/env.sh reset"],
      [". .e9g/adapters/env.sh reset", ".e9g/adapters/env.sh reset"],
      ["bash -x scripts/env.sh down", "scripts/env.sh down"],
    ] as const)
      assert.equal(unwrap(wrapped.split(" ")).at(-1)?.join(" "), inner, wrapped);
  });

  test("the factory's CLI by its path reads as e9g, past the runtime's own options", () => {
    for (const command of [
      "node ~/.e9g/versions/0.3.0/bin/e9g.ts pause fixture",
      "node --no-warnings ~/.e9g/versions/0.3.0/bin/e9g.ts pause fixture",
      "node --import tsx --experimental-strip-types /Users/x/.e9g/versions/dev/bin/e9g.ts pause fixture",
      "bun run ~/.e9g/versions/0.3.0/bin/e9g.ts pause fixture",
      "deno run -A ~/.e9g/versions/0.3.0/bin/e9g.ts pause fixture",
      "tsx bin/e9g.ts pause fixture",
      "~/.e9g/bin/e9g pause fixture",
    ])
      assert.ok(
        unwrap(command.split(" ")).some((variant) => variant.join(" ") === "e9g pause fixture"),
        command
      );
    assert.equal(unwrap(["node", "scripts/check.mjs", "e9g.ts"]).length, 1, "a script's own argument isn't the CLI");
  });

  test("withoutText leaves out messages, titles, bodies and what echo prints", () => {
    assert.deepEqual(withoutText(["git", "commit", "-m", "vercel deploy", "--", "a.ts"]), ["git", "commit", "-m", "--", "a.ts"]);
    assert.deepEqual(withoutText(["git", "commit", "-am", "x"]), ["git", "commit", "-am"]);
    assert.deepEqual(withoutText(["git", "commit", "--message=x"]), ["git", "commit", "--message"]);
    assert.deepEqual(withoutText(["gh", "issue", "create", "--title", "t", "-b", "b", "--label", "x"]), [
      "gh",
      "issue",
      "create",
      "--title",
      "-b",
      "--label",
      "x",
    ]);
    assert.deepEqual(withoutText(["echo", "vercel", "deploy"]), ["echo"]);
    assert.deepEqual(withoutText(["e9g", "log", "merged b1"]), ["e9g", "log"]);
    assert.deepEqual(withoutText(["e9g", "verdict", "review", "b", "approve", "--note", "x"]), ["e9g", "verdict", "review", "b", "approve", "--note"]);
  });

  test("lines: each variant as the plain command, with or without its text, separators in a word blanked", () => {
    const [push] = parseShell("git -C . -c core.pager=cat push --force origin x", "/w");
    assert.ok(push && lines(push).includes("git push --force origin x"));
    const [commit] = parseShell('git commit -m "a; vercel deploy"', "/w");
    assert.ok(commit);
    assert.deepEqual(lines(commit), ["git commit -m"]);
    assert.deepEqual(lines(commit, { withText: true }), ["git commit -m a  vercel deploy"]);
  });

  test("withoutExcludes leaves out what only keeps files out", () => {
    assert.deepEqual(withoutExcludes(["rg", "-n", "X", "-g", "!**/.env*", "--glob=!.env*", "-g", "*.ts"]), ["rg", "-n", "X", "-g", "*.ts"]);
    assert.deepEqual(withoutExcludes(["tar", "--exclude=.env*", "--exclude", ".env.local", "-czf", "x.tgz", "."]), ["tar", "-czf", "x.tgz", "."]);
    assert.deepEqual(withoutExcludes(["git", "diff", "--", ".", ":!.env*", ":(exclude).env"]), ["git", "diff", "--", "."]);
    assert.deepEqual(withoutExcludes(["zip", "-r", "x.zip", ".", "-x", ".env*", "*.pem"]), ["zip", "-r", "x.zip", "."]);
    assert.deepEqual(withoutExcludes(["grep", "-x", "A", ".env"]), ["grep", "-x", "A", ".env"], "grep's -x is a flag");
  });
});
