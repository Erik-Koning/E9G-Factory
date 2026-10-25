import { e9g, fakeKeychain } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { outboxMessage, reachSummary, recordSend } from "../lib/channels.ts";
import { refusal } from "../lib/policies.ts";
import { normalize } from "../lib/config.ts";
import { TEMPLATE_BODY, WHATSAPP_FILE, whatsappChannel, whatsappMessage } from "../lib/whatsapp.ts";

const keychain = fakeKeychain();

// Meta's Graph API, as far as the factory uses it: the business number, the account's templates, and messages.
interface Posted {
  path: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}
const meta = {
  posted: [] as Posted[],
  templates: [] as { name: string; language: string; status: string; rejected_reason?: string }[],
  created: "PENDING",
  messages: { status: 200, body: { messages: [{ id: "wamid.1" }] } as object },
};
const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk: Buffer) => (body += chunk));
  request.on("end", () => {
    const answer = (status: number, value: object) => response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    const path = request.url?.split("?")[0] ?? "";
    if (request.headers.authorization !== "Bearer EAAtoken1234567890abcdef")
      return answer(401, { error: { message: "Invalid OAuth access token.", code: 190 } });
    if (request.method === "GET" && path === "/111")
      return answer(200, { verified_name: "Example Rides", display_phone_number: "+1 604-555-0100", id: "111" });
    if (request.method === "GET" && path === "/222/message_templates") return answer(200, { data: meta.templates });
    if (request.method === "POST")
      meta.posted.push({ path, authorization: request.headers.authorization, body: JSON.parse(body) as Record<string, unknown> });
    if (request.method === "POST" && path === "/222/message_templates") {
      meta.templates.push({ name: "e9g_update", language: "en", status: meta.created });
      return answer(200, { id: "t-1", status: meta.created, category: "UTILITY" });
    }
    if (request.method === "POST" && path === "/111/messages") return answer(meta.messages.status, meta.messages.body);
    return answer(404, { error: { message: `no ${request.method} ${path}` } });
  });
});
before(() =>
  new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done())).then(() => {
    process.env.E9G_GRAPH_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  })
);
after(() => server.close());

const TOKEN = "EAAtoken1234567890abcdef\n";
const connect = (...extra: string[]) =>
  e9g(["connect", "whatsapp", "--phone-number-id", "111", "--account-id", "222", "--to", "+1 (604) 555-0123", ...extra], { input: TOKEN });
const sentTemplate = (posted: Posted | undefined) => posted?.body["template"] as { name: string; components: { parameters: { text: string }[] }[] };

describe("e9g connect whatsapp", () => {
  test("adds the template, and while Meta reviews it, connects without sending", async () => {
    const wrong = await e9g(["connect", "whatsapp", "--phone-number-id", "111", "--account-id", "222", "--to", "16045550123"], {
      input: "EAAwrongtoken1234567890\n",
    });
    assert.equal(wrong.code, 1);
    assert.match(wrong.out, /Invalid OAuth access token/);
    assert.ok(!existsSync(WHATSAPP_FILE));

    const pending = await connect();
    assert.equal(pending.code, 0, pending.out);
    assert.match(pending.out, /waiting for Meta's review/);
    const created = meta.posted.find((p) => p.path === "/222/message_templates");
    assert.equal(created?.body["category"], "UTILITY");
    assert.equal((created?.body["components"] as { text: string }[])[0]?.text, TEMPLATE_BODY);
    assert.ok(!meta.posted.some((p) => p.path === "/111/messages"), "nothing is sent before approval");
    assert.equal((JSON.parse(readFileSync(WHATSAPP_FILE, "utf8")) as { to: string }).to, "16045550123");
    assert.equal(readFileSync(join(keychain, "ca.e9g.whatsapp"), "utf8"), "EAAtoken1234567890abcdef");
    assert.doesNotMatch(readFileSync(join(keychain, "calls"), "utf8"), /EAAtoken/);
    assert.match((await e9g(["connect", "whatsapp", "--test"])).out, /template is pending/);
  });

  test("once approved, sends a test through the template, and connect shows it", async () => {
    meta.templates[0]!.status = "APPROVED";
    const approved = await connect();
    assert.equal(approved.code, 0, approved.out);
    assert.match(approved.out, /accepted a test message from Example Rides \(\+1 604-555-0100\)/);
    assert.equal(meta.posted.filter((p) => p.path === "/222/message_templates").length, 1, "the template is added once");
    const message = meta.posted.at(-1);
    assert.equal(message?.path, "/111/messages");
    assert.equal(message?.body["to"], "16045550123");
    assert.equal(sentTemplate(message).name, "e9g_update");
    assert.equal(sentTemplate(message).components[0]?.parameters[0]?.text, "your teams");
    assert.match((await e9g(["connect"])).out, /whatsapp {2}to \+16045550123, from number 111, one way/);

    meta.messages = { status: 400, body: { error: { message: "(#132001) Template name does not exist in the translation", code: 132001 } } };
    const refused = await e9g(["connect", "whatsapp", "--test"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /code 132001/);
    meta.messages = { status: 200, body: { messages: [{ id: "wamid.2" }] } };
  });

  test("a rejected template connects nothing", async () => {
    assert.equal((await e9g(["disconnect", "whatsapp"])).code, 0);
    assert.ok(!existsSync(WHATSAPP_FILE) && !existsSync(join(keychain, "ca.e9g.whatsapp")));
    meta.templates[0]!.status = "REJECTED";
    meta.templates[0]!.rejected_reason = "INCORRECT_CATEGORY";
    const rejected = await connect();
    assert.equal(rejected.code, 1);
    assert.match(rejected.out, /rejected the e9g_update template \(INCORRECT_CATEGORY\)/);
    assert.ok(!existsSync(WHATSAPP_FILE));
    meta.templates[0]!.status = "APPROVED";
  });
});

describe("WhatsApp messages", () => {
  test("two template parameters: the team, and one line of the subject and text", () => {
    assert.deepEqual(
      whatsappMessage(
        "[My app] The planner is waiting for an answer in T3 Code.",
        "The planner is waiting for an answer in T3 Code.\n\ne9g status my-app shows the team.\n\nSent by the E9G Factory watchdog on mac.\n"
      ),
      ["My app", "The planner is waiting for an answer in T3 Code. e9g status my-app shows the team."]
    );
    assert.deepEqual(whatsappMessage("[My app] Which database", "Postgres\tor   SQLite?\n- Postgres: shared\n- SQLite: simpler\n"), [
      "My app",
      "Which database. Postgres or SQLite? - Postgres: shared - SQLite: simpler",
    ]);
    assert.equal(whatsappMessage("[E9G Factory] T3 Code won't start", "")[0], "your teams");
    // The planner's own messages are labelled as its, in the first parameter, so the approved template stays as it is.
    const { subject, text } = outboxMessage("My app", "2026-10-25-db.md", "Subject: Which database?\n\nPostgres or SQLite?\n");
    assert.deepEqual(whatsappMessage(subject, text), ["E9G-Planner · My app", "Which database? Postgres or SQLite?"]);
    const long = whatsappMessage("[My app] Long", "x".repeat(2000))[1];
    assert.equal(long.length, 700);
    assert.ok(long.endsWith("…"));
  });

  test("the watchdog's channel sends through the template", async () => {
    assert.equal((await connect()).code, 0);
    const channel = whatsappChannel();
    assert.equal(channel?.name, "whatsapp");
    assert.equal(channel?.replies, undefined, "it takes no replies");
    assert.equal(await channel?.send("[My app] Which database?", "Postgres or SQLite?", "my-app"), null);
    assert.deepEqual(
      sentTemplate(meta.posted.at(-1)).components[0]?.parameters.map((p) => p.text),
      ["My app", "Which database? Postgres or SQLite?"]
    );
  });

  test("the planner hears WhatsApp works, without the number, only while it does", async () => {
    assert.equal((await connect()).code, 0);
    assert.deepEqual(reachSummary(), { working: ["WhatsApp, one way"], failing: [] });
    recordSend("whatsapp", "Meta refused it (401, code 190: Invalid OAuth access token.)");
    assert.deepEqual(reachSummary().failing, ["WhatsApp (Meta refused it (401, code 190: Invalid OAuth access token.))"]);
    recordSend("whatsapp", null);
  });

  test("agents can't message through the Graph API themselves", () => {
    const { team } = normalize({ name: "fixture", branch: "e9g/next" }, "/tmp/fixture");
    assert.ok(refusal(team, "curl -X POST https://graph.facebook.com/v25.0/111/messages -H 'Authorization: Bearer x' -d @m.json"));
    assert.equal(refusal(team, "curl https://graph.facebook.com/v25.0/me?fields=id"), null);
  });
});
