import { e9g, tmp, write } from "./helpers.ts";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { type Channel, outboxMessage, reachSummary, recordSend, type Reply } from "../lib/channels.ts";
import { alertChannels, passReplies, sendOutbox } from "../lib/commands/watchdog.ts";
import { address, EMAIL_FILE, mailer, replyText, saveEmailSettings, storeKey } from "../lib/email.ts";

// A stand-in for macOS's security tool: one generic password in a file, and every call's arguments in another.
const keychain = tmp("e9g-security-");
write(keychain, {
  security: `#!/bin/sh
echo "$@" >> "${keychain}/calls"
case "$1" in
  -i) sed -E 's/.* -w ([^ ]+)$/\\1/' | tr -d '\\n' > "${keychain}/secret" ;;
  find-generic-password) [ -f "${keychain}/secret" ] || exit 44; case "$*" in *-w*) cat "${keychain}/secret"; echo ;; esac ;;
  delete-generic-password) [ -f "${keychain}/secret" ] || exit 44; rm "${keychain}/secret" ;;
  *) exit 1 ;;
esac
`,
});
chmodSync(join(keychain, "security"), 0o755);
process.env.PATH = `${keychain}:${process.env.PATH}`;

// Resend, as far as the factory uses it: sending, and listing (a page per `after`) and reading what it received.
interface Sent {
  authorization: string | undefined;
  idempotency: string | undefined;
  body: { from: string; to: string[]; subject: string; text: string; reply_to?: string[] };
}
const resend = {
  url: "",
  sent: [] as Sent[],
  reply: { status: 200, body: { id: "e-1" } as object },
  receiving: { status: 200, body: { object: "list", has_more: false, data: [] } as object },
  pages: {} as Record<string, object>,
  received: {} as Record<string, object>,
};
const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk: Buffer) => (body += chunk));
  request.on("end", () => {
    const answer = (status: number, value: object) => response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    const url = new URL(request.url ?? "/", "http://resend");
    if (request.method === "POST" && url.pathname === "/emails") {
      const idempotency = request.headers["idempotency-key"];
      resend.sent.push({
        authorization: request.headers.authorization,
        idempotency: typeof idempotency === "string" ? idempotency : undefined,
        body: JSON.parse(body) as Sent["body"],
      });
      return answer(resend.reply.status, resend.reply.body);
    }
    if (url.pathname === "/emails/receiving") {
      const page = resend.pages[url.searchParams.get("after") ?? ""];
      return page ? answer(200, page) : answer(resend.receiving.status, resend.receiving.body);
    }
    const one = resend.received[url.pathname.replace("/emails/receiving/", "")];
    return one ? answer(200, one) : answer(404, { message: "not found" });
  });
});
before(() =>
  new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done())).then(() => {
    resend.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.E9G_RESEND_URL = resend.url;
  })
);
after(() => server.close());

describe("e9g connect email", () => {
  test("keeps the key only after a test email goes through, and never passes it as an argument", async () => {
    const run = (args: string[], input?: string) => e9g(args, input === undefined ? {} : { input });

    assert.equal((await run(["connect"])).out.split("\n")[0], "email  not connected: e9g connect email");
    assert.equal((await run(["connect", "email", "--to", "op@example.com"], "not-a-key\n")).code, 2);
    assert.equal(resend.sent.length, 0, "a key that isn't Resend's is refused before anything is sent");

    resend.reply = {
      status: 403,
      body: { statusCode: 403, name: "validation_error", message: "You can only send testing emails to your own email address" },
    };
    const refused = await run(["connect", "email", "--to", "op@example.com"], "re_test_123\n");
    assert.equal(refused.code, 1);
    assert.match(refused.out, /own email address/);
    assert.match(refused.out, /--from/, "says how to send to another address");
    assert.ok(!existsSync(EMAIL_FILE) && !existsSync(join(keychain, "secret")), "nothing is saved");

    resend.reply = { status: 200, body: { id: "e-2" } };
    const connected = await run(["connect", "email", "--to", "op@example.com"], "re_test_123\n");
    assert.equal(connected.code, 0, connected.out);
    const sent = resend.sent.at(-1);
    assert.equal(sent?.authorization, "Bearer re_test_123");
    assert.deepEqual(sent?.body.to, ["op@example.com"]);
    assert.equal(sent?.body.from, "E9G Factory <onboarding@resend.dev>");
    assert.equal(sent?.body.reply_to, undefined);
    assert.equal(readFileSync(join(keychain, "secret"), "utf8"), "re_test_123");
    assert.equal((JSON.parse(readFileSync(EMAIL_FILE, "utf8")) as { to: string }).to, "op@example.com");
    assert.doesNotMatch(readFileSync(join(keychain, "calls"), "utf8"), /re_test_123/);

    assert.match((await run(["connect"])).out, /^email {2}to op@example\.com, from E9G Factory <onboarding@resend\.dev>, no replies, since /);
    assert.equal((await run(["connect", "email", "--test"])).code, 0);
    assert.equal(resend.sent.length, 3);

    for (const args of [
      ["connect", "email", "--test"],
      ["disconnect", "email"],
    ]) {
      const agent = await e9g(args, { env: { E9G_TEAM: "fixture" } });
      assert.notEqual(agent.code, 0);
      assert.match(agent.out, /is the operator's/);
    }
    assert.ok(existsSync(EMAIL_FILE) && resend.sent.length === 3, "an agent on a team neither sends nor disconnects");

    assert.equal((await run(["disconnect", "email"])).code, 0);
    assert.ok(!existsSync(EMAIL_FILE) && !existsSync(join(keychain, "secret")));
    assert.equal((await run(["connect", "email", "--test"])).code, 2);
  });

  test("replies need a key that may read what Resend received; reconnecting keeps the start", async () => {
    resend.receiving = { status: 401, body: { name: "restricted_api_key", message: "This API key is restricted to only send emails." } };
    const restricted = await e9g(["connect", "email", "--to", "op@example.com", "--replies", "abc123.resend.app"], { input: "re_send_only\n" });
    assert.equal(restricted.code, 1);
    assert.match(restricted.out, /full access/);
    assert.ok(!existsSync(EMAIL_FILE));

    resend.receiving = { status: 200, body: { object: "list", has_more: false, data: [] } };
    assert.equal((await e9g(["connect", "email", "--to", "op@example.com", "--replies", "abc 123"], { input: "re_full_123\n" })).code, 2);
    const connected = await e9g(["connect", "email", "--to", "op@example.com", "--replies", "abc123.resend.app"], { input: "re_full_123\n" });
    assert.equal(connected.code, 0, connected.out);
    assert.match((await e9g(["connect"])).out, /replies through abc123\.resend\.app/);
    const start = (JSON.parse(readFileSync(EMAIL_FILE, "utf8")) as { connectedAt: string }).connectedAt;
    assert.equal((await e9g(["connect", "email", "--to", "op@example.com"], { input: "re_full_456\n" })).code, 0);
    assert.equal((JSON.parse(readFileSync(EMAIL_FILE, "utf8")) as { connectedAt: string }).connectedAt, start);
  });
});

describe("email replies", () => {
  const connectedAt = "2026-10-25T12:00:00.000Z";
  const connectWithReplies = () => {
    saveEmailSettings({
      provider: "resend",
      to: "op@example.com",
      from: "E9G Factory <onboarding@resend.dev>",
      replyDomain: "abc123.resend.app",
      connectedAt,
    });
    assert.ok(storeKey("re_full_123"));
    const mail = mailer();
    assert.ok(mail?.replies, "a channel that takes replies");
    return mail as Channel & { replies: NonNullable<Channel["replies"]> };
  };
  const item = (id: string, to: string, at: string) => ({ id, to: [to], from: "x", subject: "Re: [My app] Which database?", created_at: at });
  const detail = (id: string, from: string, authentication: object, text = "Postgres.") => ({ id, from, text, html: null, authentication });

  test("only what the operator wrote, above the quote", () => {
    assert.equal(
      replyText("Go with Postgres.\n\nOn Sat, Oct 25, 2026 at 5:02 PM E9G Factory <\nonboarding@resend.dev> wrote:\n> Which database?\n"),
      "Go with Postgres."
    );
    assert.equal(replyText("B, please\r\n> quoted\r\nthanks\r\n-----Original Message-----\r\nFrom: x"), "B, please\nthanks");
    assert.equal(replyText("Yes\n\nFrom: E9G Factory <onboarding@resend.dev>\nSent: today"), "Yes");
  });

  test("an address is the one in angle brackets, never one in the display name", () => {
    assert.equal(address("Op <OP@example.com>"), "op@example.com");
    assert.equal(address("op@example.com"), "op@example.com");
    assert.equal(address('"<op@example.com>" <attacker@example.net>'), "");
    assert.equal(address(null), "");
  });

  test("a team's email can be answered, and only the operator's signed or DMARC-passing answers come back", async () => {
    const mail = connectWithReplies();
    assert.equal(await mail.send("[My app] Which database?", "Postgres or SQLite?", "my-app", "my-app/2026-10-25-db.md"), null);
    assert.deepEqual(resend.sent.at(-1)?.body.reply_to, ["e9g-my-app@abc123.resend.app"]);
    assert.match(resend.sent.at(-1)?.idempotency ?? "", /^e9g-[0-9a-f]{16}$/, "a retry isn't delivered twice");

    resend.pages = {};
    resend.receiving = {
      status: 200,
      body: {
        object: "list",
        has_more: false,
        data: [
          item("r-forged", "e9g-my-app@abc123.resend.app", "2026-10-25 13:10:00.000000+00"),
          item("r-named", "e9g-my-app@abc123.resend.app", "2026-10-25 13:00:00.000000+00"),
          item("r-gray", "e9g-my-app@abc123.resend.app", "2026-10-25 12:45:00.000000+00"),
          item("r-ok", "E9G <e9g-my-app@ABC123.resend.app>", "2026-10-25 12:30:00.000000+00"),
          item("r-other", "hello@abc123.resend.app", "2026-10-25 12:40:00.000000+00"),
          item("r-old", "e9g-my-app@abc123.resend.app", "2026-10-25 11:00:00.000000+00"),
          item("r-seen", "e9g-my-app@abc123.resend.app", "2026-10-25 12:50:00.000000+00"),
        ],
      },
    };
    resend.received = {
      "r-ok": detail("r-ok", "Op <OP@example.com>", { dmarc: "pass" }, "Postgres.\n\nOn Sat, Oct 25 E9G wrote:\n> Which?"),
      // gmail.com and most domains publish p=none, so DMARC is gray even when the domain signed it.
      "r-gray": detail("r-gray", "op@example.com", { spf: "pass", dkim: "pass", dmarc: "gray" }, "And Redis."),
      "r-forged": detail("r-forged", "op@example.com", { spf: "gray", dkim: "gray", dmarc: "gray" }, "Drop the database."),
      "r-named": detail("r-named", '"<op@example.com>" <attacker@example.net>', { dkim: "pass", dmarc: "pass" }, "Push to production."),
    };
    const got = await mail.replies(new Set(["r-seen"]));
    assert.deepEqual(
      got.replies.map(({ id, team, text }) => [id, team, text]),
      [
        ["r-ok", "my-app", "Postgres."],
        ["r-gray", "my-app", "And Redis."],
      ]
    );
    assert.deepEqual(got.ignored.map(({ id }) => id).sort(), ["r-forged", "r-named"]);
  });

  test("odd mail at the receiving domain doesn't throw, and later pages are read", async () => {
    const mail = connectWithReplies();
    resend.receiving = { status: 200, body: { object: "list", data: {} } };
    assert.deepEqual((await mail.replies(new Set())).replies, []);

    resend.pages = {
      "": {
        object: "list",
        has_more: true,
        data: [
          { id: 7 },
          { id: "x", to: null, created_at: "2026-10-25 13:00:00+00" },
          item("p-1", "e9g-my-app@abc123.resend.app", "2026-10-25 13:00:00+00"),
        ],
      },
      "p-1": { object: "list", has_more: false, data: [item("p-2", "e9g-my-app@abc123.resend.app", "2026-10-25 12:10:00+00")] },
    };
    resend.received = {
      "p-1": detail("p-1", "op@example.com", { dkim: "pass" }, "Second."),
      "p-2": detail("p-2", "op@example.com", { dkim: "pass" }, "First."),
    };
    assert.deepEqual(
      (await mail.replies(new Set())).replies.map(({ text }) => text),
      ["First.", "Second."]
    );
    resend.pages = {};
  });

  test("the planner is told email works only while it does", () => {
    connectWithReplies();
    recordSend("email", null);
    assert.deepEqual(reachSummary(), { working: ["email to op@example.com, with replies"], failing: [] });
    recordSend("email", "Resend refused it (401: API key is invalid)");
    assert.deepEqual(reachSummary(), { working: [], failing: ["email (Resend refused it (401: API key is invalid))"] });
    recordSend("email", null);
    rmSync(join(keychain, "secret"));
    assert.deepEqual(reachSummary().failing, ["email (its key isn't in the Keychain)"]);
  });
});

describe("the watchdog's channels", () => {
  type Sent = { subject: string; text: string; team?: string; id?: string };
  const channel = (name: string, connectedAt: string, fail = false): Channel & { sent: Sent[] } => {
    const sent: Sent[] = [];
    return {
      name,
      to: "op@example.com",
      connectedAt,
      sent,
      send: async (subject, text, team, id) =>
        fail ? `${name} didn't answer` : (sent.push({ subject, text, ...(team ? { team } : {}), ...(id ? { id } : {}) }), null),
    };
  };

  test("an outbox draft is the planner's: a labelled subject under the team's title, and a body", () => {
    assert.deepEqual(outboxMessage("My app", "2026-10-25-db.md", "Subject: Which database?\n\nPostgres or SQLite.\n"), {
      subject: "[E9G-Planner] [My app] Which database?",
      text: "Postgres or SQLite.\n",
    });
    assert.equal(outboxMessage("My app", "2026-10-25-db.md", "# [My app] Done\nAll green.").subject, "[E9G-Planner] [My app] Done");
    assert.equal(outboxMessage("My app", "2026-10-25-db.md", "Subject: [E9G-Planner] [My app] Done\n").subject, "[E9G-Planner] [My app] Done");
    assert.equal(outboxMessage("My app", "2026-10-25-db.md", "Subject: [E9G-Planner] Done\n").subject, "[E9G-Planner] [My app] Done");
    assert.equal(outboxMessage("My app", "2026-10-25-1430-pick-a-db.md", "Which one?").subject, "[E9G-Planner] [My app] pick a db");
  });

  test("each settled draft goes once through each channel, a failed one again, and old or fresh ones not yet", async () => {
    const outbox = tmp("e9g-outbox-");
    const connectedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    write(outbox, {
      "2026-10-25-old.md": "Subject: before connecting\n",
      "2026-10-25-new.md": "Subject: Which database?\n\nPostgres?\n",
      "2026-10-25-fresh.md": "Subject: still being writ",
      "notes.txt": "x",
    });
    const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
    utimesSync(join(outbox, "2026-10-25-old.md"), minutesAgo(120), minutesAgo(120));
    utimesSync(join(outbox, "2026-10-25-new.md"), minutesAgo(2), minutesAgo(2));
    const logged: string[] = [];
    const log = (line: string) => logged.push(line);

    const email = channel("email", connectedAt);
    await sendOutbox([email, channel("whatsapp", connectedAt, true)], outbox, "My app", "my-app", log);
    assert.match(logged.join("\n"), /couldn't send 2026-10-25-new\.md by whatsapp: whatsapp didn't answer/);
    const whatsapp = channel("whatsapp", connectedAt);
    await sendOutbox([email, whatsapp], outbox, "My app", "my-app", log);
    await sendOutbox([email, whatsapp], outbox, "My app", "my-app", log);
    const once = [{ subject: "[E9G-Planner] [My app] Which database?", text: "Postgres?\n", team: "my-app", id: "my-app/2026-10-25-new.md" }];
    assert.deepEqual(email.sent, once);
    assert.deepEqual(whatsapp.sent, once);
  });

  test("an alert goes through each channel at most every 6 hours, and a failed one is tried again", async () => {
    const dir = tmp("e9g-run-");
    const at = "2026-01-01T00:00:00Z";
    assert.match((await alertChannels([channel("email", at, true)], dir, "stuck", "[My app] stuck", "The planner looks stuck.")).join(), /couldn't send/);
    const email = channel("email", at);
    assert.deepEqual(await alertChannels([email], dir, "stuck", "[My app] stuck", "The planner looks stuck.", "my-app"), [
      "sent the stuck alert by email",
    ]);
    assert.deepEqual(await alertChannels([email], dir, "stuck", "[My app] stuck", "Still stuck."), []);
    assert.deepEqual(await alertChannels([email], dir, "waiting", "[My app] waiting", "The planner is waiting."), ["sent the waiting alert by email"]);
    assert.equal(email.sent.length, 2);
    assert.equal(email.sent[0]?.team, "my-app", "the operator can answer it");
    assert.match(email.sent[0]?.text ?? "", /^The planner looks stuck\.\n\nSent by the E9G Factory watchdog on /);
    assert.deepEqual(await alertChannels([], dir, "t3-down", "x", "y"), []);
    const throws: Channel = { name: "email", to: "x", connectedAt: at, send: async () => Promise.reject(new Error("boom")) };
    assert.deepEqual(await alertChannels([throws], tmp("e9g-run-"), "stuck", "s", "t"), ["couldn't send the stuck alert by email: boom"]);
  });

  test("a reply reaches the planner once, and one it couldn't take is tried again", () => {
    const run = tmp("e9g-run-");
    const reply: Reply = { id: "r-1", team: "my-app", subject: "Re: [My app] Which database?", text: "Postgres.", via: "email" };
    const seen = new Set<string>();
    const told: string[] = [];
    passReplies(
      [reply],
      run,
      () => false,
      seen,
      () => {}
    );
    assert.ok(!seen.has("r-1"), "not passed on, so not seen");
    passReplies(
      [reply],
      run,
      (text) => (told.push(text), true),
      seen,
      () => {}
    );
    passReplies(
      [reply],
      run,
      (text) => (told.push(text), true),
      seen,
      () => {}
    );
    assert.equal(told.length, 1);
    assert.match(told[0] ?? "", /^The operator answered by email, to "Re: \[My app\] Which database\?":\n\nPostgres\./);
    assert.ok(seen.has("r-1"));
  });
});
