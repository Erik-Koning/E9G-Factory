// Who is calling a hook or an agent-facing command: which team (its T3 instance sets E9G_TEAM, E9G_HOME_DIR and
// E9G_RUN), which role (Claude Code's agent type, "e9g:<role>") and where the team's run folder is. People's own
// Claude sessions in the same repository set none of these, so the factory never affects them.
import { resolve } from "node:path";
import { type LoadedTeam, loadTeam, roleOfAgent } from "./config.ts";
import { defaultRunDir, findHome } from "./paths.ts";

// What Claude Code sends a hook on stdin (the fields the factory's hooks read).
export interface HookInput {
  session_id?: string;
  hook_event_name?: string;
  transcript_path?: string;
  cwd?: string;
  agent_type?: string;
  agent_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  stop_hook_active?: boolean;
  prompt?: string;
  source?: string;
}

export const inTeam = (): boolean => Boolean(process.env.E9G_TEAM);
export const inSetup = (): boolean => process.env.E9G_SETUP === "1";

export interface TeamSession {
  home: string;
  team: LoadedTeam;
  run: string;
  role: string;
}

export function teamSession({
  cwd,
  team: name,
  agentType,
  strict = true,
}: { cwd?: string | undefined; team?: string | undefined; agentType?: string | undefined; strict?: boolean } = {}): TeamSession {
  const home = findHome({ ...(cwd === undefined ? {} : { cwd }), team: name });
  if (!home) throw new Error("not in a team: no E9G_HOME_DIR and no .e9g/team.json above the working directory");
  const team = loadTeam(home, { strict });
  const run = process.env.E9G_RUN ? resolve(process.env.E9G_RUN) : defaultRunDir(team.name);
  return { home, team, run, role: roleFor(agentType) };
}

// The member's role comes from its T3 instance (E9G_ROLE). Claude Code's agent type only lowers it: a session whose
// agent type isn't the member's own is a subagent (Explore, or even one named e9g:planner), and a role the team
// doesn't have writes nothing and runs none of the owned commands.
export function roleFor(agentType: string | undefined): string {
  const own = process.env.E9G_ROLE ?? "";
  if (agentType === undefined || agentType === "") return own;
  if (!own) return roleOfAgent(agentType);
  return agentType === `e9g:${own}` ? own : `subagent:${agentType}`;
}

// In setup the session is the setup agent's (agent type e9g:setup, or none); its own subagents write nothing.
export const setupRole = (agentType: string | undefined): string =>
  agentType === undefined || agentType === "" || agentType === "e9g:setup" ? "setup" : `subagent:${agentType}`;
