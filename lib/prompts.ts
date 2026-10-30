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
    existingDocs(team).join("\n"),
    // The rules name CLAUDE.md only when the repository has one.
    String(existsSync(join(team.home, "CLAUDE.md")))
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
  if (team.finish && team.mode !== "cycles") lines.push(`\`e9g finish\`: exits 0 only when the finish line holds (${code(team.finish)}).`);
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
    if (team.push?.pullRequest)
      lines.push(
        `\`e9g pr --title "<what it holds>" --body-file <file>\`: after a push, open the pull request from ${code(team.push.branch)} into ${code(team.push.pullRequest)}, or update the open one. Write the body to a file in \`.e9g/run/scratch/\`: what's in it since the operator last merged, how to see it, the product calls you made, and what's left. It's labelled and signed for you. The first time, watch it from your thread (\`mcp__t3-code__watch_pull_request\` with its URL): T3 Code wakes you on the operator's comments and reviews, failed checks and conflicts.`
      );
  }
  if (team.board.type === "tasks") {
    lines.push("`e9g task list|show|note|graph`: the task graph (see The board).");
    if (role === "planner")
      lines.push(
        '`e9g task add "<title>" [--kind] [--sev] [--body-file] [--parent <journey>] [--after <ids>] [--files <paths>] [--request <rN>]`, `edit <id> [--sev] [--area] [--files] …`, `score`, `status <id> <status> [--reason]`: shape, score and move tasks. `e9g task approve <id> [--note]` approves a finding another member filed, when your rules let you. `e9g task release <id>` frees a claim whose member is gone.',
        "`e9g request list|show|note|reject`: stakeholders' feature requests (promote one with `e9g task add … --request <id>`)."
      );
    if (role === "planner" && team.mode === "cycles")
      lines.push("`e9g cycle close --report-file <file>`: close the cycle; the report goes to the operator.");
    if ((role === "planner" || role === "reviewer") && team.tasks.store === "mongo" && team.tasks.lead)
      lines.push("`e9g task fetch <id>`: a task's branch as a worker pushed it, before its review (the verdict and the merge fetch it too).");
    if (role === "builder" || role === "tester")
      lines.push('`e9g task claim [<id>]`, `e9g task submit <id>`, `e9g task release <id> [--blocked "…"]`: take, hand in or hand back your task.');
    if (role === "approver")
      lines.push(
        "`e9g task approve|reject|research|escalate <id>`: your verdicts on proposals. `e9g request show|note <id>`: what a stakeholder asked for, and what you found."
      );
    if (role === "reviewer" || role === "tester" || role === "builder")
      lines.push(
        "`e9g blast [<sha>] [--json]`: what a change touches (run it in the checkout of that commit): importers, related files, their tests, UI, critical paths."
      );
  }
  if (role === "reviewer")
    lines.push(
      '`e9g verdict review <branch> approve|changes --sha <the commit you reviewed> --note "<one line>"`: record your verdict on exactly that commit. An approval also takes `--risk low|medium|high`, how much the change could break (a high-risk change merges only with its tests), and `--shots "<what you looked at>"` when you looked. It\'s refused if the branch has moved past it; review what was added and record again. The merge queue merges only the commit you approved.'
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
  const intro =
    "The board is the team's task graph (`e9g task`): one task per piece of work, each with a status and a history of who moved it. Statuses: `triage` (a finding), `proposed` (scored work waiting for approval), `researching`, `approved` (ready to claim), `building` (claimed by a builder or tester, on a machine, with a lease its heartbeats renew), `review`, `done`, `blocked`, `question`, `rejected`. A journey whose tasks are all done is due its verification (`e9g task list` says so). `e9g task list` shows what's open (`--all` everything), `e9g task show <id>` one task.";
  const finding =
    'File each finding as `e9g task add "<what\'s wrong, in a few words>" --kind bug|ux|test-infra|feature --sev blocker|major|minor --body-file <file>` (steps, what happened, what should, the screenshot\'s path); it goes to triage. Search `e9g task list --all` first so you don\'t repeat one, and add to an existing task with `e9g task note <id> "…"`.';
  const byRole: Record<string, string> = {
    planner: `You own it. Triage findings: give each its severity, area and files (\`e9g task edit <id> --sev … --area … --files …\`), then approve it (\`e9g task approve <id>\`) when your rules let you approve the findings other members file, or \`e9g task status <id> proposed\` for the approver (or rejected or question, with \`--reason\`). Shape work (\`e9g task add\`, \`edit\`: a journey as \`--kind journey\` with its tasks naming it as \`--parent\`, dependencies as \`--after\`, where it lands as \`--files\`), and score every proposal but a journey, which only groups tasks (\`e9g task score\`). ${approvalText(team)} The merge queue marks what it merges done; you never approve your own proposals or mark code done.`,
    builder: `Take your task with \`e9g task claim\` (the next approved one, or the one your brief names), hand it in with \`e9g task submit <id>\` once it's committed and the gate passes, or hand it back with \`e9g task release <id> --blocked "<why>"\`. When what you change could break much (money, sign-in, data, code many files import, a flow people depend on), its tests come in the same branch: the reviewer judges the risk, and a high-risk change merges only with them. ${finding}`,
    tester: `Take your task with \`e9g task claim\` (the next approved test work, or the one your brief names), hand it in with \`e9g task submit <id>\`, or back with \`e9g task release <id> --blocked "<why>"\`. ${finding}`,
    approver: `You decide on proposals: \`e9g task approve <id> [--note]\`, \`reject <id> --reason\`, \`research <id> --note "<what to find out>"\`, or \`escalate <id> --reason\` (it goes to the operator). ${approvalText(team)}`,
  };
  return [intro, byRole[role] ?? finding, severity].join("\n");
}

// Who approves the planner's proposals (team.json approval).
function approvalText(team: Team): string {
  const findings =
    team.approval.findings === "planner"
      ? ` The planner approves the bug, UX and test findings other members file, up to size ${team.approval.maxSize}.`
      : "";
  return proposalsText(team) + findings;
}
function proposalsText(team: Team): string {
  if (team.approval.mode === "operator") return "Proposals wait for the operator to approve them (team.json approval).";
  if (team.approval.mode === "full")
    return "The approver approves proposals of any size (team.json approval: full); privacy, policy unlocks, promotion and rule changes stay the operator's.";
  return `The approver approves proposals up to size ${team.approval.maxSize}; anything larger, or a change of scope, is escalated to the operator (team.json approval). A journey only groups tasks: nobody approves it, only its tasks.`;
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
  if (team.push) {
    const pull = team.push.pullRequest
      ? ` After a push, the planner's ${code("e9g pr")} opens the pull request from ${code(team.push.branch)} into ${code(team.push.pullRequest)}, or updates the open one; the operator merges it.`
      : "";
    return `Pushes: only the planner, only ${code(`git push ${team.push.remote} ${team.push.branch}`)}${team.push.everyMin ? `, at most every ${team.push.everyMin / 60} h` : ""}.${pull}${board} Nothing else leaves this machine.`;
  }
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
        team.mode === "cycles"
          ? null
          : team.finish
            ? `The finish line: ${code(team.finish)} exits 0, with no blocker or major task open.`
            : "The team has no finish command yet; the brief says what done means.",
        `Polish: ${team.polishRounds} round(s) of minor fixes per page or journey, then one last audit (Article 9).`,
        team.mode === "cycles"
          ? "The team works in cycles (team.json mode): it keeps building toward the direction, cycle after cycle, with no finish line to stop at (Article 1)."
          : null,
        role === "planner" && team.board.type === "tasks"
          ? `Priority weights (team.json priorities): ${Object.entries(team.priorities.weights)
              .map(([d, w]) => `${d} ${w}`)
              .join(", ")}.`
          : null,
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
    `## Read first\n\n${list([
      ...(existsSync(join(team.home, "CLAUDE.md")) ? ["`CLAUDE.md` (the repository's own rules; already in your context)"] : []),
      ...existingDocs(team).map(code),
    ])}`,
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
