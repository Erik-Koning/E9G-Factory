// e9g connect: the ways the factory reaches the operator away from this Mac (lib/channels.ts). The watchdog sends its
// alerts and the planner's outbox through each, and passes their replies to the planner.
//
//   e9g connect                                   what's connected
//   e9g connect email [--to <address>] [--from <sender>] [--replies <domain> | --no-replies]
//   e9g connect whatsapp [--phone-number-id <id>] [--account-id <id>] [--to <number>]
//   e9g connect heartbeat <url>                   an outside check the watchdog pings, which tells them when it stops
//   e9g connect mongo [--machine <name>] [--no-check]   this machine's connection to a team's shared task graph
//   e9g connect email|whatsapp|heartbeat --test   send another test message, or ping
//   e9g disconnect email|whatsapp|heartbeat
//
// Email goes through Resend with the operator's own API key (lib/email.ts); WhatsApp through their WhatsApp Business
// number on Meta's Cloud API (lib/whatsapp.ts). Each key or token is typed at a prompt or piped in, goes in the
// Keychain, and is kept only after a test message goes through (or, for WhatsApp, while Meta reviews the template).
// The heartbeat (lib/heartbeat.ts) is kept only after a test ping goes through.
import { readFileSync } from "node:fs";
import { MACHINE_NAME, machineName, saveMachineName } from "../machine.ts";
import { driver, forgetUri, hasUri, MONGO_URI, readUri, shownUri, storeUri } from "../tasks/mongo.ts";
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
import { forgetHeartbeat, HEARTBEAT_FILE, heartbeatSettings, heartbeatUrl, hostOf, lastPing, ping, saveHeartbeat } from "../heartbeat.ts";
import { readRegistry, teamFile } from "../paths.ts";
import { operatorOnly } from "../session.ts";
import { die, localTime, parseArgs, readJson, text } from "../util.ts";
import {
  businessNumber,
  ensureTemplate,
  forgetWhatsApp,
  readToken,
  saveWhatsAppSettings,
  sendWhatsApp,
  storeToken,
  TEMPLATE,
  WHATSAPP_FILE,
  type WhatsAppSettings,
  whatsappSettings,
} from "../whatsapp.ts";
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

const WHATSAPP_TEST = [
  "[E9G Factory] WhatsApp is connected",
  `This is E9G Factory on ${hostname()}. The watchdog messages you here when a team needs you.`,
] as const;

function whatsappStatus(): void {
  const settings = whatsappSettings();
  if (!settings) console.info("whatsapp  not connected: e9g connect whatsapp");
  else if (!readToken()) console.info(`whatsapp  +${settings.to}, but its token isn't in the Keychain any more: e9g connect whatsapp`);
  else
    console.info(
      `whatsapp  to +${settings.to}, from number ${settings.phoneNumberId}, one way, since ${localTime(new Date(settings.connectedAt))} (e9g connect whatsapp --test sends one)`
    );
}

// The test message, once the template is approved; otherwise what Meta says about it.
async function sendWhatsAppTest(settings: WhatsAppSettings, token: string): Promise<number> {
  const template = await ensureTemplate(settings.accountId, token);
  if ("problem" in template) {
    console.error(`e9g: couldn't read the ${TEMPLATE} template: ${template.problem}`);
    return 1;
  }
  if (template.status !== "APPROVED") {
    console.info(
      `e9g: the ${TEMPLATE} template is ${template.status.toLowerCase()}${template.reason ? ` (${template.reason})` : ""}, so nothing can be sent yet. Meta usually reviews it within minutes.`
    );
    return template.status === "REJECTED" ? 1 : 0;
  }
  const problem = await sendWhatsApp(settings, token, ...WHATSAPP_TEST);
  if (problem) {
    console.error(`e9g: the test message didn't go: ${problem}`);
    return 1;
  }
  recordSend("whatsapp", null);
  console.info(`e9g: Meta accepted a test message to +${settings.to}. If it doesn't arrive in a minute, check the number.`);
  return 0;
}

async function connectWhatsApp(argv: string[]): Promise<number> {
  const { options } = parseArgs(argv, { booleans: ["test"] });
  const previous = whatsappSettings();
  if (options["test"]) {
    const token = readToken();
    if (!previous || !token) die("WhatsApp isn't connected: e9g connect whatsapp");
    return sendWhatsAppTest(previous, token);
  }
  const interactive = Boolean(process.stdin.isTTY);
  if (interactive)
    console.info(`E9G Factory messages you from your WhatsApp Business number, through Meta's Cloud API. You need:
  - the number's phone number ID and its WhatsApp Business Account ID, from your Meta app's WhatsApp > API Setup;
  - a permanent access token: a system user's, with whatsapp_business_messaging and whatsapp_business_management
    (Meta Business Settings > Users > System users).
WhatsApp lets a business message you first only with a template Meta has approved, so this adds one, ${TEMPLATE},
to the account. Replies to it don't reach your teams.
`);
  const field = async (option: string, question: string, fallback?: string): Promise<string | undefined> =>
    text(options[option]) ?? (interactive ? (await ask(`${question}${fallback ? ` [${fallback}]` : ""}: `)) || fallback : fallback);
  const phoneNumberId = await field("phone-number-id", "Phone number ID", previous?.phoneNumberId);
  if (!phoneNumberId || !/^\d+$/.test(phoneNumberId)) die("--phone-number-id: the business number's id from WhatsApp > API Setup (digits)");
  const accountId = await field("account-id", "WhatsApp Business Account ID", previous?.accountId);
  if (!accountId || !/^\d+$/.test(accountId)) die("--account-id: the WhatsApp Business Account ID from WhatsApp > API Setup (digits)");
  const to = (await field("to", "Your own WhatsApp number, with its country code", previous ? `+${previous.to}` : undefined))?.replace(/[\s()+.-]/g, "");
  if (!to || !/^\d{8,15}$/.test(to)) die("--to: your WhatsApp number with its country code, like +1 604 555 0123");

  const token = interactive ? await askHidden("Access token (it isn't shown): ") : readFileSync(0, "utf8").trim();
  if (!/^[\w.-]{20,}$/.test(token)) die("that doesn't look like a Meta access token");
  const number = await businessNumber(phoneNumberId, token);
  if ("problem" in number) {
    console.error(`e9g: couldn't reach the business number ${phoneNumberId} with that token: ${number.problem}. Nothing was saved.`);
    return 1;
  }
  const template = await ensureTemplate(accountId, token);
  if ("problem" in template) {
    console.error(`e9g: couldn't find or add the ${TEMPLATE} template on account ${accountId}: ${template.problem}.`);
    console.error("  The token needs whatsapp_business_management for that account. Nothing was saved.");
    return 1;
  }
  if (template.status === "REJECTED") {
    console.error(
      `e9g: Meta rejected the ${TEMPLATE} template${template.reason ? ` (${template.reason})` : ""}; see WhatsApp Manager. Nothing was saved.`
    );
    return 1;
  }
  // Reconnecting the same number keeps its start, so drafts from before aren't dropped.
  const connectedAt = previous?.to === to ? previous.connectedAt : new Date().toISOString();
  const settings: WhatsAppSettings = { provider: "meta", phoneNumberId, accountId, to, connectedAt };
  if (template.status === "APPROVED") {
    const problem = await sendWhatsApp(settings, token, ...WHATSAPP_TEST);
    if (problem) {
      console.error(`e9g: the test message didn't go: ${problem}. Nothing was saved.`);
      return 1;
    }
  }
  if (!storeToken(token)) die("the token couldn't be saved in the Keychain (security add-generic-password failed)", 1);
  saveWhatsAppSettings(settings);
  recordSend("whatsapp", null);
  console.info(
    template.status === "APPROVED"
      ? `e9g: Meta accepted a test message from ${number.name} to +${to}. If it doesn't arrive in a minute, check the number.`
      : `e9g: connected to ${number.name}. The ${TEMPLATE} template is waiting for Meta's review, usually minutes; until then nothing can be sent. e9g connect whatsapp --test sends one once it's approved.`
  );
  console.info(`  The watchdog now sends the planner's outbox and its alerts there. The token is in the Keychain, the rest in ${WHATSAPP_FILE}.`);
  return 0;
}

function heartbeatStatus(): void {
  const settings = heartbeatSettings();
  if (!settings) console.info("heartbeat  not connected: e9g connect heartbeat <url>");
  else {
    const last = lastPing();
    console.info(
      `heartbeat  pings ${hostOf(settings.url)} each watchdog run, last ${last ? localTime(last) : "never"} (e9g connect heartbeat --test pings it)`
    );
  }
}

const HEARTBEAT_HELP = `An outside service tells you when this Mac stops pinging it: when it's off, asleep or at the login screen
after a restart, when the watchdog stops, or when T3 Code won't start. The watchdog pings it at the end of every
run (every 5 minutes) in which T3 Code answers.
  1. Make a check at a service that alerts you when pings stop, such as https://healthchecks.io (free): period
     5 minutes, grace 15, so a restart of T3 Code doesn't alert you.
  2. e9g connect heartbeat <the check's ping URL>`;

async function connectHeartbeat(argv: string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, { booleans: ["test"] });
  const previous = heartbeatSettings();
  if (options["test"]) {
    if (!previous) die("the heartbeat isn't connected: e9g connect heartbeat <url>");
    const problem = await ping(previous.url);
    if (problem) {
      console.error(`e9g: the ping to ${hostOf(previous.url)} didn't go through: ${problem}`);
      return 1;
    }
    console.info(`e9g: pinged ${hostOf(previous.url)}`);
    return 0;
  }
  if (!positional[0]) {
    console.info(HEARTBEAT_HELP);
    return 2;
  }
  const url = heartbeatUrl(positional[0]);
  if (!url) die(`${positional[0]} isn't a URL; give the check's ping URL, like https://hc-ping.com/<uuid>`);
  const problem = await ping(url);
  if (problem) {
    console.error(`e9g: the test ping to ${hostOf(url)} didn't go through: ${problem}. Nothing was saved.`);
    return 1;
  }
  saveHeartbeat({ url, connectedAt: previous?.url === url ? previous.connectedAt : new Date().toISOString() });
  console.info(`e9g: pinged ${hostOf(url)}. The watchdog now pings it at the end of every run in which T3 Code answers.
  Give the check a period of 5 minutes and a grace of 15. The URL is in ${HEARTBEAT_FILE}.`);
  return 0;
}

function mongoStatus(): void {
  const uri = hasUri() ? readUri() : null;
  console.info(
    uri
      ? `mongo  ${shownUri(uri)}, as the machine ${machineName()} (e9g connect mongo --machine <name> renames it)`
      : "mongo  not connected: e9g connect mongo (for a team whose tasks are in Mongo)"
  );
}

// e9g connect mongo: the connection string, typed at a prompt or piped in (never an argument, which other processes
// can read), kept in the Keychain once a connection goes through; and this machine's name in the task graph.
async function connectMongo(argv: string[]): Promise<number> {
  const { options } = parseArgs(argv, { booleans: ["no-check"] });
  const machine = typeof options["machine"] === "string" ? options["machine"] : undefined;
  if (machine !== undefined && !MACHINE_NAME.test(machine)) die("--machine: lowercase letters, digits and dashes, such as studio");
  // Already connected, and nothing piped in: --machine only renames this machine.
  if (machine && hasUri() && process.stdin.isTTY) {
    saveMachineName(machine);
    console.info(`e9g: this machine is ${machine} in the task graph`);
    return 0;
  }
  const uri = process.stdin.isTTY ? await askHidden("MongoDB connection string (mongodb+srv://…): ") : readFileSync(0, "utf8").trim();
  if (!MONGO_URI.test(uri)) die("that isn't a MongoDB connection string (mongodb://… or mongodb+srv://…)");
  if (!options["no-check"]) {
    try {
      const { MongoClient } = await driver();
      const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, appName: "e9g" });
      await client.connect();
      await client.close();
    } catch (error) {
      console.error(`e9g: couldn't connect to ${shownUri(uri)}: ${(error as Error).message}. Nothing was saved.`);
      return 1;
    }
  }
  if (!storeUri(uri)) die("couldn't keep the connection string in the Keychain");
  // The name is kept either way, so a network that changes the host's name doesn't change which machine this is.
  saveMachineName(machine ?? machineName());
  console.info(
    `e9g: connected to ${shownUri(uri)} as the machine ${machineName()}. A team whose team.json says "tasks": {"store": "mongo"} keeps its task graph there.`
  );
  return 0;
}

export async function connect(argv: string[]): Promise<number> {
  operatorOnly("connect");
  const [what, ...rest] = argv;
  if (!what) {
    status();
    whatsappStatus();
    heartbeatStatus();
    mongoStatus();
    return 0;
  }
  if (what === "email") return connectEmail(rest);
  if (what === "whatsapp") return connectWhatsApp(rest);
  if (what === "heartbeat") return connectHeartbeat(rest);
  if (what === "mongo") return connectMongo(rest);
  die("usage: e9g connect [email|whatsapp|heartbeat|mongo]");
}

export function disconnect(argv: string[]): number {
  operatorOnly("disconnect");
  if (argv[0] === "mongo") {
    if (!hasUri()) console.info("e9g: Mongo wasn't connected");
    else {
      forgetUri();
      console.info("e9g: this machine no longer reaches the shared task graph; the database and its tasks are as they were.");
    }
    return 0;
  }
  if (argv[0] === "heartbeat") {
    const settings = heartbeatSettings();
    if (!settings) console.info("e9g: the heartbeat wasn't connected");
    else {
      forgetHeartbeat();
      console.info(`e9g: the heartbeat is off. Pause or delete the check at ${hostOf(settings.url)}, or it alerts you when the pings stop.`);
    }
    return 0;
  }
  if (argv[0] === "whatsapp") {
    if (!whatsappSettings() && !readToken()) console.info("e9g: WhatsApp wasn't connected");
    else {
      forgetWhatsApp();
      console.info(`e9g: WhatsApp is off. The ${TEMPLATE} template stays on the account, and the token still works at Meta.`);
    }
    return 0;
  }
  if (argv[0] !== "email") die("usage: e9g disconnect email|whatsapp|heartbeat|mongo");
  if (!emailSettings() && !readKey()) {
    console.info("e9g: email wasn't connected");
    return 0;
  }
  forgetEmail();
  console.info("e9g: email is off. The key still works at Resend; delete it at https://resend.com/api-keys if you won't use it again.");
  return 0;
}
