// The app end to end, against a local MongoDB seeded with the factory's own functions (seed.ts): one story, in order.
import { readFileSync } from "node:fs";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { actionIdOn, closeDatabases, databases, errorOf, mailsTo, newPage, nextLink, signInAsAdmin, signInByLink, state } from "./helpers.ts";

test.describe.configure({ mode: "serial" });

const CONTRIBUTOR = "casey@example.com";
let admin: { context: BrowserContext; page: Page };
let contributor: { context: BrowserContext; page: Page };

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
  const { context, page } = await newPage(browser);
  await signInByLink(page, state().member);
  await page.goto("/t/shop");
  await expect(page.getByRole("heading", { name: "Board" })).toBeVisible();
  await expect(page.locator(".board").getByText("Export orders as CSV")).toBeVisible();
  await expect(page.locator(".board").getByText("builder on studio")).toBeVisible();
  await expect(page.getByRole("img", { name: "The task graph" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent merges" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Recent merges" }).getByText("Pay by card")).toBeVisible();

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
  await context.close();
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

  // Exactly what e9g task approve and reject write, as the operator.
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
  await expect(unverified.page.getByRole("heading", { name: "Sign in with your second factor" })).toBeVisible();
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
  expect(errorOf(response)).toContain("Sign in again with your authenticator or a passkey first.");
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
  await expect(page.locator("main").getByRole("alert")).toContainText("You've sent 20 requests today");
  // What was typed is still there.
  await expect(page.getByLabel("Title")).toHaveValue("Idea 21");
  await expect(page.getByLabel("What you need, and why")).toHaveValue("Kept when it's refused.");
  const { graph } = await databases();
  expect(await graph.collection("requests").countDocuments({ team: "shop", title: /^Idea / })).toBe(20);
  await context.close();
});

test("pages fit a phone's width without scrolling sideways", async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: state().baseURL,
    storageState: await admin.context.storageState(),
    viewport: { width: 360, height: 740 },
  });
  const page = await context.newPage();
  for (const path of ["/", "/t/shop", "/t/shop/requests", "/t/shop/proposals", "/admin/people", "/account"]) {
    await page.goto(path);
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
      data: { email: to, metadata: { team: "ACME. URGENT: re-verify at https://evil.example/e9g" } },
      headers: { origin: state().baseURL },
    });
  expect((await ask()).status()).toBe(200);
  await expect.poll(() => subjects().length).toBe(before + 1);
  expect(subjects().at(-1)).toBe(JSON.stringify("Your E9G sign-in link"));
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
