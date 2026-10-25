// The text each agent works under, besides its role prompt (plugin/agents/<role>.md): the constitution's articles,
// the team's rules rendered from team.json, the operator's notes for the role and the planner's lessons. Compiled
// into ~/.e9g/runs/<team>/prompts/<role>.md, which T3 Code appends to the agent's system prompt
// (--append-system-prompt-file). Nothing here is written by hand, so the prose can't disagree with the rules the
// guard enforces. A prompt records the hash of its sources; the session-start hook recompiles a stale one.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { instanceId, ROLES } from "./config.mjs";
import { FACTORY_ROOT, PACKAGE } from "./paths.mjs";
import { policyStates } from "./policies.mjs";
import { hash, localTime, writeFileAtomic } from "./util.mjs";

const read = (path) => (existsSync(path) ? readFileSync(path, "utf8").trim() : "");

export function articles() {
  const text = read(join(FACTORY_ROOT, "CONSTITUTION.md"));
  const match = /<!-- e9g:articles:start -->([\s\S]*?)<!-- e9g:articles:end -->/.exec(text);
  if (!match) throw new Error("CONSTITUTION.md has no articles section (<!-- e9g:articles:start --> … end)");
  return match[1].trim();
}

const roleNotesFile = (team, role) => join(team.home, ".e9g", "roles", `${role}.md`);
const lessonsFile = (team) => join(team.home, ".e9g", "lessons.md");

export function sourcesHash(team, role) {
  return hash(PACKAGE.version, read(join(FACTORY_ROOT, "CONSTITUTION.md")), read(team.file), read(roleNotesFile(team, role)), read(lessonsFile(team)));
}

const code = (text) => `\`${text}\``;
const list = (items) => items.map((item) => `- ${item}`).join("\n");

function laneText(team, role) {
  const lane = team.roles[role];
  const writes = lane.write.length ? lane.write.map((rule) => (rule === "*" ? "anything in the repository" : code(rule))).join(", ") : "nothing";
  const parts = [`Writes: ${writes}.`];
  if (lane.deny.length) parts.push(`Never: ${lane.deny.map(code).join(", ")}.`);
  parts.push("Never the factory's own files: `.e9g/` (except what your lane names), `.claude/settings*.json`, `.claude/hooks/`, `.claude/agents/`.");
  if (lane.readOnly) parts.push("You work in the shared checkout and change nothing in it: no checkout, switch, stash, commit or edits.");
  if (lane.branch) parts.push(`Your branch matches ${code(lane.branch)}, made from ${code(team.branch)} in your own worktree.`);
  return parts.join(" ");
}

function commandsFor(team, role) {
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
    lines.push('`e9g verdict review <branch> approve|changes --note "<one line>"`: record your verdict on the branch\'s current commit.');
  if (role === "ux-specialist") lines.push('`e9g verdict ux <subject> pass|issues --note "<one line>"`: record your verdict on what you audited.');
  for (const owner of team.commandOwners) if (owner.roles.includes(role) && owner.reason) lines.push(`${code(owner.rule)}: ${owner.reason}`);
  return list(lines);
}

function boardText(team, role) {
  const severity =
    "Severity: **blocker** (the work can't be finished, data reaches the wrong person, or money could move wrongly); **major** (it works, but a reasonable person gets stuck, misled or loses work, or an accessibility failure); **minor** (polish; never holds up the finish line).";
  if (team.board.type === "github") {
    const l = team.board.label;
    return [
      `The board is GitHub issues labelled ${code(l)} on this repository (\`gh issue list --label ${l}\`). Status labels: ${["triage", "ready", "building", "review", "blocked", "question", "proposal"].map((s) => code(`${l}:${s}`)).join(", ")}; also \`kind:bug|feature|ux|test-infra\` and \`sev:blocker|major|minor\`.`,
      role === "planner"
        ? "You triage findings into tickets, keep the labels true, and the merge queue closes what a branch fixes."
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

function teamTable(team) {
  const rows = Object.entries(team.roles)
    .filter(([role]) => role !== "planner")
    .map(([role, lane]) => `| ${role} | ${code(instanceId(team, role))} | ${lane.limit} | ${ROLES[role].summary} |`);
  return ["| Role | providerInstanceId | At most | Does |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

export function compile(team, role) {
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
        team.push
          ? `Pushes: only the planner, only ${code(`git push ${team.push.remote} ${team.push.branch}`)}${team.push.everyMin ? `, at most every ${team.push.everyMin / 60} h` : ""}. Nothing else leaves this machine.`
          : "Pushes: none. Everything stays on this machine.",
        `Protected branches, never pushed or merged into by the team: ${team.protectedBranches.map(code).join(", ")}.`,
        role === "planner" && team.owner ? `The operator: ${team.owner} (Article 10).` : null,
      ].filter(Boolean)
    ),
    role === "planner"
      ? `## Your team members\n\nStart each with \`${"mcp__t3-code__delegate_task"}\`, \`mode: "async"\`, \`model: "${team.model}"\`, and \`target.providerInstanceId\` from this table; the instance gives the member its role, its rules and its hooks. The guard refuses a start over a limit.\n\n${teamTable(team)}`
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
    `## Read first\n\n${list(["`CLAUDE.md` (the repository's own rules; already in your context)", ...team.docs.filter((doc) => existsSync(join(team.home, doc))).map(code)])}`,
    read(roleNotesFile(team, role)) ? `## The operator's notes for the ${role}\n\n${read(roleNotesFile(team, role))}` : null,
    read(lessonsFile(team)) ? `## Lessons the team has learned (.e9g/lessons.md)\n\n${read(lessonsFile(team))}` : null,
  ];
  return `${sections.filter(Boolean).join("\n\n")}\n`;
}

export const promptFile = (runDir, role) => join(runDir, "prompts", `${role}.md`);

export function writePrompt(team, role, runDir) {
  const file = promptFile(runDir, role);
  writeFileAtomic(file, compile(team, role));
  return file;
}

export function promptStale(team, role, runDir) {
  const file = promptFile(runDir, role);
  if (!existsSync(file)) return true;
  const match = /sources ([0-9a-f]{16}) -->/.exec(readFileSync(file, "utf8").slice(0, 400));
  return match?.[1] !== sourcesHash(team, role);
}
