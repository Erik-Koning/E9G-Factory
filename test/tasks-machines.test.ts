import { baseTeam, commit, e9g, fakeKeychain, git, makeRepo, tmp, write } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { RawTeam } from "../lib/config.ts";
import { normalize } from "../lib/config.ts";
import { fileStore } from "../lib/tasks/files.ts";
import {
  branchRef,
  integrationDiverged,
  isLead,
  multiMachine,
  prepareBranch,
  pushIntegration,
  pushTaskBranch,
  refreshCheckout,
} from "../lib/tasks/machines.ts";
import { newTask, type Task, withEvent } from "../lib/tasks/model.ts";
import { keyHash } from "../lib/commands/request.ts";
import { markMoved, migrate } from "../lib/tasks/migrate.ts";
import { openStore, update } from "../lib/tasks/store.ts";
import { type MongoClientLike, type MongoCollectionLike, storeOver } from "../lib/tasks/mongo.ts";

const team = (overrides: RawTeam = {}) =>
  baseTeam({ roles: { planner: {}, builder: { limit: 2 }, reviewer: { limit: 1 }, approver: { limit: 1 } }, ...overrides });

function setup(raw: RawTeam = team()) {
  const home = makeRepo(raw);
  const run = tmp("e9g-run-");
  const as = (role: string | null, cwd = home, env: NodeJS.ProcessEnv = {}) => ({
    cwd,
    env: role ? { E9G_HOME_DIR: home, E9G_TEAM: "fixture", E9G_ROLE: role, E9G_RUN: run, ...env } : { E9G_RUN: run, ...env },
  });
  return { home, run, as, store: () => fileStore(run, "fixture") };
}

describe("feature requests", () => {
  test("stakeholders' names stay with the operator; the planner promotes or rejects", async () => {
    const { as, store } = setup();
    const added = await e9g(
      [
        "request",
        "add",
        "Export to PDF",
        "--body",
        "Our accountant needs a PDF.",
        "--name",
        "Dana Ruiz",
        "--email",
        "dana@example.com",
        "--role",
        "customer",
      ],
      as(null)
    );
    assert.equal(added.code, 0, added.out);
    await e9g(["request", "add", "Dark mode", "--name", "Dana Ruiz", "--email", "DANA@example.com", "--role", "customer"], as(null));
    assert.equal((await store().stakeholders.all()).length, 1, "the same person, by address");
    assert.match((await e9g(["request", "list"], as(null))).out, /Dana Ruiz <dana@example.com>/);
    const seen = await e9g(["request", "list", "--json"], as("planner"));
    assert.doesNotMatch(seen.out, /Dana|dana@/, "agents see a stakeholder's id and role only");
    assert.match(seen.out, /"fromRole": "customer"/);
    assert.equal((await e9g(["request", "stakeholders"], as("planner"))).code, 2);
    // A link of their own, kept as a hash; revoked, it opens nothing.
    const link = await e9g(["request", "stakeholders", "add", "--name", "Dana Ruiz", "--email", "dana@example.com", "--role", "customer"], as(null));
    const key = /\?token=(\S+)/.exec(link.out)?.[1] ?? "";
    assert.ok(key.length > 20, link.out);
    assert.equal((await store().stakeholders.get("s1"))?.key, keyHash(key));
    assert.doesNotMatch(JSON.stringify(await store().stakeholders.all()), new RegExp(key), "never the key itself");
    assert.match(
      (await e9g(["request", "stakeholders", "add", "--name", "Mallory", "--email", "dana@example.com", "--role", "customer"], as(null))).out,
      /is s1 Dana Ruiz already/,
      "an address on file is that person's"
    );
    assert.equal((await e9g(["request", "stakeholders", "revoke", "s1"], as(null))).code, 0);
    assert.equal((await store().stakeholders.get("s1"))?.key, null);
    assert.match((await e9g(["request", "add", "x", "--name", "A", "--email", "a@b.co"], as("planner"))).out, /doesn't record people's names/);

    // Researched, then promoted into a task, or rejected with a reason.
    assert.equal((await e9g(["request", "note", "r1", "Three competitors have it."], as("planner"))).code, 0);
    assert.equal((await store().requests.get("r1"))?.status, "researching");
    assert.equal((await e9g(["task", "add", "PDF export of the summary", "--request", "r1"], as("planner"))).code, 0);
    const r1 = await store().requests.get("r1");
    assert.deepEqual([r1?.status, r1?.tasks], ["promoted", ["1"]]);
    assert.equal((await store().tasks.get("1"))?.request, "r1");
    assert.match((await e9g(["request", "reject", "r2"], as("planner"))).out, /--reason/);
    assert.equal((await e9g(["request", "reject", "r2", "--reason", "the direction puts reading first"], as("planner"))).code, 0);
    assert.equal((await e9g(["task", "add", "x", "--request", "r2"], as("builder"))).code, 2);
  });
});

describe("cycles", () => {
  test("closing one records what's done since the last and drafts the report", async () => {
    const { run, as, store } = setup(team({ mode: "cycles" }));
    const merged = newTask({ team: "fixture", title: "a", kind: "feature", status: "done", by: "planner" });
    merged.history.push({ at: new Date().toISOString(), by: "merge-queue", what: "review → done: merged e9g/b1-a at abc", from: "review", to: "done" });
    await store().tasks.createAs("1", merged);
    // Done long ago, and only noted on since: not this cycle's.
    await store().tasks.createAs("2", newTask({ team: "fixture", title: "b", kind: "feature", status: "done", by: "planner" }));
    const report = join(tmp(), "report.md");
    write(report.replace(/\/report\.md$/, ""), {
      "report.md": "Checkout journey verified\n\nBuilt the address step and the receipt; verified on phone and desktop.",
    });
    assert.equal((await e9g(["cycle", "close", "--report-file", report], as("builder"))).code, 2);
    const closed = await e9g(["cycle", "close", "--report-file", report], as("planner"));
    assert.equal(closed.code, 0, closed.out);
    const drafts = readdirSync(join(run, "outbox"));
    assert.equal(drafts.length, 1);
    const draft = readFileSync(join(run, "outbox", drafts[0] ?? ""), "utf8");
    assert.match(draft, /^Subject: Cycle 1: Checkout journey verified/);
    assert.match(draft, /Done this cycle: #1\./);
    assert.deepEqual((await store().cycles.get("c1"))?.done, ["1"]);
    await update(store().tasks, "1", (t) => withEvent(t, "builder", "added a note"));
    assert.equal((await e9g(["cycle", "close", "--report-file", report], as("planner"))).code, 0);
    assert.deepEqual((await store().cycles.get("c2"))?.done, [], "a note on a task done last cycle doesn't count it again");
    const finishing = setup();
    assert.match((await e9g(["cycle", "list"], finishing.as("planner"))).out, /works to a finish line/);
  });
});

// An in-memory stand-in for the few driver calls the Mongo store makes.
function fakeMongo(): MongoClientLike {
  const dbs = new Map<string, Map<string, Map<string, Record<string, unknown>>>>();
  const matches = (doc: Record<string, unknown>, filter: Record<string, unknown>) => Object.entries(filter).every(([k, v]) => doc[k] === v);
  return {
    db(name) {
      const db = dbs.get(name) ?? new Map();
      dbs.set(name, db);
      return {
        collection(cname): MongoCollectionLike {
          const docs = db.get(cname) ?? new Map<string, Record<string, unknown>>();
          db.set(cname, docs);
          const clone = (d: Record<string, unknown> | undefined) => (d ? structuredClone(d) : null);
          return {
            findOne: async (filter) => clone([...docs.values()].find((d) => matches(d, filter))),
            find: (filter) => ({ toArray: async () => [...docs.values()].filter((d) => matches(d, filter)).map((d) => structuredClone(d)) }),
            insertOne: async (doc) => {
              if (docs.has(String(doc._id))) throw Object.assign(new Error("duplicate"), { code: 11000 });
              docs.set(String(doc._id), structuredClone(doc));
            },
            replaceOne: async (filter, doc) => {
              const current = [...docs.values()].find((d) => matches(d, filter));
              if (!current) return { matchedCount: 0 };
              docs.set(String(current._id), structuredClone(doc));
              return { matchedCount: 1 };
            },
            findOneAndUpdate: async (filter, update) => {
              const id = String(filter._id);
              const doc = docs.get(id) ?? { _id: id, seq: 0 };
              const inc = (update.$inc ?? {}) as Record<string, number>;
              for (const [k, v] of Object.entries(inc)) doc[k] = Number(doc[k] ?? 0) + v;
              docs.set(id, doc);
              return structuredClone(doc);
            },
            updateOne: async (filter, update) => {
              const id = String(filter._id);
              const doc = docs.get(id) ?? { _id: id, seq: 0 };
              for (const [k, v] of Object.entries((update.$max ?? {}) as Record<string, number>)) doc[k] = Math.max(Number(doc[k] ?? 0), v);
              docs.set(id, doc);
            },
            createIndex: async () => "ok",
          };
        },
      };
    },
    close: async () => {},
  };
}

describe("moving a task graph to Mongo", () => {
  test("copies every document with its id, refuses a store that has the team's already, and freezes the files", async () => {
    const run = tmp("e9g-run-");
    const files = fileStore(run, "fixture");
    await files.tasks.createAs("7", newTask({ team: "fixture", title: "seven", kind: "feature", status: "approved", by: "planner" }));
    await files.tasks.create(newTask({ team: "fixture", title: "eight", kind: "bug", status: "triage", by: "tester" }));
    await files.requests.create({
      team: "fixture",
      title: "r",
      body: "b",
      from: "s1",
      status: "new",
      tasks: [],
      notes: [],
      createdAt: "x",
      updatedAt: "x",
      history: [],
    });
    await files.stakeholders.create({ team: "fixture", name: "Dana", email: "d@example.com", role: "customer", createdAt: "x" });
    const mongo = storeOver(fakeMongo(), { name: "fixture", tasks: { store: "mongo", database: "e9g", lead: null } });
    assert.deepEqual(await migrate(files, mongo), { tasks: 2, requests: 1, stakeholders: 1, cycles: 0 });
    assert.deepEqual(
      (await mongo.tasks.all()).map((t) => [t.id, t.title]),
      [
        ["7", "seven"],
        ["8", "eight"],
      ]
    );
    assert.equal((await mongo.tasks.create(newTask({ team: "fixture", title: "nine", kind: "chore", status: "triage", by: "planner" }))).id, "9");
    await assert.rejects(migrate(files, mongo), /already has this team's tasks/);
    markMoved(run, "mongo");
    await assert.rejects(openStore({ name: "fixture", tasks: { store: "files", database: "e9g", lead: null } }, run), /moved to mongo/);
  });

  test("is the operator's, from the store team.json names", async () => {
    const { as } = setup();
    assert.match((await e9g(["task", "migrate", "--to", "mongo"], as("planner"))).out, /operator's/);
    assert.match((await e9g(["task", "migrate", "--to", "files"], as(null))).out, /in files already/);
    assert.match((await e9g(["task", "migrate", "--to", "mongo"], as(null))).out, /pause the team first/);
  });
});

describe("the Mongo store", () => {
  test("numbers per team, replaces only the version it read, and keeps imported numbers", async () => {
    const client = fakeMongo();
    const tasks = { store: "mongo" as const, database: "e9g", lead: null };
    const a = storeOver(client, { name: "alpha", tasks });
    const b = storeOver(client, { name: "beta", tasks });
    const fields = newTask({ team: "alpha", title: "one", kind: "feature", status: "proposed", by: "planner" });
    const one = await a.tasks.create(fields);
    assert.deepEqual([one.id, one.version, (await b.tasks.create({ ...fields, team: "beta" })).id], ["1", 1, "1"], "each team counts its own");
    assert.equal((await a.tasks.replace({ ...one, title: "first" }))?.version, 2);
    assert.equal(await a.tasks.replace({ ...one, title: "stale" }), null);
    assert.equal((await a.tasks.get("1"))?.title, "first");
    assert.equal((await a.tasks.createAs("7", fields))?.id, "7");
    assert.equal(await a.tasks.createAs("7", fields), null);
    assert.equal((await a.tasks.create(fields)).id, "8");
    assert.deepEqual(
      (await a.tasks.all()).map((t: Task) => t.id),
      ["1", "7", "8"]
    );
    assert.equal((await b.tasks.all()).length, 1);
    assert.equal(
      (
        await a.requests.create({
          team: "alpha",
          title: "r",
          body: "",
          from: null,
          status: "new",
          tasks: [],
          notes: [],
          createdAt: "",
          updatedAt: "",
          history: [],
        })
      ).id,
      "r1"
    );
  });

  test("e9g connect mongo keeps the connection string in the Keychain, encoded, and names the machine", async () => {
    const keychain = fakeKeychain();
    const uri = "mongodb+srv://e9g:p%40ss@cluster0.example.net/?retryWrites=true&w=majority";
    const connected = await e9g(["connect", "mongo", "--machine", "studio", "--no-check"], { input: uri });
    assert.equal(connected.code, 0, connected.out);
    assert.match(connected.out, /connected to mongodb\+srv:\/\/…@cluster0\.example\.net\/ as the machine studio/);
    assert.doesNotMatch(connected.out, /p%40ss/);
    const stored = readFileSync(join(keychain, "e9g-mongo"), "utf8");
    assert.equal(Buffer.from(stored, "base64url").toString("utf8"), uri);
    assert.equal(JSON.parse(readFileSync(join(process.env.E9G_HOME ?? "", "machine.json"), "utf8")).name, "studio");
    assert.match((await e9g(["connect", "mongo", "--no-check"], { input: "postgres://x" })).out, /isn't a MongoDB connection string/);
    assert.equal((await e9g(["disconnect", "mongo"])).code, 0);
    assert.ok(!existsSync(join(keychain, "e9g-mongo")));
  });
});

describe("a team on several machines", () => {
  test("the settings: Mongo with a lead needs a remote; one machine is everyone's lead", () => {
    const { team: t, problems } = normalize({ ...team(), tasks: { store: "mongo", lead: "studio" } }, "/x");
    assert.match(problems.join(" "), /push: a team on several machines/);
    assert.equal(multiMachine(t), true);
    const alone = normalize(team(), "/x").team;
    assert.deepEqual([multiMachine(alone), isLead(alone)], [false, true]);
  });

  test("a worker builds from the remote and pushes its branch; the lead fetches it, merges and pushes", () => {
    const remote = tmp("e9g-remote-");
    git(remote, "init", "-q", "--bare");
    const lead = makeRepo(team());
    git(lead, "remote", "add", "origin", remote);
    git(lead, "push", "-q", "origin", "e9g/next");
    const settings = {
      ...normalize({ ...team(), tasks: { store: "mongo", lead: "studio" }, push: { remote: "origin" } }, lead).team,
    };

    // The lead merged something the worker hasn't seen.
    commit(lead, { "src/merged.ts": "export const m = 1;\n" }, "merged on the lead");
    assert.match(pushIntegration(lead, settings).said ?? "", /pushed e9g\/next/);

    // A worker's fresh worktree, its own clone: the claim makes the task's branch from the remote integration branch.
    const worker = realpathSync(tmp("e9g-worker-"));
    git(worker, "clone", "-q", "-b", "e9g/next", remote, "clone");
    const tree = join(worker, "clone");
    git(tree, "config", "user.email", "w@example.com");
    git(tree, "config", "user.name", "Worker");
    git(tree, "checkout", "-q", "--detach");
    assert.match(prepareBranch(tree, settings, "e9g/b5-thing", false).said, /on e9g\/b5-thing, from origin's e9g\/next/);
    assert.ok(existsSync(join(tree, "src/merged.ts")), "built on what the lead merged");
    commit(tree, { "src/thing.ts": "export const t = 1;\n" }, "the thing");
    assert.equal(pushTaskBranch(tree, settings, "e9g/b5-thing"), null);

    // The lead reviews and merges the remote's copy, fetched each time: a second push is what it sees next.
    const seen = branchRef(lead, settings, "e9g/b5-thing");
    assert.deepEqual(seen.ok && [seen.ref, git(lead, "rev-parse", seen.ref)], ["refs/remotes/origin/e9g/b5-thing", git(tree, "rev-parse", "HEAD")]);
    commit(tree, { "src/thing.ts": "export const t = 2;\n" }, "round two");
    assert.equal(pushTaskBranch(tree, settings, "e9g/b5-thing"), null);
    const again2 = branchRef(lead, settings, "e9g/b5-thing");
    assert.equal(again2.ok && git(lead, "rev-parse", again2.ref), git(tree, "rev-parse", "HEAD"));
    assert.equal(git(lead, "branch", "--list", "e9g/b5-thing"), "", "the lead keeps no copy of its own");
    assert.match(JSON.stringify(branchRef(lead, settings, "e9g/b9-never-pushed")), /isn't on origin/);
    // Rework: the next claim starts from the task's own branch on the remote.
    git(tree, "checkout", "-q", "--detach", "HEAD~2");
    const rework = prepareBranch(tree, settings, "e9g/b5-thing", true);
    assert.equal(rework.ok, true, rework.said);
    assert.equal(readFileSync(join(tree, "src/thing.ts"), "utf8"), "export const t = 2;\n");
    // A rework whose branch never reached the remote: said loudly, not started over from the integration branch.
    git(tree, "checkout", "-q", "--detach");
    const missing = prepareBranch(tree, settings, "e9g/b6-lost", true);
    assert.deepEqual([missing.ok, /isn't on origin.*release the task/.test(missing.said)], [false, true]);
    // A rework whose copy here went its own way from the remote's (which holds the latest round) isn't continued.
    git(tree, "checkout", "-q", "-B", "e9g/b5-thing", "origin/e9g/b5-thing~1");
    commit(tree, { "src/side.ts": "export const side = 1;\n" }, "a stale round's own commit");
    git(tree, "checkout", "-q", "--detach");
    const diverged = prepareBranch(tree, settings, "e9g/b5-thing", true);
    assert.deepEqual([diverged.ok, /gone different ways/.test(diverged.said)], [false, true]);
    // A claim ran out before its member handed the task in, and the task is claimed again here: its work is continued.
    git(tree, "checkout", "-q", "-b", "e9g/b7-again", "origin/e9g/next");
    commit(tree, { "src/again.ts": "export const a = 1;\n" }, "work before the lease ran out");
    git(tree, "checkout", "-q", "--detach", "origin/e9g/next");
    const again = prepareBranch(tree, settings, "e9g/b7-again", false);
    assert.match(again.said, /earlier member's work/);
    assert.ok(existsSync(join(tree, "src/again.ts")), "not reset to the integration branch");

    // Only the lead pushes the integration branch: a push from elsewhere stops its merges until the operator brings it in.
    assert.equal(integrationDiverged(lead, settings), null);
    git(tree, "checkout", "-q", "-B", "hotfix", "origin/e9g/next");
    commit(tree, { "src/hotfix.ts": "export const h = 1;\n" }, "a hotfix pushed by hand");
    git(tree, "push", "-q", "origin", "HEAD:refs/heads/e9g/next");
    assert.match(integrationDiverged(lead, settings) ?? "", /has commits this machine's doesn't/);
    // A worker's own checkout catches up with the remote's integration branch when it's clean.
    git(lead, "push", "-q", "--force", "origin", "e9g/next:refs/heads/e9g/next");
    const own = join(worker, "own");
    git(worker, "clone", "-q", "-b", "e9g/next", remote, "own");
    commit(lead, { "src/later.ts": "export const later = 1;\n" }, "merged later on the lead");
    pushIntegration(lead, settings);
    assert.equal(refreshCheckout(own, settings), null);
    assert.equal(git(own, "rev-parse", "HEAD"), git(lead, "rev-parse", "e9g/next"));
  });

  test("merges happen only on the lead", async () => {
    const { home, as } = setup(team({ tasks: { store: "mongo", lead: "studio" }, push: { remote: "origin" } }));
    write(process.env.E9G_HOME ?? "", { "machine.json": { name: "laptop" } });
    try {
      const refused = await e9g(["merge", "e9g/b1-x"], as("planner"));
      assert.equal(refused.code, 2);
      assert.match(refused.out, /merges happen on the team's lead machine, studio/);
      assert.ok(home);
    } finally {
      write(process.env.E9G_HOME ?? "", { "machine.json": {} });
    }
  });
});

describe("the watchdog and the task graph", () => {
  // A registered team (test/fake-t3.ts) whose registry entry carries its task graph, as e9g register writes it.
  async function world(extra: Record<string, unknown> = {}) {
    const { fakeWorld } = await import("./fake-t3.ts");
    const w = await fakeWorld();
    const file = join(w.e9gHome, "teams", "fixture.json");
    write(join(w.e9gHome, "teams"), {
      "fixture.json": { ...JSON.parse(readFileSync(file, "utf8")), tasks: { store: "files", database: "e9g", lead: null }, mode: "cycles", ...extra },
    });
    return { w, store: fileStore(w.run, "fixture") };
  }

  test("returns an expired claim and its mark; wakes an idle team only for what arrived since", async () => {
    const { w, store } = await world();
    try {
      write(w.run, { "planner-thread": "mcp:planner\n" });
      const past = new Date(Date.now() - 60_000).toISOString();
      await store.tasks.createAs(
        "1",
        newTask({
          team: "fixture",
          title: "a",
          kind: "feature",
          status: "building",
          by: "planner",
          claim: { role: "builder", machine: "m", worktree: "/w/one", at: past, until: past },
        })
      );
      const { claimMark, markClaim } = await import("../lib/tasks/ops.ts");
      markClaim(w.run, "/w/one", ["1"]);
      // Idle since now: the task the expiry returns changed after it, so it wakes the team once.
      write(w.run, { idle: "" });
      const { utimesSync } = await import("node:fs");
      const before = new Date(Date.now() - 120_000);
      utimesSync(join(w.run, "idle"), before, before);
      assert.equal((await w.e9g("watchdog", "run", "fixture")).code, 0);
      assert.equal((await store.tasks.get("1"))?.status, "approved");
      assert.ok(!existsSync(claimMark(w.run, "/w/one")), "the mark goes with the claim");
      assert.ok(
        w.calls().some((c) => /thread send mcp:planner .*new work: 1 task to triage, approve, build, review or verify/.test(c)),
        w.calls().join("\n")
      );
      assert.ok(!existsSync(join(w.run, "idle")));

      // Idle again, after it: the same waiting task doesn't wake it; a new request does.
      write(w.run, { idle: "" });
      const sent = () => w.calls().filter((c) => c.includes("new work:")).length;
      await w.e9g("watchdog", "run", "fixture");
      assert.equal(sent(), 1);
      assert.ok(existsSync(join(w.run, "idle")));
      const { addRequest } = await import("../lib/commands/request.ts");
      await new Promise((done) => setTimeout(done, 20));
      await addRequest(store, "fixture", { title: "Export", body: "", from: null, by: "operator" });
      await w.e9g("watchdog", "run", "fixture");
      assert.equal(sent(), 2);
      assert.ok(w.calls().some((c) => /new work: 1 new feature request/.test(c)));
    } finally {
      await w.close();
    }
  });

  test("a worker machine starts members for approved work, up to its limits, counting the threads it started", async () => {
    const { w, store } = await world({ worker: true, limits: { builder: 2, tester: 1 }, branch: "e9g/next" });
    try {
      for (const id of ["1", "2", "3"])
        await store.tasks.createAs(
          id,
          newTask({ team: "fixture", title: `t${id}`, kind: "feature", status: "approved", by: "planner", files: [`src/${id}/`] })
        );
      const starts = () => w.calls().filter((c) => c.startsWith("t3 thread start"));
      // Two it started still running: the builder slots are full.
      write(w.run, {
        "worker-threads.json": {
          builder: [
            { id: "a", at: new Date().toISOString() },
            { id: "b", at: new Date().toISOString() },
          ],
        },
      });
      w.show({ status: "running", updatedAt: new Date().toISOString() });
      assert.equal((await w.e9g("watchdog", "run", "fixture")).code, 0);
      assert.equal(starts().length, 0, "both slots busy");
      // Finished, but started within the half hour: none again yet, so members that claim nothing aren't restarted.
      w.show({ status: "completed", updatedAt: new Date().toISOString() });
      await w.e9g("watchdog", "run", "fixture");
      assert.equal(starts().length, 0, "at most one start per slot each half hour");
      // Finished long ago: two builders, none for the tester (no test work), in worktrees of the integration branch.
      const old = new Date(Date.now() - 3600_000).toISOString();
      write(w.run, {
        "worker-threads.json": {
          builder: [
            { id: "a", at: old },
            { id: "b", at: old },
          ],
        },
      });
      await w.e9g("watchdog", "run", "fixture");
      assert.equal(starts().length, 2, starts().join("\n"));
      assert.match(starts()[0] ?? "", /--provider e9g-fixture-builder .*--worktree e9g\/next/);
      assert.match(starts()[0] ?? "", /e9g task claim/);
      assert.ok(!w.calls().some((c) => c.startsWith("t3 thread send")), "no planner on a worker");
    } finally {
      await w.close();
    }
  });
});

describe("stakeholders' details", () => {
  test("live beside the run folder, and the guard refuses them by any path or glob", async () => {
    const { bash, holds, tool } = await import("./helpers.ts");
    const { privateDir } = await import("../lib/tasks/files.ts");
    const home = makeRepo();
    const run = `${home}-run`;
    await fileStore(run, "fixture").stakeholders.create({ team: "fixture", name: "Ada", email: "ada@example.com", role: "customer", createdAt: "" });
    const dir = join(privateDir(run), "stakeholders");
    assert.ok(existsSync(join(dir, "s1.json")) && !existsSync(join(run, "stakeholders")), "not in the run folder members search");
    await holds([
      tool(home, "builder", "Read", { file_path: join(dir, "s1.json") }, "refuse"),
      bash(home, "planner", `cat ${dir}/*.json`, "refuse"),
      bash(home, "reviewer", `cat "${privateDir(run)}"/stakeholders/*`, "refuse"),
      bash(home, "builder", `rg Ada ${dir}`, "refuse"),
      tool(home, "tester", "Grep", { pattern: "Ada", path: dir }, "refuse"),
      bash(home, "builder", `rg Ada ${run}`, "allow"),
    ]);
  });
});
