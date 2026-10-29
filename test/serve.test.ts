// e9g serve: the operator's page. Each test starts the server on a free port against a team checkout and a run folder
// of its own, and talks to it with fetch, as the page's browser would.
import { baseTeam, makeRepo, tmp } from "./helpers.ts";
import assert from "node:assert/strict";
import { request } from "node:http";
import { describe, test } from "node:test";
import { startServer } from "../lib/commands/serve.ts";
import { loadTeam } from "../lib/config.ts";
import { fileStore } from "../lib/tasks/files.ts";
import { newTask, type Score, type Task } from "../lib/tasks/model.ts";

const SCORE: Score = {
  pain: 3,
  reach: 2,
  revenue: 1,
  wow: 2,
  distribution: 1,
  leverage: 2,
  urgency: 1,
  risk: 0,
  confidence: "data",
  size: "S",
  why: "users lose work",
};

// A team checkout, its run folder, a server on it, and the store the server reads.
async function served({ host = "127.0.0.1", token = null }: { host?: string; token?: string | null } = {}) {
  const home = makeRepo(baseTeam());
  const run = tmp("e9g-run-");
  const server = await startServer({ home, run, team: loadTeam(home), host, port: 0, token });
  const store = fileStore(run, "fixture");
  const add = (fields: Partial<Task> & Pick<Task, "title">) =>
    store.tasks.create(newTask({ team: "fixture", kind: "feature", status: "proposed", by: "planner", ...fields }));
  return { home, run, store, add, url: server.url, close: () => server.close() };
}

const post = (url: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
// A GET's status with headers fetch won't send as given (it sets Host from the URL).
const statusFor = (url: string, headers: Record<string, string>): Promise<number | undefined> =>
  new Promise((done, fail) => {
    const sent = request(url, { headers }, (res) => {
      res.resume();
      done(res.statusCode);
    });
    sent.on("error", fail);
    sent.end();
  });

describe("e9g serve", () => {
  test("the form makes a request and a stakeholder, and the page shows it escaped", async () => {
    const s = await served();
    try {
      const form = new URLSearchParams({
        title: "<script>alert(1)</script> Export to CSV",
        body: "Accounting re-types every invoice.",
        name: "Ada Lovelace",
        email: "ada@example.com",
        role: "customer",
      });
      const sent = await fetch(`${s.url}/requests`, { method: "POST", body: form, redirect: "manual" });
      assert.equal(sent.status, 303);
      assert.equal(sent.headers.get("location"), "/");

      const [request, ...more] = await s.store.requests.all();
      assert.equal(more.length, 0);
      assert.equal(request?.title, "<script>alert(1)</script> Export to CSV");
      assert.equal(request?.history[0]?.by, "operator");
      const [person] = await s.store.stakeholders.all();
      assert.deepEqual([person?.name, person?.email, person?.role], ["Ada Lovelace", "ada@example.com", "customer"]);
      assert.equal(request?.from, person?.id);
      assert.doesNotMatch(JSON.stringify(request), /Ada|ada@example/, "the request keeps the stakeholder's id, not who they are");

      const page = await (await fetch(s.url)).text();
      assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt; Export to CSV/);
      assert.doesNotMatch(page, /<script>alert/);
      assert.match(page, /Ada Lovelace/);
      assert.match(page, /\(customer\)/);

      const listed = (await (await fetch(`${s.url}/api/requests`)).json()) as {
        id: string;
        stakeholder: { name: string; email: string; role: string } | null;
      }[];
      assert.deepEqual(listed[0]?.stakeholder, { id: person?.id, name: "Ada Lovelace", email: "ada@example.com", role: "customer" });

      // A request without a plausible address isn't taken, and the form comes back with what was typed.
      const bad = await fetch(`${s.url}/requests`, {
        method: "POST",
        body: new URLSearchParams({ title: "Dark mode", name: "Bo", email: "bo-at-example" }),
      });
      assert.equal(bad.status, 400);
      assert.match(await bad.text(), /email address/);
      assert.equal(
        (await fetch(`${s.url}/requests`, { method: "POST", body: new URLSearchParams({ name: "Bo", email: "bo@example.com" }) })).status,
        400,
        "no title"
      );
      assert.equal((await s.store.requests.all()).length, 1);
    } finally {
      await s.close();
    }
  });

  test("approving a scored proposal runs e9g task as the operator", async () => {
    const s = await served();
    try {
      const unscored = await s.add({ title: "Unscored idea" });
      const scored = await s.add({ title: "Resume a paused recording", score: SCORE, priority: 60 });
      assert.match(await (await fetch(s.url)).text(), /Resume a paused recording[\s\S]*Approve/);

      const refused = await post(`${s.url}/api/tasks/${unscored.id}/approve`, {});
      assert.equal(refused.status, 422);
      const why = (await refused.json()) as { ok: boolean; output: string };
      assert.equal(why.ok, false);
      assert.match(why.output, /isn't scored yet/, "e9g task's own rules decide");

      const approved = await post(`${s.url}/api/tasks/${scored.id}/approve`, { note: "--fits the direction" });
      const result = (await approved.json()) as { ok: boolean; output: string };
      assert.deepEqual([approved.status, result.ok], [200, true], result.output);
      const task = await s.store.tasks.get(scored.id);
      assert.equal(task?.status, "approved");
      assert.equal(task?.approval?.by, "operator");
      assert.equal(task?.approval?.note, "--fits the direction", "a note that starts with -- stays a note");
      assert.equal(task?.history.at(-1)?.by, "operator");
    } finally {
      await s.close();
    }
  });

  test("rejecting a proposal needs a reason", async () => {
    const s = await served();
    try {
      const proposal = await s.add({ title: "A second login page" });
      const without = await post(`${s.url}/api/tasks/${proposal.id}/reject`, { reason: "  " });
      assert.equal(without.status, 400);
      assert.match(((await without.json()) as { output: string }).output, /reason/);
      assert.equal((await s.store.tasks.get(proposal.id))?.status, "proposed");

      // A form post works the same as JSON.
      const rejected = await fetch(`${s.url}/api/tasks/${proposal.id}/reject`, {
        method: "POST",
        body: new URLSearchParams({ reason: "against the direction" }),
      });
      assert.equal(rejected.status, 200);
      const task = await s.store.tasks.get(proposal.id);
      assert.equal(task?.status, "rejected");
      assert.equal(task?.notes.at(-1)?.text, "against the direction");
      assert.equal(task?.notes.at(-1)?.by, "operator");
    } finally {
      await s.close();
    }
  });

  test("with a token, every request needs it: ?token= once, then the cookie or the header", async () => {
    const s = await served({ token: "s3cret-token" });
    try {
      assert.equal((await fetch(s.url)).status, 401);
      assert.equal((await fetch(`${s.url}/api/tasks`)).status, 401);
      assert.equal((await fetch(`${s.url}/?token=wrong`)).status, 401);

      const first = await fetch(`${s.url}/?token=s3cret-token`);
      assert.equal(first.status, 200);
      const setCookie = first.headers.get("set-cookie") ?? "";
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /SameSite=Strict/);
      const cookie = setCookie.split(";")[0] ?? "";
      assert.equal((await fetch(s.url, { headers: { cookie } })).status, 200);
      assert.equal((await fetch(`${s.url}/api/tasks`, { headers: { "x-e9g-token": "s3cret-token" } })).status, 200);
      assert.equal((await fetch(s.url, { headers: { cookie: `${cookie.split("=")[0]}=guess` } })).status, 401);
    } finally {
      await s.close();
    }
  });

  test("a change from another origin is refused", async () => {
    const s = await served();
    try {
      const proposal = await s.add({ title: "Thing", score: SCORE });
      const form = new URLSearchParams({ title: "Planted", name: "Eve", email: "eve@example.com" });
      assert.equal(
        (await fetch(`${s.url}/requests`, { method: "POST", body: form, headers: { origin: "http://evil.example" }, redirect: "manual" })).status,
        403
      );
      assert.equal((await post(`${s.url}/api/tasks/${proposal.id}/approve`, {}, { origin: "http://evil.example" })).status, 403);
      assert.equal((await s.store.requests.all()).length, 0);
      assert.equal((await s.store.tasks.get(proposal.id))?.status, "proposed");
      // Its own origin is fine.
      assert.equal((await fetch(`${s.url}/requests`, { method: "POST", body: form, headers: { origin: s.url }, redirect: "manual" })).status, 303);
      // Without a token, only a loopback name reaches it (a rebound DNS name doesn't).
      assert.equal(await statusFor(s.url, { host: "evil.example" }), 403);
      assert.equal(await statusFor(s.url, { host: "localhost" }), 200);
    } finally {
      await s.close();
    }
  });

  test("off loopback, it won't start without a token", async () => {
    const home = makeRepo(baseTeam());
    const options = { home, run: tmp("e9g-run-"), team: loadTeam(home), port: 0, token: null };
    await assert.rejects(startServer({ ...options, host: "0.0.0.0" }), /isn't a loopback address.*--token/);
    await assert.rejects(startServer({ ...options, host: "192.168.1.20" }), /--token/);
    const local = await startServer({ ...options, host: "localhost" });
    await local.close();
  });

  test("the graph's JSON, the page's SVG, and what isn't a route", async () => {
    const s = await served();
    try {
      const first = await s.add({ title: "Record", status: "approved" });
      await s.add({ title: "Resume", status: "approved", after: [first.id] });
      const graph = (await (await fetch(`${s.url}/api/graph`)).json()) as { nodes: { id: string }[]; edges: unknown[] };
      assert.ok(Array.isArray(graph.nodes));
      assert.ok(graph.nodes.some((n) => n.id === `t${first.id}`));
      assert.equal(graph.edges.length, 1);
      const page = await (await fetch(s.url)).text();
      // The dependency's line, under the two boxes.
      assert.match(page, /<svg[\s\S]*<path class="dep"[\s\S]*#1 Record[\s\S]*#2 Resume[\s\S]*<\/svg>/);

      assert.equal((await fetch(`${s.url}/nope`)).status, 404);
      assert.equal((await post(`${s.url}/api/tasks/1x/approve`, {})).status, 404, "a task id is a number");
      assert.equal((await post(`${s.url}/api/tasks/../approve`, {})).status, 404);
      const big = await fetch(`${s.url}/requests`, { method: "POST", body: new URLSearchParams({ title: "x".repeat(70 * 1024) }) });
      assert.equal(big.status, 413);
    } finally {
      await s.close();
    }
  });
});
