#!/usr/bin/env node
// Live context, so no agent works from memory. Claude Code shows a hook's context in full only under about 10,000
// characters, so this stays short and the static rules live in the compiled prompt instead.
// - SessionStart, every role: who and when; recompiles the team's prompt if its sources changed (for the next
//   session) and says so. The planner also gets how the operator is connected (e9g connect), the members running
//   against the limits, the team's context commands (team.json "context") and its latest log entries.
// - UserPromptSubmit, planner only (every wake): the real time, members running, merge results it hasn't seen,
//   whether the environment is draining, and whether the operator paused the team.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { reachSummary } from "../../lib/channels.ts";
import { instanceId } from "../../lib/config.ts";
import { stateDir } from "../../lib/paths.ts";
import { promptFile, promptStale, writePrompt } from "../../lib/prompts.ts";
import { type HookInput, inTeam, teamSession } from "../../lib/session.ts";
import { runningByInstance } from "../../lib/t3.ts";
import { localTime } from "../../lib/util.ts";

if (!inTeam()) process.exit(0);
const input = JSON.parse(readFileSync(0, "utf8")) as HookInput;
const event = input.hook_event_name ?? "SessionStart";
const { home, team, run, role } = teamSession({ cwd: input.cwd, agentType: input.agent_type });
if (!team.roles[role]) process.exit(0);
if (event === "UserPromptSubmit" && role !== "planner") process.exit(0);
const state = stateDir(home);
const LIMIT = 9000;
// While the operator has the team paused, the guard refuses new members and merges.
const paused = existsSync(join(run, "paused")) ? "The operator paused the team: start no members and merge nothing until they run e9g resume." : null;

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}\n(… cut at ${max} characters)` : text);
const runCommand = (command: string): string => {
  try {
    return execFileSync("sh", ["-c", command], { cwd: home, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    return `(${command.split(" ").slice(0, 3).join(" ")} failed: ${String((error as Error).message).split("\n")[0]})`;
  }
};

function slots() {
  const roles = Object.keys(team.roles).filter((r) => r !== "planner");
  const counts = runningByInstance(roles.map((r) => instanceId(team, r)));
  if (!counts) return "Members running: unknown (T3 Code's database couldn't be read).";
  return `Members running / limit: ${roles.map((r) => `${r} ${counts[instanceId(team, r)] ?? 0}/${team.roles[r]?.limit}`).join(", ")}.`;
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
    paused,
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
    if (paused) parts.push(paused);
    const { working, failing } = reachSummary();
    if (working.length)
      parts.push(
        `The operator is connected (${working.join("; ")}): put messages for them in ${join(run, "outbox")}, as Talking to the operator says. The watchdog delivers them, and passes on their replies.`
      );
    if (failing.length)
      parts.push(
        `Not reaching the operator now: ${failing.join("; ")}. The watchdog has told them on their Mac.${working.length ? "" : " Until it works, use Gmail if you have it."}`
      );
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
