// Regressions from the audit of setup and distribution: installing and pinning releases, e9g init and its drafts,
// doctor, check, pages, metrics, team.json and its schema, and the docs. Each test names the finding it holds.
//
// Anything that installs, runs the launcher or runs doctor does it on a machine of its own (machine() in helpers.ts):
// HOME, E9G_HOME and T3CODE_HOME in a temporary folder, and a PATH whose t3, launchctl, claude and gh are stand-ins.
import { baseTeam, commit, e9g, git, gitRepo, machine, makeRepo, ROOT, sourceCopy, tmp, write } from "./helpers.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { teamName } from "../lib/commands/init.ts";
import { ASSERTION_PATTERN, normalize, type RawTeam } from "../lib/config.ts";
import { detect, draftTeam } from "../lib/detect.ts";
import { PACKAGE } from "../lib/paths.ts";
import { validator } from "./jsonschema.ts";

const VERSION = PACKAGE.version;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const norm = (raw: RawTeam | Record<string, unknown>) => normalize({ name: "t", branch: "e9g/next", ...raw } as RawTeam, "/tmp/x");
const problemsOf = (raw: Record<string, unknown>) => norm(raw).problems.join("\n");

// Runs a command line (a bin/e9g.ts, or the launcher) and collects what it prints.
function run(command: string[], { cwd, env = {} }: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    const [file = "", ...args] = command;
    const child = spawn(file, args, { env: { ...process.env, ...env }, ...(cwd === undefined ? {} : { cwd }) });
    let out = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk: Buffer) => (out += chunk));
    child.on("close", (code) => done({ code, out }));
  });
}
const node = (entry: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => run([process.execPath, entry, ...args], options);

const plist = (m: ReturnType<typeof machine>, path: string | null) => {
  const file = join(m.home, "Library", "LaunchAgents", "com.t3tools.t3code.service.plist");
  mkdirSync(dirname(file), { recursive: true });
  const env = path === null ? "" : `<key>EnvironmentVariables</key><dict><key>PATH</key><string>${path}</string></dict>`;
  writeFileSync(
    file,
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.t3tools.t3code.service</string>${env}</dict></plist>\n`
  );
};

describe("installing and pinning releases, on a machine of its own", () => {
  const m = machine();
  const source = sourceCopy();
  const older = sourceCopy("0.2.99");
  const versions = join(m.e9gHome, "versions");
  const launcher = (args: string[], cwd?: string) => run([m.launcher, ...args], { env: m.env, ...(cwd === undefined ? {} : { cwd }) });

  test("self-install from a clone: the release, current, the launcher, and a word about PATH (#10, #16)", async () => {
    const first = await node(join(older, "bin", "e9g.ts"), ["self-install"], { env: m.env });
    assert.equal(first.code, 0, first.out);
    const installed = await node(join(source, "bin", "e9g.ts"), ["self-install"], { env: m.env });
    assert.equal(installed.code, 0, installed.out);
    assert.ok(existsSync(join(versions, VERSION, "bin", "e9g.ts")));
    assert.ok(existsSync(join(versions, VERSION, "node_modules", "axe-core", "axe.min.js")), "axe-core comes along");
    assert.equal(realpathSync(join(m.e9gHome, "current")), realpathSync(join(versions, VERSION)));
    const text = readFileSync(join(m.e9gHome, "bin", "e9g"), "utf8");
    assert.match(text, new RegExp(`echo '${escape(join(m.bin, "node"))}'`), "the node PATH finds, not the folder it resolves to");
    assert.match(text, /export E9G_HOME="\$\{E9G_HOME:-\$HOME\/\.e9g\}"/, "the default home stays relative to HOME");
    assert.equal(realpathSync(m.launcher), realpathSync(join(m.e9gHome, "bin", "e9g")));
    assert.match(installed.out, new RegExp(`${escape(join(m.home, ".local", "bin"))} isn't on your PATH`));
    const version = await launcher(["--version"]);
    assert.equal(version.out.trim(), VERSION);
  });

  test("versions lists what's installed, and survives a dangling versions/dev link (#17)", async () => {
    symlinkSync(join(m.root, "a-checkout-that-moved"), join(versions, "dev"));
    const listed = await launcher(["versions"]);
    assert.equal(listed.code, 0, listed.out);
    assert.match(listed.out, new RegExp(`^\\* ${escape(VERSION)}\\b`, "m"));
    assert.match(listed.out, /^ {2}0\.2\.99\b/m);
    assert.match(listed.out, /dev\s+→ .*a-checkout-that-moved \(missing/);
    rmSync(join(versions, "dev"));
  });

  test("an installed copy never installs itself; --force swaps a release into place (#4)", async () => {
    // The trigger: a HOME that's a git work tree, so the installed copy looks like a checkout.
    git(m.home, "init", "-q");
    const self = await node(join(versions, VERSION, "bin", "e9g.ts"), ["self-install", "--force"], { env: m.env });
    assert.equal(self.code, 2, self.out);
    assert.match(self.out, /is an installed copy/);
    assert.ok(existsSync(join(versions, VERSION, "bin", "e9g.ts")), "the release is still there");
    rmSync(join(m.home, ".git"), { recursive: true, force: true });

    writeFileSync(join(source, "README.md"), "changed\n");
    const refused = await node(join(source, "bin", "e9g.ts"), ["self-install"], { env: m.env });
    assert.equal(refused.code, 2);
    assert.match(refused.out, /pass --force/);
    assert.match(refused.out, /next tool call/, "says when running teams pick the files up");
    const forced = await node(join(source, "bin", "e9g.ts"), ["self-install", "--force"], { env: m.env });
    assert.equal(forced.code, 0, forced.out);
    assert.equal(readFileSync(join(versions, VERSION, "README.md"), "utf8"), "changed\n");
    assert.deepEqual(
      readdirSync(versions).filter((name) => name.startsWith(".")),
      [],
      "no staging or replaced copies left"
    );
  });

  test("doctor: an unknown T3 Code service PATH is a warning, not ok (#9)", async () => {
    const lines = async () => (await launcher(["doctor"])).out;
    const unknown = await lines();
    assert.match(unknown, /^warn {2}T3 Code's service isn't a launchd job here/m);
    assert.doesNotMatch(unknown, /^ok {4}agents can run e9g/m);
    plist(m, null);
    assert.match(await lines(), /^warn {2}T3 Code's service sets no PATH/m);
    plist(m, `${join(m.home, ".local", "bin")}:${m.bin}:/usr/bin:/bin`);
    const known = await lines();
    assert.match(known, /^ok {4}agents can run e9g/m);
    assert.match(known, /^ok {4}the hooks run .*node, which runs TypeScript/m);
    assert.match(known, new RegExp(`^ok {4}E9G Factory ${escape(VERSION)} is the current version`, "m"));
  });

  test("doctor judges a team pinned to another version with that version's code (#9)", async () => {
    const home = makeRepo(baseTeam({ factory: "0.2.99", t3ProjectId: "p1" }));
    const runDir = join(m.root, "runs", "fixture");
    mkdirSync(join(m.e9gHome, "teams"), { recursive: true });
    writeFileSync(
      join(m.e9gHome, "teams", "fixture.json"),
      JSON.stringify({ name: "fixture", title: "Fixture team", home, run: runDir, version: "0.2.99" })
    );
    // Registered by 0.2.99: its prompts carry 0.2.99's sources hash.
    for (const role of Object.keys(baseTeam().roles ?? {})) {
      const prompt = await node(join(versions, "0.2.99", "bin", "e9g.ts"), ["prompt", "fixture", role], { env: m.env });
      mkdirSync(join(runDir, "prompts"), { recursive: true });
      writeFileSync(join(runDir, "prompts", `${role}.md`), prompt.out);
    }
    assert.match((await launcher(["doctor"])).out, /^ok {4}fixture: rules load, prompts current \(judged by 0\.2\.99\)/m);
    write(home, { ".e9g/team.json": baseTeam({ factory: "0.2.99", t3ProjectId: "p1", title: "Renamed" }) });
    assert.match((await launcher(["doctor"])).out, /^warn {2}fixture: prompts out of date for planner/m);
  });

  test("a source checkout runs its own code; the installed e9g hands a pinned team over (#18)", async () => {
    const home = makeRepo(baseTeam({ factory: "0.2.99" }));
    const fromSource = await node(join(ROOT, "bin", "e9g.ts"), ["prompt", home, "planner"], { cwd: home, env: m.env });
    assert.match(fromSource.out, new RegExp(`compiled by E9G Factory ${escape(VERSION)} `));
    const installed = await launcher(["prompt", home, "planner"], home);
    assert.match(installed.out, /compiled by E9G Factory 0\.2\.99 /);
  });
});

describe("a launcher for another E9G_HOME (#16)", () => {
  test("remembers it", async () => {
    const root = tmp("e9g-custom-");
    const m = machine({ e9gHome: join(root, "factory home") });
    const installed = await node(join(sourceCopy(), "bin", "e9g.ts"), ["self-install"], { env: m.env });
    assert.equal(installed.code, 0, installed.out);
    assert.match(readFileSync(join(m.e9gHome, "bin", "e9g"), "utf8"), new RegExp(`E9G_HOME="\\$\\{E9G_HOME:-${escape(m.e9gHome)}\\}"`));
    const { E9G_HOME: _, ...withoutHome } = { ...process.env, ...m.env };
    const listed = spawnSync(m.launcher, ["versions"], { env: withoutHome, encoding: "utf8" });
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, new RegExp(`^\\* ${escape(VERSION)}\\b`, "m"));
  });
});

describe("e9g init and its drafts", { concurrency: true }, () => {
  test("a repository without a build script gets adapters that parse, and check proves them once committed (#1, #3, #6, #11, #12, #15)", async () => {
    const m = machine();
    const repo = gitRepo(join(tmp("e9g-init-"), "2048"), {
      "package.json": { name: "game", scripts: { test: "node --test" } },
      "package-lock.json": "{}\n",
      "index.js": "\n",
    });
    git(repo, "remote", "add", "origin", "git@github.com:someone/game.git");
    const made = await e9g(["init", repo, "--owner", "op@example.com", "--no-interview"], { cwd: repo, env: m.env });
    assert.equal(made.code, 0, made.out);
    assert.match(made.out, /git add \.e9g && git commit -m "E9G team: team-2048"/, "says to commit before check --run");
    assert.ok(made.out.indexOf("git add .e9g") < made.out.indexOf("e9g check --run"));
    const checkout = `${repo}-e9g`;
    const team = JSON.parse(readFileSync(join(checkout, ".e9g", "team.json"), "utf8")) as RawTeam;
    assert.equal(team.name, "team-2048", "a name that starts with a digit gets team- in front");
    assert.equal(team.factory, VERSION, "the draft pins the version that wrote it");
    assert.equal(team.board, "tasks", "a GitHub remote isn't a reason to post issues");
    assert.match(readFileSync(join(checkout, ".e9g", "brief.md"), "utf8"), /## Budget[\s\S]*not a\s+limit the factory enforces/);
    const gate = readFileSync(join(checkout, ".e9g", "adapters", "gate.sh"), "utf8");
    assert.match(gate, /if \[ "\$\{1:-\}" != "--quick" \]; then\n {2}: # \(fill in/);
    for (const script of ["gate.sh", "env.sh", "after-merge.sh"]) {
      const parsed = spawnSync("bash", ["-n", join(checkout, ".e9g", "adapters", script)], { encoding: "utf8" });
      assert.equal(parsed.status, 0, `${script}: ${parsed.stderr}`);
    }

    const before = await e9g(["check", checkout], { cwd: checkout, env: m.env });
    assert.equal(before.code, 1, before.out);
    assert.match(before.out, /^FAIL {2}not committed on e9g\/next: .*\.e9g\/team\.json/m);
    assert.match(before.out, /^warn {2}factory: the team pins .*, which isn't installed here/m);
    git(checkout, "add", ".e9g");
    git(checkout, "commit", "-qm", "E9G team: team-2048");
    const after = await e9g(["check", checkout], { cwd: checkout, env: m.env });
    assert.equal(after.code, 0, after.out);
    assert.match(after.out, /^ok {4}\.e9g\/adapters\/gate\.sh parses \(bash -n\)/m);
    assert.match(after.out, /^ok {4}the rules and adapters are committed on e9g\/next/m);
    assert.match(after.out, /Ready: e9g register/);

    // What the old draft wrote for this repository: an if-block with nothing in it.
    writeFileSync(join(checkout, ".e9g", "adapters", "gate.sh"), gate.replace(/ {2}: # \(fill in[^\n]*\n/, ""));
    git(checkout, "commit", "-qam", "empty block");
    const broken = await e9g(["check", checkout], { cwd: checkout, env: m.env });
    assert.equal(broken.code, 1);
    assert.match(broken.out, /^FAIL {2}\.e9g\/adapters\/gate\.sh isn't valid bash/m);
  });

  test("a draft with build and test:e2e scripts parses too (#1)", async () => {
    const m = machine();
    const repo = gitRepo(tmp("e9g-init-"), {
      "package.json": { name: "shop", scripts: { build: "tsc", "test:e2e": "playwright test", lint: "eslint ." } },
      "package-lock.json": "{}\n",
    });
    assert.equal((await e9g(["init", repo, "--name", "shop", "--no-interview"], { cwd: repo, env: m.env })).code, 0);
    const gate = join(`${repo}-e9g`, ".e9g", "adapters", "gate.sh");
    assert.match(readFileSync(gate, "utf8"), /then\n {2}check build npm run build\n {2}check test-e2e npm run test:e2e\nfi/);
    assert.equal(spawnSync("bash", ["-n", gate]).status, 0);
  });

  test("--in-place makes the integration branch and checks it out; protected branches and dirty checkouts are refused (#7)", async () => {
    const m = machine();
    const files = { "package.json": { name: "app", scripts: {} }, "README.md": "app\n" };
    const repo = gitRepo(tmp("e9g-inplace-"), files);
    const made = await e9g(["init", repo, "--in-place", "--no-interview"], { cwd: repo, env: m.env });
    assert.equal(made.code, 0, made.out);
    assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "e9g/next");
    assert.equal(git(repo, "rev-parse", "e9g/next"), git(repo, "rev-parse", "main"), "made from the base");
    assert.ok(existsSync(join(repo, ".e9g", "team.json")));

    const protectedRepo = gitRepo(tmp("e9g-inplace-"), files);
    const refused = await e9g(["init", protectedRepo, "--in-place", "--branch", "main", "--no-interview"], { cwd: protectedRepo, env: m.env });
    assert.equal(refused.code, 2, refused.out);
    assert.match(refused.out, /branch: main is protected/);
    assert.ok(!existsSync(join(protectedRepo, ".e9g")), "nothing is written");
    const worktree = await e9g(["init", protectedRepo, "--branch", "master", "--no-interview"], { cwd: protectedRepo, env: m.env });
    assert.equal(worktree.code, 2, "a protected branch is refused for a new checkout too");
    assert.ok(!existsSync(`${protectedRepo}-e9g`));

    const dirty = gitRepo(tmp("e9g-inplace-"), files);
    writeFileSync(join(dirty, "README.md"), "edited\n");
    const busy = await e9g(["init", dirty, "--in-place", "--no-interview"], { cwd: dirty, env: m.env });
    assert.equal(busy.code, 2, busy.out);
    assert.match(busy.out, /uncommitted changes/);
    assert.equal(git(dirty, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  });

  test("an invalid --name is refused, and names come from the folder (#15)", async () => {
    const m = machine();
    const repo = gitRepo(tmp("e9g-name-"), { "README.md": "x\n" });
    const bad = await e9g(["init", repo, "--name", "2048", "--no-interview"], { cwd: repo, env: m.env });
    assert.equal(bad.code, 2);
    assert.match(bad.out, /--name 2048: lowercase letters/);
    assert.equal(teamName("2048"), "team-2048");
    assert.equal(teamName("My App"), "my-app");
    assert.equal(teamName("_private"), "private");
    assert.match(teamName("日本"), /^team-[0-9a-f]{6}$/);
    const long = teamName("a-very-long-repository-name-that-goes-on-");
    assert.ok(long.length <= 31 && !long.endsWith("-") && /^[a-z][a-z0-9-]*$/.test(long), long);
    for (const name of ["2048", "My App", "日本", "a".repeat(40), "---"]) assert.deepEqual(norm({ name: teamName(name) }).problems, [], name);
  });

  test("the draft keeps tickets on the machine, even for a GitHub repository (#11)", () => {
    const repo = gitRepo(tmp("e9g-detect-"), { "README.md": "x\n" });
    git(repo, "remote", "add", "origin", "https://github.com/someone/app.git");
    const found = detect(repo);
    assert.equal(found.git.github, "someone/app");
    assert.equal(draftTeam(found, { name: "app", branch: "e9g/next" }).board, "tasks");
    assert.equal(draftTeam(found, { name: "app", branch: "e9g/next" }).factory, VERSION);
  });
});

describe("e9g check", { concurrency: true }, () => {
  const { env } = machine();
  const checkOf = (home: string) => e9g(["check", home], { cwd: home, env: { PATH: env.PATH } });

  test("the checkout must be on its integration branch, which must exist (#7)", async () => {
    const home = makeRepo();
    git(home, "checkout", "-q", "main");
    const off = await checkOf(home);
    assert.equal(off.code, 1);
    assert.match(off.out, /^FAIL {2}the team's checkout is on main, not its integration branch e9g\/next/m);
    const missing = makeRepo(baseTeam({ branch: "e9g/elsewhere" }));
    git(missing, "checkout", "-q", "-b", "other");
    git(missing, "branch", "-q", "-D", "e9g/elsewhere");
    assert.match((await checkOf(missing)).out, /^FAIL {2}the integration branch e9g\/elsewhere doesn't exist/m);
  });

  test("adapters committed without their executable bit, and uncommitted changes (#6)", async () => {
    const home = makeRepo(baseTeam({ gate: { full: ".e9g/adapters/gate.sh" } }), { ".e9g/adapters/gate.sh": "#!/usr/bin/env bash\necho ok\n" });
    chmodSync(join(home, ".e9g", "adapters", "gate.sh"), 0o755);
    const result = await checkOf(home);
    assert.equal(result.code, 1);
    assert.match(result.out, /^FAIL {2}\.e9g\/adapters\/gate\.sh is committed without its executable bit/m);
    git(home, "add", "-A");
    git(home, "commit", "-qm", "executable");
    write(home, { ".e9g/adapters/gate.sh": "#!/usr/bin/env bash\necho changed\n" });
    const changed = await checkOf(home);
    assert.equal(changed.code, 0, changed.out);
    assert.match(changed.out, /^warn {2}\.e9g\/adapters\/gate\.sh has changes not committed on e9g\/next/m);
  });

  test("a bad duration names its key instead of crashing (#14)", async () => {
    const home = makeRepo(baseTeam({ watchdog: { tickEvery: "soon" } }));
    const result = await checkOf(home);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /^FAIL {2}team\.json: watchdog\.tickEvery: a duration/m);
  });

  test("every example loads and passes check (#19)", async () => {
    for (const file of readdirSync(join(ROOT, "examples"))) {
      const team = JSON.parse(readFileSync(join(ROOT, "examples", file), "utf8")) as RawTeam;
      assert.deepEqual(normalize(team, "/tmp/x").problems, [], file);
      const scripts = [team.gate?.full, team.gate?.quick, team.environment?.script, team.afterMerge]
        .filter((command): command is string => typeof command === "string")
        .map((command) => command.split(/\s+/)[0] ?? "");
      const home = makeRepo(team, Object.fromEntries(scripts.map((script) => [script, "#!/usr/bin/env bash\nexit 0\n"])));
      for (const script of scripts) chmodSync(join(home, script), 0o755);
      git(home, "add", "-A");
      git(home, "commit", "-qm", "executable");
      const result = await checkOf(home);
      assert.equal(result.code, 0, `${file}:\n${result.out}`);
      assert.doesNotMatch(result.out, /^FAIL/m, file);
    }
  });
});

describe("pages and metrics", { concurrency: true }, () => {
  const planner = (home: string) => ({ cwd: home, env: { E9G_HOME_DIR: home, E9G_TEAM: "fixture", E9G_ROLE: "planner" } });

  test("a pages finish line needs pages to check (#5)", async () => {
    assert.match(problemsOf({ finish: "e9g pages done" }), /pages: the finish line is e9g pages done/);
    assert.match(problemsOf({ finish: "e9g pages done", pages: {} }), /pages\.list: the pages to check/);
    assert.match(problemsOf({ finish: "e9g pages done", pages: { list: [] } }), /pages\.list: the pages to check/);
    assert.match(problemsOf({ pages: { list: [{ id: "a b", path: "/" }] } }), /pages\.list\[0\]\.id/);
    assert.match(problemsOf({ pages: { list: [{ id: "a", path: "a" }] } }), /pages\.list\[0\]\.path/);
    assert.match(
      problemsOf({
        pages: {
          list: [
            { id: "a", path: "/" },
            { id: "a", path: "/b" },
          ],
        },
      }),
      /more than one page is named a/
    );
    assert.match(problemsOf({ pages: { list: [{ id: "a", path: "/" }], schemes: ["sepia"] } }), /pages\.schemes\[0\]/);
    assert.match(problemsOf({ pages: { list: [{ id: "a", path: "/" }], viewports: [] } }), /pages\.viewports/);
    assert.match(norm({ pages: { list: [{ id: "a", path: "/" }], extra: 1 } }).warnings.join("\n"), /unknown key "pages\.extra"/);
    assert.deepEqual(norm({ finish: "e9g pages done", pages: { list: [{ id: "landing", path: "/", title: "Landing" }] } }).problems, []);
    // These teams don't load, so pages done never runs; the pages command's own refusal, for a team that loads, is in
    // review-setup.test.ts (#10 of that review).
    for (const pages of [undefined, {}, { list: [] }]) {
      const home = makeRepo(baseTeam({ finish: "e9g pages done", ...(pages ? { pages } : {}) }));
      const done = await e9g(["pages", "done"], planner(home));
      assert.notEqual(done.code, 0, `pages ${JSON.stringify(pages)}: ${done.out}`);
      assert.match(done.out, /team\.json:\n {2}- pages(\.list)?: /, `pages ${JSON.stringify(pages)}: refused as rules that don't load`);
    }
  });

  test("allowedChanges is checked against the team's base when pages.base is left out (#5)", async () => {
    const home = makeRepo(
      baseTeam({ base: "main", finish: "e9g pages done", pages: { allowedChanges: ["^src/concept/"], list: [{ id: "home", path: "/" }] } })
    );
    commit(home, { "src/elsewhere.ts": "export {};\n" });
    const done = await e9g(["pages", "done"], planner(home));
    assert.equal(done.code, 1);
    assert.match(done.out, /changed outside the allowed paths: src\/elsewhere\.ts/);
  });

  test("metrics runs before Claude Code has written any transcripts (#8)", async () => {
    const home = makeRepo();
    const result = await e9g(["metrics", "--project", "p1"], { cwd: home });
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /T3 project p1/);
  });
});

describe("team.json: what normalize checks", { concurrency: true }, () => {
  test("an integration branch can't be protected; protectedBranches: [] protects none (#7, #14)", () => {
    assert.match(problemsOf({ branch: "main" }), /branch: main is protected/);
    assert.match(problemsOf({ branch: "next", protectedBranches: ["next"] }), /branch: next is protected/);
    assert.match(problemsOf({ push: { branch: "main" } }), /push\.branch: main is protected/);
    assert.deepEqual(norm({ branch: "main", protectedBranches: [] }).problems, []);
    assert.deepEqual(norm({ protectedBranches: [] }).team.protectedBranches, []);
  });

  test("a tester's branch that removes an assertion needs a review by default (#13)", async () => {
    assert.equal(norm(baseTeam()).team.review.removedPattern, ASSERTION_PATTERN);
    assert.equal(norm({}).team.review.removedPattern, null, "no tester, no default");
    assert.equal(norm({ ...baseTeam(), review: { removedPattern: null } }).team.review.removedPattern, null, "null turns it off");
    const assertion = new RegExp(ASSERTION_PATTERN);
    for (const line of [
      "-  expect(page).toHaveURL('/home');",
      "-  expect.soft(x).toBe(1)",
      "-  assert.equal(a, b);",
      "-  assert(ok)",
      "-    self.assertEqual(a, b)",
      "-  result.should.equal(1)",
      "-  await expect(locator).toBeVisible()",
      "-  t.true(x)  ;  y.toEqual(2)",
      "-    assert_eq!(a, b);",
    ])
      assert.ok(assertion.test(line), line);
    for (const line of ["-  const expected = 1;", "-  unexpected(x)", "-  // we assert nothing here", "-  shouldRender = true"])
      assert.ok(!assertion.test(line), line);

    const home = makeRepo(baseTeam(), { "e2e/home.spec.ts": "test('home', async () => {\n  expect(1).toBe(1);\n});\n" });
    git(home, "checkout", "-q", "-b", "e9g/t-lighter");
    commit(home, { "e2e/home.spec.ts": "test('home', async () => {\n});\n" });
    git(home, "checkout", "-q", "e9g/next");
    const merged = await e9g(["merge", "e9g/t-lighter"], { cwd: home, env: { E9G_HOME_DIR: home } });
    assert.equal(merged.code, 2, merged.out);
    const record = JSON.parse(readFileSync(join(home, ".e9g/run/state/merges/e9g_t-lighter.json"), "utf8")) as { message: string };
    assert.match(record.message, /has no review/);
  });

  test("types and minimums, the way the schema has them (#14)", () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ branch: "" }, /branch:/],
      [{ gate: { full: "x", concurrency: 0 } }, /gate\.concurrency/],
      [{ environment: { health: "http://x" } }, /environment\.health: a list/],
      [{ environment: { health: ["localhost:3000"] } }, /environment\.health\[0\]/],
      [{ environment: { script: 5 } }, /environment\.script/],
      [{ docs: ".e9g/brief.md" }, /docs: a list/],
      [{ never: [{ reason: "r" }] }, /never\[0\]\.rule: a regular expression/],
      [{ never: [{ rule: "", reason: "r" }] }, /never\[0\]\.rule/],
      [{ roles: { planner: {}, builder: { limit: -1 } } }, /roles\.builder\.limit/],
      [{ roles: "planner" }, /roles: an object/],
      [{ watchdog: { tickEvery: "soon" } }, /watchdog\.tickEvery: a duration/],
      [{ push: { every: "6 hours" } }, /push\.every: a duration/],
      [{ polishRounds: -1 }, /polishRounds/],
      [{ protectedBranches: "main" }, /protectedBranches: a list/],
      [{ protectedBranches: [1] }, /protectedBranches\[0\]/],
      [{ environment: { script: 1 } }, /environment\.script/],
      [{ commandOwners: [{ rule: "x", roles: "planner" }] }, /commandOwners\[0\]\.roles: a list/],
      [{ commandOwners: [{ rule: "x", roles: ["ux"] }] }, /commandOwners\[0\]\.roles\[0\]: a role/],
      [{ legacyInstances: { old: 5 } }, /legacyInstances\.old: a role/],
      [{ vars: { A: [1] } }, /vars\.A: text/],
      [{ vars: { E9G_ROLE: "planner" } }, /vars\.E9G_ROLE: a variable name/],
      [{ vars: { CLAUDE_CONFIG_DIR: "/tmp" } }, /vars\.CLAUDE_CONFIG_DIR/],
      [{ factory: "../../elsewhere" }, /factory:/],
      [{ board: { github: { label: "" } } }, /board\.github\.label/],
      [{ review: { required: ["wizard"] } }, /review\.required\[0\]: a role/],
    ];
    for (const [raw, problem] of cases) {
      let result: string;
      try {
        result = problemsOf(raw);
      } catch (error) {
        result = `threw ${(error as Error).message}`;
      }
      assert.match(result, problem, JSON.stringify(raw));
    }
    assert.deepEqual(norm({ board: { github: {} } }).team.board, { type: "github", label: "e9g" }, "the label the docs name");
    assert.match(norm({ roles: { planner: {}, reviewer: { worktree: true } } }).warnings.join("\n"), /unknown key "roles\.reviewer\.worktree"/);
    assert.deepEqual(normalize(null as unknown as RawTeam, "").problems.slice(0, 1), ["team.json: an object with the team's settings"]);
  });

  test("the schema and normalize agree (#14)", () => {
    const schema = JSON.parse(readFileSync(join(ROOT, "schema", "team.schema.json"), "utf8")) as Record<string, unknown>;
    const validate = validator(schema);
    const base = { name: "t", branch: "e9g/next" };
    const page = { id: "home", path: "/" };
    const examples = readdirSync(join(ROOT, "examples")).map(
      (file) => JSON.parse(readFileSync(join(ROOT, "examples", file), "utf8")) as Record<string, unknown>
    );
    const accepted: Record<string, unknown>[] = [
      base,
      ...examples,
      baseTeam() as Record<string, unknown>,
      { ...base, protectedBranches: [] },
      { ...base, push: null },
      { ...base, push: {} },
      { ...base, push: { remote: "origin", branch: "e9g/next", every: 90 } },
      { ...base, board: "files" },
      { ...base, board: { github: {} } },
      { ...base, never: [["\\bx\\b", "no x"]] },
      { ...base, commandOwners: [["\\by\\b", ["planner"]]] },
      { ...base, commandOwners: [["\\by\\b", ["planner"], "only the planner"]] },
      { ...base, context: [["Board", "ls"]] },
      { ...base, review: { removedPattern: null } },
      { ...base, environment: { script: null, health: ["any:http://127.0.0.1:1/"] } },
      { ...base, vars: { E2E_ENV_FILE: "${home}/x" } },
      { ...base, finish: "e9g pages done", pages: { list: [page] } },
      {
        ...base,
        pages: {
          list: [{ ...page, title: "Home", exclude: ["^x/"] }],
          viewports: [{ id: "phone", width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 }],
        },
      },
      { ...base, legacyInstances: { claudeBuilder: "builder" } },
      { ...base, roles: { planner: { limit: 3, compactAt: 100000 }, reviewer: { branch: "^r/" } } },
      { ...base, roles: { planner: {}, builder: { write: ["*"] }, tester: { write: ["^e2e/"] } } },
      { ...base, isolation: "user", watchdog: { tickEvery: "1.5h", stuckAfter: 0 } },
      { ...base, factory: "dev" },
      { ...base, factory: "0.3.0" },
      { ...base, title: "" },
      { ...base, watchdog: { tickEvery: " 5m" } },
      { ...base, push: false },
      { ...base, finish: "" },
      { ...base, vars: { A: 1 } },
      { ...base, vars: { CLAUDE_X: "y" } },
    ];
    const rejected: Record<string, unknown>[] = [
      { name: "t" },
      { ...base, name: "" },
      { ...base, name: "2048" },
      { ...base, name: "Bad" },
      { ...base, branch: "" },
      { ...base, owner: "a@b" },
      { ...base, model: "" },
      { ...base, factory: "../x" },
      { ...base, gate: { full: "x", concurrency: 0 } },
      { ...base, polishRounds: -1 },
      { ...base, roles: { planner: {}, builder: { limit: -1 } } },
      { ...base, roles: { planner: {}, builder: { limit: 1.5 } } },
      { ...base, roles: { planner: { compactAt: 0 } } },
      { ...base, roles: { planner: {}, wizard: {} } },
      { ...base, roles: { builder: {} } },
      { ...base, roles: "x" },
      { ...base, roles: { planner: "x" } },
      { ...base, roles: { planner: {}, builder: { write: ["("] } } },
      { ...base, roles: { planner: {}, reviewer: { branch: "(" } } },
      { ...base, roles: { planner: {}, tester: {} } },
      { ...base, roles: { planner: {}, tester: { write: [] } } },
      { ...base, environment: { health: "http://x" } },
      { ...base, environment: { health: ["ftp://x"] } },
      { ...base, environment: { script: 5 } },
      { ...base, environment: { needsDocker: "yes" } },
      { ...base, docs: ".e9g/brief.md" },
      { ...base, docs: [""] },
      { ...base, never: [{ reason: "r" }] },
      { ...base, never: [{ rule: "", reason: "r" }] },
      { ...base, never: [{ rule: "(", reason: "r" }] },
      { ...base, never: [{ rule: "x" }] },
      { ...base, never: [["x"]] },
      { ...base, never: [["x", "r", "e"]] },
      { ...base, never: [["(", "r"]] },
      { ...base, watchdog: { tickEvery: "soon" } },
      { ...base, watchdog: { tickEvery: "" } },
      { ...base, watchdog: { tickEvery: -5 } },
      { ...base, push: { every: "6 hours" } },
      { ...base, push: { remote: "" } },
      { ...base, context: [{ title: "x" }] },
      { ...base, context: [["x"]] },
      { ...base, commandOwners: [{ rule: "x", roles: "planner" }] },
      { ...base, commandOwners: [{ rule: "x", roles: ["wizard"] }] },
      { ...base, commandOwners: [{ roles: ["planner"] }] },
      { ...base, commandOwners: [{ rule: "x" }] },
      { ...base, commandOwners: [["x"]] },
      { ...base, board: "github" },
      { ...base, board: { github: { label: "" } } },
      { ...base, board: { gitlab: {} } },
      { ...base, review: { required: ["wizard"] } },
      { ...base, review: { removedPattern: "(" } },
      { ...base, pages: {} },
      { ...base, pages: { list: [] } },
      { ...base, finish: "e9g pages done" },
      { ...base, pages: { list: [{ id: "a b", path: "/" }] } },
      { ...base, pages: { list: [{ id: "a", path: "x" }] } },
      { ...base, pages: { list: [{ id: "a" }] } },
      { ...base, pages: { list: [page], viewports: [] } },
      { ...base, pages: { list: [page], viewports: [{ id: "x", width: 0, height: 1 }] } },
      { ...base, pages: { list: [page], viewports: [{ id: "x", width: 1, height: 1, deviceScaleFactor: 0 }] } },
      { ...base, pages: { list: [page], schemes: ["sepia"] } },
      { ...base, pages: { list: [page], schemes: [] } },
      { ...base, pages: { list: [page], settleMs: -1 } },
      { ...base, pages: { list: [page], appUrl: "localhost:3000" } },
      { ...base, pages: { list: [page], ignoreConsole: ["("] } },
      { ...base, isolation: "loose" },
      { ...base, vars: { E9G_ROLE: "x" } },
      { ...base, vars: { "1A": "x" } },
      { ...base, legacyInstances: { x: "wizard" } },
      { ...base, protect: [1] },
      { ...base, protect: ["("] },
      { ...base, policies: { deploy: "maybe" } },
      { ...base, policies: { teleport: "allow" } },
      { ...base, protectedBranches: [1] },
      { ...base, protectedBranches: "main" },
      { ...base, $schema: "" },
      { ...base, t3ProjectId: 5 },
    ];
    const loads = (raw: Record<string, unknown>) => !normalize(structuredClone(raw) as RawTeam, "/tmp/x").problems.length;
    for (const raw of accepted) {
      assert.deepEqual(validate(raw), [], `the schema accepts ${JSON.stringify(raw).slice(0, 200)}`);
      assert.ok(
        loads(raw),
        `normalize accepts ${JSON.stringify(raw).slice(0, 200)}: ${normalize(structuredClone(raw) as RawTeam, "").problems.join("; ")}`
      );
    }
    for (const raw of rejected) {
      assert.notDeepEqual(validate(raw), [], `the schema rejects ${JSON.stringify(raw)}`);
      assert.ok(!loads(raw), `normalize rejects ${JSON.stringify(raw)}`);
    }
    // Where they differ, on purpose: a rule that needs two keys at once, which a schema can't say, and an unknown key at
    // any level, which the schema flags for editors and normalize only warns about (a typo mustn't stop a running team,
    // and an older factory reading a newer file keeps working).
    const differ: [Record<string, unknown>, boolean, boolean][] = [
      [{ ...base, branch: "main" }, true, false],
      [{ ...base, branch: "next", protectedBranches: ["next"] }, true, false],
      [{ ...base, push: { branch: "main" } }, true, false],
      [{ ...base, pages: { list: [page, page] } }, true, false],
      [{ ...base, flavour: 1 }, false, true],
      [{ ...base, gate: { fast: "x" } }, false, true],
      [{ ...base, roles: { planner: {}, reviewer: { worktree: true } } }, false, true],
      [{ ...base, never: [{ rule: "x", reason: "r", extra: 1 }] }, false, true],
      [{ ...base, watchdog: { every: "5m" } }, false, true],
      [{ ...base, context: [{ title: "x", command: "y", extra: 1 }] }, false, true],
      [{ ...base, board: { github: {}, extra: 1 } }, false, true],
      [{ ...base, board: { github: { label: "x", color: "red" } } }, false, true],
      [{ ...base, review: { other: 1 } }, false, true],
      [{ ...base, pages: { list: [page], extra: 1 } }, false, true],
    ];
    for (const [raw, schemaAccepts, normalizeAccepts] of differ) {
      assert.equal(!validate(raw).length, schemaAccepts, `schema: ${JSON.stringify(raw)}`);
      assert.equal(loads(raw), normalizeAccepts, `normalize: ${JSON.stringify(raw)}`);
    }
    assert.match(normalize({ ...base, flavour: 1 } as RawTeam, "").warnings.join("\n"), /unknown key "flavour"/);
  });
});

describe("the public repository (#19)", () => {
  // The traces, in base64, so that this file, which the test reads too, doesn't name them.
  const traces = new RegExp(
    Buffer.from("XGIoOTEwMXw5MjAxfDU1MzIxKVxifENIRUNLT1VUX1BVUkNIQVNFU3xkYjptaWdyYXRlfGdpdmVuZXR8cmlkZW5ldHxDb21tdW5pdHlTdXBwb3J0", "base64").toString(),
    "i"
  );
  test("no traces of the projects the factory was first used on, tests included", () => {
    assert.match("app-" + "ride" + "net", traces, "the pattern still finds them");
    const files = git(ROOT, "ls-files", "examples", "docs", "templates", "README.md", "CONSTITUTION.md", "schema", "plugin/agents", "test")
      .split("\n")
      .filter(Boolean);
    assert.ok(files.includes("test/audit-setup.test.ts"));
    for (const file of files) {
      const text = readFileSync(join(ROOT, file), "utf8");
      assert.doesNotMatch(text, traces, file);
    }
  });
});
