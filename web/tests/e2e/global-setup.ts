// Before the end-to-end tests: a MongoDB replica set of one on this machine (mongodb-memory-server, from the mongod
// binary already cached, so nothing downloads), seeded by seed.ts, and the built app (next start) against it, with
// emails to its console (MAIL_LOG), which it writes to a log the tests read sign-in links from. Nothing here touches
// a real database, ~/.e9g or ~/.t3.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";

const WEB = resolve(import.meta.dirname, "../..");
export const PORT = Number(process.env.E2E_PORT ?? 3100);

export default async function globalSetup(): Promise<() => Promise<void>> {
  const binary = process.env.MONGOMS_SYSTEM_BINARY ?? join(homedir(), ".cache/mongodb-binaries/mongod-arm64-darwin-8.2.6");
  if (!existsSync(binary)) throw new Error(`no mongod at ${binary}: set MONGOMS_SYSTEM_BINARY to a cached mongod binary`);
  if (!existsSync(join(WEB, ".next", "BUILD_ID"))) throw new Error("build the app first: npm run build (npm run test:e2e does)");
  const dir = mkdtempSync(join(tmpdir(), "e9g-web-e2e-"));
  const mongo = await MongoMemoryReplSet.create({
    binary: { systemBinary: binary, version: "8.2.6" },
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  const env = {
    MONGODB_URI: mongo.getUri(),
    E9G_DATABASE: "e9g",
    AUTH_DATABASE: "e9g_web",
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64"),
    BETTER_AUTH_URL: `http://localhost:${PORT}`,
    MAIL_LOG: "1",
  };
  Object.assign(process.env, env);

  // The world, by the factory's functions and the app's own code.
  const { seed } = await import("./seed.ts");
  const { closeMongo } = await import("../../server/db.ts");
  const world = await seed();
  await closeMongo();

  const log = join(dir, "server.log");
  const out = openSync(log, "a");
  const server: ChildProcess = spawn(process.execPath, [join(WEB, "node_modules/next/dist/bin/next"), "start", "-p", String(PORT)], {
    cwd: WEB,
    env: { ...process.env, ...env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", out, out],
  });
  const state = join(dir, "state.json");
  writeFileSync(state, JSON.stringify({ ...world, mongoUri: env.MONGODB_URI, log, baseURL: env.BETTER_AUTH_URL, secret: env.BETTER_AUTH_SECRET }));
  process.env.E2E_STATE = state;

  const stop = async (): Promise<void> => {
    server.kill("SIGTERM");
    await mongo.stop();
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    await waitFor(`${env.BETTER_AUTH_URL}/sign-in`, server);
  } catch (error) {
    await stop();
    throw error;
  }
  return stop;
}

async function waitFor(url: string, server: ChildProcess): Promise<void> {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    if (server.exitCode !== null) throw new Error(`next start exited (${server.exitCode})`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`${url} didn't answer within a minute`);
}
