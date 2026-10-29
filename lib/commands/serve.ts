// e9g serve: the operator's page for one team, on the always-on machine. Stakeholders' feature requests come in through
// its form; it shows the open requests (with who sent them, which only this page and the operator's own commands
// show), the board by status, the proposals waiting for the operator with Approve and Reject, and the task graph.
// Approving and rejecting run `e9g task` as the operator, so every rule there applies here too.
//
// It's node:http and nothing else: no dependencies, no external assets, the CSS and the little JS inline. It binds
// 127.0.0.1 unless told otherwise, and always asks for a token: E9G_SERVE_TOKEN, or one made at start and printed in
// the address to open. Loopback alone isn't enough, since the team's own agents run on this machine and could approve
// their own work or read stakeholders' names and addresses; and a token on the command line is readable by any process.
import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Team } from "../config.ts";
import { entryOf, FACTORY_ROOT } from "../paths.ts";
import { operatorOnly, teamSession } from "../session.ts";
import { betterDiagram, layout } from "../tasks/graph.ts";
import { claimOrder, type FeatureRequest, type Stakeholder, STATUSES, type Status, type Task } from "../tasks/model.ts";
import { openTeamStore } from "../tasks/ops.ts";
import { Refused, type Store } from "../tasks/store.ts";
import { parseArgs, text as optionText } from "../util.ts";
import { addRequest, stakeholderFor } from "./request.ts";

export const USAGE = "usage: e9g serve [--port 4600] [--host 127.0.0.1] [--team <name>]   (the token: E9G_SERVE_TOKEN, or one made for you)";

const BODY_LIMIT = 64 * 1024;
// Past the limit the rest of a body is read and dropped, so the client gets its 413 instead of a broken pipe; past
// this, the connection is cut.
const BODY_CEILING = 4 * 1024 * 1024;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PROPOSALS: Status[] = ["proposed", "researching", "question"];
// The environment keys that make a command act as a member of a team: the operator's runs go without them.
const MEMBER_KEYS = ["E9G_TEAM", "E9G_ROLE", "E9G_HOME_DIR", "E9G_SETUP"];

export interface ServeOptions {
  home: string;
  run: string;
  team: Team;
  host: string;
  port: number;
  token: string | null;
}

// e9g serve [--port 4600] [--host 127.0.0.1] [--team <name>]: runs until SIGINT or SIGTERM.
export async function serve(argv: string[]): Promise<number> {
  operatorOnly("serve");
  const { positional, options } = parseArgs(argv);
  const rawPort = optionText(options["port"]) ?? "4600";
  const host = optionText(options["host"]) ?? "127.0.0.1";
  if (options["token"] !== undefined) {
    console.error("serve: give the token in E9G_SERVE_TOKEN, not --token: any process on this machine can read a command's arguments");
    return 2;
  }
  const token = process.env.E9G_SERVE_TOKEN || randomBytes(18).toString("base64url");
  if (positional.length || !/^\d+$/.test(rawPort) || Number(rawPort) > 65535 || options["host"] === true) {
    console.error(USAGE);
    return 2;
  }
  const { home, team, run } = teamSession({ team: optionText(options["team"]) });
  if (team.board.type !== "tasks") {
    console.error("serve: this team's board is GitHub issues (team.json board), so it keeps no task graph or requests to serve");
    return 2;
  }
  let server: { url: string; close(): Promise<void> };
  try {
    server = await startServer({ home, run, team, host, port: Number(rawPort), token });
  } catch (error) {
    if (error instanceof Refused) {
      console.error(`serve: ${error.message}`);
      return 2;
    }
    throw error;
  }
  console.info(`e9g serve: ${server.url}`);
  console.info(
    process.env.E9G_SERVE_TOKEN
      ? "Open it once with ?token=<E9G_SERVE_TOKEN>; the browser keeps it after that."
      : `Open ${server.url}/?token=${token} once; the browser keeps it after that. The token lasts until this stops.`
  );
  await new Promise<void>((done) => {
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      done();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  await server.close();
  return 0;
}

// --- Addresses and the token ---------------------------------------------------------------------------------------

const bare = (host: string): string => host.replace(/^\[(.*)\]$/, "$1").toLowerCase();
const isLoopback = (host: string): boolean => {
  const h = bare(host);
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h) || /^::ffff:127(\.\d{1,3}){3}$/.test(h);
};
// The host part of a Host header ("127.0.0.1:4600", "[::1]:4600").
const hostOfHeader = (value: string): string => (value.startsWith("[") ? value.slice(0, value.indexOf("]") + 1) : (value.split(":")[0] ?? ""));
const urlHost = (host: string): string => (bare(host).includes(":") ? `[${bare(host)}]` : host);

// Compared as hashes, so the comparison takes as long whatever the guess.
const sameSecret = (given: string, token: string): boolean =>
  timingSafeEqual(createHash("sha256").update(given).digest(), createHash("sha256").update(token).digest());

function cookiesOf(req: IncomingMessage): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    try {
      jar.set(part.slice(0, at).trim(), decodeURIComponent(part.slice(at + 1).trim()));
    } catch {
      // A cookie that isn't ours, badly encoded: passed over.
    }
  }
  return jar;
}

// --- Requests and responses ----------------------------------------------------------------------------------------

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// The body as text, refused past BODY_LIMIT.
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_CEILING) {
        // Settled here: a destroyed request may never end.
        fail(new HttpError(413, `a request body is at most ${BODY_LIMIT / 1024} KB`));
        req.destroy();
      } else if (size <= BODY_LIMIT) chunks.push(chunk);
    });
    req.on("end", () =>
      size > BODY_LIMIT ? fail(new HttpError(413, `a request body is at most ${BODY_LIMIT / 1024} KB`)) : done(Buffer.concat(chunks).toString("utf8"))
    );
    req.on("error", fail);
  });
}

// A form's or a JSON object's text fields.
function fieldsOf(req: IncomingMessage, body: string): Record<string, string> {
  if (String(req.headers["content-type"] ?? "").includes("application/json")) {
    let parsed: unknown;
    try {
      parsed = body.trim() ? JSON.parse(body) : {};
    } catch {
      throw new HttpError(400, "the body isn't JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "the body is a JSON object");
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  }
  return Object.fromEntries(new URLSearchParams(body));
}

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
};
const sendJson = (res: ServerResponse, status: number, value: unknown): void => {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8" });
  res.end(`${JSON.stringify(value, null, 2)}\n`);
};
const sendText = (res: ServerResponse, status: number, message: string): void => {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" });
  res.end(`${message}\n`);
};
// The page, whose inline style and script run by a nonce of their own: nothing else on it runs, whatever it shows.
const sendPage = async (
  res: ServerResponse,
  status: number,
  headers: Record<string, string>,
  render: (nonce: string) => Promise<string>
): Promise<void> => {
  const nonce = randomBytes(16).toString("base64");
  const html = await render(nonce);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...headers,
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  });
  res.end(html);
};

// --- The server ------------------------------------------------------------------------------------------------------

// Starts the page for `team` and resolves once it's listening, with its address (the real port, for port 0).
export async function startServer({ home, run, team, host, port, token }: ServeOptions): Promise<{ url: string; close(): Promise<void> }> {
  if (!isLoopback(host) && !token)
    throw new Refused(
      `${host} isn't a loopback address, so anyone who can reach it could approve work and read stakeholders' names and addresses: give it a --token, or leave --host at 127.0.0.1`
    );
  const store = await openTeamStore(team, run, home);
  // Both are known once it listens. Cookies don't keep to a port, so the cookie's name carries it: two pages on one
  // machine keep their own tokens.
  let url = "";
  let cookie = "";

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? "GET";
    const where = new URL(req.url ?? "/", "http://serve.invalid");
    const path = where.pathname;
    const api = path.startsWith("/api/");
    const refuse = (status: number, message: string): void =>
      api ? sendJson(res, status, { ok: false, output: message }) : sendText(res, status, message);
    const headers: Record<string, string> = {};

    // Without a token the page is loopback's alone, and only by a loopback name: a page elsewhere that points its own
    // name at 127.0.0.1 (DNS rebinding) is refused, since it would otherwise count as this page's own origin.
    const hostHeader = req.headers.host ?? "";
    if (!token && !isLoopback(hostOfHeader(hostHeader))) return refuse(403, "e9g serve answers to its loopback address only (127.0.0.1, localhost)");
    if (token) {
      const fromQuery = where.searchParams.get("token");
      const header = req.headers["x-e9g-token"];
      const given = fromQuery ?? (typeof header === "string" ? header : undefined) ?? cookiesOf(req).get(cookie);
      if (given === undefined || !sameSecret(given, token))
        return refuse(401, "e9g serve needs its token: open the page once with ?token=<token>, or send x-e9g-token");
      // The first visit's token is kept in a cookie the page's scripts can't read and other sites can't send.
      if (fromQuery !== null) headers["set-cookie"] = `${cookie}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`;
    }
    // A change comes from this page or from no browser at all (curl sends no Origin).
    if (method === "POST" && req.headers.origin !== undefined) {
      const own = new Set([url, `http://${hostHeader}`]);
      if (!own.has(req.headers.origin)) return refuse(403, `a change comes from this page (${url}), not ${req.headers.origin}`);
    }

    if (method === "GET" && path === "/") return sendPage(res, 200, headers, (nonce) => page(store, team, { nonce }));
    if (method === "POST" && path === "/requests") {
      const fields = fieldsOf(req, await readBody(req));
      const problem = requestProblem(fields);
      // The page again, with what was typed and what's wrong with it.
      if (problem) return sendPage(res, 400, headers, (nonce) => page(store, team, { nonce, form: fields, problem }));
      const name = (fields["name"] ?? "").trim();
      const email = (fields["email"] ?? "").trim();
      const role = (fields["role"] ?? "").trim() || "stakeholder";
      // The stakeholder keeps the name and address; the request only its id (Article 8).
      const from = await stakeholderFor(store, team.name, { name, email, role });
      await addRequest(store, team.name, { title: (fields["title"] ?? "").trim(), body: (fields["body"] ?? "").trim(), from: from.id, by: "operator" });
      res.writeHead(303, { ...SECURITY_HEADERS, ...headers, location: "/" });
      res.end();
      return;
    }
    if (method === "GET" && path === "/api/tasks") return sendJson(res, 200, await store.tasks.all());
    if (method === "GET" && path === "/api/requests") {
      const people = new Map((await store.stakeholders.all()).map((s) => [s.id, s]));
      const requests = (await store.requests.all()).map((r) => {
        const s = r.from ? people.get(r.from) : undefined;
        return { ...r, stakeholder: s ? { id: s.id, name: s.name, email: s.email, role: s.role } : null };
      });
      return sendJson(res, 200, requests);
    }
    if (method === "GET" && path === "/api/graph") return sendJson(res, 200, betterDiagram(await store.tasks.all(), { title: team.title }));
    const verdict = /^\/api\/tasks\/([^/]+)\/(approve|reject)$/.exec(path);
    if (method === "POST" && verdict && /^\d+$/.test(verdict[1] ?? "")) {
      const [, id = "", action = ""] = verdict;
      const fields = fieldsOf(req, await readBody(req));
      const text = (action === "approve" ? (fields["note"] ?? "") : (fields["reason"] ?? "")).trim();
      if (action === "reject" && !text) return sendJson(res, 400, { ok: false, output: "say why it's rejected: a reason is needed" });
      const result = await asOperator(home, run, ["task", action, id, ...(text ? [`--${action === "approve" ? "note" : "reason"}=${text}`] : [])]);
      return sendJson(res, result.ok ? 200 : 422, result);
    }
    return refuse(404, `no ${method} ${path} here`);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) return void res.end();
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      if (new URL(req.url ?? "/", "http://serve.invalid").pathname.startsWith("/api/")) sendJson(res, status, { ok: false, output: message });
      else sendText(res, status, message);
    });
  });
  try {
    await new Promise<void>((done, fail) => {
      server.once("error", fail);
      server.listen(port, bare(host), () => {
        server.off("error", fail);
        done();
      });
    });
  } catch (error) {
    await store.close();
    throw error;
  }
  const listening = (server.address() as AddressInfo).port;
  url = `http://${urlHost(host)}:${listening}`;
  cookie = `e9g_serve_${listening}`;
  return {
    url,
    close: async () => {
      await new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      });
      await store.close();
    },
  };
}

// Runs the factory's own command line as the operator, from the team's checkout, so `e9g task`'s rules decide.
// Each value goes as --flag=value, so a note that starts with -- stays a note.
// It runs beside the server, which keeps answering meanwhile.
function asOperator(home: string, run: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, E9G_RUN: run };
  for (const key of MEMBER_KEYS) delete env[key];
  return new Promise((done) => {
    const child = spawn(process.execPath, [entryOf(FACTORY_ROOT), ...args], { cwd: home, env, timeout: 120_000 });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk: Buffer) => (output += chunk));
    child.on("error", (error) => done({ ok: false, output: error.message }));
    child.on("close", (code) => done({ ok: code === 0, output: output.trim() }));
  });
}

// Why a request from the form can't be taken, or null.
function requestProblem(fields: Record<string, string>): string | null {
  const title = (fields["title"] ?? "").trim();
  const name = (fields["name"] ?? "").trim();
  const email = (fields["email"] ?? "").trim();
  if (!title) return "Give the request a title: what should be possible.";
  if (title.length > 200) return "Keep the title under 200 characters; the rest goes in the description.";
  if (!name || name.length > 120) return "Say who it's from: a name.";
  if (!EMAIL.test(email) || email.length > 254) return "Give an email address the planner's questions can reach (name@example.com).";
  if ((fields["role"] ?? "").trim().length > 80) return "Keep the role short (customer, sales, support…).";
  return null;
}

// --- The page --------------------------------------------------------------------------------------------------------

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const meta = (t: Task): string =>
  [t.kind, t.severity, t.priority === null ? null : `p${t.priority}`]
    .filter(Boolean)
    .map((part) => `<span class="chip">${esc(part)}</span>`)
    .join("");
const claimOf = (t: Task): string => (t.claim ? `<div class="claim">${esc(t.claim.role)} on ${esc(t.claim.machine)}</div>` : "");

// A request is open while it's new or being researched, and while any task it became isn't finished.
function isOpen(r: FeatureRequest, byId: Map<string, Task>): boolean {
  if (r.status === "new" || r.status === "researching") return true;
  if (r.status !== "promoted") return false;
  return r.tasks.some((id) => !["done", "rejected"].includes(byId.get(id)?.status ?? "done"));
}

async function page(
  store: Store,
  team: Team,
  { nonce, form = {}, problem = null }: { nonce: string; form?: Record<string, string>; problem?: string | null }
): Promise<string> {
  const [tasks, requests, stakeholders] = await Promise.all([store.tasks.all(), store.requests.all(), store.stakeholders.all()]);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const people = new Map(stakeholders.map((s) => [s.id, s]));
  const proposals = tasks
    .filter((t) => PROPOSALS.includes(t.status))
    .sort((a, b) => (b.priority ?? -1) - (a.priority ?? -1) || Number(a.id) - Number(b.id));
  const open = requests.filter((r) => isOpen(r, byId)).reverse();
  const inFlight = tasks.filter((t) => !["done", "rejected"].includes(t.status)).length;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(team.title)}: e9g</title>
<style nonce="${esc(nonce)}">${CSS}</style>
</head>
<body>
<main>
<header>
  <h1>${esc(team.title)}</h1>
  <p class="muted">${proposals.length} waiting for you · ${open.length} open request${open.length === 1 ? "" : "s"} · ${inFlight} task${inFlight === 1 ? "" : "s"} in flight · ${tasks.filter((t) => t.status === "done").length} done</p>
</header>
${proposalsSection(proposals)}
<div class="two">
${formSection(form, problem)}
${requestsSection(open, people, byId)}
</div>
${boardSection(tasks)}
${graphSection(tasks)}
</main>
<script nonce="${esc(nonce)}">${SCRIPT}</script>
</body>
</html>
`;
}

function proposalsSection(proposals: Task[]): string {
  const item = (t: Task): string => {
    const score = t.score
      ? `<p class="why"><b>Score:</b> ${esc(t.score.why)} <span class="muted">(confidence ${esc(t.score.confidence)}, size ${esc(t.score.size)})</span></p>`
      : `<p class="why muted">Not scored yet.</p>`;
    const gate = t.gate ? `<p class="why"><b>Asked:</b> ${esc(t.gate.asked)} · <b>Simplest:</b> ${esc(t.gate.simplest)}</p>` : "";
    const lastNote = t.notes.at(-1);
    return `<li class="proposal">
  <div class="head"><span class="id">#${esc(t.id)}</span> <span class="title">${esc(t.title)}</span> <span class="chip status-${esc(t.status)}">${esc(t.status)}</span>${meta(t)}</div>
  ${score}${gate}
  ${t.body ? `<p class="body">${esc(clip(t.body, 600))}</p>` : ""}
  ${lastNote ? `<p class="why muted">${esc(lastNote.by)}: ${esc(clip(lastNote.text, 300))}</p>` : ""}
  <div class="verdict">
    <form method="post" action="/api/tasks/${esc(t.id)}/approve" data-api>
      <input name="note" placeholder="Note (optional)" maxlength="500" aria-label="Note for approving #${esc(t.id)}">
      <button class="approve">Approve</button>
      <output></output>
    </form>
    <form method="post" action="/api/tasks/${esc(t.id)}/reject" data-api>
      <input name="reason" placeholder="Reason (needed)" required maxlength="500" aria-label="Reason for rejecting #${esc(t.id)}">
      <button class="reject">Reject</button>
      <output></output>
    </form>
  </div>
</li>`;
  };
  return `<section>
  <h2>Waiting for you</h2>
  ${proposals.length ? `<ul class="plain">${proposals.map(item).join("\n")}</ul>` : `<p class="muted">No proposals are waiting for you.</p>`}
</section>`;
}

function formSection(form: Record<string, string>, problem: string | null): string {
  const value = (key: string): string => esc(form[key] ?? "");
  return `<section>
  <h2>Request a feature</h2>
  ${problem ? `<p class="problem" role="alert">${esc(problem)}</p>` : ""}
  <form method="post" action="/requests" class="stack">
    <label>Title <input name="title" required maxlength="200" value="${value("title")}" placeholder="What should be possible"></label>
    <label>Description <textarea name="body" rows="4" placeholder="Who needs it, what they do today, and why it matters">${value("body")}</textarea></label>
    <div class="row">
      <label>Your name <input name="name" required maxlength="120" value="${value("name")}"></label>
      <label>Email <input name="email" type="email" required maxlength="254" value="${value("email")}"></label>
    </div>
    <label>Role <input name="role" maxlength="80" value="${value("role")}" placeholder="customer, sales, support…"></label>
    <div><button>Send the request</button></div>
    <p class="muted small">Your name and email stay on this page. The team's agents see your role and what you write here, never who you are.</p>
  </form>
</section>`;
}

function requestsSection(open: FeatureRequest[], people: Map<string, Stakeholder>, byId: Map<string, Task>): string {
  const item = (r: FeatureRequest): string => {
    const who = r.from ? people.get(r.from) : undefined;
    const from = who ? `${esc(who.name)} <span class="muted">(${esc(who.role)}) ${esc(who.email)}</span>` : `<span class="muted">no stakeholder</span>`;
    const linked = r.tasks.length
      ? `<div class="small">Tasks: ${r.tasks.map((id) => `#${esc(id)} <span class="muted">${esc(byId.get(id)?.status ?? "missing")}</span>`).join(", ")}</div>`
      : "";
    return `<li class="request">
  <div class="head"><span class="id">${esc(r.id)}</span> <span class="title">${esc(r.title)}</span> <span class="chip">${esc(r.status)}</span></div>
  <div class="small">${from}</div>
  ${r.body ? `<p class="body">${esc(clip(r.body, 400))}</p>` : ""}
  ${linked}
</li>`;
  };
  return `<section>
  <h2>Open requests</h2>
  ${open.length ? `<ul class="plain">${open.map(item).join("\n")}</ul>` : `<p class="muted">No open requests.</p>`}
</section>`;
}

function boardSection(tasks: Task[]): string {
  const card = (t: Task): string => `<li class="card status-${esc(t.status)}">
  <div><span class="id">#${esc(t.id)}</span> ${esc(t.title)}</div>
  <div class="small">${meta(t)}</div>
  ${claimOf(t)}
</li>`;
  const columns = STATUSES.flatMap((status) => {
    const list = tasks.filter((t) => t.status === status).sort(claimOrder);
    if (!list.length) return [];
    const cards = `<ul class="plain cards">${list.map(card).join("\n")}</ul>`;
    // Finished work piles up; it's there when wanted.
    const body = status === "done" || status === "rejected" ? `<details><summary>Show</summary>${cards}</details>` : cards;
    return [`<div class="column"><h3>${esc(status)} <span class="muted">${list.length}</span></h3>${body}</div>`];
  });
  return `<section>
  <h2>Board</h2>
  ${columns.length ? `<div class="board">${columns.join("\n")}</div>` : `<p class="muted">No tasks yet.</p>`}
</section>`;
}

// The graph as inline SVG, from the same layout as e9g task graph: a band per journey (and one for tasks in none), a
// box per task in columns by how many tasks come first, and a line for each dependency.
const BOX_W = 200;
const BOX_H = 52;
const COL_W = BOX_W + 44;
const ROW_H = BOX_H + 14;
const PAD = 14;
const BAND_TOP = 34;
const BAND_GAP = 16;

function graphSection(tasks: Task[]): string {
  const { bands, placed } = layout(tasks);
  if (!placed.length && !bands.some((b) => b.journey)) return `<section><h2>Graph</h2><p class="muted">No tasks yet.</p></section>`;
  const where = new Map<string, { x: number; y: number }>();
  const width = Math.max(...bands.map((b) => PAD * 2 + b.cols * COL_W - (COL_W - BOX_W)));
  const parts: string[] = [];
  let y = 0;
  for (const band of bands) {
    const h = BAND_TOP + band.rows * ROW_H - (ROW_H - BOX_H) + PAD;
    const label = band.journey ? `${band.label} · ${band.journey.status}` : band.label;
    parts.push(`<rect class="band" x="0.5" y="${y + 0.5}" width="${width - 1}" height="${h - 1}" rx="8"/>`);
    parts.push(`<text class="band-label" x="${PAD}" y="${y + 22}">${esc(clip(label, 90))}</text>`);
    for (const p of placed.filter((p) => p.band === band.id)) where.set(p.task.id, { x: PAD + p.col * COL_W, y: y + BAND_TOP + p.row * ROW_H });
    y += h + BAND_GAP;
  }
  const height = Math.max(1, y - BAND_GAP);
  const lines = placed.flatMap(({ task }) =>
    task.after.flatMap((dep) => {
      const from = where.get(dep);
      const to = where.get(task.id);
      if (!from || !to) return [];
      const [x1, y1, x2, y2] = [from.x + BOX_W, from.y + BOX_H / 2, to.x, to.y + BOX_H / 2];
      return [`<path class="dep" d="M${x1} ${y1} C${x1 + 28} ${y1}, ${x2 - 28} ${y2}, ${x2} ${y2}" marker-end="url(#arrow)"/>`];
    })
  );
  const boxes = placed.map(({ task: t }) => {
    const at = where.get(t.id) ?? { x: 0, y: 0 };
    const detail = [t.status, t.kind, t.severity, t.priority === null ? null : `p${t.priority}`, t.claim ? `${t.claim.role}@${t.claim.machine}` : null]
      .filter(Boolean)
      .join(" · ");
    return `<g class="node status-${esc(t.status)}">
  <title>#${esc(t.id)} ${esc(t.title)} (${esc(detail)})</title>
  <rect x="${at.x}" y="${at.y}" width="${BOX_W}" height="${BOX_H}" rx="6"/>
  <text x="${at.x + 10}" y="${at.y + 21}">${esc(clip(`#${t.id} ${t.title}`, 30))}</text>
  <text class="sub" x="${at.x + 10}" y="${at.y + 39}">${esc(clip(detail, 34))}</text>
</g>`;
  });
  return `<section>
  <h2>Graph</h2>
  <div class="graph"><svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="The task graph">
<defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path class="arrowhead" d="M0 0 L8 4 L0 8 z"/></marker></defs>
${parts.join("\n")}
${lines.join("\n")}
${boxes.join("\n")}
</svg></div>
</section>`;
}

const CSS = `
:root { color-scheme: light dark; --bg: #f6f6f4; --panel: #fff; --text: #1d1d1f; --muted: #6b6b70; --line: #e0e0dc; --chip: #efefec;
  --accent: #2557d6; --ok: #1f7a3f; --warn: #b3261e; --dim: #a0a0a4; }
@media (prefers-color-scheme: dark) { :root { --bg: #131315; --panel: #1b1b1e; --text: #ececec; --muted: #9b9ba1; --line: #2d2d32;
  --chip: #26262b; --accent: #7ea4ff; --ok: #62c98f; --warn: #ff8a80; --dim: #5d5d63; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1240px; margin: 0 auto; padding: 24px 16px 64px; }
header h1 { font-size: 21px; margin: 0 0 2px; }
h2 { font-size: 15px; margin: 0 0 12px; }
h3 { font-size: 13px; margin: 0 0 8px; text-transform: capitalize; }
section { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; margin: 16px 0; min-width: 0; }
.two { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 0 16px; }
.muted { color: var(--muted); }
.small { font-size: 12.5px; }
ul.plain { list-style: none; margin: 0; padding: 0; }
.proposal, .request { padding: 12px 0; border-top: 1px solid var(--line); }
.proposal:first-child, .request:first-child { border-top: 0; padding-top: 0; }
.head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; }
.id { color: var(--muted); font-variant-numeric: tabular-nums; }
.title { font-weight: 600; }
.chip { display: inline-block; background: var(--chip); border-radius: 999px; padding: 0 8px; font-size: 12px; margin-right: 4px; }
.why { margin: 6px 0 0; }
.body { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.verdict { display: flex; flex-wrap: wrap; gap: 8px 16px; margin-top: 10px; }
.verdict form { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.verdict output { flex-basis: 100%; font-size: 12.5px; color: var(--warn); white-space: pre-wrap; }
.verdict output:empty { display: none; }
input, textarea, button { font: inherit; color: inherit; }
input, textarea { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; width: 100%; }
.verdict input { width: 220px; }
button { background: var(--chip); border: 1px solid var(--line); border-radius: 6px; padding: 6px 12px; cursor: pointer; }
button:hover { border-color: var(--muted); }
button:disabled { opacity: .6; cursor: progress; }
button.approve { color: var(--ok); }
button.reject { color: var(--warn); }
.stack { display: grid; gap: 10px; }
.stack label { display: grid; gap: 4px; font-size: 12.5px; color: var(--muted); }
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.problem { color: var(--warn); margin: 0 0 10px; }
.board { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; align-items: start; }
.column { background: var(--bg); border-radius: 8px; padding: 10px; }
.cards { display: grid; gap: 8px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; overflow-wrap: anywhere; }
.card .small { margin-top: 4px; }
.claim { font-size: 12px; color: var(--accent); margin-top: 4px; }
.status-building { border-left: 3px solid var(--accent); }
.status-blocked, .status-question { border-left: 3px solid var(--warn); }
details summary { cursor: pointer; color: var(--muted); font-size: 12.5px; margin-bottom: 8px; }
.graph { overflow: auto; }
svg { font: 12px system-ui, -apple-system, "Segoe UI", sans-serif; display: block; }
svg .band { fill: var(--bg); stroke: var(--line); }
svg .band-label { fill: var(--muted); font-weight: 600; }
svg .node rect { fill: var(--panel); stroke: var(--line); }
svg .node text { fill: var(--text); }
svg .node text.sub { fill: var(--muted); font-size: 11px; }
svg .node.status-building rect { stroke: var(--accent); stroke-width: 2; }
svg .node.status-blocked rect, svg .node.status-question rect { stroke: var(--warn); stroke-width: 2; }
svg .node.status-proposed rect, svg .node.status-researching rect, svg .node.status-triage rect { stroke-dasharray: 4 3; }
svg .node.status-done text, svg .node.status-rejected text { fill: var(--dim); }
svg .dep { fill: none; stroke: var(--muted); stroke-width: 1.2; }
svg .arrowhead { fill: var(--muted); }
@media (max-width: 560px) { .row { grid-template-columns: 1fr; } .verdict input { width: 100%; } }
`;

// The token leaves the address bar once its cookie is set; Approve and Reject post to the API and reload, or say why not.
const SCRIPT = `
(() => {
  const here = new URL(location.href);
  if (here.searchParams.has("token")) {
    here.searchParams.delete("token");
    history.replaceState(null, "", here.pathname + here.search + here.hash);
  }
  for (const form of document.querySelectorAll("form[data-api]")) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const out = form.querySelector("output");
      const buttons = form.querySelectorAll("button");
      buttons.forEach((b) => (b.disabled = true));
      out.textContent = "";
      try {
        const res = await fetch(form.getAttribute("action"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(Object.fromEntries(new FormData(form))),
        });
        const result = await res.json().catch(() => ({ ok: false, output: res.status + " " + res.statusText }));
        if (result.ok) return location.reload();
        out.textContent = result.output || "refused";
      } catch (error) {
        out.textContent = String(error);
      }
      buttons.forEach((b) => (b.disabled = false));
    });
  }
})();
`;
