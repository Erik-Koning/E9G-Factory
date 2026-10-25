#!/usr/bin/env node
// Live context, so no agent works from memory. Claude Code shows a hook's context in full only under about 10,000
// characters, so this stays short and the static rules live in the compiled prompt instead.
// - SessionStart, every role: who and when; recompiles the team's prompt if its sources changed (for the next
//   session) and says so. The planner also gets the members running against the limits, the team's context
//   commands (team.json "context") and its latest log entries.
// - UserPromptSubmit, planner only (every wake): the real time, members running, merge results it hasn't seen,
//   and whether the environment is draining.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { instanceId } from "../../lib/config.mjs";
import { stateDir } from "../../lib/paths.mjs";
import { promptFile, promptStale, writePrompt } from "../../lib/prompts.mjs";
import { inTeam, teamSession } from "../../lib/session.mjs";
import { runningByInstance } from "../../lib/t3.mjs";
import { localTime } from "../../lib/util.mjs";

if (!inTeam()) process.exit(0);
const input = JSON.parse(readFileSync(0, "utf8"));
const event = input.hook_event_name ?? "SessionStart";
const { home, team, run, role } = teamSession({ cwd: input.cwd, agentType: input.agent_type });
if (!team.roles[role]) process.exit(0);
if (event === "UserPromptSubmit" && role !== "planner") process.exit(0);
const state = stateDir(home);
const LIMIT = 9000;

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}\n(… cut at ${max} characters)` : text);
const runCommand = (command) => {
  try {
    return execFileSync("sh", ["-c", command], { cwd: home, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    return `(${command.split(" ").slice(0, 3).join(" ")} failed: ${String(error.message).split("\n")[0]})`;
  }
};

function slots() {
  const roles = Object.keys(team.roles).filter((r) => r !== "planner");
  const counts = runningByInstance(roles.map((r) => instanceId(team, r)));
  if (!counts) return "Members running: unknown (T3 Code's database couldn't be read).";
  return `Members running / limit: ${roles.map((r) => `${r} ${counts[instanceId(team, r)] ?? 0}/${team.roles[r].limit}`).join(", ")}.`;
}

// Merge results the queue finished since the planner last looked; each is shown once.
function merges() {
  const dir = join(state, "merges");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".seen.json"))
    .map((name) => {
      const record = JSON.parse(readFileSync(join(dir, name), "utf8"));
      renameSync(join(dir, name), join(dir, name.replace(/\.json$/, ".seen.json")));
      return `- ${record.branch}: ${record.result}${record.sha ? ` at ${record.sha}` : ""}. ${record.message ?? ""}`.trim();
    });
}

let context;
if (event === "UserPromptSubmit") {
  const finished = merges();
  const drain = join(state, "drain");
  context = [
    `Now: ${localTime()} (local). e9g log stamps this time.`,
    slots(),
    finished.length ? `Merge queue results:\n${finished.join("\n")}` : null,
    existsSync(drain) ? `Draining for an environment reset: no new ${readFileSync(drain, "utf8").trim()} until e9g drain off.` : null,
  ]
    .filter(Boolean)
    .join("\n");
} else {
  const parts = [`You are the ${role} of the ${team.title} (session ${input.session_id}, ${input.source ?? "startup"}, ${localTime()}).`];
  if (promptStale(team, role, run)) {
    writePrompt(team, role, run);
    parts.push(
      `The team's rules changed after this session's prompt was compiled. Read the current ones before you start: ${promptFile(run, role)}. Where they differ, they win.`
    );
  }
  if (role === "planner") {
    parts.push(slots());
    for (const { title, command } of team.context) parts.push(`${title}:\n${clip(runCommand(command), 2000)}`);
    const logFile = join(state, "log.md");
    const log = existsSync(logFile)
      ? readFileSync(logFile, "utf8").split("\n\n").slice(1, 5).join("\n\n")
      : "(no log yet: this is the team's first session)";
    parts.push(`Your latest log entries (e9g log; newest first):\n${clip(log, 3000)}`);
  }
  context = parts.join("\n\n");
}

process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: clip(context, LIMIT) } }));
