// Where a team's task graph lives: one document per task, request, stakeholder and closed cycle. The file store
// (files.ts) keeps them in the team's run folder; the Mongo store (mongo.ts) in a database several machines share.
// Both replace a document only if it's still at the version the writer read, so two members claiming at once can't
// both win.
import type { Team } from "../config.ts";
import { type Cycle, type Doc, type FeatureRequest, Refused, type Stakeholder, type Task } from "./model.ts";

export interface Collection<T extends Doc> {
  all(): Promise<T[]>;
  get(id: string): Promise<T | null>;
  // Assigns the next id (tasks: 1, 2, …; requests: r1, …) and version 1.
  create(fields: Omit<T, "id" | "version">): Promise<T>;
  // The same with a given id (an imported ticket keeps its number), or null when that id is taken. Later creates
  // number after it.
  createAs(id: string, fields: Omit<T, "id" | "version">): Promise<T | null>;
  // Writes `doc` if the stored one is still at doc.version, as version + 1; resolves to what was written, or null when
  // someone changed it first (or it's gone).
  replace(doc: T): Promise<T | null>;
}

export interface Store {
  kind: "files" | "mongo";
  tasks: Collection<Task>;
  requests: Collection<FeatureRequest>;
  stakeholders: Collection<Stakeholder>;
  cycles: Collection<Cycle>;
  close(): Promise<void>;
}

export { Refused } from "./model.ts";

// Applies `change` to the document `id`, reading it again and retrying when someone else changed it first. `change`
// throws a Refused to stop.
export async function update<T extends Doc>(collection: Collection<T>, id: string, change: (doc: T) => T): Promise<T> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const doc = await collection.get(id);
    if (!doc) throw new Refused(`no ${id}`);
    const written = await collection.replace(change(doc));
    if (written) return written;
    await new Promise((done) => setTimeout(done, 20 + Math.random() * 80));
  }
  throw new Refused(`${id} kept changing while this tried to change it; try again`);
}

// The team's store: Mongo when team.json says so, otherwise files in the run folder.
export async function openStore(team: Pick<Team, "name" | "tasks">, run: string): Promise<Store> {
  if (team.tasks.store === "mongo") {
    const { mongoStore } = await import("./mongo.ts");
    return mongoStore(team);
  }
  // A file store whose graph was moved to Mongo is never written again: team.json says where it lives now.
  const { movedTo } = await import("./migrate.ts");
  const moved = movedTo(run);
  if (moved)
    throw new Refused(
      `this team's task graph moved to ${moved.to}${moved.at ? ` on ${moved.at.slice(0, 10)}` : ""} (e9g task migrate): set team.json tasks.store to "${moved.to}"`
    );
  const { fileStore } = await import("./files.ts");
  return fileStore(run, team.name);
}
