// e9g pages: the finish line for teams that build pages (team.json "pages"). For each page, viewport and colour
// scheme it loads the page on the team's app and records the HTTP status, uncaught errors, console errors,
// horizontal overflow at that width, and axe's WCAG A/AA violations (serious and critical), plus a full-page
// screenshot that builders and the UX specialist look at. Results are keyed to the pages' source, so a change to
// it has to be checked again, and UX verdicts (e9g verdict ux <page>) count only for the source they saw.
//
//   e9g pages run [ids…]                     check the team's app and record the results (the planner)
//   e9g pages shots --base <url> [--out dir] [--path /x] [ids…]   the same checks on any server, or any path (such
//                                            as the original page), recording nothing
//   e9g pages status [--brief]               one line per page
//   e9g pages done                           exit 0 only when every page meets the finish line
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { LoadedTeam, PageSpec, PagesSettings, Viewport } from "../config.ts";
import { FACTORY_ROOT, stateDir, workDir } from "../paths.ts";
import { teamSession } from "../session.ts";
import { readJson } from "../util.ts";

// The part of Playwright this uses. It's the team's own copy (its node_modules), so the factory doesn't depend on it.
interface ConsoleMessage {
  type(): string;
  text(): string;
  location(): { url?: string } | undefined;
}
interface Tab {
  on(event: "pageerror", listener: (error: Error) => void): void;
  on(event: "console", listener: (message: ConsoleMessage) => void): void;
  goto(url: string, options: { waitUntil: "load"; timeout: number }): Promise<{ status(): number } | null>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T>(fn: () => T | Promise<T>): Promise<T>;
  addScriptTag(options: { path: string }): Promise<unknown>;
  screenshot(options: {
    path: string;
    fullPage: boolean;
    scale?: "css";
    clip?: { x: number; y: number; width: number; height: number };
  }): Promise<unknown>;
}
interface Browser {
  newContext(options: Record<string, unknown>): Promise<{ newPage(): Promise<Tab>; close(): Promise<void> }>;
  close(): Promise<void>;
}
interface Axe {
  run(context: unknown, options: unknown): Promise<{ violations: { id: string; impact?: string; nodes: unknown[] }[] }>;
}

// One page at one viewport and colour scheme, and a page's result across them.
interface PageRun {
  viewport: string;
  scheme: string;
  problems: string[];
  status?: number;
  overflow?: number;
  axe?: string[];
  shot?: string;
  slices?: string[];
}
interface PageResult {
  passed: boolean;
  runs: PageRun[];
}
interface SavedResult extends PageResult {
  hash: string;
  commit: string;
  at: string;
}
interface UxVerdict {
  verdict: string;
  sha: string;
}

let home = "";
let team: LoadedTeam;
let pages: PagesSettings = {};
let STATE = "";
let RESULTS = "";
let list: PageSpec[] = [];
const git = (...args: string[]): string => execFileSync("git", args, { cwd: home, encoding: "utf8" }).trim();
const pick = (ids: string[]): PageSpec[] => (ids.length ? list.filter((page) => ids.includes(page.id)) : list);

// What a page's result depends on: the files under the pages' source paths at a commit, minus the paths that
// belong only to other pages (a page's "exclude"), so a change to one page doesn't make another's verdict stale.
function sourceHash(ref = "HEAD", page: Partial<PageSpec> = {}): string {
  let listing = "";
  try {
    listing = execFileSync("git", ["ls-tree", "-r", ref, "--", ...(pages.content ?? [])], {
      cwd: home,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {}
  const exclude = (page.exclude ?? []).map((rule) => new RegExp(rule));
  const files = listing.split("\n").filter((line) => line && !exclude.some((rule) => rule.test(line.split("\t")[1] ?? "")));
  return createHash("sha256").update(files.join("\n")).digest("hex").slice(0, 16);
}

async function check(base: string, chosen: PageSpec[], outDir: string | null): Promise<Record<string, PageResult>> {
  const require = createRequire(join(home, "package.json"));
  const { chromium } = require(existsSync(join(home, "node_modules", "playwright")) ? "playwright" : "@playwright/test") as {
    chromium: { launch(): Promise<Browser> };
  };
  const axePath = [join(FACTORY_ROOT, "node_modules/axe-core/axe.min.js")].find(existsSync);
  const ignore = (pages.ignoreConsole ?? []).map((rule) => new RegExp(rule, "i"));
  const viewports: Viewport[] = pages.viewports ?? [
    { id: "desktop", width: 1440, height: 900 },
    { id: "laptop", width: 1024, height: 768 },
    { id: "phone", width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 },
  ];
  const schemes = pages.schemes ?? ["light", "dark"];
  const browser = await chromium.launch();
  const results: Record<string, PageResult> = {};
  try {
    for (const page of chosen) {
      const runs: PageRun[] = [];
      for (const viewport of viewports) {
        for (const scheme of schemes) {
          const context = await browser.newContext({
            viewport: { width: viewport.width, height: viewport.height },
            isMobile: viewport.isMobile ?? false,
            hasTouch: viewport.isMobile ?? false,
            deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
            colorScheme: scheme,
            reducedMotion: "no-preference",
          });
          const tab = await context.newPage();
          const errors: string[] = [];
          const consoleErrors: string[] = [];
          tab.on("pageerror", (error) => errors.push((String(error.message).split("\n")[0] ?? "").slice(0, 200)));
          tab.on("console", (message) => {
            if (message.type() !== "error") return;
            const text = message.text();
            // Rules match the text or the URL it came from ("Failed to load resource" names no URL itself).
            const url = message.location()?.url ?? "";
            const seen = `${text} ${url}`;
            if (!ignore.some((rule) => rule.test(seen)))
              consoleErrors.push(`${(text.split("\n")[0] ?? "").slice(0, 160)}${url ? ` (${url.replace(base, "")})` : ""}`);
          });
          const run: PageRun = { viewport: viewport.id, scheme, problems: [] };
          try {
            const response = await tab.goto(new URL(page.path, base).href, { waitUntil: "load", timeout: 120_000 });
            run.status = response?.status() ?? 0;
            await tab.waitForTimeout(pages.settleMs ?? 1500);
            run.overflow = await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
            if (axePath) {
              await tab.addScriptTag({ path: axePath });
              const violations = await tab.evaluate(async () => {
                const result = await (window as unknown as { axe: Axe }).axe.run(document, {
                  runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
                });
                return result.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} (${v.nodes.length})`);
              });
              run.axe = violations;
            }
            if (outDir) {
              mkdirSync(join(outDir, page.id), { recursive: true });
              run.shot = join(outDir, page.id, `${viewport.id}-${scheme}.png`);
              await shoot(tab, run, viewport, run.shot);
            }
          } catch (error) {
            run.problems.push(`didn't load: ${String((error as Error).message).split("\n")[0]}`);
          }
          if (run.status && run.status >= 400) run.problems.push(`HTTP ${run.status}`);
          if ((run.overflow ?? 0) > 1) run.problems.push(`scrolls sideways by ${run.overflow}px`);
          if (run.axe?.length) run.problems.push(`axe: ${run.axe.join(", ")}`);
          if (errors.length) run.problems.push(`errors: ${errors.slice(0, 3).join(" | ")}`);
          if (consoleErrors.length) run.problems.push(`console: ${consoleErrors.slice(0, 3).join(" | ")}`);
          if (!axePath) run.problems.push("axe-core not found (reinstall E9G Factory: e9g self-install)");
          runs.push(run);
          await context.close();
        }
      }
      results[page.id] = { passed: runs.every((run) => !run.problems.length), runs };
    }
  } finally {
    await browser.close();
  }
  return results;
}

// Chromium can't capture more than about 16,000 device pixels in one screenshot (taller ones come out blank). A
// tall page is shot at CSS scale, and past 16,000 CSS px in slices: <name>.png, <name>-2.png, …
const MAX_DEVICE_PX = 16_000;
async function shoot(tab: Tab, run: PageRun, viewport: Viewport, path: string): Promise<void> {
  const height = await tab.evaluate(() => document.documentElement.scrollHeight);
  const scale = viewport.deviceScaleFactor ?? 1;
  if (height * scale <= MAX_DEVICE_PX) {
    await tab.screenshot({ path, fullPage: true });
    return;
  }
  if (height <= MAX_DEVICE_PX) {
    await tab.screenshot({ path, fullPage: true, scale: "css" });
    return;
  }
  const slices: string[] = [];
  run.slices = slices;
  for (let y = 0, i = 1; y < height; y += MAX_DEVICE_PX / 2, i++) {
    const slice = i === 1 ? path : path.replace(/\.png$/, `-${i}.png`);
    await tab.screenshot({
      path: slice,
      fullPage: true,
      scale: "css",
      clip: { x: 0, y, width: viewport.width, height: Math.min(MAX_DEVICE_PX / 2, height - y) },
    });
    slices.push(slice);
  }
}

function print(results: Record<string, PageResult>): void {
  for (const [id, result] of Object.entries(results)) {
    console.info(`${result.passed ? "pass" : "FAIL"} ${id}`);
    for (const run of result.runs) {
      console.info(`  ${run.viewport}/${run.scheme}: ${run.problems.length ? run.problems.join("; ") : "ok"}${run.shot ? `  ${run.shot}` : ""}`);
    }
  }
}

function uxFor(page: PageSpec, hash: string): string {
  const record = readJson<UxVerdict>(join(STATE, "ux", `${page.id}.json`));
  if (!record) return "due";
  return sourceHash(record.sha, page) === hash ? record.verdict : "due";
}

function rows(): { id: string; path: string; checks: string; ux: string; problems: string[] }[] {
  const saved = readJson<{ pages: Record<string, SavedResult> }>(RESULTS, { pages: {} }).pages;
  return list.map((page) => {
    const hash = sourceHash("HEAD", page);
    const result = saved[page.id];
    const current = result?.hash === hash;
    return {
      id: page.id,
      path: page.path,
      checks: !result ? "not run" : !current ? "stale" : result.passed ? "pass" : "fail",
      ux: uxFor(page, hash),
      problems: current ? result.runs.flatMap((run) => run.problems.map((problem) => `${run.viewport}/${run.scheme}: ${problem}`)) : [],
    };
  });
}

// What the branch changed outside pages.allowedChanges, since pages.base (the team's base when it's left out).
function outsideChanges(): string[] {
  if (!pages.allowedChanges) return [];
  const base = pages.base ?? team.base;
  const allowed = pages.allowedChanges.map((rule) => new RegExp(rule));
  let changed: string;
  try {
    // -z: git quotes unusual names otherwise, and a quoted one would match no rule.
    changed = git("diff", "--name-only", "--no-renames", "-z", `${base}...HEAD`);
  } catch {
    throw new Error(`can't compare with ${base}, which allowedChanges is checked against (pages.base, or the team's base)`);
  }
  return changed
    .split("\0")
    .filter(Boolean)
    .filter((path) => !allowed.some((rule) => rule.test(path)));
}

export async function run(argv: string[]): Promise<number> {
  ({ home, team } = teamSession());
  pages = team.pages ?? {};
  STATE = stateDir(home);
  RESULTS = join(STATE, "pages.json");
  list = pages.list ?? [];
  const [command, ...rest] = argv;
  const option = (flag: string): string | undefined => {
    const at = rest.indexOf(flag);
    if (at < 0) return undefined;
    const [value] = rest.splice(at, 2).slice(1);
    return value;
  };
  // Nothing to check is never done: an empty list would pass every finish line.
  if (["run", "status", "done"].includes(command ?? "") && !list.length) {
    console.error('pages: team.json "pages.list" names no pages, so there is nothing to check');
    return 2;
  }

  if (command === "run") {
    if (git("rev-parse", "--abbrev-ref", "HEAD") !== team.branch) {
      console.error(`pages: results are recorded only on ${team.branch} in the team's checkout; use shots for anything else`);
      return 2;
    }
    const chosen = pick(rest);
    if (!pages.appUrl) {
      console.error("pages: team.json pages.appUrl says where the team's app runs");
      return 2;
    }
    const results = await check(pages.appUrl, chosen, join(workDir(home), "shots"));
    const saved = readJson<{ pages: Record<string, SavedResult> }>(RESULTS, { pages: {} });
    const commit = git("rev-parse", "--short", "HEAD");
    for (const [id, result] of Object.entries(results))
      saved.pages[id] = {
        ...result,
        hash: sourceHash(
          "HEAD",
          list.find((page) => page.id === id)
        ),
        commit,
        at: new Date().toISOString(),
      };
    mkdirSync(STATE, { recursive: true });
    writeFileSync(RESULTS, `${JSON.stringify(saved, null, 2)}\n`);
    print(results);
    const all = rows();
    console.info(
      `pages: ${all.filter((row) => row.checks === "pass").length}/${all.length} pass their checks at ${commit}; UX: ${all.map((row) => `${row.id} ${row.ux}`).join(", ")}. Screenshots in .e9g/run/shots/.`
    );
  } else if (command === "shots") {
    const base = option("--base");
    const path = option("--path");
    const out = resolve(option("--out") ?? join("/tmp", `pages-${Date.now()}`));
    if (!base) {
      console.error("usage: e9g pages shots --base <url> [--out dir] [--path /x] [ids…]");
      return 2;
    }
    const chosen = path ? [{ id: path.replace(/[^\w]+/g, "-").replace(/^-|-$/g, "") || "root", path }] : pick(rest);
    print(await check(base, chosen, out));
    console.info(`screenshots in ${out}`);
  } else if (command === "status") {
    for (const row of rows()) {
      console.info(`${row.id.padEnd(12)} checks:${row.checks.padEnd(8)} ux:${row.ux.padEnd(7)} ${row.path}`);
      if (!rest.includes("--brief")) for (const problem of row.problems.slice(0, 6)) console.info(`             ↳ ${problem}`);
    }
    const outside = outsideChanges();
    if (outside.length) console.info(`Changed outside the allowed paths since ${pages.base ?? team.base}: ${outside.join(", ")}`);
  } else if (command === "done") {
    const gaps = rows().flatMap((row) => [
      ...(row.checks === "pass" ? [] : [`${row.id}: checks ${row.checks}`]),
      ...(row.ux === "pass" ? [] : [`${row.id}: UX ${row.ux}`]),
    ]);
    const outside = outsideChanges();
    if (outside.length) gaps.push(`changed outside the allowed paths: ${outside.join(", ")}`);
    if (gaps.length) {
      console.info(`Not done (${gaps.length}):\n${gaps.map((gap) => `- ${gap}`).join("\n")}`);
      return 1;
    }
    console.info(`Done: every page passes its checks on the current source and has a UX pass for it.`);
  } else {
    console.error("usage: e9g pages run [ids…] | shots --base <url> [--out dir] [--path /x] [ids…] | status [--brief] | done");
    return 2;
  }
  return 0;
}
