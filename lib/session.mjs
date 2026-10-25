// Who is calling a hook or an agent-facing command: which team (its T3 instance sets E9G_TEAM, E9G_HOME_DIR and
// E9G_RUN), which role (Claude Code's agent type, "e9g:<role>") and where the team's run folder is. People's own
// Claude sessions in the same repository set none of these, so the factory never affects them.
import { resolve } from "node:path";
import { loadTeam, roleOfAgent } from "./config.mjs";
import { defaultRunDir, findHome } from "./paths.mjs";

export const inTeam = () => Boolean(process.env.E9G_TEAM);
export const inSetup = () => process.env.E9G_SETUP === "1";

export function teamSession({ cwd, agentType, strict = true } = {}) {
  const home = findHome({ cwd });
  if (!home) throw new Error("not in a team: no E9G_HOME_DIR and no .e9g/team.json above the working directory");
  const team = loadTeam(home, { strict });
  const run = process.env.E9G_RUN ? resolve(process.env.E9G_RUN) : defaultRunDir(team.name);
  return { home, team, run, role: roleFor(agentType) };
}

// The member's role comes from its T3 instance (E9G_ROLE). Claude Code's agent type only lowers it: a session whose
// agent type isn't the member's own is a subagent (Explore, or even one named e9g:planner), and a role the team
// doesn't have writes nothing and runs none of the owned commands.
export function roleFor(agentType) {
  const own = process.env.E9G_ROLE ?? "";
  if (agentType === undefined || agentType === "") return own;
  if (!own) return roleOfAgent(agentType);
  return agentType === `e9g:${own}` ? own : `subagent:${agentType}`;
}
