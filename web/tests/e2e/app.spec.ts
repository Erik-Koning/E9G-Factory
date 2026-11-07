// The app end to end, against a local MongoDB seeded with the factory's own functions (seed.ts): one story, in order.
import { readFileSync } from "node:fs";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { answersMessage, answersSince } from "../../../lib/tasks/answer.ts";
import { type Control, holdOf, holdReport } from "../../../lib/tasks/controls.ts";
import { newTask, type Task, withEvent } from "../../../lib/tasks/model.ts";
import { update } from "../../../lib/tasks/store.ts";
import { actionIdOn, closeDatabases, databases, errorOf, freshCode, mailsTo, newPage, nextLink, signInAsAdmin, signInByLink, state } from "./helpers.ts";

test.describe.configure({ mode: "serial" });

const CONTRIBUTOR = "casey@example.com";
let admin: { context: BrowserContext; page: Page };
let contributor: { context: BrowserContext; page: Page };
let member: { context: BrowserContext; page: Page };
// The member's session once their browser is closed, for a later look (sign-in links go at most once a minute).
let memberSession: Awaited<ReturnType<BrowserContext["storageState"]>>;
// A lane of the board, by its name.
const lane = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

test.afterAll(async () => {
  await closeDatabases();
});

test("an admin signs in with the password and the authenticator's code", async ({ browser }) => {
  admin = await newPage(browser);
  const { page } = admin;
  await signInAsAdmin(page);
  await expect(page.getByRole("link", { name: "Shop" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Blog" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "People" })).toBeVisible();
  // The session began with the second factor.
  const { accounts } = await databases();
  const user = await accounts.collection("user").findOne({ email: state().admin.email });
  const sessions = await accounts.collection("session").find({ userId: user?._id }).toArray();
  expect(sessions.map((s) => s.secondFactor)).toEqual([true]);
});

test("Better Auth's admin endpoints and enrolment aren't served over HTTP, even to an admin", async () => {
  const { page } = admin;
  for (const [method, path] of [
    ["GET", "/api/auth/admin/list-users"],
    ["POST", "/api/auth/admin/set-role"],
    ["POST", "/api/auth/two-factor/disable"],
  ] as const) {
    const response = await page.request.fetch(path, { method, data: method === "POST" ? {} : undefined, headers: { origin: state().baseURL } });
    expect(response.status(), path).toBe(403);
  }
});

test("an admin never gets a sign-in link by email", async ({ browser }) => {
  const { context, page } = await newPage(browser);
  const before = mailsTo(state().admin.email).length;
  await page.goto("/sign-in");
  await page.getByLabel("Email", { exact: true }).first().fill(state().admin.email);
  await page.getByRole("button", { name: "Email me a link" }).click();
  // The same answer as for anyone, and nothing sent.
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await page.waitForTimeout(500);
  expect(mailsTo(state().admin.email).length).toBe(before);
  await context.close();
});

test("the admin invites a contributor", async () => {
  const { page } = admin;
  const seen = mailsTo(CONTRIBUTOR).length;
  await page.goto("/admin/people");
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Invite" }) });
  await form.getByLabel("Email", { exact: true }).fill(CONTRIBUTOR);
  await form.getByLabel("Name", { exact: true }).fill("Casey Contributor");
  await form.getByLabel("Team", { exact: true }).selectOption("shop");
  await form.getByLabel("Role", { exact: true }).selectOption("contributor");
  await form.getByLabel("What they are to the team's agents").fill("customer");
  await form.getByRole("button", { name: "Invite" }).click();
  await expect(page.getByRole("status")).toContainText(`Invited ${CONTRIBUTOR} to shop as a contributor`);
  await expect(page.getByText("Casey Contributor")).toBeVisible();
  await nextLink(CONTRIBUTOR, seen);

  // Their role, and their stakeholder record on the team, linked to the account (by the factory's stakeholderFor).
  const { graph, accounts } = await databases();
  const user = await accounts.collection("user").findOne({ email: CONTRIBUTOR });
  expect(user?.role).toBe("user");
  const userId = String(user?._id);
  expect(await accounts.collection("memberships").findOne({ userId, team: "shop" })).toMatchObject({ role: "contributor", label: "customer" });
  expect(await graph.collection("stakeholders").findOne({ team: "shop", userId })).toMatchObject({ email: CONTRIBUTOR, role: "customer" });
});

test("the contributor signs in by the invitation's link, sends a request, and sees only their own and the overview", async ({ browser }) => {
  contributor = await newPage(browser);
  const { page } = contributor;
  const invitation = mailsTo(CONTRIBUTOR).at(-1) ?? "";
  await page.goto(invitation);
  await expect(page).toHaveURL(/\/t\/shop$/);

  // The overview: status, progress and journeys, not the board, the graph or merges.
  await expect(page.getByRole("heading", { name: "Status" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Progress" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Journeys" })).toBeVisible();
  await expect(page.getByText("Checkout")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Board" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Graph" })).toHaveCount(0);
  await expect(page.getByText("Export orders as CSV")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Decisions" })).toHaveCount(0);

  // Nobody else's requests.
  await page.getByRole("link", { name: "Requests" }).click();
  await expect(page.getByRole("heading", { name: "Your requests" })).toBeVisible();
  await expect(page.getByText("You haven't sent any yet.")).toBeVisible();
  await expect(page.getByText("Refund exports")).toHaveCount(0);

  await page.getByLabel("Title").fill("Invoices as PDF");
  await page.getByLabel("What you need, and why").fill("Our accountant asks for a PDF of each invoice.");
  await page.getByRole("button", { name: "Send the request" }).click();
  await expect(page.getByRole("status")).toContainText("Request sent");
  await expect(page.getByRole("heading", { name: "Invoices as PDF" })).toBeVisible();
  await expect(page.getByText("from you")).toBeVisible();

  await page.getByRole("link", { name: "← Requests" }).click();
  await expect(page.getByRole("link", { name: "Invoices as PDF" })).toBeVisible();
  await expect(page.locator("main li").filter({ has: page.locator(".id") })).toHaveCount(1);

  // The request carries the stakeholder's id and nothing that names them (Article 8).
  const { graph, accounts } = await databases();
  const request = await graph.collection("requests").findOne({ team: "shop", title: "Invoices as PDF" });
  const userId = String((await accounts.collection("user").findOne({ email: CONTRIBUTOR }))?._id);
  const stakeholder = await graph.collection("stakeholders").findOne({ team: "shop", userId });
  expect(request).toMatchObject({ from: stakeholder?.id, status: "new", history: [expect.objectContaining({ by: "stakeholder", what: "requested" })] });
  expect(JSON.stringify(request)).not.toMatch(/Casey|casey@example\.com/);

  // Others' requests, other teams and the admins' pages aren't there for them.
  for (const path of [`/t/shop/requests/${state().requests.promoted}`, "/t/blog", "/t/shop/proposals", "/admin/people"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Not found" }), path).toBeVisible();
  }
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Shop" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Blog" })).toHaveCount(0);
});

test("a member sees the board, the graph and every request, senders by role only", async ({ browser }) => {
  member = await newPage(browser);
  const { page } = member;
  await signInByLink(page, state().member);
  await page.goto("/t/shop");
  await expect(page.getByRole("img", { name: "The task graph" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent merges" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Recent merges" }).getByText("Pay by card")).toBeVisible();
  await page.getByRole("link", { name: "Board", exact: true }).click();
  await expect(page).toHaveURL(/\/t\/shop\/board$/);
  await expect(lane(page, "Proposed").getByRole("link", { name: "Export orders as CSV" })).toBeVisible();
  await expect(lane(page, "Building").getByText("builder on studio")).toBeVisible();
  await expect(lane(page, "Done").getByRole("link", { name: "Pay by card" })).toBeVisible();
  // Work the planner made of a request says who asked, by role.
  await expect(
    lane(page, "Proposed")
      .getByRole("listitem")
      .filter({ hasText: "Export orders as CSV" })
      .getByText(/^requested by customer/)
  ).toBeVisible();

  await page.goto("/t/shop/requests");
  await expect(page.getByRole("heading", { name: "All requests" })).toBeVisible();
  for (const title of ["Refund exports", "A fax integration", "Invoices as PDF"]) await expect(page.getByRole("link", { name: title })).toBeVisible();
  await expect(page.getByText("from customer").first()).toBeVisible();
  const html = await page.content();
  expect(html).not.toMatch(/Grace|grace@example\.com|Casey|casey@example\.com/);

  // A rejected request says why; a promoted one, the tasks it became.
  await page.getByRole("link", { name: "A fax integration" }).click();
  await expect(page.getByText("nobody else has asked, and fax is going away").first()).toBeVisible();
  await page.goto(`/t/shop/requests/${state().requests.promoted}`);
  await expect(page.getByText("Export orders as CSV")).toBeVisible();
  // No decisions for a member.
  await page.goto("/t/shop/proposals");
  await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
});

test("a member follows the work on the board, and suggests a task, which goes to triage as theirs", async () => {
  const { page } = member;
  await page.goto("/t/shop/board");
  const building = lane(page, "Building");
  await expect(building.getByRole("link", { name: "Save the card for next time" })).toBeVisible();
  await expect(building.getByText("builder on studio")).toBeVisible();
  await expect(building.getByText(/lease \d+ min left/)).toBeVisible();
  // The team's own work says which role added it.
  await expect(building.getByText(/^by the planner/)).toBeVisible();
  await expect(lane(page, "Approved").getByRole("link", { name: "Totals round the wrong way" })).toBeVisible();
  // A member suggests; only an admin adds. Shop is the only team they're on, so there's nothing to switch to.
  await expect(page.getByRole("link", { name: "Add a task" })).toHaveCount(0);
  await expect(page.getByText("Switch team")).toHaveCount(0);

  await page.getByRole("link", { name: "Suggest a task" }).click();
  await expect(page.getByRole("heading", { name: "Suggest a task" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: /^Journey/ })).toHaveCount(0);
  // How bad it is, asked only of a bug or a UX problem.
  await expect(page.getByLabel(/How bad/)).toHaveCount(0);
  await page.getByLabel("Kind").selectOption("ux");
  await expect(page.getByLabel("How bad it is")).toBeVisible();
  await page.getByLabel("Title").fill("Search orders by email");
  await page.getByLabel("Kind").selectOption("feature");
  await page.getByLabel("What's needed, and why").fill("Support looks up a customer's orders by email several times a day.");
  await page.getByRole("button", { name: "Suggest the task" }).click();
  await expect(page.getByRole("status")).toContainText("The planner triages it.");
  await expect(page.getByRole("heading", { name: "Search orders by email" })).toBeVisible();
  await expect(page.getByText(/^suggested by you/)).toBeVisible();
  // A task's page is the board's.
  await expect(page.getByRole("link", { name: "Board", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("added as triage, from the web app by you")).toBeVisible();

  // In triage, by "stakeholder", from their stakeholder record: an id, never a name (Article 8).
  const { graph, accounts } = await databases();
  const userId = String((await accounts.collection("user").findOne({ email: state().member }))?._id);
  const stakeholder = await graph.collection("stakeholders").findOne({ team: "shop", userId });
  const suggested = await graph.collection("tasks").findOne({ team: "shop", title: "Search orders by email" });
  expect(suggested).toMatchObject({ status: "triage", kind: "feature", by: "stakeholder", from: stakeholder?.id, approval: null });
  expect(JSON.stringify(suggested)).not.toMatch(/Morgan|member@example\.com/);
  // On the board, as theirs.
  await page.goto("/t/shop/board");
  const card = lane(page, "Triage").getByRole("listitem").filter({ hasText: "Search orders by email" });
  await expect(card.getByText(/^suggested by you/)).toBeVisible();

  // A suggestion whose form was changed to say it's approved, under a journey, after other work, is still only a
  // suggestion.
  await page.goto("/t/shop/add");
  await page.locator("main form").evaluate((form) => {
    for (const [name, value] of [
      ["approved", "yes"],
      ["parent", "1"],
      ["after", "2"],
    ]) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name ?? "";
      input.value = value ?? "";
      form.appendChild(input);
    }
  });
  await page.getByLabel("Title").fill("Free shipping, approved");
  await page.getByLabel("What's needed, and why").fill("Every order should ship free from now on, please.");
  await page.getByRole("button", { name: "Suggest the task" }).click();
  await expect(page.getByRole("status")).toContainText("The planner triages it.");
  expect(await graph.collection("tasks").findOne({ team: "shop", title: "Free shipping, approved" })).toMatchObject({
    status: "triage",
    approval: null,
    parent: null,
    after: [],
  });
  memberSession = await member.context.storageState();
  await member.context.close();
});

test("the admin approves one proposal with a note and rejects another with a reason", async ({ browser }) => {
  // A second sign-in, with a backup code this time.
  const fresh = await newPage(browser);
  await signInAsAdmin(fresh.page, { backupCode: state().admin.backupCodes[0] ?? "" });
  await fresh.context.close();

  const { page } = admin;
  const { approve, reject } = state().proposals;
  await page.goto("/t/shop/proposals");
  await expect(page.getByRole("heading", { name: "Proposed" })).toBeVisible();

  await page
    .getByLabel("Note (optional)")
    .and(page.locator(`#approve-${approve}`))
    .fill("Ship it before the holidays");
  await page.getByRole("button", { name: `Approve #${approve}` }).click();
  await expect(page.getByRole("status")).toContainText(`#${approve} approved.`);

  await page.locator(`#reject-${reject}`).fill("Not this quarter");
  await page.getByRole("button", { name: `Reject #${reject}` }).click();
  await expect(page.getByRole("status")).toContainText(`#${reject} rejected.`);

  // Exactly what a6g task approve and reject write, as the operator.
  const { graph } = await databases();
  const approved = await graph.collection("tasks").findOne({ _id: `shop:${approve}` as never });
  expect(approved).toMatchObject({ status: "approved", approval: { by: "operator", note: "Ship it before the holidays" } });
  expect(approved?.history.at(-1)).toMatchObject({
    by: "operator",
    from: "proposed",
    to: "approved",
    what: "proposed → approved: Ship it before the holidays",
  });
  const rejected = await graph.collection("tasks").findOne({ _id: `shop:${reject}` as never });
  expect(rejected).toMatchObject({ status: "rejected", approval: null });
  expect(rejected?.notes.at(-1)).toMatchObject({ by: "operator", text: "Not this quarter" });

  // A decision the move table refuses comes back in its words.
  await page.goto("/t/shop/proposals");
  await expect(page.getByRole("button", { name: `Approve #${approve}` })).toHaveCount(0);
});

test("the admin sees what waits on them and answers a question with one of its options, as the operator", async () => {
  const { page } = admin;
  const { question } = state().asks;
  await page.goto("/t/shop");
  // Every page says how much waits; the overview asks for an answer.
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /Waiting on you/ })).toContainText("2");
  await expect(page.getByText("2 things are waiting on you.")).toBeVisible();
  await page.getByRole("link", { name: "Answer them" }).click();
  await expect(page).toHaveURL(/\/t\/shop\/inbox$/);
  await expect(page.getByRole("navigation", { name: "Team" }).getByRole("link", { name: /Waiting on you/ })).toHaveAttribute("aria-current", "page");

  // The question as the planner put it: why it's the operator's, what the team recommends, its options.
  const item = page.locator(`#task-${question}`);
  await expect(item.getByText("who sees an order is the operator's")).toBeVisible();
  await expect(item.getByRole("definition").filter({ hasText: "(b), behind the same sign-in as checkout." })).toBeVisible();
  await expect(item.getByRole("radio")).toHaveCount(4);
  await expect(item.locator("label", { hasText: "(b) open them to signed-in customers" }).getByText("recommended")).toBeVisible();
  // A research question has nothing to approve: answer it, or reject it.
  await item.getByText(`Or decide #${question} yourself`).click();
  await expect(item.getByRole("button", { name: `Approve #${question}` })).toHaveCount(0);
  await expect(item.getByRole("button", { name: `Reject #${question}` })).toBeVisible();
  // Something else needs words; an option doesn't.
  await item.getByRole("radio", { name: /^Something else/ }).check();
  await expect(item.getByLabel("Your answer", { exact: true })).toHaveAttribute("required", "");
  await item.getByRole("radio", { name: /^\(b\) open them to signed-in customers/ }).check();
  await item.getByLabel("Anything to add (optional)").fill("Show the totals too.");
  await item.getByRole("button", { name: `Send the answer on #${question}` }).click();
  await expect(page.getByRole("status")).toContainText(`Answer sent on #${question}.`);

  // It waits on the planner now, not on the admin.
  const answered = page.getByRole("region", { name: /^Answered, with the planner/ });
  await expect(answered.getByText("Show the totals too.")).toBeVisible();
  await expect(answered.getByText("sent", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: /^Questions for you/ })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Team" }).getByRole("link", { name: /Waiting on you/ })).toContainText("1");

  // In the graph: the operator's note, marked as the answer, and the task where it was, for the planner to move on.
  const { graph, accounts } = await databases();
  const task = (await graph.collection("tasks").findOne({ _id: `shop:${question}` as never })) as unknown as Task;
  expect(task).toMatchObject({ status: "question" });
  expect(task.notes.at(-1)).toMatchObject({ by: "operator", kind: "answer", text: "(b) open them to signed-in customers.\n\nShow the totals too." });
  expect(task.history.at(-1)).toMatchObject({ by: "operator", what: "answered: (b) open them to signed-in customers. Show the totals too." });
  // What the lead's watchdog passes to the planner.
  expect(answersMessage(answersSince([task], "2000-01-01T00:00:00.000Z"))).toContain(
    `1. #${question} "Q: who sees a customer's past orders?" (question): (b)`
  );
  const logged = await accounts.collection("audit").findOne({ action: "task.answered", outcome: "ok" });
  expect(logged).toMatchObject({ team: "shop", target: `#${question} Q: who sees a customer's past orders?` });
});

test("the admin approves blocked work again from the inbox, and comes back to it", async () => {
  const { page } = admin;
  const { blocked } = state().asks;
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { name: "Waiting on you", level: 1 })).toBeVisible();
  await expect(page.getByText("1 waiting for your answer.")).toBeVisible();
  const item = page.locator(`#task-${blocked}`);
  // Why it's the operator's, and what the team recommends, always.
  await expect(item.getByText("needs the carrier's API key")).toBeVisible();
  await expect(item.getByRole("definition").filter({ hasText: "add the key to the vault, then approve it again" })).toBeVisible();
  await item.getByText(`Or decide #${blocked} yourself`).click();
  await item.locator(`#approve-${blocked}`).fill("The key is in the vault now");
  await item.getByRole("button", { name: `Approve again #${blocked}` }).click();
  await expect(page).toHaveURL(/\/inbox\?/);
  await expect(page.getByRole("status")).toContainText(`#${blocked} approved.`);
  await expect(page.getByText("Nothing is waiting on you.")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Waiting on you", exact: true })).toBeVisible();
  const { graph } = await databases();
  expect(await graph.collection("tasks").findOne({ _id: `shop:${blocked}` as never })).toMatchObject({
    status: "approved",
    approval: { by: "operator", note: "The key is in the vault now" },
  });
});

test("only an admin sees what waits on the operator", async ({ browser }) => {
  const { context, page } = await newPage(browser, { storageState: memberSession });
  await page.goto("/t/shop");
  await expect(page.getByRole("navigation", { name: "Team" }).getByRole("link", { name: /Waiting on you/ })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /Waiting on you/ })).toHaveCount(0);
  for (const path of ["/t/shop/inbox", "/inbox"]) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(404);
  }
  await context.close();
});

test("the admin chooses what they're emailed, and a test email shows it reaches them", async () => {
  const { page } = admin;
  await page.goto("/account");
  await page.getByRole("link", { name: "Change what we email you" }).click();
  await expect(page.getByRole("heading", { name: "Notifications", level: 1 })).toBeVisible();
  await expect(page.getByText("These are the defaults for an admin")).toBeVisible();
  await expect(page.getByRole("group", { name: /^Questions for you/ }).getByRole("radio", { name: "At once" })).toBeChecked();
  await expect(page.getByRole("group", { name: /^Work merged/ }).getByRole("radio", { name: "In the daily digest" })).toBeChecked();
  // This admin wants no email about merges, and their digest at 7 in Toronto.
  await page
    .getByRole("group", { name: /^Work merged/ })
    .getByText("Don't email")
    .click();
  await page.getByRole("combobox", { name: /^At/ }).selectOption("7");
  await page.getByRole("combobox", { name: /^Time zone/ }).selectOption("America/Toronto");
  await page.getByRole("button", { name: "Save notifications" }).click();
  await expect(page.getByRole("status")).toContainText("Saved.");
  await expect(page.getByRole("group", { name: /^Work merged/ }).getByRole("radio", { name: "Don't email" })).toBeChecked();
  const { accounts } = await databases();
  const user = await accounts.collection("user").findOne({ email: state().admin.email });
  expect(await accounts.collection("notification_prefs").findOne({ _id: String(user?._id) as never })).toMatchObject({
    digestHour: 7,
    timeZone: "America/Toronto",
    reminder: true,
    muted: [],
    modes: { question: "now", blocked: "digest", merged: "off" },
  });

  const seen = mailsTo(state().admin.email).length;
  await page.getByRole("button", { name: "Send me a test email" }).click();
  await expect(page.getByRole("status")).toContainText("Test email sent to your sign-in address.");
  expect(await nextLink(state().admin.email, seen)).toBe(`${state().baseURL}/account/notifications`);
});

test("the notifier emails the admin a new question at once, once, and never the member", async () => {
  // The server's notifier is off in these tests: they run it here, as the server would every minute.
  const { notifyOnce } = await import("../../server/notifier.ts");
  const { storeFor } = await import("../../server/factory.ts");
  const sent: string[] = [];
  const info = console.info;
  console.info = (...args: unknown[]) => void sent.push(args.join(" "));
  try {
    // The first look at a team is no news, whatever happened before it.
    await notifyOnce();
    const mails = () => sent.filter((line) => line.startsWith("[mail]") && line.includes("[Shop]"));
    expect(mails()).toEqual([]);

    const shop = storeFor("shop");
    const asked = await shop.tasks.create(
      newTask({ team: "shop", title: "Q: refunds by card or credit?", kind: "research", status: "proposed", by: "planner" })
    );
    await update(shop.tasks, asked.id, (t) =>
      withEvent({ ...t, status: "question" }, "planner", "proposed → question: money is the operator's", { from: "proposed", to: "question" })
    );
    await notifyOnce();
    expect(mails()).toEqual([
      `[mail] to=${state().admin.email} subject="[Shop] Question for you: #${asked.id} Q: refunds by card or credit?" link=${state().baseURL}/t/shop/inbox#task-${asked.id}`,
    ]);
    // Read again, it isn't news again.
    await notifyOnce();
    expect(mails()).toHaveLength(1);
    expect(mails().some((line) => line.includes(state().member))).toBe(false);
  } finally {
    console.info = info;
    await (await import("../../server/db.ts")).closeMongo();
  }
});

test("a contributor calling an admin's server action directly is refused, and nothing changes", async () => {
  const { untouched } = state().proposals;
  const decide = await actionIdOn(admin.page, "/t/shop/proposals");
  const invite = await actionIdOn(admin.page, "/admin/people");
  const { graph, accounts } = await databases();
  const before = await graph.collection("tasks").findOne({ _id: `shop:${untouched}` as never });

  const response = await contributor.page.request.post("/t/shop/proposals", {
    multipart: { [decide]: "", team: "shop", id: untouched, decision: "approve", text: "sneaky" },
    headers: { origin: state().baseURL },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(303);
  expect(errorOf(response)).toContain("You can't do that here.");
  const after = await graph.collection("tasks").findOne({ _id: `shop:${untouched}` as never });
  expect(after).toMatchObject({ status: "proposed", approval: null, version: before?.version });

  const invited = await contributor.page.request.post("/admin/people", {
    multipart: { [invite]: "", email: "mallory@example.com", name: "Mallory", team: "shop", role: "member", label: "" },
    headers: { origin: state().baseURL },
    maxRedirects: 0,
  });
  expect(errorOf(invited)).toContain("You can't do that here.");
  expect(await accounts.collection("user").findOne({ email: "mallory@example.com" })).toBeNull();
});

test("the admin adds a proposal, and a task approved under a journey after another", async () => {
  const { page } = admin;
  const { graph } = await databases();
  const journey = await graph.collection("tasks").findOne({ team: "shop", title: "Checkout" });
  const paid = await graph.collection("tasks").findOne({ team: "shop", title: "Pay by card" });

  await page.goto("/t/shop/add");
  await expect(page.getByRole("heading", { name: "Add a task" })).toBeVisible();
  await page.getByLabel("Title").fill("A receipt by email");
  await page.getByLabel("Description").fill("Send the receipt once the payment goes through.");
  await page.getByRole("button", { name: "Add the task" }).click();
  await expect(page.getByRole("status")).toContainText("added, proposed.");
  // Added as the operator, and by whom: the admin's own stakeholder record, as on their requests.
  const adminStakeholder = await graph.collection("stakeholders").findOne({ team: "shop", email: state().admin.email });
  expect(adminStakeholder).toMatchObject({ role: "operator" });
  const receipt = await graph.collection("tasks").findOne({ team: "shop", title: "A receipt by email" });
  expect(receipt).toMatchObject({ status: "proposed", by: "operator", from: adminStakeholder?.id, approval: null });
  expect(receipt?.history[0]).toMatchObject({ by: "operator", what: `added as proposed, from the web app by stakeholder ${adminStakeholder?.id}` });

  await page.goto("/t/shop/add");
  await page.getByLabel("Title").fill("Refund from the order page");
  await page.getByRole("combobox", { name: /^Journey/ }).selectOption({ label: `#${journey?.id} Checkout` });
  await page.getByLabel("Comes after (task numbers)").fill(`#${paid?.id}, 999`);
  await page.getByLabel(/Approve it now/).check();
  await page.getByRole("button", { name: "Add the task" }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("There's no task #999 on this team.");
  // What was typed is still there.
  await expect(page.getByLabel("Title")).toHaveValue("Refund from the order page");
  await page.getByLabel("Comes after (task numbers)").fill(`#${paid?.id}`);
  await page.getByRole("button", { name: "Add the task" }).click();
  await expect(page.getByRole("status")).toContainText("added, approved.");
  await expect(page.getByRole("region", { name: "Where it stands" }).getByRole("link", { name: `#${journey?.id} Checkout` })).toBeVisible();
  await expect(page.getByRole("region", { name: "Where it stands" }).getByRole("link", { name: `#${paid?.id} Pay by card` })).toBeVisible();
  // Exactly what a6g task add --approved writes, as the operator.
  expect(await graph.collection("tasks").findOne({ team: "shop", title: "Refund from the order page" })).toMatchObject({
    status: "approved",
    by: "operator",
    parent: journey?.id,
    after: [paid?.id],
    approval: { by: "operator", note: "added approved by the operator" },
  });
  await page.goto("/t/shop/board");
  const refund = lane(page, "Approved").getByRole("listitem").filter({ hasText: "Refund from the order page" });
  // Their own, to them.
  await expect(refund.getByText(/^added by you/)).toBeVisible();
  await expect(refund.getByText("in Checkout")).toBeVisible();

  // To an admin, who asked for work is a name.
  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: "Export orders as CSV" })
      .getByText(/^requested by Grace Hopper/)
  ).toBeVisible();
  // The member's suggestion, as the admin sees it: by name, in its history too.
  const suggestion = lane(page, "Triage").getByRole("listitem").filter({ hasText: "Search orders by email" });
  await expect(suggestion.getByText(/^suggested by Morgan Member/)).toBeVisible();
  await suggestion.getByRole("link", { name: "Search orders by email" }).click();
  await expect(page.getByText("suggested by Morgan Member <member@example.com> (sales)")).toBeVisible();
  await expect(page.getByText("added as triage, from the web app by Morgan Member")).toBeVisible();

  // A proposal's page leads to where it's decided.
  const receiptId = String(receipt?.id);
  await page.goto(`/t/shop/tasks/${receiptId}`);
  await page.getByRole("link", { name: `Decide on #${receiptId}` }).click();
  await expect(page).toHaveURL(new RegExp(`/t/shop/proposals#task-${receiptId}$`));
  await expect(page.getByRole("button", { name: `Approve #${receiptId}` })).toBeVisible();

  // Triage waits for the planner, but an admin can decide one that can't wait.
  await page.goto("/t/shop/proposals");
  await expect(page.getByRole("heading", { name: /^In triage/ })).toBeVisible();
  const triaged = String((await graph.collection("tasks").findOne({ team: "shop", title: "Search orders by email" }))?.id);
  await expect(page.getByRole("button", { name: `Reject #${triaged}` })).toBeVisible();
  await page.goto(`/t/shop/tasks/${triaged}`);
  await expect(page.getByRole("link", { name: `Decide on #${triaged}` })).toBeVisible();

  // Everything done, and what was turned down, on request.
  await page.goto("/t/shop/board");
  await lane(page, "Done").getByRole("link", { name: "show them" }).click();
  await expect(page).toHaveURL(/\/t\/shop\/board\?done=all$/);
  await expect(lane(page, "Rejected").getByRole("link", { name: "Dark mode for receipts" })).toBeVisible();
});

test("a contributor neither sees the work nor adds to it, by page or by calling the action", async () => {
  const { page } = contributor;
  for (const path of ["/t/shop/board", "/t/shop/add", "/t/shop/tasks/1"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Not found" }), path).toBeVisible();
  }
  await page.goto("/t/shop");
  await expect(page.getByRole("link", { name: "Board", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Suggest a task" })).toHaveCount(0);
  // The add form's own fields, as the admin's page has them, posted as a browser without scripts would post them: the
  // admin's adds a task, the contributor's adds nothing.
  await admin.page.goto("/t/shop/add");
  const hidden = await admin.page
    .locator("main form input[type=hidden]")
    .evaluateAll((inputs) => inputs.map((input) => [(input as HTMLInputElement).name, (input as HTMLInputElement).value]));
  const post = (as: Page, title: string) =>
    as.request.post("/t/shop/add", {
      multipart: { ...Object.fromEntries(hidden), team: "shop", title, kind: "feature", body: "This should reach the graph only from an admin." },
      headers: { origin: state().baseURL },
    });
  await post(admin.page, "An admin's task, posted");
  await post(page, "Sneaky task");
  const { graph } = await databases();
  expect(await graph.collection("tasks").findOne({ team: "shop", title: "An admin's task, posted" })).toMatchObject({
    status: "proposed",
    by: "operator",
  });
  expect(await graph.collection("tasks").findOne({ team: "shop", title: "Sneaky task" })).toBeNull();
});

test("the admin pauses the team after the work under way, reads where it stands, and resumes it with feedback", async () => {
  const { page } = admin;
  const { graph, accounts } = await databases();
  const controls = async (): Promise<Control[]> =>
    (await graph.collection("controls").find({ team: "shop" }).sort({ _id: 1 }).toArray()).map(({ _id, ...c }) => c as unknown as Control);
  const tasks = async (): Promise<Task[]> =>
    (await graph.collection("tasks").find({ team: "shop" }).toArray()).map(({ _id, ...t }) => t as unknown as Task);
  // The lead's watchdog isn't running here: the test reports what it would, from the same functions.
  const report = (status: Record<string, unknown>) =>
    graph
      .collection("teams")
      .updateOne({ _id: "shop" as never }, { $set: { status: { members: {}, planner: "running", at: new Date().toISOString(), ...status } } });
  const panel = page.getByRole("region", { name: "Pause and resume" });

  await page.goto("/t/shop");
  // Closed until asked for: a stop control doesn't greet every visit.
  await expect(panel.getByText("After the work under way")).toBeHidden();
  await panel.getByText("Pause the team").click();
  await expect(panel.getByText("After the work under way")).toBeVisible();
  // A wrong code changes nothing.
  await panel.getByLabel("Code from your authenticator").first().fill("000000");
  await panel.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("That code isn't right");
  expect(await controls()).toEqual([]);
  // The refused form is open again, to correct.
  await expect(panel.getByText("After the work under way")).toBeVisible();

  await panel.getByLabel("Note (optional, for the record and the report)").fill("Let me check the board");
  await panel
    .getByLabel("Code from your authenticator")
    .first()
    .fill(await freshCode(page, state().admin.totpURI));
  await panel.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Asked to pause after the work under way");
  await expect(panel.getByText("waiting for the team's Mac")).toBeVisible();
  const [pause] = await controls();
  const building = (await tasks()).filter((t) => t.status === "building").map((t) => t.id);
  expect(pause).toMatchObject({ kind: "pause", scope: "tasks", tasks: building, note: "Let me check the board", by: expect.stringMatching(/^web:s\d+$/) });

  // The watchdog applies it: pausing, with what's left.
  const hold = holdOf(await controls());
  if (!hold) throw new Error("no hold");
  await report({ state: "pausing", hold: { ...hold, settledAt: null, left: [`#${building[0]} being built`], stuck: [], report: null } });
  await page.reload();
  await expect(panel.getByText(/Pausing after the work under way/)).toBeVisible();
  await expect(panel.getByText(`#${building[0]} being built`)).toBeVisible();
  await expect(panel.getByText("waiting for the team's Mac")).toHaveCount(0);
  await expect(panel.getByText("Pause now instead")).toBeVisible();

  // It settles: paused, and the report says where the team stands.
  const settledAt = new Date().toISOString();
  await report({ state: "paused", hold: { ...hold, settledAt, left: [], stuck: [], report: holdReport(hold, await tasks(), []) } });
  await page.reload();
  await expect(panel.getByText("Where the team stands")).toBeVisible();
  await expect(panel.locator("pre.report")).toContainText("Paused after the work under way");
  await expect(panel.locator("pre.report")).toContainText('("Let me check the board")');

  await panel.getByLabel("Feedback for the planner (optional)").fill("Looks right. Carry on with checkout.");
  await panel.getByLabel("Code from your authenticator").fill(await freshCode(page, state().admin.totpURI));
  await panel.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByRole("status")).toContainText("Asked to resume");
  expect((await controls()).map((c) => [c.kind, c.note])).toEqual([
    ["pause", "Let me check the board"],
    ["resume", "Looks right. Carry on with checkout."],
  ]);
  const audit = await accounts
    .collection("audit")
    .find({ team: "shop", action: { $in: ["team.paused", "team.resumed"] } })
    .sort({ at: 1 })
    .toArray();
  expect(audit.map((e) => [e.action, e.outcome])).toEqual([
    ["team.paused", "refused"],
    ["team.paused", "ok"],
    ["team.resumed", "ok"],
  ]);

  // A contributor posting the same action is refused, and nothing is recorded.
  // Read as the page loads: React drops the fields a browser without scripts posts once it hydrates.
  await page.goto("/t/shop");
  const action = await panel.locator('input[name^="$ACTION_ID_"]').first().getAttribute("name");
  const refused = await contributor.page.request.post("/t/shop", {
    multipart: { [action ?? ""]: "", team: "shop", kind: "pause", scope: "now", code: "123456" },
    headers: { origin: state().baseURL },
    maxRedirects: 0,
  });
  expect(errorOf(refused)).toContain("You can't do that here.");
  expect(await controls()).toHaveLength(2);
  await report({ state: "active", hold: null });
});

test("the admin sees what the team spent: today, this week and in all against the budget, each day, and the costliest work", async () => {
  const { page } = admin;
  const { graph } = await databases();
  const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toLocaleDateString("sv-SE");
  const tasks = (await graph.collection("tasks").find({ team: "shop" }).toArray()) as unknown as Task[];
  const journey = tasks.find((t) => t.kind === "journey");
  const child = tasks.find((t) => t.parent === journey?.id);
  const row = (role: string, task: string | null, cost: number) => ({
    role,
    model: "claude-opus-5-5",
    task,
    requests: 3,
    input: 1,
    output: 1,
    cacheRead: 1,
    cacheWrite: 1,
    cost,
    unpriced: 0,
  });
  const usage = [
    { day: day(9), machine: "studio", rows: [row("planner", null, 4.5)] },
    { day: day(1), machine: "studio", rows: [row("builder", child?.id ?? null, 12.25), row("planner", null, 3)] },
    { day: day(0), machine: "studio", rows: [row("builder", child?.id ?? null, 6)] },
    { day: day(0), machine: "worker", rows: [row("reviewer", child?.id ?? null, 2)] },
  ];
  for (const u of usage)
    await graph
      .collection("usage")
      .updateOne({ _id: `shop:${u.day}:${u.machine}` as never }, { $set: { team: "shop", updatedAt: new Date().toISOString(), ...u } }, { upsert: true });
  await graph.collection("controls").insertOne({
    _id: "shop:k900" as never,
    team: "shop",
    id: "k900",
    version: 1,
    kind: "budget",
    by: "operator",
    at: new Date().toISOString(),
    note: "",
    scope: null,
    tasks: [],
    journeys: [],
    limits: { daily: 10, weekly: null, total: 100, since: new Date(Date.now() - 30 * 86_400_000).toISOString() },
  });
  await graph
    .collection("teams")
    .updateOne(
      { _id: "shop" as never },
      { $set: { "status.spend": { day: day(0), today: 8, week: 21.25, total: 27.75, since: day(30), unpriced: 0, at: new Date().toISOString() } } }
    );

  await page.goto("/t/shop");
  const panel = page.getByRole("region", { name: "Spend" });
  const tiles = panel.locator(".tiles li");
  await expect(tiles.nth(0)).toContainText("Today$8.00");
  await expect(tiles.nth(0)).toContainText("of $10 a day · near the budget");
  await expect(tiles.nth(1)).toContainText("This week$21");
  const since = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${day(30)}T12:00:00Z`));
  await expect(tiles.nth(2)).toContainText(`Since ${since}$28`);
  await expect(panel.locator(".chart .columns li")).toHaveCount(14);
  await expect(panel.locator(".chart")).toContainText("daily budget $10");
  // The tallest day is labelled; each day's value is in its tooltip and the table.
  await expect(panel.locator(".chart .value")).toHaveText("$15");
  await panel.getByText("Each day, as a table").click();
  await expect(panel.locator("table.figures tbody tr")).toHaveCount(14);
  await expect(panel.locator("table.figures tbody tr").last()).toContainText("$8.00");
  await expect(panel.locator(".ranked").first()).toContainText(`#${journey?.id} ${journey?.title}`);
  await expect(panel.locator(".ranked").first().locator("li").first()).toContainText("$20");
  await panel.locator(".chart .columns li").nth(12).focus();
  await expect(panel.locator(".chart .columns li").nth(12).locator(".tip")).toBeVisible();
  await panel.screenshot({ path: "test-results/spend-panel.png" });

  await graph.collection("controls").deleteOne({ _id: "shop:k900" as never });
});

test("the admin sets the budget with a code; a limit left blank is none", async () => {
  const { page } = admin;
  const { graph, accounts } = await databases();
  await page.goto("/t/shop");
  const panel = page.getByRole("region", { name: "Spend" });
  await panel.getByText("Set a budget").click();
  await panel.getByLabel("A day", { exact: true }).fill("12");
  await panel.getByLabel("In all", { exact: true }).fill("$300");
  await panel.getByLabel(/start it again when the next one starts/).check();
  await panel.getByLabel("Code from your authenticator").fill(await freshCode(page, state().admin.totpURI));
  await panel.getByRole("button", { name: "Set the budget" }).click();
  await expect(page.getByRole("status")).toContainText("The budget is $12 a day, none a week, $300 in all.");
  const budget = await graph.collection("controls").findOne({ team: "shop", kind: "budget" }, { sort: { _id: -1 } });
  expect(budget).toMatchObject({ by: expect.stringMatching(/^web:s\d+$/), limits: { daily: 12, weekly: null, total: 300, autoResume: true } });
  expect(await accounts.collection("audit").findOne({ team: "shop", action: "team.budget", outcome: "ok" })).toMatchObject({
    detail: "$12 a day, none a week, $300 in all",
  });
  // The tiles measure against it at once.
  await expect(panel.locator(".tiles li").first()).toContainText("of $12 a day");
  await graph.collection("controls").deleteMany({ team: "shop", kind: "budget" });
});

test("the admin switches between teams, staying on the same page", async () => {
  const { page } = admin;
  await page.goto("/");
  await expect(page.getByRole("listitem").filter({ hasText: "Shop" }).getByRole("link", { name: "Board" })).toBeVisible();
  await page.goto("/t/shop/board");
  // It closes like a menu: on Escape, and on a click elsewhere.
  await page.getByText("Switch team").click();
  await expect(page.getByRole("link", { name: /^Blog/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("link", { name: /^Blog/ })).toBeHidden();
  await page.getByText("Switch team").click();
  await page.getByRole("heading", { name: "Shop", level: 1 }).click();
  await expect(page.getByRole("link", { name: /^Blog/ })).toBeHidden();
  await page.getByText("Switch team").click();
  await page.getByRole("link", { name: /^Blog/ }).click();
  await expect(page).toHaveURL(/\/t\/blog\/board$/);
  await expect(page.getByRole("heading", { name: "Blog", level: 1 })).toBeVisible();
  await expect(lane(page, "Approved").getByRole("link", { name: "Write the launch post" })).toBeVisible();
  // From one task's page, to the other team's list: ids are a team's own.
  await page.goto("/t/blog/tasks/1");
  await page.getByText("Switch team").click();
  await page.getByRole("link", { name: /^Shop/ }).click();
  await expect(page).toHaveURL(/\/t\/shop\/board$/);
});

test("an admin session without its second factor is refused every admin page and action", async ({ browser }) => {
  // The admin adds a passkey, on an authenticator that can verify them (a PIN or biometrics).
  const { page } = admin;
  const cdp = await admin.context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const KEY = {
    protocol: "ctap2",
    transport: "internal",
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  } as const;
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: KEY });
  await page.goto("/account");
  await page.getByLabel("Name it").fill("Test key");
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByRole("button", { name: "Remove Test key" })).toBeVisible();
  const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  expect(credentials).toHaveLength(1);

  // The same passkey, from a browser that asks the authenticator not to verify the person (a client the server can't
  // trust to ask): the assertion has no UV flag, so the session has no second factor.
  const unverified = await newPage(browser);
  const cdp2 = await unverified.context.newCDPSession(unverified.page);
  await cdp2.send("WebAuthn.enable");
  const second = await cdp2.send("WebAuthn.addVirtualAuthenticator", { options: KEY });
  await cdp2.send("WebAuthn.addCredential", { authenticatorId: second.authenticatorId, credential: credentials[0]! });
  await unverified.page.route("**/api/auth/passkey/generate-authenticate-options*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), userVerification: "discouraged" } });
  });
  await unverified.page.goto("/sign-in");
  await unverified.page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(unverified.page).toHaveURL(/\/second-factor$/);
  await expect(unverified.page.getByRole("heading", { name: "Enter your authenticator's code" })).toBeVisible();
  for (const path of ["/", "/t/shop/proposals", "/admin/people", "/account"]) {
    await unverified.page.goto(path);
    await expect(unverified.page, path).toHaveURL(/\/second-factor$/);
  }

  // Its server actions are refused, and nothing changes.
  const { untouched } = state().proposals;
  const decide = await actionIdOn(page, "/t/shop/proposals");
  const { graph } = await databases();
  const response = await unverified.page.request.post("/t/shop/proposals", {
    multipart: { [decide]: "", team: "shop", id: untouched, decision: "approve", text: "" },
    headers: { origin: state().baseURL },
    maxRedirects: 0,
  });
  expect(errorOf(response)).toContain("Enter your authenticator's code first.");
  expect(await graph.collection("tasks").findOne({ _id: `shop:${untouched}` as never })).toMatchObject({ status: "proposed", approval: null });
  // Nor can it raise itself: no new passkeys or backup codes over HTTP.
  for (const [method, path] of [
    ["GET", "/api/auth/passkey/generate-register-options"],
    ["POST", "/api/auth/two-factor/generate-backup-codes"],
  ] as const) {
    const refused = await unverified.page.request.fetch(path, {
      method,
      data: method === "POST" ? { password: "x" } : undefined,
      headers: { origin: state().baseURL },
    });
    expect(refused.status(), path).toBe(403);
  }
  // The passkey as it is now, its signature counter past the one the server has seen (an older one reads as a clone).
  const [used] = (await cdp2.send("WebAuthn.getCredentials", { authenticatorId: second.authenticatorId })).credentials;
  await unverified.context.close();

  // When the authenticator verifies them, the passkey is a second factor.
  const verified = await newPage(browser);
  const cdp3 = await verified.context.newCDPSession(verified.page);
  await cdp3.send("WebAuthn.enable");
  const third = await cdp3.send("WebAuthn.addVirtualAuthenticator", { options: KEY });
  await cdp3.send("WebAuthn.addCredential", { authenticatorId: third.authenticatorId, credential: used! });
  await verified.page.goto("/sign-in");
  await verified.page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(verified.page.getByRole("heading", { name: "Teams", exact: true })).toBeVisible();
  await verified.page.goto("/t/shop/proposals");
  await expect(verified.page.getByRole("heading", { name: "Proposed" })).toBeVisible();
  await verified.context.close();
});

test(`a person sends at most 20 requests a day`, async ({ browser }) => {
  const { context, page } = await newPage(browser);
  await signInByLink(page, state().busy);
  for (let n = 1; n <= 20; n++) {
    await page.goto("/t/shop/requests");
    await page.getByLabel("Title").fill(`Idea ${n}`);
    await page.getByRole("button", { name: "Send the request" }).click();
    await expect(page.getByRole("status")).toContainText("Request sent");
  }
  await page.goto("/t/shop/requests");
  await page.getByLabel("Title").fill("Idea 21");
  await page.getByLabel("What you need, and why").fill("Kept when it's refused.");
  await page.getByRole("button", { name: "Send the request" }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("You've sent 20 requests and suggestions today");
  // What was typed is still there.
  await expect(page.getByLabel("Title")).toHaveValue("Idea 21");
  await expect(page.getByLabel("What you need, and why")).toHaveValue("Kept when it's refused.");
  const { graph } = await databases();
  expect(await graph.collection("requests").countDocuments({ team: "shop", title: /^Idea / })).toBe(20);
  await context.close();
});

test("pages fit a phone's width without scrolling sideways", async ({ browser }) => {
  const { context, page } = await newPage(browser, { storageState: await admin.context.storageState() });
  await page.setViewportSize({ width: 360, height: 740 });
  for (const path of [
    "/",
    "/t/shop",
    "/t/shop/board",
    "/t/shop/add",
    "/t/shop/tasks/1",
    "/t/shop/requests",
    "/t/shop/proposals",
    "/t/shop/inbox",
    "/inbox",
    "/admin/people",
    "/admin/audit",
    "/account",
    "/account/notifications",
  ]) {
    await page.goto(path);
    // The page itself, not a refusal.
    await expect(page.getByRole("heading", { level: 1 }).first(), path).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
  await context.close();
});

test("password sign-in attempts are rate limited (Better Auth's limits, kept in the database)", async ({ request }) => {
  const statuses: number[] = [];
  for (let n = 0; n < 7; n++) {
    const response = await request.post("/api/auth/sign-in/email", {
      data: { email: state().admin.email, password: "not the password" },
      headers: { origin: state().baseURL },
    });
    statuses.push(response.status());
  }
  expect(statuses.at(-1), statuses.join(" ")).toBe(429);
  const { accounts } = await databases();
  expect(await accounts.collection("rateLimit").countDocuments()).toBeGreaterThan(0);
});

test("only the app makes an invitation: a stranger's text never reaches an email, and links go at most once a minute", async ({ request }) => {
  const to = "member@example.com";
  const subjects = () =>
    readFileSync(state().log, "utf8")
      .split("\n")
      .flatMap((line) => (line.includes(`[mail] to=${to} `) ? [/subject=(".*?") link=/.exec(line)?.[1] ?? ""] : []));
  // Sent a link earlier in this run: the cooldown is cleared, so this one goes.
  await (await databases()).accounts.collection("magic_link_sends").deleteMany({ _id: to as never });
  const before = subjects().length;
  const ask = () =>
    request.post("/api/auth/sign-in/magic-link", {
      data: { email: to, metadata: { team: "ACME. URGENT: re-verify at https://evil.example/a6g" } },
      headers: { origin: state().baseURL },
    });
  expect((await ask()).status()).toBe(200);
  await expect.poll(() => subjects().length).toBe(before + 1);
  expect(subjects().at(-1)).toBe(JSON.stringify("Your Anything Factory sign-in link"));
  expect((await ask()).status(), "the same answer").toBe(200);
  await new Promise((done) => setTimeout(done, 1000));
  expect(subjects().length, "no second link within a minute").toBe(before + 1);
});

test("a notice is shown only as the app wrote it", async () => {
  // The admin's session from the start of the story; a forged ?error= shows nothing, the app's own notice shows.
  await admin.page.goto("/t/shop/proposals?error=Your%20session%20expired%2C%20sign%20in%20at%20evil.example");
  await expect(admin.page.getByText("evil.example")).toHaveCount(0);
  await expect(admin.page.getByRole("heading", { level: 1 })).toBeVisible();
});
