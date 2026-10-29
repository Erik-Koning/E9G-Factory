// The task graph in MongoDB, for a team that runs on several machines (team.json tasks.store "mongo"). Each machine
// connects with `e9g connect mongo`, which keeps the connection string in the Keychain; agents never see it. One
// document per task, request, stakeholder and cycle, keyed "<team>:<id>", with a counter per collection. The driver
// (the optional mongodb package) loads only here, and only the few calls below are used, so tests run on a fake.
import type { Team } from "../config.ts";
import { forgetSecret, hasSecret, readSecret, storeSecret } from "../keychain.ts";
import type { Doc } from "./model.ts";
import type { Collection, Store } from "./store.ts";

export const MONGO_SERVICE = "e9g-mongo";
export const MONGO_ACCOUNT = "uri";
// The connection string holds its password and characters the Keychain item's text can't take as it is, so it's kept
// base64url-encoded.
export const MONGO_URI = /^mongodb(\+srv)?:\/\/\S+$/;
export const storeUri = (uri: string): boolean =>
  storeSecret(MONGO_SERVICE, MONGO_ACCOUNT, "E9G Factory: MongoDB", Buffer.from(uri).toString("base64url"));
export function readUri(): string | null {
  const stored = readSecret(MONGO_SERVICE, MONGO_ACCOUNT);
  return stored ? Buffer.from(stored, "base64url").toString("utf8") : null;
}
export const hasUri = (): boolean => hasSecret(MONGO_SERVICE, MONGO_ACCOUNT);
export const forgetUri = (): void => forgetSecret(MONGO_SERVICE, MONGO_ACCOUNT);
// Where the connection string goes, without its password, for messages.
// Everything up to the last @ before the host is the user and password, however malformed.
export const shownUri = (uri: string): string => {
  const [scheme, rest = ""] = uri.split("://", 2);
  const host = rest.slice(rest.lastIndexOf("@") + 1).replace(/[?#].*$/, "");
  return `${scheme}://${rest.includes("@") ? "…@" : ""}${host}`;
};

// The parts of the driver the store uses.
export interface MongoCollectionLike {
  findOne(filter: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  find(filter: Record<string, unknown>): { toArray(): Promise<Record<string, unknown>[]> };
  insertOne(doc: Record<string, unknown>): Promise<unknown>;
  replaceOne(filter: Record<string, unknown>, doc: Record<string, unknown>): Promise<{ matchedCount: number }>;
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: { upsert: boolean; returnDocument: "after" }
  ): Promise<Record<string, unknown> | null>;
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>, options?: { upsert: boolean }): Promise<unknown>;
  createIndex(keys: Record<string, number>): Promise<unknown>;
}
export interface MongoClientLike {
  db(name: string): { collection(name: string): MongoCollectionLike };
  close(): Promise<void>;
}

const PREFIX = { tasks: "", requests: "r", stakeholders: "s", cycles: "c" } as const;
const duplicate = (error: unknown): boolean => (error as { code?: number })?.code === 11000;

function collection<T extends Doc>(db: ReturnType<MongoClientLike["db"]>, team: string, name: keyof typeof PREFIX): Collection<T> {
  const docs = db.collection(name);
  const counters = db.collection("counters");
  const prefix = PREFIX[name];
  const key = (id: string) => `${team}:${id}`;
  const counter = `${team}:${name}`;
  const named = new RegExp(`^${prefix}(0|[1-9]\\d*)$`);
  const out = (row: Record<string, unknown> | null): T | null => {
    if (!row) return null;
    const { _id: _ignored, ...doc } = row;
    return doc as unknown as T;
  };
  const next = async (): Promise<number> => {
    const row = await counters.findOneAndUpdate({ _id: counter }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: "after" });
    return Number(row?.seq ?? 1);
  };
  return {
    async all() {
      const rows = await docs.find({ team }).toArray();
      return rows.flatMap((row) => out(row) ?? []).sort((a, b) => Number(named.exec(a.id)?.[1] ?? 0) - Number(named.exec(b.id)?.[1] ?? 0));
    },
    async get(id) {
      return named.test(id) ? out(await docs.findOne({ _id: key(id) })) : null;
    },
    async create(fields) {
      // A number an imported ticket already took (createAs) is skipped.
      for (let attempt = 0; attempt < 50; attempt++) {
        let id: string;
        try {
          id = `${prefix}${await next()}`;
        } catch (error) {
          // Two first upserts of the counter at once: one of them loses, and tries again.
          if (duplicate(error)) continue;
          throw error;
        }
        const doc = { ...fields, team, id, version: 1 } as unknown as T;
        try {
          await docs.insertOne({ _id: key(id), ...(doc as unknown as Record<string, unknown>) });
          return doc;
        } catch (error) {
          if (!duplicate(error)) throw error;
        }
      }
      throw new Error(`couldn't find a free ${name} id in Mongo`);
    },
    async createAs(id, fields) {
      const match = named.exec(id);
      if (!match) return null;
      const doc = { ...fields, team, id, version: 1 } as unknown as T;
      try {
        await docs.insertOne({ _id: key(id), ...(doc as unknown as Record<string, unknown>) });
      } catch (error) {
        if (duplicate(error)) return null;
        throw error;
      }
      await counters.updateOne({ _id: counter }, { $max: { seq: Number(match[1]) } }, { upsert: true });
      return doc;
    },
    async replace(doc) {
      const written = { ...doc, version: doc.version + 1 };
      const result = await docs.replaceOne(
        { _id: key(doc.id), version: doc.version },
        { _id: key(doc.id), ...(written as unknown as Record<string, unknown>) }
      );
      return result.matchedCount === 1 ? written : null;
    },
  };
}

// The store over a connected client (tests pass a fake one).
export function storeOver(client: MongoClientLike, team: Pick<Team, "name" | "tasks">): Store {
  const db = client.db(team.tasks.database);
  for (const name of Object.keys(PREFIX))
    void db
      .collection(name)
      .createIndex({ team: 1, status: 1 })
      .catch(() => {});
  return {
    kind: "mongo",
    tasks: collection(db, team.name, "tasks"),
    requests: collection(db, team.name, "requests"),
    stakeholders: collection(db, team.name, "stakeholders"),
    cycles: collection(db, team.name, "cycles"),
    close: () => client.close(),
  };
}

// The driver, from the factory's own node_modules. A variable name keeps tsc from needing its types.
export async function driver(): Promise<{
  MongoClient: new (uri: string, options?: Record<string, unknown>) => MongoClientLike & { connect(): Promise<unknown> };
}> {
  const name = "mongodb";
  try {
    return (await import(name)) as never;
  } catch {
    throw new Error("the mongodb package isn't installed with this factory version; run npm install in the factory's checkout and e9g self-install again");
  }
}

export async function mongoStore(team: Pick<Team, "name" | "tasks">, uri = readUri()): Promise<Store> {
  if (!uri) throw new Error("this team's tasks are in Mongo, and this machine isn't connected: run e9g connect mongo");
  const { MongoClient } = await driver();
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, appName: "e9g" });
  await client.connect();
  return storeOver(client, team);
}
