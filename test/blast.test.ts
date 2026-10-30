// e9g blast: the files a change touches, what imports them, what usually changes with them, the tests among those,
// whether it touches UI and how much, and which of the team's critical paths it reaches.
import { baseTeam, commit, E9G, e9g, git, makeRepo, ROOT, tmp, write } from "./helpers.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { blastRadius } from "../lib/blast.ts";

// A branch off the team's integration branch with one commit on it.
function branch(dir: string, files: Record<string, unknown>, name = "feature"): void {
  git(dir, "checkout", "-q", "-b", name);
  commit(dir, files, name);
}

test("importers: an exact tsconfig paths key that names nothing of its file's name", () => {
  const dir = makeRepo(baseTeam(), {
    "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@app": ["src/main.ts"] } } }),
    "src/main.ts": "export const start = 0;\n",
    "src/boot.ts": 'import { start } from "@app";\nexport const boot = start;\n',
  });
  branch(dir, { "src/main.ts": "export const start = 1;\n" });
  assert.deepEqual(blastRadius(dir, { base: "e9g/next" }).importers, ["src/boot.ts"]);
});

test("importers: relative, .js-suffixed and tsconfig paths imports, two levels and no further", () => {
  const dir = makeRepo(baseTeam(), {
    // Comments, trailing commas, and a "@/*" key that isn't the start of a comment.
    "tsconfig.json": `{
  // the aliases
  "compilerOptions": {
    "baseUrl": ".",
    /* "@lib/*" first */
    "paths": { "@lib/*": ["src/lib/*"], "@/*": ["src/*",], },
  },
}
`,
    "src/lib/core.ts": "export const core = 1;\n",
    "src/a.ts": 'import { core } from "./lib/core.js";\nexport const a = core;\n',
    "src/b.ts": 'import { a } from "./a";\nexport const b = a;\n',
    "src/c.ts": 'import { b } from "./b";\nexport const c = b;\n',
    "src/alias.ts": 'import {\n  core,\n} from "@lib/core";\nexport const viaAlias = core;\n',
    "src/via-alias.ts": 'export * from "@/alias";\n',
    "src/side.ts": 'import "../src/lib/core";\n',
    "src/lazy.ts": 'export const load = () => import("./lib/core.ts");\n',
    "src/old.cjs": 'const { core } = require("./lib/core");\nmodule.exports = core;\n',
    "src/lib/index.ts": 'export { core } from "./core";\n',
    "src/folder.ts": 'import { core } from "./lib";\nexport const folder = core;\n',
    "src/packages.ts": 'import lodash from "lodash";\nimport { core } from "@unknown/core";\nexport { lodash, core };\n',
    "src/other.ts": "export const other = 2;\n",
  });
  branch(dir, { "src/lib/core.ts": "export const core = 2;\n" });
  const radius = blastRadius(join(dir, "src"), { base: "e9g/next" });
  assert.equal(radius.base, "e9g/next");
  assert.equal(radius.ref, "HEAD");
  assert.deepEqual(radius.changed, ["src/lib/core.ts"]);
  // One level: a, alias, side, lazy, old.cjs and lib/index; two: b (a), via-alias (alias) and folder (lib/index).
  // Not c, three levels away, nor the files that import packages or nothing.
  assert.deepEqual(radius.importers, [
    "src/a.ts",
    "src/alias.ts",
    "src/b.ts",
    "src/folder.ts",
    "src/lazy.ts",
    "src/lib/index.ts",
    "src/old.cjs",
    "src/side.ts",
    "src/via-alias.ts",
  ]);
  assert.deepEqual(radius.related, []);
  assert.deepEqual(radius.tests, []);
  assert.equal(radius.ui, false);
  assert.deepEqual(radius.uiFiles, []);
  assert.equal(radius.uiLines, 0);
  assert.deepEqual(radius.critical, []);

  // A tsconfig.json that isn't JSON even so is ignored: the aliases go, the rest stays.
  write(dir, { "tsconfig.json": '{ "compilerOptions": { "paths": ' });
  const without = blastRadius(dir, { base: "e9g/next" });
  assert.deepEqual(
    without.importers,
    radius.importers.filter((file) => file !== "src/alias.ts" && file !== "src/via-alias.ts")
  );
});

test("importers: a workspace's packages by name, through exports, main or module, or the index, and paths in them", () => {
  const dir = makeRepo(baseTeam(), {
    "pnpm-workspace.yaml": "packages:\n  - 'packages/*' # the libraries\n  - \"apps/*\"\n  - '!packages/legacy'\n",
    "packages/ui/package.json": {
      name: "@acme/ui",
      // The build isn't in the checkout, so "." is its types; a condition inside another is read too.
      exports: {
        ".": { import: "./dist/index.js", types: "./src/index.ts" },
        "./button": "./src/Button.tsx",
        "./icons/*": { import: { default: "./src/icons/*.tsx" } },
      },
    },
    "packages/ui/src/index.ts": 'export { Button } from "./Button";\nexport const version = 1;\n',
    "packages/ui/src/Button.tsx": "export const Button = () => null;\n",
    "packages/ui/src/icons/Star.tsx": "export const Star = () => null;\n",
    "packages/legacy/package.json": { name: "@acme/legacy", main: "Button.ts" },
    "packages/legacy/Button.ts": "export const Old = 1;\n",
    "apps/web/package.json": { name: "web", dependencies: { "@acme/ui": "workspace:*" } },
    "apps/web/src/Page.tsx": 'import { Button } from "@acme/ui";\nexport const Page = Button;\n',
    "apps/web/src/Toolbar.tsx": 'import { Button } from "@acme/ui/button";\n',
    "apps/web/src/Rating.tsx": 'import { Star } from "@acme/ui/icons/Star";\n',
    "apps/web/src/Direct.tsx": 'import { Button } from "@acme/ui/src/Button";\n',
    // Another package whose name @acme/ui starts, and one the workspace leaves out.
    "apps/web/src/Kit.tsx": 'import { Button } from "@acme/ui-kit";\nimport { Old } from "@acme/legacy";\nexport { Button, Old };\n',
  });
  branch(dir, {
    "packages/ui/src/Button.tsx": "export const Button = () => 1;\n",
    "packages/ui/src/icons/Star.tsx": "export const Star = () => 1;\n",
    "packages/legacy/Button.ts": "export const Old = 2;\n",
  });
  // One level: the package's index, and through exports ./button, ./icons/* and a path in the folder; two: Page,
  // which imports the package itself (its index).
  assert.deepEqual(blastRadius(dir, { base: "e9g/next" }).importers, [
    "apps/web/src/Direct.tsx",
    "apps/web/src/Page.tsx",
    "apps/web/src/Rating.tsx",
    "apps/web/src/Toolbar.tsx",
    "packages/ui/src/index.ts",
  ]);

  // Yarn's workspaces in package.json: a package found by its main (the .ts behind a .js), and one without exports or
  // main by its src/index.
  const yarn = makeRepo(baseTeam(), {
    "package.json": { private: true, workspaces: { packages: ["libs/**"] } },
    "libs/shared/package.json": { name: "shared", main: "./lib/main.js" },
    "libs/shared/lib/main.ts": "export const shared = 1;\n",
    "libs/fmt/package.json": { name: "@acme/fmt", version: "1.0.0" },
    "libs/fmt/src/index.ts": "export const fmt = 1;\n",
    "src/a.ts": 'import { shared } from "shared";\nexport const a = shared;\n',
    "src/b.ts": 'import { fmt } from "@acme/fmt";\nexport const b = fmt;\n',
  });
  branch(yarn, { "libs/shared/lib/main.ts": "export const shared = 2;\n", "libs/fmt/src/index.ts": "export const fmt = 2;\n" });
  assert.deepEqual(blastRadius(yarn, { base: "e9g/next" }).importers, ["src/a.ts", "src/b.ts"]);
});

test("importers: paths from the nearest jsconfig.json or tsconfig.json above the importing file, baseUrl relative to it", () => {
  const dir = makeRepo(baseTeam(), {
    "jsconfig.json": { compilerOptions: { baseUrl: "src", paths: { "~/*": ["*"] } } },
    "src/lib/core.js": "export const core = 1;\n",
    "src/app.jsx": 'import { core } from "~/lib/core";\nexport const App = () => core;\n',
    // A folder with a config of its own and no paths in it: the root's don't apply there.
    "tools/tsconfig.json": { compilerOptions: { strict: true } },
    "tools/build.ts": 'import { core } from "~/lib/core";\n',
  });
  branch(dir, { "src/lib/core.js": "export const core = 2;\n" });
  assert.deepEqual(blastRadius(dir, { base: "e9g/next" }).importers, ["src/app.jsx"]);
});

test("importers: a package's tsconfig.json with the paths of the base it extends, baseUrl relative to the base", () => {
  const dir = makeRepo(baseTeam(), {
    "tsconfig.base.json": { compilerOptions: { baseUrl: ".", paths: { "@shared/*": ["packages/shared/src/*"] } } },
    "packages/shared/src/core.ts": "export const core = 1;\n",
    // A package's config (@tsconfig/…) isn't read; a relative one may leave out .json.
    "packages/app/tsconfig.json": `{
  // the base's paths
  "extends": ["@tsconfig/node22/tsconfig.json", "../../tsconfig.base"],
  "compilerOptions": { "outDir": "dist", },
}
`,
    "packages/app/src/main.ts": 'import { core } from "@shared/core";\nexport const main = core;\n',
    // Paths without a baseUrl are relative to the file that sets them.
    "config/paths.json": { compilerOptions: { paths: { "#shared/*": ["../packages/shared/src/*"] } } },
    "packages/cli/tsconfig.json": { extends: "../../config/paths.json" },
    "packages/cli/src/run.ts": 'import { core } from "#shared/core.js";\nexport const run = core;\n',
    // Configs that extend each other: the cycle ends, and the paths stay.
    "packages/loop/tsconfig.json": { extends: "./tsconfig.other.json" },
    "packages/loop/tsconfig.other.json": { extends: "./tsconfig.json", compilerOptions: { baseUrl: ".", paths: { "@shared/*": ["../shared/src/*"] } } },
    "packages/loop/index.ts": 'import { core } from "@shared/core";\nexport const loop = core;\n',
    // No tsconfig.json above it: tsconfig.base.json isn't one TypeScript would read for it.
    "scripts/release.ts": 'import { core } from "@shared/core";\n',
  });
  branch(dir, { "packages/shared/src/core.ts": "export const core = 2;\n" });
  assert.deepEqual(blastRadius(dir, { base: "e9g/next" }).importers, ["packages/app/src/main.ts", "packages/cli/src/run.ts", "packages/loop/index.ts"]);
});

test("importers: a barrel (export … from and nothing else) isn't a level; what imports it is at its level", () => {
  const dir = makeRepo(baseTeam(), {
    "src/ui/components/Button.tsx": "export const Button = () => null;\nexport type ButtonProps = {};\n",
    "src/ui/components/index.ts": 'export { Button, type ButtonProps } from "./Button";\n',
    "src/ui/index.ts": '// The UI kit, all of it.\nexport * from "./components";\nexport * as icons from "./icons";\n',
    "src/pages/Home.tsx": 'import { Button } from "../ui";\nexport const Home = () => Button;\n',
    "src/pages/Home.test.tsx": 'import { Home } from "./Home";\n',
    "src/pages/About.tsx": 'import { Home } from "./Home";\nexport const About = Home;\n',
    "src/ui/components/parts/Label.tsx": 'import { Button as B } from "..";\nexport const Label = B;\n', // names its folder's index by ".." alone
    "src/App.tsx": 'import { About } from "./pages/About";\n', // three levels away
    // Barrels in a cycle: each is listed once, and the cycle ends.
    "src/ui/left/index.ts": 'export * from "../right";\n',
    "src/ui/right/index.ts": 'export * from "../left";\nexport * from "../components";\n',
    // More than re-exports: a level of its own.
    "src/lib/index.ts": 'export { Button } from "../ui/components/Button";\nexport const lib = 1;\n',
    "src/feature.ts": 'import { lib } from "./lib";\nexport const feature = lib;\n',
    "src/deeper.ts": 'import { feature } from "./feature";\n',
  });
  branch(dir, { "src/ui/components/Button.tsx": "export const Button = () => 1;\nexport type ButtonProps = {};\n" });
  const radius = blastRadius(dir, { base: "e9g/next" });
  // One level: lib/index, and through the barrels (components/index, ui/index, right and left) Home and Label; two:
  // Home's test, About and feature. Not App or deeper, three levels away.
  assert.deepEqual(radius.importers, [
    "src/feature.ts",
    "src/lib/index.ts",
    "src/pages/About.tsx",
    "src/pages/Home.test.tsx",
    "src/pages/Home.tsx",
    "src/ui/components/index.ts",
    "src/ui/components/parts/Label.tsx",
    "src/ui/index.ts",
    "src/ui/left/index.ts",
    "src/ui/right/index.ts",
  ]);
  assert.deepEqual(radius.tests, ["src/pages/Home.test.tsx"]);
});

test("importers: only the files that name a changed file are read, so few are plenty; more of them than that is truncated", () => {
  // 30 files that come first in git's order and name nothing that changed, then three that do, one of them an importer.
  const noise = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`a/noise${i}.ts`, `export const n${i} = ${i};\n`]));
  const dir = makeRepo(baseTeam(), {
    ...noise,
    "b/one.ts": "// the core of it\n",
    "b/two.ts": "// core values\n",
    "src/lib/core.ts": "export const core = 1;\n",
    "src/use.ts": 'import { core } from "./lib/core";\nexport const use = core;\n',
  });
  branch(dir, { "src/lib/core.ts": "export const core = 2;\n" });
  const radius = blastRadius(dir, { base: "e9g/next", maxSources: 3 });
  assert.deepEqual([radius.importers, radius.truncated], [["src/use.ts"], false]);
  // Three files name core (besides itself), and only two are read: importers may be missing, and it says so.
  assert.equal(blastRadius(dir, { base: "e9g/next", maxSources: 2 }).truncated, true);
});

test("related: files that changed together in at least 3 commits and 30% of the changed file's, still in the tree", () => {
  const gen = (round: number) => Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`gen/f${i}.ts`, `export const v = ${round};\n`]));
  const dir = makeRepo(baseTeam(), {
    "src/billing/invoice.ts": "export const invoice = 0;\n",
    "src/billing/tax.ts": "export const tax = 0;\n",
    "src/billing/api.ts": 'import "./invoice";\n// 0\n',
    "src/old.ts": "0\n",
    "docs/notes.md": "0\n",
  });
  for (let i = 1; i <= 3; i++)
    commit(
      dir,
      {
        "src/billing/invoice.ts": `export const invoice = ${i};\n`,
        "src/billing/tax.ts": `export const tax = ${i};\n`,
        "src/billing/api.ts": `import "./invoice";\n// ${i}\n`,
        "src/old.ts": `${i}\n`,
      },
      `billing ${i}`
    );
  // notes.md changes with invoice twice in all (with the first commit): too few.
  commit(dir, { "src/billing/invoice.ts": "export const invoice = 4;\n", "docs/notes.md": "1\n" }, "notes");
  // Commits of more than 50 files say nothing about which files go together.
  for (let i = 1; i <= 3; i++) commit(dir, { "src/billing/invoice.ts": `export const invoice = ${4 + i};\n`, ...gen(i) }, `generate ${i}`);
  git(dir, "rm", "-q", "src/old.ts");
  git(dir, "commit", "-qm", "old.ts goes");
  // busy changes in 10 commits, 3 of them with rare (30%: related); hub in 11, 3 with seldom (27%: not).
  for (let i = 1; i <= 7; i++) commit(dir, { "src/busy.ts": `${i}\n` }, `busy ${i}`);
  for (let i = 1; i <= 3; i++) commit(dir, { "src/busy.ts": `rare ${i}\n`, "src/rare.ts": `${i}\n` }, `busy and rare ${i}`);
  for (let i = 1; i <= 8; i++) commit(dir, { "src/hub.ts": `${i}\n` }, `hub ${i}`);
  for (let i = 1; i <= 3; i++) commit(dir, { "src/hub.ts": `seldom ${i}\n`, "src/seldom.ts": `${i}\n` }, `hub and seldom ${i}`);

  branch(dir, { "src/billing/invoice.ts": "export const invoice = 9;\n", "src/busy.ts": "9\n", "src/hub.ts": "9\n" });
  const radius = blastRadius(dir, { base: "e9g/next" });
  assert.deepEqual(radius.changed, ["src/billing/invoice.ts", "src/busy.ts", "src/hub.ts"]);
  // api.ts changes with invoice too, but it imports it: it's an importer, not related. old.ts is gone.
  assert.deepEqual(radius.importers, ["src/billing/api.ts"]);
  assert.deepEqual(radius.related, ["src/billing/tax.ts", "src/rare.ts"]);
});

test("tests: by folder and by name among the changed, importing and related files, and by the changed files' stems", () => {
  const dir = makeRepo(baseTeam(), {
    "src/price.ts": "export const price = 1;\n",
    "src/cart.ts": 'import { price } from "./price";\nexport const cart = price;\n',
    "src/__tests__/cart.ts": 'import { cart } from "../cart";\n',
    "e2e/checkout.ts": 'import { price } from "../src/price";\n',
    "src/format_spec.mjs": 'import { price } from "./price.js";\n',
    "test/price.test.ts": 'import { price } from "app/price";\n',
    "src/billing/index.ts": "export const billing = 1;\n",
    "test/billing.test.ts": 'import { billing } from "app/billing";\n',
    "test/changed.test.ts": "// 1\n",
    "test/unrelated.test.ts": "// nothing to do with it\n",
    "test/fixtures/data.json": "{}\n",
  });
  branch(dir, { "src/price.ts": "export const price = 2;\n", "src/billing/index.ts": "export const billing = 2;\n", "test/changed.test.ts": "// 2\n" });
  const radius = blastRadius(dir, { base: "e9g/next" });
  assert.deepEqual(radius.importers, ["e2e/checkout.ts", "src/__tests__/cart.ts", "src/cart.ts", "src/format_spec.mjs"]);
  // e2e/ and __tests__/ by folder, format_spec by name, the changed test itself, price.test.ts by price.ts's stem
  // and billing.test.ts by billing/index.ts's (its folder's name).
  assert.deepEqual(radius.tests, [
    "e2e/checkout.ts",
    "src/__tests__/cart.ts",
    "src/format_spec.mjs",
    "test/billing.test.ts",
    "test/changed.test.ts",
    "test/price.test.ts",
  ]);
});

test("UI: view files by extension and templates in view folders; never a test, an API route or a server file", () => {
  const dir = makeRepo(baseTeam(), { "src/pages/home.ts": "a\nb\nc\n", "src/server.ts": "x\n" });
  branch(dir, {
    "src/components/Button.tsx": "export function Button() {\n  return (\n    <button />\n  );\n}\n", // 5 lines
    "src/styles/site.css": "body {\n  margin: 0;\n}\n", // 3
    "src/pages/home.ts": "a\nB\nc\n", // logic in a pages folder: not a view
    "docs/index.html": "<p>hi</p>\n", // 1
    "app/views/home/index.html.erb": "<h1>Home</h1>\n", // 1: a template in a view folder
    "app/models/user.rb": "class User; end\n", // a model in app/: not UI
    "app/api/users/route.ts": "export const GET = 1;\n", // an API route
    "src/components/api/Fetcher.tsx": "export const F = 1;\n", // under api/: server-side
    "src/components/logo.png": "\u0000\u0001\u0002 binary\n", // an image, not a view file
    "src/components/Button.test.tsx": "a\nb\nc\nd\n", // a test, not UI
    "src/server.ts": "y\n",
    "src/application/main.ts": "export {};\n",
  });
  const radius = blastRadius(dir, { base: "e9g/next" });
  assert.equal(radius.ui, true);
  assert.deepEqual(radius.uiFiles, ["app/views/home/index.html.erb", "docs/index.html", "src/components/Button.tsx", "src/styles/site.css"]);
  assert.equal(radius.uiLines, 10);
  assert.deepEqual(radius.tests, ["src/components/Button.test.tsx"]);
  assert.equal(radius.truncated, false);
  const touches = blastRadius(dir, { base: "e9g/next", touches: true });
  assert.deepEqual([touches.uiLines, touches.importers, touches.related], [10, [], []], "touches alone reads no imports or history");
});

test("UI: pages under routes/, plain-JS components and what styles every page; not a route handler or server code", () => {
  const dir = makeRepo(baseTeam(), { "README.md": "x\n" });
  branch(dir, {
    "src/routes/+page.svelte": "<h1>Hi</h1>\n", // a SvelteKit page
    "app/routes/_index.tsx": "export default () => null;\n", // a Remix page
    "src/components/Header.js": "export const Header = 1;\n",
    "src/theme/colors.ts": "export const ink = '#111';\n",
    "tailwind.config.ts": "export default {};\n",
    "src/Button.styles.ts": "export const s = {};\n",
    "public/logo.svg": "<svg/>\n",
    "src/routes/+server.ts": "export const GET = 1;\n", // a SvelteKit endpoint
    "src/routes/+page.server.ts": "export const load = 1;\n",
    "server/routes/users.ts": "export const u = 1;\n",
    "routes/users.js": "module.exports = 1;\n", // an Express router
    "app/models/user.js": "module.exports = 1;\n",
  });
  assert.deepEqual(blastRadius(dir, { base: "e9g/next", touches: true }).uiFiles, [
    "app/routes/_index.tsx",
    "public/logo.svg",
    "src/Button.styles.ts",
    "src/components/Header.js",
    "src/routes/+page.svelte",
    "src/theme/colors.ts",
    "tailwind.config.ts",
  ]);
});

test("critical: the team's critical regexes, as given, that match a changed file or one that imports it", () => {
  const dir = makeRepo(baseTeam(), { "src/billing/invoice.ts": "0\n", "db/001.sql": "select 0;\n", "infra/main.tf": "0\n" });
  branch(dir, { "src/billing/invoice.ts": "1\n", "db/001.sql": "select 1;\n" });
  const radius = blastRadius(dir, { base: "e9g/next", critical: ["^src/billing/", "^infra/", "\\.sql$"] });
  assert.deepEqual(radius.critical, ["\\.sql$", "^src/billing/"]);
  // Against another ref and base: nothing changed between them.
  const none = blastRadius(dir, { base: "main", ref: "e9g/next", critical: ["^src/billing/"] });
  assert.deepEqual([none.base, none.ref, none.changed, none.critical], ["main", "e9g/next", [], []]);
  assert.throws(() => blastRadius(dir, { base: "e9g/next", ref: "no-such-ref" }), /no-such-ref isn't a commit/);
  // A helper billing imports reaches billing; reading only what changed, it doesn't.
  const helper = makeRepo(baseTeam(), {
    "src/lib/round.ts": "export const round = 0;\n",
    "src/billing/total.ts": 'import { round } from "../lib/round.ts";\nexport const t = round;\n',
  });
  branch(helper, { "src/lib/round.ts": "export const round = 1;\n" });
  assert.deepEqual(blastRadius(helper, { base: "e9g/next", critical: ["^src/billing/"] }).critical, ["^src/billing/"]);
  assert.deepEqual(blastRadius(helper, { base: "e9g/next", critical: ["^src/billing/"], touches: true }).critical, []);
});

// The command as bin/e9g.ts runs it, and whether bin/e9g.ts dispatches it yet.
const COMMAND = pathToFileURL(join(ROOT, "lib", "commands", "blast.ts")).href;
const wired = readFileSync(E9G, "utf8").includes("commands/blast.ts");
function blastCommand(args: string[], { cwd, env = {} }: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    const script = `import { blast } from ${JSON.stringify(COMMAND)}; process.exitCode = await blast(process.argv.slice(1));`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, "--", ...args], { cwd, env: { ...process.env, ...env } });
    let out = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk: Buffer) => (out += chunk));
    child.on("close", (code) => done({ code, out }));
  });
}

// The team's checkout, and a member's worktree on a branch of its own with one change in it.
function teamWithWorktree(): { home: string; worktree: string } {
  const home = makeRepo(baseTeam({ critical: ["^src/billing/"] }), {
    "src/billing/invoice.ts": "export const invoice = 0;\n",
    "src/billing/api.ts": 'import { invoice } from "./invoice.js";\nexport const api = invoice;\n',
  });
  const worktree = join(tmp("e9g-worktree-"), "builder-1");
  git(home, "worktree", "add", "-q", "-b", "e9g/builder/1", worktree, "e9g/next");
  commit(worktree, { "src/billing/invoice.ts": "export const invoice = 1;\n" }, "invoice 1");
  return { home, worktree };
}

test("e9g blast: the radius of the worktree it's run in, against the team's branch, with the team's critical paths", async () => {
  const { home, worktree } = teamWithWorktree();
  const env = { E9G_HOME_DIR: home };
  const json = await blastCommand(["--json"], { cwd: worktree, env });
  assert.equal(json.code, 0, json.out);
  const radius = JSON.parse(json.out) as ReturnType<typeof blastRadius>;
  assert.deepEqual(radius, blastRadius(worktree, { base: "e9g/next", critical: ["^src/billing/"] }));
  assert.deepEqual(
    [radius.base, radius.ref, radius.changed, radius.importers, radius.critical],
    ["e9g/next", "HEAD", ["src/billing/invoice.ts"], ["src/billing/api.ts"], ["^src/billing/"]]
  );

  const shown = await blastCommand([], { cwd: worktree, env });
  assert.equal(shown.code, 0, shown.out);
  assert.match(shown.out, /^HEAD against e9g\/next: 1 file changed, 1 importer, 0 related files, 0 tests$/m);
  assert.match(shown.out, /^changed \(1\):\n {2}src\/billing\/invoice\.ts$/m);
  assert.match(shown.out, /^importers \(up to two levels\) \(1\):\n {2}src\/billing\/api\.ts$/m);
  assert.match(shown.out, /^UI: no$/m);
  assert.match(shown.out, /^critical paths it reaches: \^src\/billing\/$/m);

  // A ref and --base of one's own: the team's branch against main changes nothing.
  const other = await blastCommand(["e9g/next", "--base", "main", "--json"], { cwd: worktree, env });
  assert.equal(other.code, 0, other.out);
  assert.deepEqual((JSON.parse(other.out) as ReturnType<typeof blastRadius>).changed, []);
  assert.match((await blastCommand(["e9g/next", "--base", "main"], { cwd: worktree, env })).out, /^e9g\/next changes nothing since main$/m);
});

test("e9g blast: a bad ref, a bad argument, or no git checkout exits 2 and says why", async () => {
  const { home, worktree } = teamWithWorktree();
  const env = { E9G_HOME_DIR: home };
  const bad = await blastCommand(["no-such-ref", "--json"], { cwd: worktree, env });
  assert.equal(bad.code, 2);
  assert.match(bad.out, /^blast: no-such-ref isn't a commit in /m);
  const noBase = await blastCommand(["--base"], { cwd: worktree, env });
  assert.equal(noBase.code, 2);
  assert.match(noBase.out, /usage: e9g blast/);
  const outside = await blastCommand(["--json"], { cwd: tmp("e9g-not-git-"), env });
  assert.equal(outside.code, 2);
  assert.match(outside.out, /^blast: git rev-parse --show-toplevel failed: /m);
});

test("e9g blast runs from the CLI", { skip: wired ? false : "bin/e9g.ts doesn't dispatch blast yet" }, async () => {
  const { home, worktree } = teamWithWorktree();
  const { code, out } = await e9g(["blast", "--json"], { cwd: worktree, env: { E9G_HOME_DIR: home } });
  assert.equal(code, 0, out);
  assert.deepEqual(JSON.parse(out), blastRadius(worktree, { base: "e9g/next", critical: ["^src/billing/"] }));
});
