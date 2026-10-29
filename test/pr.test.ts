// e9g pr: the planner's pull request, from the branch it pushes into the one the operator promotes into
// (team.json push.pullRequest). gh is a stand-in that records what it was asked; the remote is a bare repository
// behind a GitHub address (git's insteadOf), so the pull request names acme/app while the push stays on disk.
import { baseTeam, bash, commit, e9g, git, holds, machine, makeRepo, tmp, write } from "./helpers.ts";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { githubRepo, shownUrl } from "../lib/commands/pr.ts";
import { loadTeam, normalize, type RawTeam } from "../lib/config.ts";
import { compile } from "../lib/prompts.ts";
import { validator } from "./jsonschema.ts";

const ADDRESS = "git@github.com:acme/app.git";

// A team's checkout whose origin is acme/app on GitHub, as far as anything but git's transport can tell.
function checkout(push: RawTeam["push"] = { remote: "origin", pullRequest: true }): { home: string; run: string } {
  const home = makeRepo(baseTeam({ push }));
  const bare = tmp("e9g-remote-");
  git(bare, "init", "-q", "--bare");
  git(home, "remote", "add", "origin", ADDRESS);
  git(home, "config", `url.${bare}.insteadOf`, ADDRESS);
  const run = tmp("e9g-run-");
  write(run, { "planner-thread": "mcp:planner-1\n" });
  write(home, { ".e9g/run/scratch/pr.md": "## What's in it\n\nThe charity approval journey, end to end.\n" });
  return { home, run };
}

// gh as far as e9g pr uses it: every call's arguments in calls, the body it was given in body, and the open pull
// requests `pr list` answers from list (none, unless a test writes one).
function fakeGh(): { dir: string; calls: () => string[]; body: () => string; list: (json: string) => void } {
  const dir = tmp("e9g-gh-");
  write(dir, {
    gh: `#!/bin/sh
printf '%s\\n' "$*" >> "${dir}/calls"
case "$1 $2" in
  "pr list") cat "${dir}/list" 2>/dev/null || echo "[]" ;;
  "pr create") cat > "${dir}/body"; echo "https://github.com/acme/app/pull/12" ;;
  "pr edit") cat > "${dir}/body" ;;
  *) exit 1 ;;
esac
`,
  });
  chmodSync(join(dir, "gh"), 0o755);
  const read = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : "");
  return {
    dir,
    calls: () => read("calls").split("\n").filter(Boolean),
    body: () => read("body"),
    list: (json) => write(dir, { list: json }),
  };
}

const prAs = (role: string, { home, run }: { home: string; run: string }, gh: { dir: string }, ...args: string[]) =>
  e9g(["pr", ...args], {
    cwd: home,
    env: { PATH: `${gh.dir}:${process.env.PATH}`, E9G_TEAM: "fixture", E9G_HOME_DIR: home, E9G_RUN: run, E9G_ROLE: role },
  });
const bodyFile = (home: string) => join(home, ".e9g/run/scratch/pr.md");

describe("e9g pr", { concurrency: true }, () => {
  test("push.pullRequest: true goes into base, a name into that branch, never into the branch it comes from", () => {
    const pullOf = (raw: RawTeam) => normalize({ name: "app", branch: "e9g/next", ...raw }, "/tmp/app");
    assert.equal(pullOf({ push: { pullRequest: true } }).team.push?.pullRequest, "main");
    assert.equal(pullOf({ base: "trunk", push: { pullRequest: true } }).team.push?.pullRequest, "trunk");
    assert.equal(pullOf({ push: { pullRequest: "release" } }).team.push?.pullRequest, "release");
    assert.equal(pullOf({ push: { pullRequest: false } }).team.push?.pullRequest, null);
    assert.equal(pullOf({ push: {} }).team.push?.pullRequest, null);
    assert.match(pullOf({ push: { pullRequest: "e9g/next" } }).problems.join("; "), /push\.pullRequest: e9g\/next is the branch the planner pushes/);
    assert.match(pullOf({ push: { pullRequest: 5 as never } }).problems.join("; "), /push\.pullRequest: true \(into base\), or the branch/);

    const validate = validator(JSON.parse(readFileSync(join(import.meta.dirname, "..", "schema", "team.schema.json"), "utf8")));
    const base = { name: "app", branch: "e9g/next" };
    for (const pullRequest of [true, false, "main"]) assert.deepEqual(validate({ ...base, push: { pullRequest } }), [], `the schema takes ${pullRequest}`);
    for (const pullRequest of ["", 5]) assert.notDeepEqual(validate({ ...base, push: { pullRequest } }), [], `the schema refuses ${pullRequest}`);
  });

  test("names the GitHub repository from any of a remote's address forms, and nothing else", () => {
    for (const url of [
      "git@github.com:acme/app.git",
      "git@github.com:acme/app",
      "https://github.com/acme/app.git",
      "https://github.com/acme/app",
      "https://x-access-token@github.com/acme/app.git",
      "ssh://git@github.com/acme/app.git",
      "ssh://git@ssh.github.com:443/acme/app.git",
      "git@github-bot:acme/app.git",
    ])
      assert.equal(githubRepo(url), "acme/app", url);
    assert.equal(githubRepo("git@github.example.com:acme/app.git"), "github.example.com/acme/app");
    for (const url of ["/tmp/app.git", "file:///tmp/app.git", "git@gitlab.com:acme/app.git", "https://bitbucket.org/acme/app.git"])
      assert.equal(githubRepo(url), null, url);
    assert.equal(shownUrl("https://x-access-token:ghp_secret@gitlab.com/acme/app.git"), "https://gitlab.com/acme/app.git", "a token isn't printed");
    assert.equal(shownUrl("git@gitlab.com:acme/app.git"), "git@gitlab.com:acme/app.git");
  });

  test("only the planner runs it, and gh's own pull requests stay refused", async () => {
    const { home } = checkout();
    await holds([
      bash(home, "planner", `e9g pr --title "Sprint one" --body-file ${bodyFile(home)}`, "allow"),
      bash(home, "builder", `e9g pr --title "Sprint one" --body-file ${bodyFile(home)}`, "refuse"),
      bash(home, "reviewer", "e9g pr --title x --body y", "refuse"),
      bash(home, "planner", "e9g progress", "allow"),
      bash(home, "planner", "gh pr create --fill", "refuse"),
    ]);
    const gh = fakeGh();
    const result = await prAs("builder", { home, run: tmp() }, gh, "--title", "x", "--body", "y");
    assert.equal(result.code, 2);
    assert.match(result.out, /only the planner does this/);
    assert.deepEqual(gh.calls(), [], "and asks gh nothing");
  });

  test("opens the pull request for what's pushed, labelled and signed, then updates the open one", async () => {
    const team = checkout();
    const gh = fakeGh();
    const notYet = await prAs("planner", team, gh, "--title", "Sprint one", "--body-file", bodyFile(team.home));
    assert.equal(notYet.code, 2, notYet.out);
    assert.match(notYet.out, /e9g\/next isn't on origin yet: git push origin e9g\/next first/);

    git(team.home, "push", "-q", "origin", "e9g/next");
    const pushed = git(team.home, "rev-parse", "e9g/next");
    const opened = await prAs("planner", team, gh, "--title", "Sprint one", "--body-file", bodyFile(team.home));
    assert.equal(opened.code, 0, opened.out);
    assert.match(opened.out, /opened e9g\/next into main: https:\/\/github\.com\/acme\/app\/pull\/12/);
    assert.deepEqual(gh.calls(), [
      "pr list --repo acme/app --head e9g/next --base main --state open --json number,url --limit 1",
      "pr create --repo acme/app --head e9g/next --base main --title [E9G-Planner] [Fixture team] Sprint one --body-file -",
    ]);
    assert.match(gh.body(), /^## What's in it\n\nThe charity approval journey, end to end\.\n\n---\n/);
    assert.match(gh.body(), new RegExp(`Holds \`e9g/next\` at ${pushed.slice(0, 9)}\\. Merging it promotes the team's work into \`main\``));
    assert.match(gh.body(), /\n— planner · mcp:planner-1\n$/);

    // Work merged since the push: the open one is updated, and says what isn't in it yet. A title that already
    // carries the labels doesn't get them twice.
    commit(team.home, { "src/next.ts": "export const next = 1;\n" }, "merge 13");
    gh.list('[{"number":12,"url":"https://github.com/acme/app/pull/12"}]');
    const updated = await prAs("planner", team, gh, "--title", "[E9G-Planner] [Fixture team] Sprint two", "--body", "More of it.");
    assert.equal(updated.code, 0, updated.out);
    assert.match(updated.out, /updated #12, e9g\/next into main: https:\/\/github\.com\/acme\/app\/pull\/12/);
    assert.equal(gh.calls().at(-1), "pr edit 12 --repo acme/app --title [E9G-Planner] [Fixture team] Sprint two --body-file -");
    assert.match(gh.body(), new RegExp(`Holds \`e9g/next\` at ${pushed.slice(0, 9)}; 1 newer commit\\(s\\) on the team's machine aren't pushed yet\\.`));
  });

  test("refuses a team without a pull request, a remote that isn't GitHub, and a call without a title or body", async () => {
    const gh = fakeGh();
    const none = checkout({ remote: "origin" });
    assert.match((await prAs("planner", none, gh, "--title", "x", "--body", "y")).out, /this team opens no pull request/);
    const elsewhere = checkout();
    git(elsewhere.home, "remote", "set-url", "origin", "git@gitlab.com:acme/app.git");
    const gitlab = await prAs("planner", elsewhere, gh, "--title", "x", "--body", "y");
    assert.equal(gitlab.code, 2);
    assert.match(gitlab.out, /origin \(git@gitlab\.com:acme\/app\.git\) isn't a GitHub repository/);
    const team = checkout();
    for (const args of [
      ["--title", "x"],
      ["--body", "y"],
      ["--title", "", "--body", "y"],
      ["--title", "x", "--body", "  "],
    ])
      assert.match((await prAs("planner", team, gh, ...args)).out, /usage: e9g pr/, args.join(" "));
    assert.match((await prAs("planner", team, gh, "--title", "x", "--body-file", "/nowhere.md")).out, /no file \/nowhere\.md/);
    assert.deepEqual(gh.calls(), [], "none of them reached gh");
  });

  test("the planner's rules name it only when the team has one, and e9g check proves it", async () => {
    const { home } = checkout();
    const planner = compile(loadTeam(home), "planner");
    assert.match(planner, /After a push, the planner's `e9g pr` opens the pull request from `e9g\/next` into `main`/);
    assert.match(planner, /`e9g pr --title "<what it holds>" --body-file <file>`: after a push/);
    assert.doesNotMatch(compile(loadTeam(home), "builder"), /`e9g pr --title/);
    assert.doesNotMatch(compile(loadTeam(makeRepo(baseTeam({ push: { remote: "origin" } }))), "planner"), /e9g pr/);

    const { env } = machine();
    const checked = await e9g(["check", home], { cwd: home, env: { PATH: env.PATH } });
    assert.doesNotMatch(checked.out, /^FAIL {2}guard:/m, checked.out);
    assert.match(checked.out, /^ok {4}e9g pr opens the planner's pull request on acme\/app, from e9g\/next into main$/m);
    assert.match(checked.out, /pushes: only the planner, e9g\/next to origin, with a pull request into main \(e9g pr\) for you to merge/);
  });
});
