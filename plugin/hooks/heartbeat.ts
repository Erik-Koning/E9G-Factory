#!/usr/bin/env node
// PostToolUse heartbeat for the watchdog: one small file per session, rewritten on every tool call, so "running
// but nothing has happened for an hour" can be told apart from "busy". It goes to the team's run folder
// (~/.e9g/runs/<team>/heartbeat/), which the watchdog can read. Inert outside a team; never in the agent's way.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type HookInput, inTeam, roleFor, teamSession } from "../../lib/session.ts";

if (!inTeam() || !process.env.E9G_RUN) process.exit(0);
try {
  const input = JSON.parse(readFileSync(0, "utf8")) as HookInput;
  const dir = join(resolve(process.env.E9G_RUN), "heartbeat");
  mkdirSync(dir, { recursive: true });
  // The session's real role (its instance's E9G_ROLE): a subagent typed e9g:planner in a builder isn't the planner,
  // whose heartbeats the watchdog reads.
  const role = roleFor(input.agent_type) || "main";
  writeFileSync(
    join(dir, `${role.replace(/[^\w.-]/g, "_")}-${input.session_id}.json`),
    JSON.stringify({
      role,
      sessionId: input.session_id,
      agentId: input.agent_id ?? null,
      cwd: input.cwd,
      tool: input.tool_name,
      at: new Date().toISOString(),
    })
  );
  // A member holding a claim renews its lease (at most every five minutes; lib/tasks/ops.ts), so the watchdog hands its
  // task to someone else only when it has gone quiet. The claim marks name the worktrees that hold one.
  const run = resolve(process.env.E9G_RUN);
  const marks = join(run, "claims");
  const cwd = resolve(input.cwd ?? process.cwd());
  if (existsSync(marks))
    for (const name of readdirSync(marks)) {
      const { worktree } = JSON.parse(readFileSync(join(marks, name), "utf8")) as { worktree?: string };
      if (!worktree || !(cwd === worktree || cwd.startsWith(`${worktree}/`))) continue;
      const { team } = teamSession({ cwd: input.cwd, agentType: input.agent_type });
      const { leaseMinutes, renewClaims } = await import("../../lib/tasks/ops.ts");
      const { openStore } = await import("../../lib/tasks/store.ts");
      await renewClaims(() => openStore(team, run), run, worktree, leaseMinutes(team.watchdog.stuckAfterMin));
      break;
    }
} catch {}
process.exit(0);
