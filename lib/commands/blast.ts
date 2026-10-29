// e9g blast [<ref>] [--base <branch>] [--json]
//
// The blast radius of a change: the files it touches, what imports them, what usually changes with them, the tests
// among those, whether it touches UI (and how much), and which of the team's critical paths (team.json critical) it
// reaches. Reviewers and testers start from it. It compares <ref> (HEAD) with --base (the team's integration branch)
// in the checkout it's run in, so a member runs it in their own worktree.
// Exit codes: 0 shown, 2 a bad ref, no git, or a bad argument.
import { type BlastRadius, blastRadius } from "../blast.ts";
import { teamSession } from "../session.ts";
import { parseArgs, text as optionText } from "../util.ts";

const USAGE = "usage: e9g blast [<ref>] [--base <branch>] [--json]";
// Past this many, a list shows its first ones and how many more there are (--json has them all).
const SHOWN = 30;

export async function blast(argv: string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, { booleans: ["json"] });
  if (positional.length > 1 || options["base"] === true) {
    console.error(USAGE);
    return 2;
  }
  const { team } = teamSession();
  let radius: BlastRadius;
  try {
    radius = blastRadius(process.cwd(), { base: optionText(options["base"]) ?? team.branch, ref: positional[0] ?? "HEAD", critical: team.critical });
  } catch (error) {
    console.error(`blast: ${(error as Error).message}`);
    return 2;
  }
  console.info(options["json"] ? JSON.stringify(radius, null, 2) : summary(radius));
  return 0;
}

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

// A list for people: a heading with how many, then the first SHOWN of them and how many more.
function section(heading: string, items: string[]): string[] {
  if (!items.length) return [];
  const more = items.length > SHOWN ? [`  … and ${items.length - SHOWN} more`] : [];
  return [`${heading} (${items.length}):`, ...items.slice(0, SHOWN).map((item) => `  ${item}`), ...more];
}

// The radius as a few lines: what it counts, the lists, then UI and the critical paths.
function summary(radius: BlastRadius): string {
  const { changed, importers, related, tests, uiFiles, uiLines, critical } = radius;
  if (!changed.length) return `${radius.ref} changes nothing since ${radius.base}`;
  return [
    `${radius.ref} against ${radius.base}: ${count(changed.length, "file")} changed, ${count(importers.length, "importer")}, ${count(related.length, "related file")}, ${count(tests.length, "test")}`,
    ...section("changed", changed),
    ...section("importers (up to two levels)", importers),
    ...section("usually change with them", related),
    ...section("tests", tests),
    radius.ui ? `UI: yes, ${count(uiFiles.length, "file")}, ${count(uiLines, "line")} added or removed` : "UI: no",
    ...(radius.ui ? section("UI files", uiFiles) : []),
    critical.length ? `critical paths it reaches: ${critical.join(", ")}` : "critical paths it reaches: none",
    ...(radius.truncated ? ["(a large repository: only the first 20,000 source files were read for imports, so importers may be missing)"] : []),
  ].join("\n");
}
