// e9g request …: the team's feature-request stack. Stakeholders' requests come in (from the operator, or e9g serve's
// form), the planner researches each and promotes it into the task graph (e9g task add --request) or rejects it.
// Who sent a request is a stakeholder id and a role: names and email addresses stay with the stakeholders, which only
// the operator's own commands show (Article 8).
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { asOperator, teamSession } from "../session.ts";
import { type FeatureRequest, nowIso, OPERATOR, REQUEST_STATUSES, type Stakeholder, withEvent } from "../tasks/model.ts";
import { addRequest, forAgents, keyHash, stakeholderFor } from "../tasks/requests.ts";
import { openTeamStore } from "../tasks/ops.ts";
import { Refused, update } from "../tasks/store.ts";
import { list, type Options, parseArgs, text as optionText } from "../util.ts";

export const USAGE = `usage: e9g request <command>
  add "<title>" [--body "…" | --body-file f] [--name "…" --email "…" --role "…" | --from sN]   (you; the planner without a person)
  list [--status s,t] [--all] [--json]   ·   show <id> [--json]
  note <id> "<text>"   ·   reject <id> --reason "…"   (the planner)
  stakeholders [add --name "…" --email "…" --role "…" | revoke <sN>]   (you: a stakeholder's own link to e9g serve's form)`;

const actor = (): string => (asOperator() ? OPERATOR : process.env.E9G_ROLE || "unknown");
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const commaList = (value: Options[string]): string[] =>
  list(value)
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);

function line(r: FeatureRequest & { fromRole?: string | null }, who: Stakeholder | null): string {
  const from = who ? `${who.name} <${who.email}>, ${who.role}` : r.from ? `${r.from}${r.fromRole ? `, ${r.fromRole}` : ""}` : "no stakeholder";
  return `${r.id.padEnd(5)} ${r.status.padEnd(11)} ${r.title}  (${from})${r.tasks.length ? ` → tasks ${r.tasks.map((t) => `#${t}`).join(" ")}` : ""}`;
}

export async function request(argv: string[]): Promise<number> {
  const [sub = "help", ...rest] = argv;
  const { positional, options } = parseArgs(rest, { booleans: ["all", "json", "help"] });
  if (!["add", "list", "show", "note", "reject", "stakeholders"].includes(sub) || options["help"] === true) {
    console.info(USAGE);
    return sub === "help" || sub === "--help" || options["help"] === true ? 0 : 2;
  }
  const who = actor();
  const operator = who === OPERATOR;
  const { home, team, run } = teamSession();
  if (team.board.type !== "tasks") {
    console.error("request: this team's board is GitHub issues (team.json board), so it keeps no feature requests");
    return 2;
  }
  const store = await openTeamStore(team, run, home);
  try {
    const get = async (id: string | undefined): Promise<FeatureRequest> => {
      const found = id ? await store.requests.get(id) : null;
      if (!found) throw new Refused(id ? `no request ${id}` : "which request? Give its id (r12).");
      return found;
    };
    if (sub === "add") {
      if (!operator && who !== "planner")
        throw new Refused("stakeholders' requests come from the operator or e9g serve; members file tasks (e9g task add)");
      const title = positional.join(" ").trim();
      if (!title) throw new Refused('give it a title: e9g request add "<what they want>"');
      const file = optionText(options["body-file"]);
      const body = file ? readFileSync(resolve(file), "utf8").trim() : (optionText(options["body"]) ?? "");
      const name = optionText(options["name"]);
      const email = optionText(options["email"]);
      const role = optionText(options["role"]);
      let from = optionText(options["from"]) ?? null;
      if (name || email) {
        // People's names and addresses never pass through an agent (Article 8).
        if (!operator) throw new Refused("an agent doesn't record people's names or addresses; leave out --name and --email");
        if (!name || !email || !EMAIL.test(email)) throw new Refused("a stakeholder needs --name, an --email and a --role");
        from = (await stakeholderFor(store, team.name, { name, email, role: role ?? "stakeholder" })).id;
      } else if (from && !(await store.stakeholders.get(from))) throw new Refused(`no stakeholder ${from} (e9g request stakeholders)`);
      const added = await addRequest(store, team.name, { title, body, from, by: who });
      console.info(`request ${added.id} added: ${added.title}`);
      return 0;
    }
    if (sub === "stakeholders") {
      if (!operator) throw new Refused("the stakeholders' names and addresses are the operator's to see");
      const [action, id] = positional;
      // A link of their own: it opens only the request form and their own requests, and what they send is theirs.
      if (action === "add") {
        const name = optionText(options["name"]);
        const email = optionText(options["email"]);
        if (!name || !email || !EMAIL.test(email)) throw new Refused('a stakeholder needs --name "…", an --email and a --role');
        const found = await stakeholderFor(store, team.name, { name, email, role: optionText(options["role"]) ?? "stakeholder" });
        // An address already on file is that person: a new link for them replaces their old one, never a stranger's.
        if (found.name.toLowerCase() !== name.toLowerCase())
          throw new Refused(`${email} is ${found.id} ${found.name} already; give their name to make them a new link`);
        const key = randomBytes(18).toString("base64url");
        await update(store.stakeholders, found.id, (s) => ({ ...s, key: keyHash(key) }));
        console.info(
          `${found.id} ${found.name} has a link of their own: e9g serve's address followed by /?token=${key}\nIt opens only the request form and their own requests. A new link replaces this one; e9g request stakeholders revoke ${found.id} ends it.`
        );
        return 0;
      }
      if (action === "revoke") {
        if (!id || !(await store.stakeholders.get(id))) throw new Refused("which stakeholder? e9g request stakeholders revoke <sN>");
        await update(store.stakeholders, id, (s) => ({ ...s, key: null }));
        console.info(`${id}'s link no longer opens the form`);
        return 0;
      }
      if (action) throw new Refused("e9g request stakeholders [add --name … --email … --role … | revoke <sN>]");
      const all = await store.stakeholders.all();
      console.info(
        all.length ? all.map((s) => `${s.id.padEnd(5)} ${s.name} <${s.email}>, ${s.role}${s.key ? " (has a link)" : ""}`).join("\n") : "no stakeholders"
      );
      return 0;
    }
    if (sub === "list") {
      let all = await store.requests.all();
      const statuses = commaList(options["status"]);
      for (const status of statuses)
        if (!(REQUEST_STATUSES as readonly string[]).includes(status)) throw new Refused(`--status: ${REQUEST_STATUSES.join(", ")}`);
      if (statuses.length) all = all.filter((r) => statuses.includes(r.status));
      else if (!options["all"]) all = all.filter((r) => r.status === "new" || r.status === "researching");
      const shown = await Promise.all(all.map((r) => forAgents(store, r)));
      if (options["json"]) console.info(JSON.stringify(shown, null, 2));
      else {
        const lines = await Promise.all(shown.map(async (r) => line(r, operator && r.from ? await store.stakeholders.get(r.from) : null)));
        console.info(lines.length ? lines.join("\n") : "no open requests");
      }
      return 0;
    }
    if (sub === "show") {
      const r = await forAgents(store, await get(positional[0]));
      if (options["json"]) console.info(JSON.stringify(r, null, 2));
      else {
        const who2 = operator && r.from ? await store.stakeholders.get(r.from) : null;
        console.info(
          [
            line(r, who2),
            "",
            r.body || "(no description)",
            ...(r.notes.length ? ["", "Notes:", ...r.notes.map((n) => `- ${n.at.slice(0, 16)} ${n.by}: ${n.text}`)] : []),
          ].join("\n")
        );
      }
      return 0;
    }
    // note, reject: the planner's (and the operator's).
    if (!operator && who !== "planner" && !(sub === "note" && who === "approver"))
      throw new Refused(`${sub === "note" ? "noting" : "rejecting"} a request is the planner's`);
    const r = await get(positional[0]);
    if (sub === "note") {
      const text = (optionText(options["text"]) ?? positional.slice(1).join(" ")).trim();
      if (!text) throw new Refused('say what: e9g request note <id> "<text>"');
      // The planner's note on a new request starts its research; anyone else's leaves it new, for the planner.
      await update(store.requests, r.id, (x) => {
        const starts = x.status === "new" && who === "planner";
        return withEvent(
          { ...x, status: starts ? "researching" : x.status, notes: [...x.notes, { at: nowIso(), by: who, text }] },
          who,
          starts ? "new → researching: added a note" : "added a note",
          starts ? { from: "new", to: "researching" } : {}
        );
      });
      console.info(`request ${r.id}: note added`);
      return 0;
    }
    const reason = optionText(options["reason"]);
    if (!reason) throw new Refused('say why, against the direction or the evidence: --reason "…"');
    // A promoted request is rejected once its tasks are: until then it's being built.
    const tasks = await store.tasks.all();
    const open = (x: FeatureRequest): void => {
      const live = x.tasks.filter((id) => tasks.find((t) => t.id === id)?.status !== "rejected");
      if (x.status === "promoted" && live.length) throw new Refused(`request ${x.id} is tasks ${live.map((t) => `#${t}`).join(" ")}; reject those first`);
      if (x.status === "rejected") throw new Refused(`request ${x.id} is already rejected`);
    };
    open(r);
    await update(store.requests, r.id, (x) => {
      open(x);
      return withEvent(
        { ...x, status: "rejected", notes: [...x.notes, { at: nowIso(), by: who, text: `rejected: ${reason}` }] },
        who,
        `${x.status} → rejected: ${reason}`,
        { from: x.status, to: "rejected" }
      );
    });
    console.info(`request ${r.id}: rejected`);
    return 0;
  } catch (error) {
    if (error instanceof Refused) {
      console.error(`request: ${error.message}`);
      return 2;
    }
    throw error;
  } finally {
    await store.close();
  }
}
