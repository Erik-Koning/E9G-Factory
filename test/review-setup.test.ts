// Regressions from the second review of setup and distribution. A team.json that 0.2.0 loaded loads again: numbers in
// vars, unknown keys at any level, the values 0.2.0 read as none. The teams on this machine load as they did. An older
// self-install leaves newer releases reachable. check tells the truth about what's committed and what parses. doctor
// judges a pinned team with its own version and survives a broken T3 settings file. An interrupted install is put
// right. Each test names the finding it holds.
//
// Anything that installs, runs the launcher or runs doctor does it on a machine of its own (machine() in helpers.ts).
import { baseTeam, e9g, git, gitRepo, guard, machine, makeRepo, NO_SERVER, ROOT, sourceCopy, tmp, write } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { memberEnvironment } from "../lib/commands/team.ts";
import { ASSERTION_PATTERN, loadTeam, normalize, type RawTeam } from "../lib/config.ts";
import { PACKAGE } from "../lib/paths.ts";
import { validator } from "./jsonschema.ts";

const VERSION = PACKAGE.version;
// E9G Factory 0.2.0, and main when the review was made.
const V020 = "7753a95";
const BASELINE = "6142b7a";

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const norm = (raw: Record<string, unknown>) => normalize({ name: "t", branch: "e9g/next", ...raw } as RawTeam, "/tmp/x");
const validate = validator(JSON.parse(readFileSync(join(ROOT, "schema", "team.schema.json"), "utf8")) as Record<string, unknown>);
const schema = (raw: Record<string, unknown>) => validate({ name: "t", branch: "e9g/next", ...raw });

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

// A commit of this repository unpacked into a folder (only these paths, if any are named); null when this clone's
// history doesn't have it.
function archive(commit: string, ...paths: string[]): string | null {
  if (spawnSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: ROOT }).status !== 0) return null;
  const dir = join(tmp("e9g-release-"), "E9G-Factory");
  mkdirSync(dir, { recursive: true });
  const tar = join(dirname(dir), "release.tar");
  execFileSync("git", ["-C", ROOT, "archive", "-o", tar, commit, ...paths]);
  execFileSync("tar", ["-xf", tar, "-C", dir]);
  rmSync(tar);
  return dir;
}
// The same, as a clone to self-install from. Its dependency is a folder of its own: through a link, an install could
// write into this checkout's node_modules.
function releaseClone(commit: string): string | null {
  const dir = archive(commit);
  if (!dir) return null;
  cpSync(join(ROOT, "node_modules", "axe-core"), join(dir, "node_modules", "axe-core"), { recursive: true });
  return gitRepo(dir);
}

// The key paths at which two values differ, so a failure names where without printing what.
function differences(a: unknown, b: unknown, at = ""): string[] {
  if (isDeepStrictEqual(a, b)) return [];
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b))
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) =>
      differences((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${at}.${key}`)
    );
  return [at || "."];
}

describe("team.json that 0.2.0 loaded loads again", { concurrency: true }, () => {
  test("number and true/false vars are passed as text, with a warning; objects, lists and null aren't (#1)", () => {
    const { team, problems, warnings } = norm({ vars: { PORT: 3200, CI: true, RATIO: 1.5, NAME: "x" } });
    assert.deepEqual(problems, []);
    assert.deepEqual(team.vars, { PORT: "3200", CI: "true", RATIO: "1.5", NAME: "x" });
    assert.match(warnings.join("\n"), /vars\.PORT: 3200 is passed as the text "3200"/);
    assert.equal(memberEnvironment(team, "builder", { home: "/tmp/x", run: "/tmp/run", version: VERSION })["PORT"], "3200");
    assert.deepEqual(schema({ vars: { PORT: 3200, CI: true } }), []);
    for (const value of [{ a: 1 }, [1], null]) {
      assert.match(norm({ vars: { A: value } }).problems.join("\n"), /vars\.A: text, a number or true\/false/, JSON.stringify(value));
      assert.notDeepEqual(schema({ vars: { A: value } }), [], JSON.stringify(value));
    }
  });

  test("vars may tune Claude Code, but not say where a member runs (#1)", () => {
    const tuning = { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000", CLAUDE_CODE_DISABLE_TELEMETRY: "1", CLAUDE_PROJECT_DIRS: "x" };
    assert.deepEqual(norm({ vars: tuning }).problems, []);
    assert.deepEqual(schema({ vars: tuning }), []);
    for (const name of ["CLAUDE_PROJECT_DIR", "CLAUDE_CONFIG_DIR", "CLAUDE_PLUGIN_ROOT", "CLAUDE_ENV_FILE", "E9G_ROLE", "E9G_ANYTHING"]) {
      assert.match(norm({ vars: { [name]: "x" } }).problems.join("\n"), new RegExp(`vars\\.${name}: `), name);
      assert.notDeepEqual(schema({ vars: { [name]: "x" } }), [], `the schema refuses ${name}`);
    }
  });

  test("a team whose vars hold a number still runs its tools (#1)", () => {
    const home = makeRepo(baseTeam({ vars: { PORT: 3200, CI: true } }));
    assert.equal(guard(home, "builder", "Bash", { command: "git status" }).outcome, "allow");
  });

  test("an unknown key at any level is a warning, and is ignored (#2)", () => {
    const pages = { list: [{ id: "a", path: "/", note: "n" }], viewports: [{ id: "v", width: 1, height: 1, dpr: 2 }], retries: 1 };
    const cases: [Record<string, unknown>, string][] = [
      [{ watchdog: { tickevery: "10m" } }, "watchdog.tickevery"],
      [{ gate: { full: "true", $comment: "what CI runs" } }, "gate.$comment"],
      [{ roles: { planner: {}, builder: { limit: 2, model: "claude-sonnet" } } }, "roles.builder.model"],
      [{ board: { github: { label: "e9g", repo: "o/r" } } }, "board.github.repo"],
      [{ board: { github: {}, note: "x" } }, "board.note"],
      [{ push: { every: "6h", force: true } }, "push.force"],
      [{ review: { required: ["builder"], approvers: 2 } }, "review.approvers"],
      [{ environment: { needsDocker: false, ports: [3000] } }, "environment.ports"],
      [{ never: [{ rule: "x", reason: "r", note: "n" }] }, "never[0].note"],
      [{ commandOwners: [{ rule: "x", roles: ["planner"], why: "y" }] }, "commandOwners[0].why"],
      [{ context: [{ title: "t", command: "c", every: "1h" }] }, "context[0].every"],
      [{ pages }, "pages.retries"],
      [{ pages }, "pages.list[0].note"],
      [{ pages }, "pages.viewports[0].dpr"],
    ];
    for (const [raw, key] of cases) {
      const { problems, warnings } = norm(raw);
      assert.deepEqual(problems, [], key);
      assert.ok(
        warnings.some((warning) => warning.startsWith(`unknown key "${key}" (ignored`)),
        `${key}: ${warnings.join("; ")}`
      );
      assert.notDeepEqual(schema(raw), [], `the schema flags ${key} for editors`);
    }
    // Ignored: a role's lane is what it would be without them.
    const plain = norm({ roles: { planner: {}, builder: { limit: 2 }, reviewer: {} } }).team.roles;
    const extra = norm({ roles: { planner: { model: "x" }, builder: { limit: 2, worktree: false, readonly: true }, reviewer: { worktree: true } } });
    assert.deepEqual(extra.team.roles, plain);
  });

  test("a typo saved into a running team's rules doesn't stop its tools (#2)", () => {
    const home = makeRepo(baseTeam({ watchdog: { tickevery: "10m" }, roles: { planner: {}, builder: { limit: 1, model: "x" } } } as RawTeam));
    assert.equal(guard(home, "builder", "Bash", { command: "git status" }).outcome, "allow");
  });

  test("what 0.2.0 read as none or as the default (#2)", () => {
    const team = (raw: Record<string, unknown>) => {
      const loaded = norm(raw);
      assert.deepEqual(loaded.problems, [], JSON.stringify(raw));
      assert.deepEqual(schema(raw), [], `the schema accepts ${JSON.stringify(raw)}`);
      return loaded.team;
    };
    assert.equal(team({ push: false }).push, null);
    assert.equal(team({ gate: { full: "make check", quick: null } }).gate.quick, "make check", "null is the full gate");
    assert.equal(team({ gate: { full: "make check", quick: "" } }).gate.quick, null, '"" is no quick gate');
    assert.deepEqual(team({ gate: { full: null } }).gate, { full: null, quick: null, concurrency: 2 });
    assert.equal(team({ title: "" }).title, "t", '"" is the name');
    assert.equal(team({ finish: "" }).finish, null);
    assert.equal(team({ finish: "", progress: "" }).progress, null);
    assert.equal(team({ finish: "e9g pages done", progress: null, pages: { list: [{ id: "a", path: "/" }] } }).progress, "e9g pages status");
    assert.deepEqual(team({ watchdog: { tickEvery: "10m ", stuckAfter: " 45m", pruneAfter: " 2h " } }).watchdog, {
      tickEveryMin: 10,
      stuckAfterMin: 45,
      pruneAfterMin: 120,
      doneTickEveryMin: 1440,
    });
    assert.equal(team({ push: { every: "6h " } }).push?.everyMin, 360);
    // Beside these: an empty example is none, and a project id is null until register assigns one.
    for (const example of ["", null]) assert.deepEqual(team({ never: [{ rule: "x", reason: "r", example }] }).never, [{ rule: "x", reason: "r" }]);
    assert.equal(team({ t3ProjectId: null }).raw.t3ProjectId, null);
    // Still refused: what has no sensible reading.
    for (const raw of [{ title: 5 }, { push: true }, { t3ProjectId: "" }, { watchdog: { tickEvery: "ten minutes" } }, { gate: { full: 5 } }]) {
      assert.notDeepEqual(norm(raw).problems, [], JSON.stringify(raw));
      assert.notDeepEqual(schema(raw), [], `the schema refuses ${JSON.stringify(raw)}`);
    }
  });
});

describe("the teams on this machine load as they did before this review", () => {
  // Every team checkout beside this one (<folder>/.e9g/team.json next to the factory's checkout). Each is read through
  // a temporary copy, removed afterwards, and a failure names keys, never values.
  const parent = dirname(ROOT);
  const files = readdirSync(parent)
    .map((folder) => join(parent, folder, ".e9g", "team.json"))
    .filter((file) => existsSync(file));
  type Loader = { normalize: (raw: unknown, home: string) => { team: Record<string, unknown>; problems: string[]; warnings: string[] } };
  const loaderAt = async (commit: string, file: string): Promise<Loader | null> => {
    const dir = archive(commit, "lib", "package.json");
    return dir ? ((await import(join(dir, "lib", file))) as Loader) : null;
  };
  const loads = (loader: Loader | null, raw: unknown, home: string): boolean => {
    try {
      return Boolean(loader) && !loader?.normalize(structuredClone(raw), home).problems.length;
    } catch {
      return false;
    }
  };

  test(
    `each that loaded before loads now, normalizes as it did at ${BASELINE}, and its tools run`,
    { skip: files.length ? false : "no team checkouts beside this one" },
    async (t) => {
      const baseline = await loaderAt(BASELINE, "config.ts");
      const v020 = await loaderAt(V020, "config.mjs");
      if (!baseline) t.diagnostic(`${BASELINE} isn't in this clone's history, so each team is only held to loading`);
      const copies = tmp("e9g-teams-");
      let compared = 0;
      try {
        for (const [i, file] of files.entries()) {
          const which = `team ${i + 1} of ${files.length}`;
          const home = join(copies, String(i));
          mkdirSync(join(home, ".e9g"), { recursive: true });
          copyFileSync(file, join(home, ".e9g", "team.json"));
          const raw = JSON.parse(readFileSync(join(home, ".e9g", "team.json"), "utf8")) as RawTeam;
          const loadedAtBaseline = loads(baseline, raw, home);
          // A draft that neither 0.2.0 nor the baseline loaded isn't held to anything.
          if ((baseline || v020) && !loadedAtBaseline && !loads(v020, raw, home)) {
            t.diagnostic(`${which} didn't load before this review either`);
            continue;
          }
          const now = loadTeam(home, { strict: false });
          assert.deepEqual(
            now.problems.map((problem) => problem.split(":")[0]),
            [],
            `${which}: the keys with problems`
          );
          if (baseline && loadedAtBaseline) {
            const then = baseline.normalize(structuredClone(raw), home);
            // The default removedPattern changed on purpose (#8), and so did the planner's default lane, which now
            // names its decisions, and contact and push.pullRequest (none, unless the team names one) are new; the rest
            // is as it was.
            const plannerWrite = (team: Record<string, unknown>) => {
              const roles = team["roles"] as Record<string, { write: string[] }>;
              const planner = roles["planner"];
              return planner ? { ...roles, planner: { ...planner, write: planner.write.filter((rule) => rule !== "^\\.e9g/decisions\\.md$") } } : roles;
            };
            const withoutPullRequest = (push: unknown) => {
              if (!push || typeof push !== "object") return push;
              const { pullRequest, ...rest } = push as Record<string, unknown>;
              return pullRequest === null ? rest : push;
            };
            const comparable = (team: Record<string, unknown>) => ({
              ...team,
              raw: null,
              file: null,
              warnings: null,
              problems: null,
              review: reviewThen(team["review"]),
              roles: plannerWrite(team),
              contact: null,
              push: withoutPullRequest(team["push"]),
              // 0.4.0: "files" is the task graph, and the task graph's settings are new.
              board: (team["board"] as { type?: string }).type === "files" ? { type: "tasks" } : team["board"],
              mode: null,
              tasks: null,
              priorities: null,
              approval: null,
              critical: null,
            });
            // review.maxRounds and viewCheckMinLines are new in 0.4.0.
            function reviewThen(review: unknown) {
              const { maxRounds: _rounds, viewCheckMinLines: _lines, ...rest } = review as Record<string, unknown>;
              return raw.review?.removedPattern === undefined ? { ...rest, removedPattern: "the default" } : rest;
            }
            assert.deepEqual(differences(comparable({ ...now }), comparable(then.team)), [], which);
            assert.deepEqual(differences(now.warnings, then.warnings), [], `${which}: its warnings`);
            compared++;
          }
          // A checkout of its own with those rules: the guard loads them and lets a member work.
          const checkout = makeRepo(raw);
          try {
            assert.equal(guard(checkout, "builder", "Bash", { command: "git status" }).outcome, "allow", which);
          } finally {
            rmSync(checkout, { recursive: true, force: true });
          }
        }
      } finally {
        rmSync(copies, { recursive: true, force: true });
      }
      t.diagnostic(`${files.length} found, ${compared} normalized as at ${BASELINE}`);
    }
  );
});

describe("an older self-install after a newer one, on a machine of its own (#3, #5, #11)", () => {
  const m = machine();
  const versions = join(m.e9gHome, "versions");
  const source = sourceCopy();
  const old = releaseClone(V020);
  const skip = old ? false : `${V020} (0.2.0) isn't in this clone's history`;
  const launcher = (args: string[], { cwd, env = {} }: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) =>
    run([m.launcher, ...args], { env: { ...m.env, ...env }, ...(cwd === undefined ? {} : { cwd }) });

  test("0.2.0 installed after this release leaves it reachable, for its agents and through 0.2.0's hand-over (#3)", { skip }, async () => {
    const installed = await node(join(source, "bin", "e9g.ts"), ["self-install"], { env: m.env });
    assert.equal(installed.code, 0, installed.out);
    assert.ok(statSync(join(versions, VERSION, "bin", "e9g.mjs")).mode & 0o100, "the release has bin/e9g.mjs, executable");
    const rolledBack = await node(join(old ?? "", "bin", "e9g.mjs"), ["self-install"], { env: m.env });
    assert.equal(rolledBack.code, 0, rolledBack.out);
    assert.match(readFileSync(join(m.e9gHome, "bin", "e9g"), "utf8"), /\/bin\/e9g\.mjs" "\$@"/, "0.2.0's launcher, which runs bin/e9g.mjs");
    const agent = await launcher(["--version"], { env: { E9G_VERSION: VERSION } });
    assert.equal(agent.out.trim(), VERSION, agent.out);
    const home = makeRepo(baseTeam({ factory: VERSION }));
    const person = await launcher(["prompt", home, "planner"], { cwd: home });
    assert.match(person.out, new RegExp(`compiled by E9G Factory ${escape(VERSION)} `), person.out.slice(0, 400));
  });

  test("doctor judges a team pinned to 0.2.0 by 0.2.0's loader (#5)", { skip }, async () => {
    mkdirSync(join(m.e9gHome, "teams"), { recursive: true });
    const register = (name: string, extra: RawTeam) => {
      const home = makeRepo(baseTeam({ name, factory: "0.2.0", ...extra }));
      const runDir = join(m.root, "runs", name);
      writeFileSync(join(m.e9gHome, "teams", `${name}.json`), JSON.stringify({ name, title: name, home, run: runDir, version: "0.2.0" }));
      mkdirSync(join(runDir, "prompts"), { recursive: true });
      for (const role of Object.keys(baseTeam().roles ?? {})) {
        const prompt = spawnSync(process.execPath, [join(versions, "0.2.0", "bin", "e9g.mjs"), "prompt", name, role], {
          env: { ...process.env, ...m.env, E9G_HANDED_OVER: "1" },
          encoding: "utf8",
        });
        writeFileSync(join(runDir, "prompts", `${role}.md`), prompt.stdout);
      }
    };
    // 0.2.0 reads a page id with a dot, which this version refuses; and refuses an isolation it doesn't know.
    register("dotted", { pages: { list: [{ id: "home.v2", path: "/" }] } });
    register("loose", { isolation: "loose" });
    const doctor = await node(join(versions, VERSION, "bin", "e9g.ts"), ["doctor"], { env: m.env });
    assert.match(doctor.out, /^ok {4}dotted: rules load, prompts current \(judged by 0\.2\.0\)/m, doctor.out);
    assert.match(doctor.out, /^FAIL {2}loose: E9G Factory 0\.2\.0, which it pins, can't load its rules or compile its prompts: .*isolation/m, doctor.out);
    for (const name of ["dotted", "loose"]) rmSync(join(m.e9gHome, "teams", `${name}.json`));
  });

  test("this release installed again is current again; an older one is only added, unless --force (#3)", async () => {
    const again = await node(join(source, "bin", "e9g.ts"), ["self-install"], { env: m.env });
    assert.equal(again.code, 0, again.out);
    assert.equal(realpathSync(join(m.e9gHome, "current")), realpathSync(join(versions, VERSION)));
    const launcherText = readFileSync(join(m.e9gHome, "bin", "e9g"), "utf8");
    const older = sourceCopy("0.2.99");
    const added = await node(join(older, "bin", "e9g.ts"), ["self-install"], { env: m.env });
    assert.equal(added.code, 0, added.out);
    assert.match(added.out, new RegExp(`${escape(VERSION)} stays current, since 0\\.2\\.99 is older`));
    assert.ok(existsSync(join(versions, "0.2.99", "bin", "e9g.ts")), "installed, for teams to pin");
    assert.equal(realpathSync(join(m.e9gHome, "current")), realpathSync(join(versions, VERSION)));
    assert.equal(readFileSync(join(m.e9gHome, "bin", "e9g"), "utf8"), launcherText, "the launcher is left as it was");
    const forced = await node(join(older, "bin", "e9g.ts"), ["self-install", "--force"], { env: m.env });
    assert.equal(forced.code, 0, forced.out);
    assert.equal(realpathSync(join(m.e9gHome, "current")), realpathSync(join(versions, "0.2.99")), "--force makes it current");
  });

  test("an interrupted install is put right by the next one (#11)", async () => {
    // As installs stopped between their steps leave them, by processes that are gone: 0.2.99 moved aside with its new
    // copy half made, and a copy of this release half made.
    const gone = 99_999_999;
    renameSync(join(versions, "0.2.99"), join(versions, `.0.2.99.replaced-${gone}`));
    mkdirSync(join(versions, `.0.2.99.installing-${gone}`, "bin"), { recursive: true });
    mkdirSync(join(versions, `.${VERSION}.installing-${gone}`));
    // One whose process is still running is left alone.
    mkdirSync(join(versions, `.${VERSION}.installing-${process.pid}`));
    const next = await node(join(source, "bin", "e9g.ts"), ["self-install"], { env: m.env });
    assert.equal(next.code, 0, next.out);
    assert.match(next.out, /put 0\.2\.99 back/);
    assert.ok(existsSync(join(versions, "0.2.99", "bin", "e9g.ts")), "the release that was moved aside is back");
    assert.deepEqual(
      readdirSync(versions).filter((name) => name.startsWith(".")),
      [`.${VERSION}.installing-${process.pid}`]
    );
    rmSync(join(versions, `.${VERSION}.installing-${process.pid}`), { recursive: true });
  });
});

describe("doctor on a machine of its own", () => {
  test("a T3 Code settings file it can't read is a warning, and the report goes on (#9, #12)", async () => {
    const m = machine();
    writeFileSync(join(m.home, ".t3", "userdata", "settings.json"), '{"providerInstances": {"e9g-');
    const doctor = await node(join(ROOT, "bin", "e9g.ts"), ["doctor"], { env: m.env });
    assert.match(doctor.out, /^warn {2}T3 Code's settings \(.*settings\.json\) can't be read: /m, doctor.out);
    assert.match(doctor.out, /^(ok|warn) +\d+ GB free/m, "the rest of the report");
    assert.match(doctor.out, new RegExp(`doesn't answer at ${escape(NO_SERVER)}/`), "the stand-in server address, never T3 Code's own");
  });

  test("tests reach stand-ins for T3 Code, never the real one (#12)", () => {
    assert.equal(spawnSync("sh", ["-c", "command -v t3"], { encoding: "utf8" }).stdout.trim(), join(ROOT, "test", "fake-t3", "t3"));
    const runtime = JSON.parse(readFileSync(join(process.env.T3CODE_HOME ?? "", "userdata", "server-runtime.json"), "utf8")) as { origin: string };
    assert.equal(runtime.origin, NO_SERVER);
  });
});

describe("e9g check", { concurrency: true }, () => {
  const { env } = machine();
  const checkOf = (home: string) => e9g(["check", home], { cwd: home, env: { PATH: env.PATH } });
  const executableAdapter = (home: string, path: string) => {
    chmodSync(join(home, path), 0o755);
    git(home, "add", "-A");
    git(home, "commit", "-qm", "executable");
  };

  test("rules git ignores fail, naming the rule, until they're committed (#4)", async () => {
    // Every dotfile ignored, .gitignore let back in, as some repositories have it.
    const home = makeRepo(baseTeam(), { ".gitignore": ".*\n!.gitignore\n" });
    assert.equal(git(home, "ls-files", ".e9g"), "", "git add -A left .e9g out");
    const ignored = await checkOf(home);
    assert.equal(ignored.code, 1, ignored.out);
    assert.match(
      ignored.out,
      /^FAIL {2}ignored by git \(\.gitignore:1: \.\*\), so not committed on e9g\/next .*: \.e9g\/team\.json, \.e9g\/\.gitignore\. Add "!\.e9g\/"/m
    );
    assert.doesNotMatch(ignored.out, /Ready/);
    write(home, { ".gitignore": ".*\n!.gitignore\n!.e9g/\n" });
    git(home, "add", "-A");
    git(home, "commit", "-qm", "the team");
    const fixed = await checkOf(home);
    assert.equal(fixed.code, 0, fixed.out);
    assert.match(fixed.out, /Ready/);
  });

  test("rules ignored by .git/info/exclude fail too; git add -f is enough (#4)", async () => {
    const home = gitRepo(tmp("e9g-exclude-"), { "README.md": "x\n" });
    appendFileSync(join(home, ".git", "info", "exclude"), ".e9g/\n");
    write(home, { ".e9g/team.json": baseTeam(), ".e9g/.gitignore": "run/\n" });
    git(home, "checkout", "-q", "-b", "e9g/next");
    const ignored = await checkOf(home);
    assert.equal(ignored.code, 1, ignored.out);
    assert.match(ignored.out, /^FAIL {2}ignored by git \(\.git\/info\/exclude:\d+: \.e9g\/\)/m);
    git(home, "add", "-f", ".e9g/team.json", ".e9g/.gitignore");
    git(home, "commit", "-qm", "the team");
    const fixed = await checkOf(home);
    assert.equal(fixed.code, 0, fixed.out);
  });

  test("a .DS_Store, an editor's backup or a note in adapters/ doesn't fail check; its shell scripts are still checked (#6)", async () => {
    const home = makeRepo(baseTeam({ gate: { full: ".e9g/adapters/gate.sh" } }), { ".e9g/adapters/gate.sh": "#!/usr/bin/env bash\necho ok\n" });
    executableAdapter(home, ".e9g/adapters/gate.sh");
    write(home, {
      ".e9g/adapters/.DS_Store": "\0\0\0\u0001Bud1",
      ".e9g/adapters/gate.sh~": "#!/bin/bash\necho old\n",
      ".e9g/adapters/notes.txt": "how the gate works\n",
      ".e9g/adapters/finish.mjs": "#!/usr/bin/env node\n",
    });
    const stray = await checkOf(home);
    assert.equal(stray.code, 0, stray.out);
    assert.match(stray.out, /^warn {2}\.e9g\/adapters\/gate\.sh~ looks like an editor's backup/m);
    assert.doesNotMatch(stray.out, /DS_Store|notes\.txt|finish\.mjs/);
    assert.match(stray.out, /Ready/);
    write(home, { ".e9g/adapters/extra.sh": "if then\n" });
    const script = await checkOf(home);
    assert.equal(script.code, 1, script.out);
    assert.match(script.out, /^FAIL {2}\.e9g\/adapters\/extra\.sh isn't valid sh/m);
    assert.match(script.out, /^FAIL {2}not committed on e9g\/next: \.e9g\/adapters\/extra\.sh/m);
  });

  test("a linked adapter is checked through what it points at (#7)", async () => {
    const home = makeRepo(baseTeam({ gate: { full: ".e9g/adapters/gate.sh" } }), { "scripts/ci.sh": "#!/usr/bin/env bash\necho ok\n" });
    mkdirSync(join(home, ".e9g", "adapters"), { recursive: true });
    symlinkSync("../../scripts/ci.sh", join(home, ".e9g", "adapters", "gate.sh"));
    executableAdapter(home, "scripts/ci.sh");
    assert.match(git(home, "ls-files", "-s", ".e9g/adapters/gate.sh"), /^120000 /);
    const linked = await checkOf(home);
    assert.equal(linked.code, 0, linked.out);
    assert.match(linked.out, /^ok {4}the rules and adapters are committed on e9g\/next/m);
    // What it points at, committed without the executable bit, is what fails.
    git(home, "update-index", "--chmod=-x", "scripts/ci.sh");
    git(home, "commit", "-qm", "not executable");
    const target = await checkOf(home);
    assert.equal(target.code, 1, target.out);
    assert.match(target.out, /^FAIL {2}scripts\/ci\.sh is committed without its executable bit/m);
    assert.doesNotMatch(target.out, /\.e9g\/adapters\/gate\.sh is committed without/);
  });

  test("#!/usr/bin/env -S bash -eu is read as bash; a #! line that names no program is mentioned (#12)", async () => {
    const { interpreterOf } = await import("../lib/commands/check.ts");
    const read: [string, string | null][] = [
      ["#!/usr/bin/env -S bash -eu", "bash"],
      ["#!/usr/bin/env -Sbash -e", "bash"],
      ["#!/usr/bin/env --split-string=dash -e", "dash"],
      ["#!/usr/bin/env -i PATH=/bin sh", "sh"],
      ["#!/usr/bin/env -u HOME zsh", "zsh"],
      ["#!/usr/bin/env bash", "bash"],
      ["#! /bin/bash -e", "bash"],
      ["#!/usr/bin/env node", "node"],
      ["#!/usr/bin/env -S", null],
      ["#!", null],
    ];
    for (const [line, program] of read) assert.equal(interpreterOf(line), program, line);
    const home = makeRepo(baseTeam({ environment: { script: ".e9g/adapters/env.sh" } }), {
      ".e9g/adapters/env.sh": "#!/usr/bin/env -S bash -eu\nif then\n",
      ".e9g/adapters/odd.sh": "#!/usr/bin/env -S\necho\n",
    });
    executableAdapter(home, ".e9g/adapters/env.sh");
    const result = await checkOf(home);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /^FAIL {2}\.e9g\/adapters\/env\.sh isn't valid bash/m);
    assert.match(result.out, /^warn {2}\.e9g\/adapters\/odd\.sh: its #! line doesn't say which shell runs it/m);
  });
});

describe("review.removedPattern's default", () => {
  test("finds real assertions, not .toString( or a helper named assert… (#8)", () => {
    const assertion = new RegExp(ASSERTION_PATTERN);
    const real = [
      "  expect(page).toHaveURL('/home');",
      "  expect.soft(x).toBe(1)",
      "  await expect(locator).toBeVisible()",
      "  expect(x).not.toBe(y)",
      "  expect(fn).toThrowError()",
      "  expect(mock).toHaveBeenCalledWith(1)",
      "  expect(tree).toMatchSnapshot()",
      "  expect(list).toContainEqual(y)",
      "  y.toEqual(2)",
      "  x.toStrictEqual(y)",
      "  assert.equal(a, b);",
      "  assert(ok)",
      "  assert.strictEqual(a, b)",
      "    assert response.status_code == 200",
      "    self.assertEqual(a, b)",
      "    self.assertIn(x, y)",
      "    self.assertRaises(ValueError, f)",
      "    assertEquals(1, x);",
      "    assertThat(x).isEqualTo(1);",
      "  result.should.equal(1)",
      "  x.should.be.true",
      "    assert_eq!(a, b);",
      "    assert!(ok);",
      "    debug_assert_ne!(a, b);",
    ];
    for (const line of real) assert.ok(assertion.test(line), `finds ${line}`);
    const ordinary = [
      "  const s = n.toString();",
      "  return name.toLowerCase();",
      "  total.toFixed(2)",
      "  date.toISOString()",
      "  JSON.parse(value.toJSON())",
      "  assertMainBranch();",
      "  await assertCleanTree(dir)",
      "  assert_main_branch",
      "  # assert nothing",
      "  // we assert nothing here",
      "  const expected = 1;",
      "  unexpected(x)",
      "  shouldRender = true",
      "  it('should render', () => {",
    ];
    for (const line of ordinary) assert.ok(!assertion.test(line), `leaves ${line}`);
  });
});

describe("the pages command (#10)", () => {
  test("pages done refuses a team that loads but lists no pages, saying so", async () => {
    const home = makeRepo(baseTeam({ finish: "true" }));
    const done = await e9g(["pages", "done"], { cwd: home, env: { E9G_HOME_DIR: home, E9G_TEAM: "fixture", E9G_ROLE: "planner" } });
    assert.equal(done.code, 2, done.out);
    assert.match(done.out, /pages\.list" names no pages/);
  });
});
