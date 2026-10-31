// The factory's own task code, over the app's MongoClient: the same store, move table and decisions as the e9g CLI.
// The app keeps no rules of its own about tasks or requests; it only reads, and writes through these.
//
// Only these modules of ../lib/tasks are imported: mongo.ts (storeOver), store.ts (update), model.ts, requests.ts,
// decide.ts, teams.ts and graph.ts. Never files.ts, ops.ts, machines.ts, migrate.ts or mongoUri.ts, and never
// openStore (the Keychain, the run folder and child processes are the CLI's).
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

const stores = new Map<string, Store>();

// A team's store, one per team for the life of the process (never closed: closing would close the shared client).
export function storeFor(team: string): Store {
  let store = stores.get(team);
  if (!store) {
    store = storeOver(mongo() as unknown as MongoClientLike, { name: team, tasks: { store: "mongo", database: config().e9gDatabase, lead: null } });
    stores.set(team, store);
  }
  return store;
}

// Every team that has published its settings (e9g register writes them; the lead's watchdog its status).
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
  if (!settings?.approval) throw new Refused(`${team} hasn't published its approval rules (e9g register publishes them)`);
  return decide(storeFor(team), id, decision, { who: OPERATOR, approval: settings.approval, text: text.trim() });
}
