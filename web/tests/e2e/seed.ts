// The end-to-end tests' world, made with the factory's own functions over the test database: two teams' published
// settings and status, a task graph with proposals, stakeholders' requests (one promoted, one rejected), the first
// admin (by create-admin's own code), a member and a contributor whose daily limit the tests reach.
import { newTask, nowIso, priorityOf, type Score, type Task, withEvent } from "../../../lib/tasks/model.ts";
import { addRequest, stakeholderFor } from "../../../lib/tasks/requests.ts";
import { update } from "../../../lib/tasks/store.ts";
import type { TeamSettings } from "../../../lib/tasks/teams.ts";
import { auth } from "../../server/auth.ts";
import { createAdmin } from "../../server/bootstrap.ts";
import { storeFor } from "../../server/factory.ts";
import { setMembership } from "../../server/people.ts";

export interface World {
  admin: { email: string; password: string; totpURI: string; backupCodes: string[] };
  member: string;
  busy: string;
  proposals: { approve: string; reject: string; untouched: string };
  requests: { promoted: string; rejected: string };
}

const score = (size: Score["size"], why: string): Score => ({
  pain: 2,
  reach: 2,
  revenue: 1,
  wow: 1,
  distribution: 1,
  leverage: 2,
  urgency: 1,
  risk: 1,
  confidence: "asks",
  size,
  why,
});
const gate = (asked: string) => ({ asked, simplify: "nothing to delete: it's new", simplest: "one button" });

function settings(name: string, title: string, mode: TeamSettings["mode"]): TeamSettings {
  return {
    name,
    title,
    mode,
    approval: { mode: "operator", maxSize: "M", findings: "planner" },
    roles: ["planner", "builder", "reviewer"],
    branch: "main",
    factory: "0.4.0",
    publishedAt: nowIso(),
  };
}

export async function seed(): Promise<World> {
  const shop = storeFor("shop");
  await shop.publish(settings("shop", "Shop", "finish"));
  await shop.report({ state: "active", planner: "running", members: { builder: 1 }, at: nowIso() });
  const blog = storeFor("blog");
  await blog.publish(settings("blog", "Blog", "cycles"));
  await blog.report({ state: "idle", planner: null, members: {}, at: nowIso() });
  await blog.tasks.create(newTask({ team: "blog", title: "Write the launch post", kind: "chore", status: "approved", by: "planner" }));

  const add = (fields: Partial<Task> & Pick<Task, "title" | "kind" | "status">): Promise<Task> =>
    shop.tasks.create(newTask({ team: "shop", by: "planner", ...fields }));
  const journey = await add({ title: "Checkout", kind: "journey", status: "approved" });
  const merged = await add({ title: "Pay by card", kind: "feature", status: "done", parent: journey.id, score: score("M", "most orders") });
  await update(shop.tasks, merged.id, (t) =>
    withEvent({ ...t, sha: "a1b2c3d4e5" }, "merge-queue", "review → done: merged e9g/b2-pay-by-card", { from: "review", to: "done", sha: "a1b2c3d4e5" })
  );
  await add({
    title: "Save the card for next time",
    kind: "feature",
    status: "building",
    parent: journey.id,
    after: [merged.id],
    claim: { role: "builder", machine: "studio", worktree: "/w/b3", at: nowIso(), until: new Date(Date.now() + 3_600_000).toISOString() },
  });
  const toApprove = await add({
    title: "Export orders as CSV",
    kind: "feature",
    status: "proposed",
    gate: gate("support, for refunds"),
    score: score("S", "weekly refunds"),
  });
  const toReject = await add({
    title: "Dark mode for receipts",
    kind: "feature",
    status: "proposed",
    gate: gate("one customer"),
    score: score("M", "nice to have"),
  });
  const untouched = await add({ title: "Gift cards", kind: "feature", status: "proposed", gate: gate("sales"), score: score("L", "holiday season") });
  for (const t of [toApprove, toReject, untouched]) await update(shop.tasks, t.id, (x) => ({ ...x, priority: x.score ? priorityOf(x.score) : null }));
  await add({ title: "Totals round the wrong way", kind: "bug", status: "approved", severity: "major" });

  // Requests from a stakeholder the app has no account for (as e9g request add makes them).
  const grace = await stakeholderFor(shop, "shop", { name: "Grace Hopper", email: "grace@example.com", role: "customer" });
  const promoted = await addRequest(shop, "shop", {
    title: "Refund exports",
    body: "We redo refunds by hand every Friday.",
    from: grace.id,
    by: "operator",
  });
  await update(shop.requests, promoted.id, (r) =>
    withEvent({ ...r, status: "promoted", tasks: [toApprove.id] }, "planner", `new → promoted: task ${toApprove.id}`, { from: "new", to: "promoted" })
  );
  const rejected = await addRequest(shop, "shop", { title: "A fax integration", body: "", from: grace.id, by: "operator" });
  await update(shop.requests, rejected.id, (r) =>
    withEvent(
      { ...r, status: "rejected", notes: [...r.notes, { at: nowIso(), by: "planner", text: "rejected: nobody else has asked, and fax is going away" }] },
      "planner",
      "new → rejected: nobody else has asked, and fax is going away",
      { from: "new", to: "rejected" }
    )
  );

  const admin = await createAdmin({ email: "operator@example.com", name: "Olive Operator" });
  const people = [
    { email: "member@example.com", name: "Morgan Member", role: "member" as const, label: "sales" },
    { email: "busy@example.com", name: "Bea Busy", role: "contributor" as const, label: "customer" },
  ];
  for (const p of people) {
    const { user } = await auth().api.createUser({ body: { email: p.email, name: p.name, role: "user" } });
    await setMembership({ userId: user.id, name: user.name, email: user.email }, "shop", p.role, p.label);
  }
  return {
    admin,
    member: "member@example.com",
    busy: "busy@example.com",
    proposals: { approve: toApprove.id, reject: toReject.id, untouched: untouched.id },
    requests: { promoted: promoted.id, rejected: rejected.id },
  };
}
