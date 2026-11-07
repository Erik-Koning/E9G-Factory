// The factory's own task code, over the app's MongoClient: the same store, move table and decisions as the a6g CLI.
// The app keeps no rules of its own about tasks or requests; it only reads, and writes through these.
//
// Only these modules of ../lib/tasks are imported: mongo.ts (storeOver), store.ts (update), model.ts, requests.ts,
// decide.ts, answer.ts, add.ts, teams.ts, graph.ts, controls.ts and spend.ts. Never files.ts, ops.ts, machines.ts, migrate.ts or mongoUri.ts, and never
// openStore (the Keychain, the run folder and child processes are the CLI's).
import { addTask, type TaskInput } from "../../lib/tasks/add.ts";
import { answer } from "../../lib/tasks/answer.ts";
import { budgetControl, type Control, type HoldScope, type Limits, limitsOf, pauseControl, resumeControl } from "../../lib/tasks/controls.ts";
import type { UsageDay } from "../../lib/tasks/spend.ts";
import { type Decision, decide } from "../../lib/tasks/decide.ts";
import { type FeatureRequest, OPERATOR, Refused, type Stakeholder, type Task } from "../../lib/tasks/model.ts";
import { type MongoClientLike, storeOver } from "../../lib/tasks/mongo.ts";
import { addRequest, stakeholderFor } from "../../lib/tasks/requests.ts";
import { type Store, update } from "../../lib/tasks/store.ts";
import type { TeamDoc } from "../../lib/tasks/teams.ts";
import { config } from "./config.ts";
import { graphDb, mongo } from "./db.ts";

export { Refused };
export type { Cycle, FeatureRequest, Stakeholder, Task } from "../../lib/tasks/model.ts";
export type { TeamDoc } from "../../lib/tasks/teams.ts";
export type { Control, HoldScope, HoldState, Limits } from "../../lib/tasks/controls.ts";
export { describeHold, isHoldScope, journeysUnderWay, limitsOf } from "../../lib/tasks/controls.ts";
export { spendByWork, type Spend, type UsageDay } from "../../lib/tasks/spend.ts";

const stores = new Map<string, Store>();

// A team's store, one per team for the life of the process (never closed: closing would close the shared client).
export function storeFor(team: string): Store {
  let store = stores.get(team);
  if (!store) {
    store = storeOver(mongo() as unknown as MongoClientLike, { name: team, tasks: { store: "mongo", database: config().a6gDatabase, lead: null } });
    stores.set(team, store);
  }
  return store;
}

// Every team that has published its settings (a6g register writes them; the lead's watchdog its status).
export async function allTeams(): Promise<TeamDoc[]> {
  const rows = await graphDb().collection<{ _id: string }>("teams").find({}).sort({ _id: 1 }).toArray();
  return rows.map(({ _id, ...doc }) => ({ status: null, name: _id, title: _id, ...doc }) as unknown as TeamDoc);
}

export const teamDoc = (team: string): Promise<TeamDoc | null> => storeFor(team).team();

// The person's stakeholder record on `team`: the one linked to their account, or the one with their email (made when
// new, by the factory's stakeholderFor), linked to it. Names and emails live here and in the accounts only.
export async function stakeholderOf(team: string, person: { userId: string; name: string; email: string }, role: string): Promise<Stakeholder> {
  const store = storeFor(team);
  const linked = (await store.stakeholders.all()).find((s) => s.userId === person.userId);
  if (linked) return linked;
  const found = await stakeholderFor(store, team, { name: person.name, email: person.email, role });
  if (found.userId === person.userId) return found;
  return update(store.stakeholders, found.id, (s) => ({ ...s, userId: person.userId }));
}

// The stakeholder linked to an account on `team`, without making one.
export async function linkedStakeholder(team: string, userId: string): Promise<Stakeholder | null> {
  return (await storeFor(team).stakeholders.all()).find((s) => s.userId === userId) ?? null;
}

// An account leaves a team: its stakeholder stays (the requests name it), no longer linked.
export async function unlinkStakeholder(team: string, userId: string): Promise<void> {
  const linked = await linkedStakeholder(team, userId);
  if (linked) await update(storeFor(team).stakeholders, linked.id, (s) => ({ ...s, userId: null }));
}

// A request from the web: from the person's stakeholder, by "operator" for an admin and "stakeholder" otherwise. The
// request carries ids and roles only.
export function sendRequest(
  team: string,
  { title, body, from, admin }: { title: string; body: string; from: string; admin: boolean }
): Promise<FeatureRequest> {
  return addRequest(storeFor(team), team, { title: title.trim(), body: body.trim(), from, by: admin ? OPERATOR : "stakeholder" });
}

// An admin's decision, as the operator, with the team's approval rules from its published settings.
export async function decideAsOperator(team: string, id: string, decision: Decision, text: string): Promise<Task> {
  const settings = await teamDoc(team);
  if (!settings?.approval) throw new Refused(`${team} hasn't published its approval rules (a6g register publishes them)`);
  return decide(storeFor(team), id, decision, { who: OPERATOR, approval: settings.approval, text: text.trim() });
}

// An admin's answer to what waits on them (a question, or blocked work), as the operator: a note marked as the answer,
// which the lead's watchdog passes to the planner within a minute.
export const answerAsOperator = (team: string, id: string, text: string): Promise<Task> => answer(storeFor(team), id, { who: OPERATOR, text });

// A task from the web, through the factory's addTask: an admin's as the operator (a proposal, or approved as it's
// added), anyone else's by "stakeholder", which goes to triage for the planner. Either way it records who it came from,
// by their stakeholder id, never their name (Article 8).
export function addTaskFromWeb(team: string, input: Omit<TaskInput, "from">, { admin, from }: { admin: boolean; from: string }): Promise<Task> {
  const fields: TaskInput = { ...input, title: input.title.trim(), body: input.body?.trim() ?? "", from };
  return admin ? addTask(storeFor(team), team, fields, OPERATOR) : addTask(storeFor(team), team, { ...fields, approved: false }, "stakeholder");
}

// The operator's controls on `team`, oldest first: what was asked for, and when (the lead's watchdog applies each within
// a minute, and reports where the team stands in its status).
export const controlsOf = (team: string): Promise<Control[]> => storeFor(team).controls.all();

// A pause from the web, by an admin's stakeholder id: its scope fixed against the graph as it is now (controls.ts).
export async function pauseFromWeb(team: string, ask: { scope: HoldScope; journeys: string[]; note: string; from: string }): Promise<Control> {
  const store = storeFor(team);
  // On the web the journeys are ticked, those under way to start with: none ticked is a mistake, not "the default".
  if (ask.scope === "journeys" && !ask.journeys.length) throw new Refused("Tick the journeys to finish before the team pauses.");
  const journeys = ask.scope === "journeys" ? ask.journeys : undefined;
  return store.controls.create(pauseControl(await store.tasks.all(), team, { scope: ask.scope, journeys, by: `web:${ask.from}`, note: ask.note }));
}

// A resume from the web; the note goes to the planner as the operator's feedback.
export const resumeFromWeb = (team: string, { note, from }: { note: string; from: string }): Promise<Control> =>
  storeFor(team).controls.create(resumeControl(team, `web:${from}`, note));

// What the team used, day by day and machine by machine, from `from` (YYYY-MM-DD) on (lib/usage.ts publishes it).
export const usageOf = (team: string, from: string): Promise<UsageDay[]> => storeFor(team).usage.since(from);

// A budget from the web, by an admin's stakeholder id: each limit in dollars, or null for none (all null clears it). The
// total keeps counting from when the budget began, unless `restart`.
export async function budgetFromWeb(
  team: string,
  ask: { daily: number | null; weekly: number | null; total: number | null; autoResume: boolean; restart: boolean; from: string }
): Promise<Control> {
  const store = storeFor(team);
  const current = limitsOf(await store.controls.all());
  const { daily, weekly, total } = ask;
  const limits: Limits | null =
    daily === null && weekly === null && total === null
      ? null
      : { daily, weekly, total, autoResume: ask.autoResume, since: ask.restart || !current ? new Date().toISOString() : current.since };
  return store.controls.create(budgetControl(team, `web:${ask.from}`, limits));
}
