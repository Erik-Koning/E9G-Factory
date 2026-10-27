import { baseTeam, guard, makeRepo, ROOT, tmp } from "./helpers.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { loadTeam, normalize } from "../lib/config.ts";
import { type Contact, contactStatus, messageKind, nextAllowed, recordSent, registeredContact, waitReason } from "../lib/contact.ts";
import { compile } from "../lib/prompts.ts";

const DIGEST: Contact = { mode: "digest", everyMin: 240 };
const PRIORITY: Contact = { mode: "priority", everyMin: 240 };
const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000);

describe("how often the planner writes (team.json contact)", () => {
  test("a message's kind is in its subject, after the labels", () => {
    assert.equal(messageKind("[E9G-Planner] [My app] Done"), "done");
    assert.equal(messageKind("Done: all green"), "done");
    assert.equal(messageKind("[E9G-Planner] [My app] Urgent: the app can't sign in"), "urgent");
    assert.equal(messageKind("[E9G-Planner] [My app] 3 questions"), "normal");
    assert.equal(messageKind("[E9G-Planner] [My app] Is it done yet?"), "normal", "only a subject that starts with it");
  });

  test("digest: one ordinary message per window, one urgent per window, Done always; priority: whenever", () => {
    const run = tmp("e9g-run-");
    const now = Date.now();
    for (const kind of ["normal", "urgent", "done"] as const) assert.equal(nextAllowed(DIGEST, run, kind, now), now, `${kind}: nothing sent yet`);
    const anHourAgo = hoursAgo(1);
    recordSent(run, "normal", anHourAgo);
    assert.equal(nextAllowed(DIGEST, run, "normal", now), anHourAgo.getTime() + 240 * 60_000);
    assert.equal(nextAllowed(DIGEST, run, "urgent", now), now, "urgent has its own window");
    assert.equal(nextAllowed(DIGEST, run, "done", now), now);
    assert.equal(nextAllowed(PRIORITY, run, "normal", now), now);
    assert.equal(nextAllowed({ mode: "digest", everyMin: 0 }, run, "normal", now), now, "a window of 0 holds nothing");
    recordSent(run, "urgent", hoursAgo(5));
    assert.equal(nextAllowed(DIGEST, run, "urgent", now), now, "a window that has passed");
    recordSent(run, "done");
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(run, "contact.json"), "utf8"))).sort(), ["normalAt", "urgentAt"], "Done isn't counted");
  });

  test("the planner's context and refusals say when the next message can go", () => {
    const run = tmp("e9g-run-");
    assert.match(contactStatus(DIGEST, run) ?? "", /the next can go now/);
    assert.equal(contactStatus(PRIORITY, run), null);
    recordSent(run, "normal", hoursAgo(1));
    assert.match(contactStatus(DIGEST, run) ?? "", /the next can go from \d/);
    assert.match(waitReason(DIGEST, "normal", run) ?? "", /one message every 4 h[\s\S]*question ticket[\s\S]*"Urgent: …"/);
    assert.equal(waitReason(DIGEST, "urgent", run), null);
    recordSent(run, "urgent", hoursAgo(1));
    assert.match(waitReason(DIGEST, "urgent", run) ?? "", /one urgent message per 4 h[\s\S]*It goes in the next message, from/);
    recordSent(run, "normal", hoursAgo(5));
    assert.match(waitReason(DIGEST, "urgent", run) ?? "", /without "Urgent:"[\s\S]*can go now/);
  });

  test("team.json: digest every 4 h unless it says otherwise", () => {
    assert.deepEqual(normalize(baseTeam(), "/x").team.contact, DIGEST);
    assert.deepEqual(normalize(baseTeam({ contact: { mode: "priority" } }), "/x").team.contact, PRIORITY);
    assert.deepEqual(normalize(baseTeam({ contact: { every: "1d" } }), "/x").team.contact, { mode: "digest", everyMin: 1440 });
    assert.match(normalize(baseTeam({ contact: { mode: "hourly" } }), "/x").problems.join("\n"), /contact\.mode/);
    assert.match(normalize(baseTeam({ contact: { every: "soon" } }), "/x").problems.join("\n"), /contact\.every/);
  });

  test("the watchdog keeps a team registered before the setting on priority", () => {
    assert.deepEqual(registeredContact(undefined).mode, "priority", "its planner's version writes whenever it needs to");
    assert.deepEqual(registeredContact(DIGEST), DIGEST);
  });

  test("only the planner's rules carry the mode", () => {
    const home = makeRepo(baseTeam({ contact: { mode: "digest", every: "6h" } }));
    assert.match(compile(loadTeam(home), "planner"), /Messages to the operator \(team\.json contact\), digest: at most one message every 6 h/);
    assert.doesNotMatch(compile(loadTeam(home), "builder"), /Messages to the operator/);
    const priority = makeRepo(baseTeam({ contact: { mode: "priority" } }));
    assert.match(compile(loadTeam(priority), "planner"), /team\.json contact\), priority: each message goes as soon as you send it/);
  });
});

describe("the planner's own email, held to the window", () => {
  const send = "mcp__claude_ai_Gmail__send_message";
  const subject = (text: string) => ({ to: ["op@example.com"], subject: `[E9G-Planner] [Fixture team] ${text}` });

  test("the guard refuses what the window doesn't allow yet", () => {
    const home = makeRepo();
    const run = tmp("e9g-run-");
    const outcome = (text: string, at = home) => guard(at, "planner", send, subject(text), { run }).outcome;
    assert.equal(outcome("3 questions"), "allow", "nothing sent yet");
    recordSent(run, "normal", hoursAgo(1));
    const refused = guard(home, "planner", send, subject("one more question"), { run });
    assert.equal(refused.outcome, "refuse");
    assert.match(refused.said, /one message every 4 h/);
    assert.equal(outcome("Urgent: nobody can sign in"), "allow");
    recordSent(run, "urgent", hoursAgo(1));
    assert.equal(outcome("Urgent: still can't"), "refuse", "one urgent per window");
    assert.equal(outcome("Done"), "allow", "Done always goes");
    assert.equal(outcome("one more question", makeRepo(baseTeam({ contact: { mode: "priority" } }))), "allow", "priority mode");
  });

  const hook = (run: string, input: Record<string, unknown>, role = "planner") =>
    spawnSync(process.execPath, [join(ROOT, "plugin", "hooks", "sent.ts")], {
      input: JSON.stringify({ session_id: "test", agent_type: `e9g:${role}`, ...input }),
      env: { ...process.env, NODE_COMPILE_CACHE: join(ROOT, ".cache"), E9G_NODE_CACHE: "1", E9G_TEAM: "fixture", E9G_RUN: run, E9G_ROLE: role },
      encoding: "utf8",
    });

  test("the sent hook records only the planner's sends that went", () => {
    const run = tmp("e9g-run-");
    hook(run, { tool_name: send, tool_input: subject("3 questions"), tool_response: { isError: true, content: "quota" } });
    hook(run, { tool_name: send, tool_input: subject("3 questions"), tool_response: "Error: unauthorized" });
    hook(run, { tool_name: send, tool_input: subject("3 questions"), tool_response: { id: "m1" } }, "builder");
    assert.ok(!existsSync(join(run, "contact.json")), "failed sends and other roles aren't recorded");
    hook(run, { tool_name: send, tool_input: subject("Urgent: nobody can sign in"), tool_response: { id: "m2" } });
    const record = JSON.parse(readFileSync(join(run, "contact.json"), "utf8")) as Record<string, string>;
    assert.deepEqual(Object.keys(record), ["urgentAt"]);
    assert.ok(Date.now() - Date.parse(record["urgentAt"] ?? "") < 60_000);
  });

  test("hooks.json runs the sent hook after the planner's email", () => {
    const { hooks } = JSON.parse(readFileSync(join(ROOT, "plugin", "hooks", "hooks.json"), "utf8")) as {
      hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
    };
    const entry = (hooks["PostToolUse"] ?? []).find((item) => item.hooks.some((h) => h.command.includes("hooks/sent.ts")));
    assert.ok(entry?.matcher && new RegExp(`^(?:${entry.matcher})$`).test(send));
    assert.ok(!new RegExp(`^(?:${entry.matcher})$`).test("mcp__claude_ai_Gmail__search_threads"));
  });
});
