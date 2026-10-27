// The text each agent works under, besides its role prompt (plugin/agents/<role>.md): the constitution's articles,
// the team's rules rendered from team.json, the operator's direction, the operator's notes for the role, and the
// planner's decisions and lessons. Compiled
// into ~/.e9g/runs/<team>/prompts/<role>.md, which T3 Code appends to the agent's system prompt
// (--append-system-prompt-file). Nothing here is written by hand, so the prose can't disagree with the rules the
// guard enforces. A prompt records the hash of its sources; the session-start hook recompiles a stale one.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { instanceId, type Lane, type LoadedTeam, ROLES, type Team } from "./config.ts";
import { FACTORY_ROOT, PACKAGE } from "./paths.ts";
import { contactRule } from "./contact.ts";
import { PLANNER_LABEL } from "./labels.ts";
import { policyStates } from "./policies.ts";
import { hash, localTime, writeFileAtomic } from "./util.ts";

const read = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8").trim() : "");
// A file the operator fills in from a starter, without its HTML comments; empty while nothing but headings is left.
const readFilled = (path: string): string => {
  const text = read(path)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.split("\n").some((line) => line.trim() && !line.startsWith("#")) ? text : "";
};

export function articles(): string {
  const text = read(join(FACTORY_ROOT, "CONSTITUTION.md"));
  const match = /<!-- e9g:articles:start -->([\s\S]*?)<!-- e9g:articles:end -->/.exec(text);
  if (!match) throw new Error("CONSTITUTION.md has no articles section (<!-- e9g:articles:start --> … end)");
  return (match[1] ?? "").trim();
}

const roleNotesFile = (team: Team, role: string): string => join(team.home, ".e9g", "roles", `${role}.md`);
const lessonsFile = (team: Team): string => join(team.home, ".e9g", "lessons.md");
// The operator's standing direction, and the planner's decisions derived from it (Article 3).
const directionFile = (team: Team): string => join(team.home, ".e9g", "direction.md");
const decisionsFile = (team: Team): string => join(team.home, ".e9g", "decisions.md");

// The documents a prompt lists are the ones that exist when it's compiled.
const existingDocs = (team: Team): string[] => team.docs.filter((doc) => existsSync(join(team.home, doc)));

export function sourcesHash(team: LoadedTeam, role: string): string {
  return hash(
    PACKAGE.version,
    // This compiler too, so a reinstalled release that renders the rules differently recompiles them.
    read(fileURLToPath(import.meta.url)),
    read(join(FACTORY_ROOT, "CONSTITUTION.md")),
    read(team.file),
    read(roleNotesFile(team, role)),
    read(lessonsFile(team)),
    read(directionFile(team)),
    read(decisionsFile(team)),
    existingDocs(team).join("\n")
  );
}

const code = (text: string): string => `\`${text}\``;
const list = (items: string[]): string => items.map((item) => `- ${item}`).join("\n");

function laneText(team: Team, role: string): string {
  const lane = team.roles[role] as Lane;
  const writes = lane.write.length ? lane.write.map((rule) => (rule === "*" ? "anything in the repository" : code(rule))).join(", ") : "nothing";
  const parts = [`Writes: ${writes}.`];
  if (lane.deny.length) parts.push(`Never: ${lane.deny.map(code).join(", ")}.`);
  parts.push("Never the factory's own files: `.e9g/` (except what your lane names), `.claude/` and `.mcp.json`.");
  if (lane.readOnly) parts.push("You work in the shared checkout and change nothing in it: no checkout, switch, stash, commit or edits.");
  if (lane.branch) parts.push(`Your branch matches ${code(lane.branch)}, made from ${code(team.branch)} in your own worktree.`);
  return parts.join(" ");
}

function commandsFor(team: Team, role: string): string {
  const lines = [
    "`e9g gate [--quick]`: the team's checks (what CI runs), in the checkout you're in.",
    "`e9g env status`: whether the team's environment is up, and its URLs.",
    "`e9g lock <name> [--slots N] [--wait-min M] -- <command>`: run a command while holding one of the team's shared slots (for anything that drives the shared environment).",
  ];
  if (team.progress) lines.push(`\`e9g progress\`: where the work stands (${code(team.progress)}).`);
  if (team.finish) lines.push(`\`e9g finish\`: exits 0 only when the finish line holds (${code(team.finish)}).`);
  if (team.pages)
    lines.push("`e9g pages shots --base <url> [--out <dir>] [--path /x] [ids…]`: the page checks and screenshots against any server, recording nothing.");
  if (role === "planner") {
    lines.push(
      "`e9g merge <branch> --queue [--closes <ticket…>] [--rebased-from <approved sha>] [--no-after]`: the only way into the integration branch. It returns at once; the result wakes you.",
      '`e9g log [--label "merge 12"] "<what changed, what\'s running, what\'s next, any risk>"`: your log, stamped with the real time.',
      "`e9g env up|reset|restart|down`: the team's environment (only you run these).",
      "`e9g drain <role…>` / `e9g drain off`: stop new members of those roles starting while the environment resets.",
      "`e9g metrics [--since <ISO time>]`: what the team has cost so far."
    );
    if (team.pages) lines.push("`e9g pages run [ids…]`: check the pages on the team's app and record the results.");
  }
  if (role === "reviewer")
    lines.push(
      '`e9g verdict review <branch> approve|changes --sha <the commit you reviewed> --note "<one line>"`: record your verdict on exactly that commit. It\'s refused if the branch has moved past it; review what was added and record again. The merge queue merges only the commit you approved.'
    );
  if (role === "ux-specialist")
    lines.push(
      '`e9g verdict ux <subject> pass|issues --ref <the commit you audited> --note "<one line>"`: record your verdict on that commit (the one the app ran, `git rev-parse HEAD` in the checkout it runs from, noted before your screenshots).'
    );
  for (const owner of team.commandOwners) if (owner.roles.includes(role) && owner.reason) lines.push(`${code(owner.rule)}: ${owner.reason}`);
  return list(lines);
}

function boardText(team: Team, role: string): string {
  const severity =
    "Severity: **blocker** (the work can't be finished, data reaches the wrong person, or money could move wrongly); **major** (it works, but a reasonable person gets stuck, misled or loses work, or an accessibility failure); **minor** (polish; never holds up the finish line).";
  if (team.board.type === "github") {
    const l = team.board.label;
    return [
      `The board is GitHub issues labelled ${code(l)} on this repository (\`gh issue list --label ${l}\`). Status labels: ${["triage", "ready", "building", "review", "blocked", "question", "proposal"].map((s) => code(`${l}:${s}`)).join(", ")}; also \`kind:bug|feature|ux|test-infra\` and \`sev:blocker|major|minor\`.`,
      role === "planner"
        ? `You triage findings into tickets, keep the labels true, and the merge queue closes what a branch fixes. Every issue you open also carries ${code(PLANNER_LABEL)} (\`gh issue create --label ${l} --label ${PLANNER_LABEL} …\`; if the repository doesn't have it yet, once: \`gh label create ${PLANNER_LABEL} --color 5319E7 --description "Opened by an E9G team's planner"\`).`
        : "File what you find as a new issue labelled `" + l + "` and `" + l + ":triage`, with a severity; one finding per issue.",
      "Every issue and comment ends with a footer naming its author: `— <role> · <T3 thread id>` (everyone posts as the operator's account).",
      severity,
    ].join("\n");
  }
  return [
    `The board is files in ${code(join(team.home, ".e9g/run/board"))}. A ticket is \`<n>-<slug>.md\`; its first lines are \`status: triage|ready|building|review|blocked|question|done\`, \`kind:\`, \`sev:\` and the page or journey it belongs to, then the outcome and what done looks like.`,
    role === "planner"
      ? "You number findings into tickets, keep statuses true, and the merge queue marks done what a branch fixes."
      : "File what you find as `f-<yyyymmdd-hhmm>-<slug>.md` there, starting with `status: triage`, `kind:`, `sev:`; one finding per file.",
    severity,
  ].join("\n");
}

// Builders and testers get their own worktree from delegate_task; everyone else shares the team's checkout, which
// is T3's default.
const isolationOf = (lane: Lane): string => (lane.worktree ? "worktree" : "shared");

function teamTable(team: Team): string {
  const rows = Object.entries(team.roles)
    .filter(([role]) => role !== "planner")
    .map(
      ([role, lane]) => `| ${role} | ${code(instanceId(team, role))} | ${code(`"${isolationOf(lane)}"`)} | ${lane.limit} | ${ROLES[role]?.summary ?? ""} |`
    );
  return ["| Role | providerInstanceId | isolation | At most | Does |", "| --- | --- | --- | --- | --- |", ...rows].join("\n");
}

// What leaves the machine: the planner's pushes, if any, and a GitHub board's issues and comments.
function pushText(team: Team): string {
  const board = team.board.type === "github" ? " The board's issues and comments go to GitHub." : "";
  if (team.push)
    return `Pushes: only the planner, only ${code(`git push ${team.push.remote} ${team.push.branch}`)}${team.push.everyMin ? `, at most every ${team.push.everyMin / 60} h` : ""}.${board} Nothing else leaves this machine.`;
  return board ? `Pushes: none, so the code stays on this machine.${board} Nothing else leaves it.` : "Pushes: none. Everything stays on this machine.";
}

export function compile(team: LoadedTeam, role: string): string {
  const sections = [
    `# ${team.title}: your team's rules`,
    `<!-- compiled by E9G Factory ${PACKAGE.version} at ${localTime()}; sources ${sourcesHash(team, role)} -->`,
    articles(),
    "## This team",
    list(
      [
        `You are the **${role}**. The team's checkout is ${code(team.home)}; its integration branch is ${code(team.branch)}.`,
        team.finish
          ? `The finish line: ${code(team.finish)} exits 0, with no blocker or major ticket open.`
          : "The team has no finish command yet; the brief says what done means.",
        `Polish: ${team.polishRounds} round(s) of minor fixes per page or journey, then one last audit (Article 9).`,
        pushText(team),
        `Protected branches, never pushed or merged into by the team: ${team.protectedBranches.map(code).join(", ")}.`,
        role === "planner" && team.owner ? `The operator: ${team.owner} (Article 10).` : null,
        role === "planner" ? `Messages to the operator (team.json contact), ${contactRule(team.contact)}` : null,
      ].filter((line) => line !== null)
    ),
    role === "planner"
      ? `## Your team members\n\nStart each with \`${"mcp__t3-code__delegate_task"}\`, \`mode: "async"\`, \`model: "${team.model}"\`, and \`target.providerInstanceId\` and the top-level \`isolation\` from this table. The instance gives the member its role, its rules and its hooks. \`isolation: "worktree"\` gives a builder or tester its own checkout, made from the integration branch's commit; without it (\`"shared"\`, the default) a member works in the team's checkout, which only the reviewer, the UX specialist and the innovator do, changing nothing there. The guard refuses a start over a limit, or a builder or tester without its worktree.\n\n${teamTable(team)}`
      : null,
    `## Your lane\n\n${laneText(team, role)}`,
    `## Commands\n\n${commandsFor(team, role)}`,
    `## The board\n\n${boardText(team, role)}`,
    `## What this team never does\n\n${list([
      ...policyStates(team)
        .filter((policy) => policy.state === "deny")
        .map((policy) => policy.summary),
      ...team.never.map((rule) => rule.reason),
      "anything under Article 7 that its rules don't unlock",
    ])}${
      policyStates(team).some((policy) => policy.state === "allow" && policy.default === "deny")
        ? `\n\nUnlocked by the operator: ${policyStates(team)
            .filter((policy) => policy.state === "allow" && policy.default === "deny")
            .map((policy) => policy.summary)
            .join("; ")}.`
        : ""
    }`,
    `## Read first\n\n${list(["`CLAUDE.md` (the repository's own rules; already in your context)", ...existingDocs(team).map(code)])}`,
    readFilled(directionFile(team)) ? `## The operator's direction (.e9g/direction.md)\n\n${readFilled(directionFile(team))}` : null,
    readFilled(decisionsFile(team))
      ? `## Decisions made from it (.e9g/decisions.md)\n\nThe planner's rulings and the operator's answers, each with the direction it follows. Treat them as settled; a member who thinks one is wrong says so in its report.\n\n${readFilled(decisionsFile(team))}`
      : null,
    read(roleNotesFile(team, role)) ? `## The operator's notes for the ${role}\n\n${read(roleNotesFile(team, role))}` : null,
    read(lessonsFile(team)) ? `## Lessons the team has learned (.e9g/lessons.md)\n\n${read(lessonsFile(team))}` : null,
  ];
  return `${sections.filter(Boolean).join("\n\n")}\n`;
}

export const promptFile = (runDir: string, role: string): string => join(runDir, "prompts", `${role}.md`);

export function writePrompt(team: LoadedTeam, role: string, runDir: string): string {
  const file = promptFile(runDir, role);
  writeFileAtomic(file, compile(team, role));
  return file;
}

export function promptStale(team: LoadedTeam, role: string, runDir: string): boolean {
  const file = promptFile(runDir, role);
  if (!existsSync(file)) return true;
  const match = /sources ([0-9a-f]{16}) -->/.exec(readFileSync(file, "utf8").slice(0, 400));
  return match?.[1] !== sourcesHash(team, role);
}
