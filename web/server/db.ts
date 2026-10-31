// One MongoClient for the app, kept across hot reloads and warm serverless invocations. It holds both databases: the
// task graphs (E9G_DATABASE) and the accounts (AUTH_DATABASE).
import { type Db, MongoClient } from "mongodb";
import { config } from "./config.ts";

const cache = globalThis as typeof globalThis & { e9gWebMongo?: MongoClient };

export function mongo(): MongoClient {
  cache.e9gWebMongo ??= new MongoClient(config().mongoUri, { appName: "e9g-web", maxPoolSize: 10, serverSelectionTimeoutMS: 8000 });
  return cache.e9gWebMongo;
}

export const authDb = (): Db => mongo().db(config().authDatabase);
export const graphDb = (): Db => mongo().db(config().e9gDatabase);

// For scripts and tests: closes the client so the process can end.
export async function closeMongo(): Promise<void> {
  const client = cache.e9gWebMongo;
  delete cache.e9gWebMongo;
  await client?.close();
}
