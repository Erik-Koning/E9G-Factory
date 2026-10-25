// e9g connect: the ways the factory reaches the operator away from this Mac (lib/channels.ts). The watchdog sends its
// alerts and the planner's outbox through each, and passes their replies to the planner.
//
//   e9g connect                                   what's connected
//   e9g connect email [--to <address>] [--from <sender>] [--replies <domain> | --no-replies]
//   e9g connect email --test                      send another test email
//   e9g disconnect email
//
// Email goes through Resend with the operator's own API key (lib/email.ts keeps it in the Keychain). The key is typed
// at a prompt or piped in, and kept only after a test email goes through.
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";
import {
  ADDRESS,
  canReadReplies,
  DEFAULT_FROM,
  EMAIL_FILE,
  emailSettings,
  forgetEmail,
  readKey,
  RESEND_KEY,
  saveEmailSettings,
  sendEmail,
  storeKey,
} from "../email.ts";
import { recordSend } from "../channels.ts";
import { readRegistry, teamFile } from "../paths.ts";
import { operatorOnly } from "../session.ts";
import { die, localTime, parseArgs, readJson, text } from "../util.ts";
import { teamNames } from "./team.ts";

const TEST_SUBJECT = "[E9G Factory] Email is connected";
const testText = (replies: boolean): string => `This is E9G Factory on ${hostname()}. From now on the watchdog emails you here when a team needs you:

- a planner waiting for your answer, or stuck;
- a planner that couldn't start, or T3 Code down;
- a message the planner left in its outbox.
${replies ? "\nReply to any of them and your answer goes to that team's planner.\n" : ""}
e9g disconnect email turns this off.
`;

// The operator's address from the registered teams' team.json, when they all name the same one.
function ownerOfTeams(): string | undefined {
  const owners = new Set<string>();
  for (const name of teamNames()) {
    const home = readRegistry(name)?.home;
    try {
      const owner = home ? readJson<{ owner?: string }>(teamFile(home))?.owner : undefined;
      if (owner) owners.add(owner);
    } catch {}
  }
  return owners.size === 1 ? [...owners][0] : undefined;
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

// A line typed without echo, for the key. Ctrl-C stops; Ctrl-D ends the line like Enter.
function askHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(question);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  return new Promise((done) => {
    let typed = "";
    const finish = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === "\u0003") {
          finish();
          process.exit(130);
        }
        if (char === "\r" || char === "\n" || char === "\u0004") {
          finish();
          return done(typed.trim());
        }
        typed = char === "\u007f" ? typed.slice(0, -1) : typed + char;
      }
    };
    stdin.on("data", onData);
  });
}

function status(): number {
  const settings = emailSettings();
  if (!settings) console.info("email  not connected: e9g connect email");
  else if (!readKey()) console.info(`email  ${settings.to}, but its key isn't in the Keychain any more: e9g connect email`);
  else
    console.info(
      `email  to ${settings.to}, from ${settings.from}, ${settings.replyDomain ? `replies through ${settings.replyDomain}` : "no replies"}, since ${localTime(new Date(settings.connectedAt))} (e9g connect email --test sends one)`
    );
  return 0;
}

async function sendTest(): Promise<number> {
  const settings = emailSettings();
  const key = readKey();
  if (!settings || !key) die("email isn't connected: e9g connect email");
  const problem = await sendEmail(settings, key, TEST_SUBJECT, testText(Boolean(settings.replyDomain)));
  if (problem) {
    console.error(`e9g: ${problem}`);
    return 1;
  }
  recordSend("email", null);
  console.info(`e9g: sent a test email to ${settings.to}`);
  return 0;
}

async function connectEmail(argv: string[]): Promise<number> {
  const { options } = parseArgs(argv, { booleans: ["test", "no-replies"] });
  if (options["test"]) return sendTest();
  const interactive = Boolean(process.stdin.isTTY);
  const previous = emailSettings();
  const from = text(options["from"]) ?? previous?.from ?? DEFAULT_FROM;
  if (!/@/.test(from)) die(`--from: a sender address, like "E9G Factory <e9g@example.com>"`);

  if (interactive)
    console.info(`E9G Factory emails you through Resend, with your own API key:
  1. Sign up at https://resend.com with the address you want the emails at (the free plan sends 100 a day).
  2. Create an API key at https://resend.com/api-keys: with full access, so your replies can reach your teams,
     or with sending access only, for email one way.
Until you verify a domain at Resend, it sends only to the address you signed up with.
`);
  const known = previous?.to ?? ownerOfTeams();
  let to = text(options["to"]);
  if (!to && interactive) to = (await ask(`Your email address${known ? ` [${known}]` : ""}: `)) || known;
  to ??= known;
  if (!to) die("name the address to email: e9g connect email --to <address>");
  if (!ADDRESS.test(to)) die(`${to} isn't an email address`);

  const key = interactive ? await askHidden("Resend API key (it isn't shown): ") : readFileSync(0, "utf8").trim();
  if (!RESEND_KEY.test(key)) die("that isn't a Resend API key (they start with re_); create one at https://resend.com/api-keys");

  // Replies come back through the account's receiving domain (Resend > Emails > Receiving, <id>.resend.app).
  let replyDomain = options["no-replies"] ? undefined : (text(options["replies"]) ?? previous?.replyDomain);
  if (!replyDomain && !options["no-replies"] && interactive) {
    const domain = await ask("Your Resend receiving address or its domain, for replies (Resend > Emails > Receiving; Enter for none): ");
    replyDomain = domain.replace(/^.*@/, "") || undefined;
  }
  if (replyDomain && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(replyDomain)) die(`${replyDomain} isn't a domain, like abc123.resend.app`);
  if (replyDomain) {
    const problem = await canReadReplies(key);
    if (problem) {
      console.error(`e9g: replies through ${replyDomain} won't work: ${problem}.`);
      console.error("  Use a key with full access, or connect without replies (--no-replies). Nothing was saved.");
      return 1;
    }
  }

  const problem = await sendEmail({ to, from }, key, TEST_SUBJECT, testText(Boolean(replyDomain)));
  if (problem) {
    console.error(`e9g: the test email didn't go: ${problem}`);
    if (/own email address|not verified/i.test(problem))
      console.error(
        `  Resend sends from ${DEFAULT_FROM} only to the address you signed up with. Use that one (--to), or verify a domain at https://resend.com/domains and send from it (--from).`
      );
    console.error("  Nothing was saved.");
    return 1;
  }
  if (!storeKey(key)) die("the test email went, but the key couldn't be saved in the Keychain (security add-generic-password failed)", 1);
  // Reconnecting the same address keeps its start, so replies and drafts from before aren't dropped.
  const connectedAt = previous?.to === to ? previous.connectedAt : new Date().toISOString();
  saveEmailSettings({ provider: "resend", to, from, ...(replyDomain ? { replyDomain } : {}), connectedAt });
  recordSend("email", null);
  console.info(`e9g: sent a test email to ${to}. If it isn't there in a minute, look in spam and mark it as not spam.
  The watchdog now emails the planner's outbox and its alerts there${replyDomain ? ", and gives each planner your replies" : ""}.
  The key is in the Keychain, the rest in ${EMAIL_FILE}.`);
  return 0;
}

export async function connect(argv: string[]): Promise<number> {
  operatorOnly("connect");
  const [what, ...rest] = argv;
  if (!what) return status();
  if (what === "email") return connectEmail(rest);
  die("usage: e9g connect [email]");
}

export function disconnect(argv: string[]): number {
  operatorOnly("disconnect");
  if (argv[0] !== "email") die("usage: e9g disconnect email");
  if (!emailSettings() && !readKey()) {
    console.info("e9g: email wasn't connected");
    return 0;
  }
  forgetEmail();
  console.info("e9g: email is off. The key still works at Resend; delete it at https://resend.com/api-keys if you won't use it again.");
  return 0;
}
