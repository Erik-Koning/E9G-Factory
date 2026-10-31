// A team as the web app sees it, in the shared MongoDB beside its task graph: its settings, which the lead publishes
// when it registers (the app has no team.json), and its state, which the lead's watchdog refreshes every run.
import type { Team } from "../config.ts";
import type { ApprovalRules } from "./model.ts";

export interface TeamSettings {
  name: string;
  title: string;
  mode: Team["mode"];
  approval: ApprovalRules;
  roles: string[];
  branch: string;
  factory: string;
  publishedAt: string;
}
export interface TeamState {
  // paused by the operator, complete (the finish line held), idle (a cycles team waiting for work), or active.
  state: "active" | "paused" | "idle" | "complete";
  // The planner's thread as T3 Code reports it (running, completed, …), or null when there's none.
  planner: string | null;
  // Members at work, by role.
  members: Record<string, number>;
  at: string;
}
export interface TeamDoc extends TeamSettings {
  status: TeamState | null;
}

export const settingsOf = (team: Team, factory: string): TeamSettings => ({
  name: team.name,
  title: team.title,
  mode: team.mode,
  approval: team.approval,
  roles: Object.keys(team.roles),
  branch: team.branch,
  factory,
  publishedAt: new Date().toISOString(),
});
