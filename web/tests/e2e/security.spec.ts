// Sign-in security end to end, after the main story (app.spec.ts) on the same server and database: the CDN's secret,
// a new IP address confirmed by email (and "it wasn't me"), an authenticator for someone who isn't an admin, and the
// audit log. Each test comes from addresses of its own, so the main story's rate limits don't reach it.
import { expect, test } from "@playwright/test";
import { databases, freshCode, mailsTo, newPage, nextLink, nextLinkLike, signInAsAdmin, state } from "./helpers.ts";
import { closeDatabases } from "./helpers.ts";

test.describe.configure({ mode: "serial" });
test.afterAll(async () => {
  await closeDatabases();
});

const CONFIRM_LINK = /\/sign-in\/confirm\?token=/;
let adminState: Awaited<ReturnType<import("@playwright/test").BrowserContext["storageState"]>>;

// A sign-in link for `email` from `ip`, with the one-a-minute limit cleared (the main story sent some just now).
async function signInByLinkFrom(page: import("@playwright/test").Page, email: string): Promise<void> {
  await (await databases()).accounts.collection("magic_link_sends").deleteMany({ _id: email as never });
  const seen = mailsTo(email).length;
  await page.goto("/sign-in");
  await page.getByLabel("Email", { exact: true }).first().fill(email);
  await page.getByRole("button", { name: "Email me a link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await page.goto(await nextLink(email, seen));
}

test("only requests through the CDN reach the app; its health check is open", async () => {
  // Plain fetch: Playwright's own request contexts carry the test config's headers, the CDN's secret among them.
  const base = state().baseURL;
  expect((await fetch(`${base}/sign-in`, { redirect: "manual" })).status).toBe(403);
  // Nor by looking like a prefetch, which Next could otherwise let past the proxy.
  const prefetches: Record<string, string>[] = [{ "next-router-prefetch": "1" }, { purpose: "prefetch" }];
  for (const prefetch of prefetches)
    expect((await fetch(`${base}/t/shop`, { redirect: "manual", headers: { ...prefetch, "x-a6g-viewer-ip": "10.9.8.7" } })).status).toBe(403);
  const forged = await fetch(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base, "x-a6g-viewer-ip": "10.9.8.7", "x-a6g-origin": "guessed" },
    body: JSON.stringify({ email: "x@example.com", password: "x" }),
  });
  expect(forged.status).toBe(403);
  const health = await fetch(`${base}/api/health`);
  expect(health.status).toBe(200);
  expect(await health.text()).toBe("ok");
});

test("an admin signing in from a new IP address confirms it by email first; the link works once", async ({ browser }) => {
  const { admin } = state();
  const seen = mailsTo(admin.email).length;
  const away = await newPage(browser, { ip: "203.0.113.20" });
  await signInAsAdmin(away.page, { confirm: true });
  await expect(away.page).toHaveURL(/\/confirm-sign-in$/);
  await expect(away.page.getByText("203.0.113.20")).toBeVisible();

  // Nothing opens meanwhile: pages, server actions, Better Auth over HTTP.
  await away.page.goto("/t/shop");
  await expect(away.page).toHaveURL(/\/confirm-sign-in$/);
  expect((await away.page.request.get("/api/auth/list-sessions")).status()).toBe(403);

  // The email, opened on a phone that isn't signed in: what signed in, from where; a button answers.
  const link = await nextLinkLike(admin.email, seen, CONFIRM_LINK);
  const phone = await newPage(browser, { ip: "192.0.2.44" });
  await phone.page.goto(link);
  await expect(phone.page.getByRole("heading", { name: "Was this you?" })).toBeVisible();
  await expect(phone.page.getByText("203.0.113.20")).toBeVisible();
  await phone.page.getByRole("button", { name: "Yes, it was me" }).click();
  await expect(phone.page.getByRole("heading", { name: "Confirmed" })).toBeVisible();
  await phone.page.goto(link);
  await expect(phone.page.getByRole("heading", { name: "This link has expired" })).toBeVisible();
  await phone.context.close();

  await away.page.getByRole("link", { name: "continue" }).click();
  await expect(away.page.getByRole("heading", { name: "Teams", exact: true })).toBeVisible();
  adminState = await away.context.storageState();

  // Recorded: the sign-in by its method and address, the email, the answer and where it came from.
  const { accounts } = await databases();
  const events = await accounts.collection("audit").find({ email: admin.email, ip: "203.0.113.20" }).sort({ _id: 1 }).toArray();
  expect(events.map((e) => [e.action, e.outcome])).toEqual(
    expect.arrayContaining([
      ["sign-in", "ok"],
      ["ip.challenged", "ok"],
      ["ip.confirmed", "ok"],
    ])
  );
  expect(events.find((e) => e.action === "sign-in")?.detail).toBe("password and authenticator");
  expect(events.find((e) => e.action === "ip.confirmed")?.detail).toMatch(/^answered from 192\.0\.2\.44/);
  // The session records its address too.
  const user = await accounts.collection("user").findOne({ email: admin.email });
  expect(await accounts.collection("session").countDocuments({ userId: user?._id, ipAddress: "203.0.113.20" })).toBe(1);
  await away.context.close();
});

test("a session taken somewhere new waits for its person; “it wasn't me” ends every session they have", async ({ browser }) => {
  const email = state().member;
  // An email link confirms the address it's opened from at once.
  const home = await newPage(browser, { ip: "203.0.113.30" });
  await signInByLinkFrom(home.page, email);
  await expect(home.page.getByRole("heading", { name: "Teams", exact: true })).toBeVisible();
  const { accounts } = await databases();
  const user = await accounts.collection("user").findOne({ email });
  expect(await accounts.collection("known_ips").findOne({ userId: String(user?._id), ip: "203.0.113.30" })).toMatchObject({ via: "email link" });

  // The same cookie, from somewhere else: it waits, and the person is emailed.
  const seen = mailsTo(email).length;
  const thief = await newPage(browser, { ip: "192.0.2.99", storageState: await home.context.storageState() });
  await thief.page.goto("/t/shop/board");
  await expect(thief.page).toHaveURL(/\/confirm-sign-in$/);
  await expect(thief.page.getByRole("link", { name: "Board" })).toHaveCount(0);

  const link = await nextLinkLike(email, seen, CONFIRM_LINK);
  await home.page.goto(link);
  await expect(home.page.getByText("192.0.2.99")).toBeVisible();
  await home.page.getByRole("button", { name: /It wasn't me/ }).click();
  await expect(home.page.getByRole("heading", { name: "Every session has ended" })).toBeVisible();

  // Both are signed out.
  for (const { page } of [thief, home]) {
    await page.goto("/");
    await expect(page).toHaveURL(/\/sign-in/);
  }
  expect(await accounts.collection("session").countDocuments({ userId: user?._id })).toBe(0);
  expect(await accounts.collection("known_ips").countDocuments({ userId: String(user?._id), ip: "192.0.2.99" })).toBe(0);
  expect(await accounts.collection("audit").findOne({ action: "ip.denied", email })).toMatchObject({ ip: "192.0.2.99", outcome: "ok" });
  await thief.context.close();
  await home.context.close();
});

test("anyone can turn on an authenticator; then every sign-in asks for its code, and a wrong one is refused", async ({ browser }) => {
  const email = state().busy;
  const first = await newPage(browser, { ip: "203.0.113.40" });
  await signInByLinkFrom(first.page, email);
  await first.page.goto("/account");
  await first.page.getByRole("button", { name: "Set up an authenticator" }).click();
  await expect(first.page.getByRole("img", { name: "QR code for your authenticator app" })).toBeVisible();
  const key = (await first.page.locator("code.key").textContent()) ?? "";
  const uri = `otpauth://totp/A6G?secret=${key}`;
  await first.page.getByLabel("6-digit code").fill("123456");
  await first.page.getByRole("button", { name: "Turn it on" }).click();
  await expect(first.page.locator("main").getByRole("alert")).toContainText("That code isn't right");
  await first.page.getByLabel("6-digit code").fill(await freshCode(first.page, uri));
  await first.page.getByRole("button", { name: "Turn it on" }).click();
  await expect(first.page.getByRole("status")).toContainText("Your authenticator is on");
  await expect(first.page.locator(".codes span")).toHaveCount(10);
  await first.context.close();

  // An email link now needs the code as well.
  const second = await newPage(browser, { ip: "203.0.113.40" });
  await signInByLinkFrom(second.page, email);
  await expect(second.page).toHaveURL(/\/second-factor$/);
  await second.page.goto("/t/shop");
  await expect(second.page).toHaveURL(/\/second-factor$/);
  // Codes are checked only on that page, where each try counts: never over HTTP by a session, nor its secret read.
  for (const path of ["/api/auth/two-factor/verify-totp", "/api/auth/two-factor/verify-backup-code", "/api/auth/two-factor/get-totp-uri"])
    expect((await second.page.request.post(path, { data: { code: "123456" }, headers: { origin: state().baseURL } })).status(), path).toBe(403);
  await second.page.getByLabel("6-digit code").fill("000000");
  await second.page.getByRole("button", { name: "Continue" }).click();
  await expect(second.page.locator("main").getByRole("alert")).toContainText("That code isn't right");
  await second.page.getByLabel("6-digit code").fill(await freshCode(second.page, uri));
  await second.page.getByRole("button", { name: "Continue" }).click();
  await expect(second.page.getByRole("heading", { name: "Teams", exact: true })).toBeVisible();

  await second.page.goto("/account");
  await expect(second.page.getByRole("region", { name: "Authenticator" }).getByText("on", { exact: true })).toBeVisible();
  const activity = second.page.getByRole("region", { name: "Recent activity" });
  await expect(activity.getByText("Authenticator turned on")).toBeVisible();
  await expect(activity.getByText("Second factor").first()).toBeVisible();
  await expect(second.page.getByRole("region", { name: "Your IP addresses" }).getByText("203.0.113.40")).toBeVisible();
  const { accounts } = await databases();
  expect(await accounts.collection("audit").countDocuments({ email, action: "second-factor", outcome: "failed" })).toBe(1);
  await second.context.close();
});

test("admins read and filter the audit log; nobody else can", async ({ browser }) => {
  const admin = await newPage(browser, { ip: "203.0.113.20", storageState: adminState });
  await admin.page.goto("/admin/audit");
  await expect(admin.page.getByRole("heading", { name: "Audit log" })).toBeVisible();
  const events = admin.page.getByRole("region", { name: "Events" });
  await expect(events.getByText("New IP address confirmed").first()).toBeVisible();
  // Changes to the work are there too, found by what they were (the newest page may be all sign-ins and controls).
  await admin.page.getByLabel("What").selectOption("task.added");
  await admin.page.getByRole("button", { name: "Filter" }).click();
  await expect(events.getByText("Task added").first()).toBeVisible();

  await admin.page.getByLabel("Who (email)").fill(state().member);
  await admin.page.getByLabel("What").selectOption("ip.denied");
  await admin.page.getByRole("button", { name: "Filter" }).click();
  await expect(events.locator("li")).toHaveCount(1);
  await expect(events.getByText(/reported: “it wasn't me”/)).toBeVisible();
  await expect(events.getByText("192.0.2.99")).toBeVisible();
  await admin.context.close();

  // From an address of its own: the main story used up this minute's sign-in links from the default one.
  const contributor = await newPage(browser, { ip: "203.0.113.50" });
  await signInByLinkFrom(contributor.page, "casey@example.com");
  await contributor.page.goto("/admin/audit");
  await expect(contributor.page.getByRole("heading", { name: "Not found" })).toBeVisible();
  await contributor.context.close();
});
