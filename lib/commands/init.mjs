// e9g init [<repo>] [--name <team>] [--branch <integration>] [--base <ref>] [--checkout <dir> | --in-place]
//          [--owner <email>] [--no-interview]
//
// Sets up a team in a repository:
// 1. Detects what it can: git, package manager and scripts, what CI runs, how the repository reaches outside the
//    machine, its tests and UI, the agent configuration it already has.
// 2. Makes the team's checkout: by default a worktree beside the repository (<repo>-e9g) on a new integration
//    branch, so the team never works in the operator's own checkout.
// 3. Writes a draft .e9g/ from what it found (team.json, brief, notes, rubric, adapters).
// 4. Opens the setup agent (claude --agent e9g:setup) in the team's checkout to interview the operator, finish
//    .e9g/, prove it with e9g check --run, and register and start the team if the operator says so. Its guard lets
//    it write only .e9g/.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { detect, draftTeam } from "../detect.mjs";
import { FACTORY_ROOT } from "../paths.mjs";
import * as t3 from "../t3.mjs";
import { die, git, gitOk, hash, parseArgs, which, writeJson } from "../util.mjs";

const TEMPLATES = join(FACTORY_ROOT, "templates", "team");

function fill(name, values) {
  return readFileSync(join(TEMPLATES, name), "utf8").replace(/\{\{(\w+)\}\}/g, (match, key) => values[key] ?? match);
}

export function init(argv) {
  const { positional, options } = parseArgs(argv, { booleans: ["in-place", "no-interview"] });
  // Only the interview needs Claude Code; --no-interview writes the draft without it.
  if (!options["no-interview"] && !which("claude")) die("Claude Code (claude) isn't on PATH (or pass --no-interview to write the draft only)");
  const repo = (() => {
    try {
      return realpathSync(git(resolve(positional[0] ?? "."), "rev-parse", "--show-toplevel"));
    } catch {
      die(`${resolve(positional[0] ?? ".")} isn't in a git repository`);
    }
  })();
  const problems = t3.contract();
  if (problems.length) console.warn(`e9g: T3 Code isn't ready yet; the team can't start until it is (e9g doctor):\n  - ${problems.join("\n  - ")}`);

  const found = detect(repo);
  const name = String(options.name ?? basename(repo))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^[^a-z]+|-+$/g, "")
    .slice(0, 31);
  const branch = String(options.branch ?? "e9g/next");
  const base = String(options.base ?? found.git.defaultBranch ?? "main");

  // The team's checkout.
  let checkout;
  if (options["in-place"]) checkout = repo;
  else {
    checkout = resolve(String(options.checkout ?? join(dirname(repo), `${basename(repo)}-e9g`)));
    if (!existsSync(checkout)) {
      const made = gitOk(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)
        ? spawnSync("git", ["worktree", "add", checkout, branch], { cwd: repo, encoding: "utf8" })
        : spawnSync("git", ["worktree", "add", "-b", branch, checkout, base], { cwd: repo, encoding: "utf8" });
      if (made.status !== 0) die(`couldn't make the team's checkout at ${checkout}: ${made.stderr.trim()}`);
      console.info(`e9g: made the team's checkout ${checkout} on ${branch} (from ${base})`);
    } else console.info(`e9g: using the existing checkout ${checkout}`);
  }

  // The draft .e9g/, never overwriting what's there.
  const dir = join(checkout, ".e9g");
  const write = (path, text, mode) => {
    const file = join(dir, path);
    if (existsSync(file)) return console.info(`  kept .e9g/${path}`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    if (mode) chmodSync(file, mode);
    console.info(`  wrote .e9g/${path}`);
  };
  const runner = { pnpm: "pnpm", yarn: "yarn", bun: "bun run", npm: "npm run" }[found.packageManager] ?? "npm run";
  const checks = (names) =>
    names
      .filter((script) => found.scripts[script])
      .map((script) => `check ${script.replace(/[^\w-]/g, "-")} ${runner} ${script}`)
      .join("\n");
  const port = 9300 + (Number.parseInt(hash(name), 16) % 90);
  const draft = draftTeam(found, { name, branch, owner: options.owner && options.owner !== true ? String(options.owner) : undefined });
  draft.base = base;
  draft.environment.health = [`http://localhost:${port}/`];
  write("team.json", `${JSON.stringify(draft, null, 2)}\n`);
  write(".gitignore", readFileSync(join(TEMPLATES, "gitignore"), "utf8"));
  write("brief.md", fill("brief.md", { GOAL: "(The operator's direction goes here.)", FINISH: "(How done is proven: the finish command in team.json.)" }));
  write(
    "notes.md",
    fill("notes.md", {
      ENVIRONMENT: `The app runs on http://localhost:${port}/ (.e9g/adapters/env.sh).`,
      COMMANDS: Object.keys(found.scripts).length
        ? Object.entries(found.scripts)
            .map(([script, command]) => `- \`${runner} ${script}\`: \`${command}\``)
            .join("\n")
        : "(none detected)",
    })
  );
  if (found.ui.length) write("rubric.md", readFileSync(join(TEMPLATES, "rubric.md"), "utf8"));
  const install = found.installCommand ? `${found.installCommand} >/dev/null || { echo "install failed" >&2; exit 1; }` : ":";
  write(
    "adapters/gate.sh",
    fill("adapters/gate.sh", {
      QUICK_CHECKS:
        [found.installCommand ? `check install ${found.installCommand}` : null, checks(["typecheck", "lint", "format:check", "test"])]
          .filter(Boolean)
          .join("\n") || "# (fill in: what CI runs first)",
      FULL_CHECKS: checks(["build", "test:e2e"]).replace(/^/gm, "  ") || "  : # (fill in: the rest of what CI runs)",
    }),
    0o755
  );
  write(
    "adapters/env.sh",
    fill("adapters/env.sh", { PORT: String(port), INSTALL: install, SERVE: found.scripts.dev ? `${runner} dev` : "echo 'fill in: how to serve the app'" }),
    0o755
  );
  write("adapters/after-merge.sh", fill("adapters/after-merge.sh", { INSTALL: install }), 0o755);
  writeJson(join(dir, "run", "setup", "detect.json"), found);

  const report = join(dir, "run", "setup", "detect.json");
  console.info(
    `\ne9g: detected ${found.packageManager ?? "no package manager"}, ${found.ci.length} CI workflow(s), ${found.surfaces.length} way(s) out: ${found.surfaces.map((s) => s.id).join(", ") || "none"}`
  );
  if (options["no-interview"]) {
    console.info(`e9g: draft written. Finish .e9g/ in ${checkout}, then: e9g check --run, e9g register, e9g start ${name}`);
    return 0;
  }
  const first = [
    `Set up an E9G team for the repository at ${repo}.`,
    `The team's checkout is ${checkout} on its integration branch ${branch} (from ${base}); the team is named ${name}.`,
    `The detection report is ${report}. The draft is in ${dir}. The reference for team.json is ${join(FACTORY_ROOT, "docs", "team.md")}.`,
    "Read them and the repository first, then interview me.",
  ].join(" ");
  const session = spawnSync("claude", ["--plugin-dir", join(FACTORY_ROOT, "plugin"), "--agent", "e9g:setup", "--setting-sources", "project", first], {
    cwd: checkout,
    stdio: "inherit",
    env: { ...process.env, E9G_SETUP: "1", E9G_HOME_DIR: checkout, E9G_FACTORY: FACTORY_ROOT },
  });
  return session.status ?? 0;
}
