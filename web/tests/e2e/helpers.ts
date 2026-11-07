// What the end-to-end tests share: the seeded world, the test database, sign-in links from the server's log, and
// signing in each way.
import { readFileSync } from "node:fs";
import { type APIResponse, type Browser, type BrowserContext, expect, type Page } from "@playwright/test";
import { type Db, MongoClient } from "mongodb";
import { DEFAULT_IP, ORIGIN_SECRET } from "../../playwright.config.ts";
import { totpCode } from "../../server/totp.ts";
import type { World } from "./seed.ts";

export interface State extends World {
  mongoUri: string;
  a6gDatabase: string;
  authDatabase: string;
  log: string;
  baseURL: string;
}
export const state = (): State => JSON.parse(readFileSync(process.env.E2E_STATE ?? "", "utf8")) as State;

let client: MongoClient | null = null;
export async function databases(): Promise<{ graph: Db; accounts: Db }> {
  client ??= await new MongoClient(state().mongoUri).connect();
  return { graph: client.db(state().a6gDatabase), accounts: client.db(state().authDatabase) };
}
export async function closeDatabases(): Promise<void> {
  await client?.close();
  client = null;
}

// The emails logged to `to` so far (MAIL_LOG), oldest first.
export function mailsTo(to: string): string[] {
  return readFileSync(state().log, "utf8")
    .split("\n")
    .flatMap((line) => {
      const match = /\[mail\] to=(\S+) subject=.* link=(\S+)$/.exec(line);
      return match && match[1] === to ? [match[2] ?? ""] : [];
    });
}
// The next link emailed to `to`, after the `seen` already there.
export async function nextLink(to: string, seen: number): Promise<string> {
  await expect.poll(() => mailsTo(to).length, { message: `an email to ${to}` }).toBeGreaterThan(seen);
  return mailsTo(to)[seen] ?? "";
}

// A browser of its own, coming from `ip` (as the CDN would say), optionally with a session already in it.
export async function newPage(
  browser: Browser,
  { ip = DEFAULT_IP, storageState }: { ip?: string; storageState?: Awaited<ReturnType<BrowserContext["storageState"]>> } = {}
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: state().baseURL,
    extraHTTPHeaders: { "x-a6g-viewer-ip": ip, "x-a6g-origin": ORIGIN_SECRET },
    ...(storageState ? { storageState } : {}),
  });
  return { context, page: await context.newPage() };
}

// The newest link emailed to `to` that `matches`, after `seen` emails.
export async function nextLinkLike(to: string, seen: number, matches: RegExp): Promise<string> {
  await expect
    .poll(
      () =>
        mailsTo(to)
          .slice(seen)
          .filter((link) => matches.test(link)).length,
      { message: `an email to ${to}` }
    )
    .toBeGreaterThan(0);
  return (
    mailsTo(to)
      .slice(seen)
      .filter((link) => matches.test(link))
      .at(-1) ?? ""
  );
}

// An authenticator's code, never the one used last (a code works once in its 30 seconds).
const lastCodes = new Map<string, string>();
export async function freshCode(page: Page, uri: string): Promise<string> {
  let code = totpCode(uri);
  while (code === lastCodes.get(uri)) {
    await page.waitForTimeout(1000);
    code = totpCode(uri);
  }
  lastCodes.set(uri, code);
  return code;
}

// Signs in by a link: asks for one on the sign-in page and opens it.
export async function signInByLink(page: Page, email: string): Promise<void> {
  const seen = mailsTo(email).length;
  await page.goto("/sign-in");
  await page.getByLabel("Email", { exact: true }).first().fill(email);
  await page.getByRole("button", { name: "Email me a link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await page.goto(await nextLink(email, seen));
}

let lastCode = "";
// An admin signs in with the password and then the authenticator's code (a fresh one each time), or a backup code.
// From an address they haven't confirmed, they land on the confirmation page instead of Teams (`confirm`).
export async function signInAsAdmin(page: Page, { backupCode, confirm = false }: { backupCode?: string; confirm?: boolean } = {}): Promise<void> {
  const { admin } = state();
  await page.goto("/sign-in");
  await page.getByText("Admins: password and authenticator").click();
  const form = page.locator("details form");
  await form.getByLabel("Email").fill(admin.email);
  await form.getByLabel("Password").fill(admin.password);
  await form.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Your authenticator's code" })).toBeVisible();
  if (backupCode) {
    await page.getByRole("button", { name: "Use a backup code instead" }).click();
    await page.getByLabel("Backup code").fill(backupCode);
  } else {
    let code = totpCode(admin.totpURI);
    while (code === lastCode) {
      await page.waitForTimeout(1000);
      code = totpCode(admin.totpURI);
    }
    lastCode = code;
    await page.getByLabel("6-digit code").fill(code);
  }
  await page.getByRole("button", { name: "Verify" }).click();
  if (confirm) await expect(page.getByRole("heading", { name: "Confirm it's you" })).toBeVisible();
  else await expect(page.getByRole("heading", { name: "Teams", exact: true })).toBeVisible();
}

// A server action's id, from a form on a page that has it: the same id answers wherever it's posted.
export async function actionIdOn(page: Page, path: string): Promise<string> {
  await page.goto(path);
  const name = await page.locator('form input[type="hidden"][name^="$ACTION_ID_"]').first().getAttribute("name");
  expect(name).toBeTruthy();
  return name ?? "";
}

// What a server action's redirect says went wrong (?error=…), or "" when it went to no error.
export const errorOf = (response: APIResponse): string => new URL(response.headers()["location"] ?? "/", state().baseURL).searchParams.get("error") ?? "";
