// Before the end-to-end tests: a database, seeded by seed.ts, and the built app (next start) against it, with emails to
// its console (MAIL_LOG), which it writes to a log the tests read sign-in links from. Nothing here touches ~/.a6g or
// ~/.t3.
//
// The database is a MongoDB replica set of one on this machine (mongodb-memory-server, from the mongod binary already
// cached, so nothing downloads), unless a real cluster is named: E2E_MONGODB_URI, or DB_USER, DB_PASSWORD and DB_HOST
// as the repository's .env has them (npm run test:e2e:atlas). There the tests use databases of their own, a6g_e2e and
// a6g_web_e2e (E2E_A6G_DATABASE, E2E_AUTH_DATABASE: names ending _e2e, nothing else), emptied before each run and
// left after it, with the run's admin in web/.env.e2e (gitignored) to sign in as.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { MongoClient } from "mongodb";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import { ORIGIN_SECRET } from "../../playwright.config.ts";

const WEB = resolve(import.meta.dirname, "../..");
export const PORT = Number(process.env.E2E_PORT ?? 3100);

// A real cluster to test against, when one is named; its databases end in _e2e, since every run empties them.
function cluster(): { uri: string; host: string; a6g: string; auth: string } | null {
  const { E2E_MONGODB_URI, DB_USER, DB_PASSWORD, DB_HOST } = process.env;
  const uri =
    E2E_MONGODB_URI ||
    (DB_USER && DB_PASSWORD && DB_HOST
      ? `mongodb+srv://${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_PASSWORD)}@${DB_HOST}/?retryWrites=true&w=majority&appName=a6g-web-e2e`
      : "");
  if (!uri) return null;
  const a6g = process.env.E2E_A6G_DATABASE || "a6g_e2e";
  const auth = process.env.E2E_AUTH_DATABASE || "a6g_web_e2e";
  for (const name of [a6g, auth])
    if (!/^[\w-]+_e2e$/.test(name)) throw new Error(`${name}: the tests empty their databases, so the names must end in _e2e`);
  if (a6g === auth) throw new Error("the task graphs' and the accounts' databases must differ");
  return { uri, host: uri.replace(/^[^@]*@/, "").replace(/[/?].*$/, ""), a6g, auth };
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync(join(WEB, ".next", "BUILD_ID"))) throw new Error("build the app first: npm run build (npm run test:e2e does)");
  const dir = mkdtempSync(join(tmpdir(), "a6g-web-e2e-"));
  const real = cluster();
  let mongo: MongoMemoryReplSet | null = null;
  if (real) {
    // Empty the tests' own databases first: each run starts from the same world.
    const client = await new MongoClient(real.uri, { serverSelectionTimeoutMS: 15_000 }).connect();
    for (const name of [real.a6g, real.auth]) await client.db(name).dropDatabase();
    await client.close();
    console.info(`e2e: against ${real.host}, databases ${real.a6g} and ${real.auth} (emptied)`);
  } else {
    const binary = process.env.MONGOMS_SYSTEM_BINARY ?? join(homedir(), ".cache/mongodb-binaries/mongod-arm64-darwin-8.2.6");
    if (!existsSync(binary)) throw new Error(`no mongod at ${binary}: set MONGOMS_SYSTEM_BINARY to a cached mongod binary`);
    mongo = await MongoMemoryReplSet.create({
      binary: { systemBinary: binary, version: "8.2.6" },
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
  }
  const env = {
    MONGODB_URI: real ? real.uri : (mongo?.getUri() ?? ""),
    A6G_DATABASE: real ? real.a6g : "a6g",
    AUTH_DATABASE: real ? real.auth : "a6g_web",
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64"),
    BETTER_AUTH_URL: `http://localhost:${PORT}`,
    MAIL_LOG: "1",
    // The notifier stays off in the server: the tests run it themselves, when they choose (app.spec.ts).
    NOTIFY_EVERY_SECONDS: "0",
    // As behind CloudFront: the viewer's address in one header, trusted with the CDN's secret.
    CLIENT_IP_HEADER: "x-a6g-viewer-ip",
    ORIGIN_SECRET,
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
  writeFileSync(
    state,
    JSON.stringify({
      ...world,
      mongoUri: env.MONGODB_URI,
      a6gDatabase: env.A6G_DATABASE,
      authDatabase: env.AUTH_DATABASE,
      log,
      baseURL: env.BETTER_AUTH_URL,
      secret: env.BETTER_AUTH_SECRET,
    })
  );
  process.env.E2E_STATE = state;
  if (real) {
    // The run's admin, to sign in as afterwards (npm run dev against the same databases; web/.env* is gitignored).
    writeFileSync(
      join(WEB, ".env.e2e"),
      [
        `# The last end-to-end run's world on ${real.host}, made ${new Date().toISOString()}; made again by every run.`,
        `# Its databases: ${real.a6g} (task graphs) and ${real.auth} (accounts). Sign-ins come from 198.51.100.7 in the tests;`,
        "# from anywhere else the admin confirms the address by email (printed to the console, with MAIL_LOG=1).",
        `A6G_DATABASE=${real.a6g}`,
        `AUTH_DATABASE=${real.auth}`,
        `BETTER_AUTH_SECRET=${env.BETTER_AUTH_SECRET}`,
        `E2E_ADMIN_EMAIL=${world.admin.email}`,
        `E2E_ADMIN_PASSWORD=${world.admin.password}`,
        `E2E_ADMIN_TOTP_URI=${world.admin.totpURI}`,
        "# The tests use the first backup code; these are the nine left.",
        `E2E_ADMIN_BACKUP_CODES=${world.admin.backupCodes.slice(1).join(",")}`,
        "",
      ].join("\n"),
      { mode: 0o600 }
    );
  }

  const stop = async (): Promise<void> => {
    server.kill("SIGTERM");
    await mongo?.stop();
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    await waitFor(`${env.BETTER_AUTH_URL}/api/health`, server);
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
