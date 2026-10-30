// e9g task …: the team's task graph (lib/tasks/). Every change goes through here, checked against the caller's role
// and the task's status, written only if nobody changed the task meanwhile, and recorded in its history. Agents never
// write the store themselves: it's in the run folder, which the guard refuses them.
import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Team } from "../config.ts";
import { machineName } from "../machine.ts";
import { boardDir, readRegistry } from "../paths.ts";
import { inTeam, teamSession } from "../session.ts";
import { betterDiagram } from "../tasks/graph.ts";
import {
  branchFor,
  CLAIMS,
  claimRefusal,
  CONFIDENCE,
  conflictOf,
  heldHere,
  DIMENSIONS,
  type Dimension,
  journeyDue,
  KINDS,
  type Kind,
  move,
  moveRefusal,
  newTask,
  nextClaim,
  nowIso,
  OPERATOR,
  priorityOf,
  type Score,
  SEVERITIES,
  SIZES,
  type Size,
  STATUSES,
  type Status,
  statusRefusal,
  type Task,
  ticketOf,
  type Via,
  withEvent,
} from "../tasks/model.ts";
import { blastRadius } from "../blast.ts";
import { branchRef, isLead, multiMachine, prepareBranch, pushTaskBranch, remoteOf } from "../tasks/machines.ts";
import { claimMark, importBoard, leaseMinutes, markClaim, openTeamStore } from "../tasks/ops.ts";
import { openStore, Refused, type Store, update } from "../tasks/store.ts";
import { git, gitOk, list, type Options, parseArgs, text as optionText } from "../util.ts";

export const USAGE = `usage: e9g task <command>
  add "<title>" [--kind k] [--sev s] [--body "…" | --body-file f] [--area a] [--files p,q] [--parent id] [--after id,id] [--request rN]
      (a member's finding goes to triage; the planner's work is proposed; yours may be --approved)
  list [--status s,t] [--kind k] [--all] [--claimable] [--json]   ·   show <id> [--json]   ·   graph [--out <file>] [--all]
  note <id> "<text>"
  edit <id> [--title …] [--body … | --body-file f] [--kind k] [--sev s] [--area a] [--files p,q] [--parent id|none] [--after id,id|none]
  score <id> --pain N --reach N --revenue N --wow N --distribution N --leverage N --urgency N --risk N
             --confidence hunch|asks|data --size S|M|L|XL --why "…" [--asked "…" --simplify "…" --simplest "…"]
  status <id> <status> [--reason "…"]   ·   import
  approve <id> [--note "…"]   ·   reject <id> --reason "…"   ·   research <id> --note "…"   ·   escalate <id> --reason "…"
  claim [<id>] [--kind k]   ·   release <id> [--blocked "…"]   ·   submit <id>   ·   fetch <id> (a worker's branch, on the lead)
  migrate --to mongo|files [--dry-run]   (yours: the whole graph into the other store)`;

// Who's acting: the member's role (its instance's E9G_ROLE), or the operator when a person runs it.
const actor = (): string => (inTeam() ? process.env.E9G_ROLE || "unknown" : OPERATOR);
const may = (who: string, roles: string[]): boolean => who === OPERATOR || roles.includes(who);
const need = (who: string, roles: string[], what: string): void => {
  if (!may(who, roles))
    throw new Refused(`${what} is the ${roles.join(" or the ")}'s${roles.includes("planner") ? "" : " (or the operator's)"}; you're the ${who}`);
};

interface Context {
  home: string;
  team: Team;
  run: string;
  store: Store;
  who: string;
}

async function withStore<R>(fn: (ctx: Context) => Promise<R>, { importFirst = true } = {}): Promise<R> {
  const { home, team, run } = teamSession();
  if (team.board.type !== "tasks") throw new Refused("this team's board is GitHub issues (team.json board), so it keeps no task graph");
  // A 0.3 files board comes across once, ticket by ticket (lib/tasks/ops.ts); e9g task import does it itself, to say so.
  const store = importFirst ? await openTeamStore(team, run, home) : await openStore(team, run);
  try {
    return await fn({ home, team, run, store, who: actor() });
  } finally {
    await store.close();
  }
}

const getTask = async (store: Store, id: string | undefined): Promise<Task> => {
  if (!id) throw new Refused("which task? Give its number.");
  const task = await store.tasks.get(id.replace(/^#/, ""));
  if (!task) throw new Refused(`no task ${id}`);
  return task;
};

const commaList = (value: Options[string]): string[] =>
  list(value)
    .flatMap((v) => v.split(","))
    .map((v) => v.trim().replace(/^#/, ""))
    .filter(Boolean);

function bodyOf(options: Options): string | undefined {
  const file = optionText(options["body-file"]);
  if (!file) return optionText(options["body"]);
  try {
    return readFileSync(resolve(file), "utf8").trim();
  } catch {
    throw new Refused(`can't read ${file}`);
  }
}

const oneOf = <T extends string>(value: string | undefined, values: readonly T[], what: string): T | undefined => {
  if (value === undefined) return undefined;
  if (!(values as readonly string[]).includes(value)) throw new Refused(`${what}: ${values.join(", ")}, not ${value}`);
  return value as T;
};

// --- Showing tasks ----------------------------------------------------------------------------------------------

const pad = (text: string, n: number) => (text.length >= n ? text : `${text}${" ".repeat(n - text.length)}`);
export function line(t: Task, all: Task[] = []): string {
  const claim = t.claim ? ` [${t.claim.role}@${t.claim.machine}]` : "";
  const due = journeyDue(t, all) ? " (due its verification)" : "";
  return `#${pad(t.id, 4)} ${pad(t.status, 11)} ${pad(t.kind, 10)} ${pad(t.severity ?? "", 7)} ${pad(t.priority === null ? "" : `p${t.priority}`, 4)} ${t.title}${claim}${due}`;
}

export function detail(t: Task): string {
  const out = [
    `#${t.id} ${t.title}`,
    `${t.status} · ${t.kind}${t.severity ? ` · ${t.severity}` : ""}${t.priority === null ? "" : ` · priority ${t.priority}`}`,
  ];
  if (t.area) out.push(`area: ${t.area}`);
  if (t.files.length) out.push(`files: ${t.files.join(", ")}`);
  if (t.parent) out.push(`journey: #${t.parent}`);
  if (t.after.length) out.push(`after: ${t.after.map((id) => `#${id}`).join(", ")}`);
  if (t.request) out.push(`request: ${t.request}`);
  if (t.branch) out.push(`branch: ${t.branch}${t.sha ? ` at ${t.sha.slice(0, 9)}` : ""}`);
  if (t.claim) out.push(`claimed by the ${t.claim.role} on ${t.claim.machine} until ${t.claim.until}`);
  if (t.rounds) out.push(`review rounds with changes: ${t.rounds}`);
  if (t.ui !== null || t.critical.length) out.push(`touches: ${[t.ui ? "UI" : null, ...t.critical].filter(Boolean).join(", ") || "no UI"}`);
  if (t.gate) out.push(`gate: asked ${t.gate.asked} · instead ${t.gate.simplify} · simplest ${t.gate.simplest}`);
  if (t.score)
    out.push(`score: ${DIMENSIONS.map((d) => `${d} ${t.score?.[d]}`).join(", ")}; confidence ${t.score.confidence}, size ${t.score.size}. ${t.score.why}`);
  if (t.approval) out.push(`approved by the ${t.approval.by} at ${t.approval.at}${t.approval.note ? `: ${t.approval.note}` : ""}`);
  if (t.body) out.push("", t.body);
  if (t.notes.length) out.push("", "Notes:", ...t.notes.map((n) => `- ${n.at.slice(0, 16)} ${n.by}: ${n.text}`));
  out.push("", "History:", ...t.history.slice(-8).map((e) => `- ${e.at.slice(0, 16)} ${e.by}: ${e.what}`));
  return out.join("\n");
}

// --- Commands -----------------------------------------------------------------------------------------------------

type Handler = (ctx: Context, positional: string[], options: Options) => Promise<number>;

const add: Handler = async ({ team, store, who }, positional, options) => {
  if (who === "unknown") throw new Refused("only the team's members add tasks");
  const title = positional.join(" ").trim();
  if (!title) throw new Refused('give the task a title: e9g task add "<what should be true>"');
  const planning = may(who, ["planner"]);
  const kind = oneOf(optionText(options["kind"]), KINDS, "--kind") ?? (planning || who === "innovator" ? "feature" : "bug");
  const severity = oneOf(optionText(options["sev"]), SEVERITIES, "--sev") ?? null;
  const body = bodyOf(options) ?? "";
  // A member's finding goes to triage, and says how bad it is and what happened; the planner's work is a proposal.
  const status: Status = planning ? (who === OPERATOR && options["approved"] ? "approved" : "proposed") : "triage";
  if (!planning && ["bug", "ux"].includes(kind) && !severity) throw new Refused("a finding says how bad it is: --sev blocker|major|minor");
  if (!planning && body.length < 20) throw new Refused("say what happened and what should happen, with steps: --body or --body-file");
  const all = await store.tasks.all();
  const byId = new Map(all.map((t) => [t.id, t]));
  const parent = optionText(options["parent"])?.replace(/^#/, "") ?? null;
  if (parent && byId.get(parent)?.kind !== "journey")
    throw new Refused(`--parent names a journey; #${parent} ${byId.has(parent) ? "isn't one" : "doesn't exist"}`);
  const after = commaList(options["after"]);
  for (const id of after) if (!byId.has(id)) throw new Refused(`--after: no task ${id}`);
  const request = optionText(options["request"]) ?? null;
  if (request) {
    need(who, ["planner"], "promoting a feature request");
    if (!(await store.requests.get(request))) throw new Refused(`no feature request ${request}`);
  }
  const fields = newTask({
    team: team.name,
    title,
    kind,
    status,
    severity,
    body,
    area: optionText(options["area"]) ?? null,
    files: commaList(options["files"]),
    parent,
    after,
    request,
    by: who,
  });
  if (status === "approved") fields.approval = { by: OPERATOR, at: nowIso(), note: "added approved by the operator" };
  const task = await store.tasks.create(fields);
  if (request)
    await update(store.requests, request, (r) =>
      withEvent({ ...r, status: "promoted", tasks: [...new Set([...r.tasks, task.id])] }, who, `${r.status} → promoted: task ${task.id}`, {
        from: r.status,
        to: "promoted",
      })
    );
  console.info(`task ${task.id} added (${task.status}): ${task.title}`);
  return 0;
};

const listTasks: Handler = async ({ store, who }, _positional, options) => {
  const everything = await store.tasks.all();
  let all = everything;
  const statuses = commaList(options["status"]);
  if (statuses.length) all = all.filter((t) => statuses.includes(t.status));
  else if (!options["all"]) all = all.filter((t) => t.status !== "done" && t.status !== "rejected");
  const kind = optionText(options["kind"]);
  if (kind) all = all.filter((t) => t.kind === kind);
  if (options["claimable"]) {
    const role = CLAIMS[who] ? who : "builder";
    all = all.filter((t) => claimRefusal(t, role, everything) === null);
  }
  if (options["json"]) console.info(JSON.stringify(all, null, 2));
  else console.info(all.length ? all.map((t) => line(t, everything)).join("\n") : "no tasks");
  return 0;
};

const show: Handler = async ({ store }, [id], options) => {
  const task = await getTask(store, id);
  console.info(options["json"] ? JSON.stringify(task, null, 2) : detail(task));
  return 0;
};

const note: Handler = async ({ store, who }, [id, ...rest], options) => {
  if (who === "unknown") throw new Refused("only the team's members add notes");
  const text = (optionText(options["text"]) ?? rest.join(" ")).trim();
  if (!text) throw new Refused('say what: e9g task note <id> "<text>"');
  const task = await getTask(store, id);
  await update(store.tasks, task.id, (t) => withEvent({ ...t, notes: [...t.notes, { at: nowIso(), by: who, text }] }, who, "added a note"));
  console.info(`task ${task.id}: note added`);
  return 0;
};

const edit: Handler = async ({ store, who }, [id], options) => {
  need(who, ["planner"], "editing a task");
  const task = await getTask(store, id);
  const all = await store.tasks.all();
  const byId = new Map(all.map((t) => [t.id, t]));
  const changes: Partial<Task> = {};
  const title = optionText(options["title"]);
  if (title) changes.title = title;
  const body = bodyOf(options);
  if (body !== undefined) changes.body = body;
  const kind = oneOf(optionText(options["kind"]), KINDS, "--kind");
  if (kind) changes.kind = kind;
  const sev = optionText(options["sev"]);
  if (sev !== undefined) changes.severity = sev === "none" ? null : (oneOf(sev, SEVERITIES, "--sev") ?? null);
  const area = optionText(options["area"]);
  if (area !== undefined) changes.area = area === "none" ? null : area;
  if (options["files"] !== undefined) changes.files = optionText(options["files"]) === "none" ? [] : commaList(options["files"]);
  const parent = optionText(options["parent"])?.replace(/^#/, "");
  if (parent !== undefined) {
    if (parent !== "none" && (byId.get(parent)?.kind !== "journey" || parent === task.id))
      throw new Refused(`--parent names a journey; #${parent} isn't one`);
    changes.parent = parent === "none" ? null : parent;
  }
  if (options["after"] !== undefined) {
    const after = optionText(options["after"]) === "none" ? [] : commaList(options["after"]);
    for (const dep of after) if (!byId.has(dep) || dep === task.id) throw new Refused(`--after: no task ${dep} (other than this one)`);
    // No loops: nothing this task must come first for may come first for it.
    const waitsFor = (from: string, seen = new Set<string>()): boolean =>
      from === task.id || (!seen.has(from) && (seen.add(from), (byId.get(from)?.after ?? []).some((next) => waitsFor(next, seen))));
    const loop = after.find((dep) => waitsFor(dep));
    if (loop) throw new Refused(`--after ${loop} would make a loop: ${loop} already waits for ${task.id}`);
    changes.after = after;
  }
  if (!Object.keys(changes).length) throw new Refused("nothing to change; see e9g task help");
  if (changes.kind && changes.kind !== "journey" && task.kind === "journey" && all.some((t) => t.parent === task.id))
    throw new Refused(`journey ${task.id} has tasks (--parent ${task.id}); move them out first`);
  // What the task is (its title, body and kind) is what was approved: changed, it's approved again before it's built.
  const substance = (["title", "body", "kind"] as const).filter((key) => key in changes);
  const moved = await update(store.tasks, task.id, (t) => {
    if (substance.length && ["building", "review"].includes(t.status))
      throw new Refused(`task ${t.id} is ${t.status}: its ${substance.join(", ")} stay as claimed; add a note (e9g task note) or move it back first`);
    const edited = `edited ${Object.keys(changes).join(", ")}`;
    if (!substance.length || t.approval === null) return withEvent({ ...t, ...changes }, who, edited);
    // An approved task goes back among the proposals (a move, by the table); a blocked or questioned one keeps its status.
    if (t.status === "approved") return move(t, "proposed", "status", who, { all }, { fields: changes, why: `${edited}, to be approved again` });
    return withEvent({ ...t, ...changes, approval: null }, who, `${edited}; approval cleared, to be approved again`);
  });
  console.info(
    `task ${task.id}: edited ${Object.keys(changes).join(", ")}${moved.approval === null && task.approval !== null ? " (to be approved again)" : ""}`
  );
  return 0;
};

const score: Handler = async ({ team, store, who }, [id], options) => {
  need(who, ["planner"], "scoring a task");
  const task = await getTask(store, id);
  const values = {} as Record<Dimension, number>;
  for (const d of DIMENSIONS) {
    const raw = optionText(options[d]);
    if (raw === undefined || !/^[0-3]$/.test(raw)) throw new Refused(`--${d}: 0, 1, 2 or 3 (every dimension is scored; see your prompt's anchors)`);
    values[d] = Number(raw);
  }
  const confidence = oneOf(optionText(options["confidence"]), Object.keys(CONFIDENCE) as (keyof typeof CONFIDENCE)[], "--confidence");
  const size = oneOf(optionText(options["size"]), Object.keys(SIZES) as Size[], "--size");
  const why = optionText(options["why"]);
  if (!confidence || !size || !why) throw new Refused('--confidence hunch|asks|data, --size S|M|L|XL and --why "…" are needed too');
  const asked = optionText(options["asked"]);
  const simplify = optionText(options["simplify"]);
  const simplest = optionText(options["simplest"]);
  const given = [asked, simplify, simplest].filter((v) => v !== undefined).length;
  if (given && given < 3) throw new Refused("the gate is all three: --asked, --simplify and --simplest");
  const gate = asked && simplify && simplest ? { asked, simplify, simplest } : task.gate;
  // Before new work is scored: who asked and why, what could go instead, and the simplest version (the score is for that).
  if (!gate && task.kind === "feature")
    throw new Refused(
      'new work passes the gate first: --asked "who asked, and why" --simplify "what could be deleted or simplified instead" --simplest "the simplest version that gets the outcome"'
    );
  const scored: Score = { ...values, confidence, size, why };
  const priority = priorityOf(scored, team.priorities.weights);
  // An approval is for the task as it was scored: a new score sends an approved task back for approving.
  const all = await store.tasks.all();
  const moved = await update(store.tasks, task.id, (t) => {
    const fields = { gate, score: scored, priority, approval: null };
    const said = `scored: priority ${priority} (size ${size}, ${confidence})`;
    return t.status === "approved"
      ? move(t, "proposed", "status", who, { all }, { fields, why: `${said}, to be approved again` })
      : withEvent({ ...t, ...fields }, who, said);
  });
  console.info(
    `task ${task.id}: priority ${priority}${moved.status === "proposed" && task.status === "approved" ? " (back to proposed, for approving again)" : ""}`
  );
  return 0;
};

const setStatus: Handler = async ({ store, who }, [id, to], options) => {
  const target = oneOf(to, STATUSES, "the status");
  if (!target) throw new Refused(`which status? ${STATUSES.join(", ")}`);
  const task = await getTask(store, id);
  const all = await store.tasks.all();
  const refusal = statusRefusal(task, target, who, all);
  if (refusal) throw new Refused(refusal);
  const reason = optionText(options["reason"]);
  await update(store.tasks, task.id, (t) =>
    move(
      t,
      target,
      "status",
      who,
      { all },
      { fields: reason ? { notes: [...t.notes, { at: nowIso(), by: who, text: `${t.status} → ${target}: ${reason}` }] } : {}, why: reason }
    )
  );
  console.info(`task ${task.id}: ${task.status} → ${target}`);
  return 0;
};

// The verdicts on a proposal: the approver's and the operator's, and the planner's on a finding another member filed.
// Who may give which, from where, is the move table's (lib/tasks/model.ts); each is checked again as it's written.
const approve: Handler = async ({ team, store, who }, [id], options) => {
  const text = optionText(options["note"]) ?? "";
  const task = await getTask(store, id);
  const ctx = { all: await store.tasks.all(), approval: team.approval };
  const refusal = moveRefusal(task, "approved", "approve", who, ctx);
  if (refusal) throw new Refused(refusal);
  await update(store.tasks, task.id, (t) =>
    move(t, "approved", "approve", who, ctx, { fields: { approval: { by: who, at: nowIso(), note: text } }, why: text || undefined })
  );
  console.info(`task ${task.id}: approved`);
  return 0;
};

const proposalVerdict =
  (to: Status, via: Via, flag: "reason" | "note"): Handler =>
  async ({ team, store, who }, [id], options) => {
    const task = await getTask(store, id);
    const ctx = { all: await store.tasks.all(), approval: team.approval };
    const refusal = moveRefusal(task, to, via, who, ctx);
    if (refusal) throw new Refused(refusal);
    const reason = optionText(options[flag]);
    if (!reason) throw new Refused(`say why: --${flag} "…"`);
    await update(store.tasks, task.id, (t) =>
      move(t, to, via, who, ctx, { fields: { notes: [...t.notes, { at: nowIso(), by: who, text: reason }] }, why: reason })
    );
    console.info(`task ${task.id}: ${to}`);
    return 0;
  };

// --- Claiming -------------------------------------------------------------------------------------------------------

const toplevel = (): string => {
  try {
    return realpathSync(git(process.cwd(), "rev-parse", "--show-toplevel"));
  } catch {
    throw new Refused("run this in your own worktree (a git checkout)");
  }
};

// The integration branch work is measured against: a worker's own copy is stale (the lead pushes what it merges), so
// there it's the remote's, which the claim fetched.
const baseRef = (team: Team, cwd: string): string => {
  if (!multiMachine(team) || isLead(team)) return team.branch;
  const remote = `refs/remotes/${remoteOf(team)}/${team.branch}`;
  return gitOk(cwd, "rev-parse", "--verify", "--quiet", remote) ? remote : team.branch;
};
const leaseMin = (team: Team): number => leaseMinutes(team.watchdog.stuckAfterMin);

const claim: Handler = async ({ home, team, run, store, who }, [id], options) => {
  if (!CLAIMS[who]) throw new Refused(`builders and testers claim tasks; you're the ${who}`);
  const worktree = toplevel();
  if (worktree === realpathSync(home)) throw new Refused("claim from your own worktree, not the team's checkout");
  const kind = oneOf(optionText(options["kind"]), KINDS, "--kind") as Kind | undefined;
  for (let attempt = 0; attempt < 8; attempt++) {
    const all = await store.tasks.all();
    const held = all.find((t) => t.status === "building" && heldHere(t.claim, worktree, machineName()));
    if (held) throw new Refused(`this worktree holds task ${held.id} already; submit it (e9g task submit ${held.id}) or release it first`);
    const target = id ? all.find((t) => t.id === id.replace(/^#/, "")) : nextClaim(all, who, kind);
    if (!target) {
      if (id) throw new Refused(`no task ${id}`);
      console.info(`nothing to claim: no approved ${CLAIMS[who]?.join(", ")} task is free. Say so in your report and stop.`);
      return 3;
    }
    const refusal = claimRefusal(target, who, all);
    if (refusal) {
      if (id) throw new Refused(refusal);
      continue;
    }
    const at = new Date();
    const lease = new Date(at.getTime() + leaseMin(team) * 60_000);
    const mine = { role: who, machine: machineName(), worktree, at: at.toISOString(), until: lease.toISOString() };
    const written = await store.tasks.replace(move(target, "building", "claim", who, { all }, { fields: { claim: mine }, by: `${who}@${mine.machine}` }));
    if (!written) continue;
    // Two claims on overlapping files at once: whoever sees the other after writing gives way (both may, and try
    // again after a pause), so two members never build on the same files.
    const clash = conflictOf(
      written,
      (await store.tasks.all()).filter((t) => t.status === "building" && t.id !== written.id)
    );
    if (clash) {
      await store.tasks.replace(
        move(
          written,
          "approved",
          "release",
          who,
          { all, machine: mine.machine, worktree },
          { by: `${who}@${mine.machine}`, why: `#${clash.id} is being built on the same files` }
        )
      );
      await new Promise((done) => setTimeout(done, 50 + Math.random() * 250));
      continue;
    }
    markClaim(run, worktree, [written.id]);
    const branch = written.branch ?? branchFor(written, who, team.branchPrefix);
    // On a worker machine, the branch comes from the remote, where the lead pushes what it merges. Finished members'
    // worktrees go first (the worker's watchdog can't read the checkout to prune them), freeing the branch if one held it.
    const worker = multiMachine(team) && !isLead(team);
    if (worker) {
      const entry = readRegistry(team.name);
      if (entry?.home === home) (await import("./watchdog.ts")).pruneWorktrees(entry);
    }
    const prepared = worker ? prepareBranch(worktree, team, branch, Boolean(written.branch)) : null;
    // A branch of this name already here, from a member whose claim ran out before it handed the task in: its work
    // is on it, so the next member continues it rather than starting over.
    const leftover = !written.branch && !prepared && gitOk(worktree, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
    console.info(
      [
        `Claimed task ${written.id} until ${lease.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}; your heartbeats renew it while you work.`,
        prepared
          ? `Branch: ${prepared.said}.`
          : written.branch || leftover
            ? `${leftover ? "An earlier member's" : "Its"} branch has the work so far: git checkout ${branch} (if git says another worktree uses it, git -C <that path> switch --detach first).`
            : `Your branch: git branch -m ${branch}`,
        `Done and committed: e9g task submit ${written.id}. Can't finish: e9g task release ${written.id} --blocked "<why>".`,
        "",
        detail(written),
      ].join("\n")
    );
    return 0;
  }
  throw new Refused("other members kept claiming the same tasks; try again");
};

const release: Handler = async ({ run, store, who }, [id], options) => {
  const blocked = optionText(options["blocked"]);
  const to: Status = blocked ? "blocked" : "approved";
  // The claimant hands it back; the planner may free one whose member is gone (the move table).
  const ctx = { all: [], machine: machineName(), worktree: toplevelOrNull() };
  const task = await getTask(store, id);
  const refusal = moveRefusal(task, to, "release", who, ctx);
  if (refusal) throw new Refused(refusal);
  let worktree = "";
  await update(store.tasks, task.id, (t) => {
    worktree = t.claim?.worktree ?? "";
    return move(t, to, "release", who, ctx, {
      fields: blocked ? { notes: [...t.notes, { at: nowIso(), by: who, text: `blocked: ${blocked}` }] } : {},
      why: blocked,
    });
  });
  if (worktree) rmSync(claimMark(run, worktree), { force: true });
  console.info(`task ${task.id}: ${to}`);
  return 0;
};
const toplevelOrNull = (): string | null => {
  try {
    return toplevel();
  } catch {
    return null;
  }
};

const submit: Handler = async ({ team, run, store, who }, [id]) => {
  if (!CLAIMS[who]) throw new Refused(`builders and testers submit what they built; you're the ${who}`);
  const worktree = toplevel();
  const ctx = { all: [], machine: machineName(), worktree };
  const task = await getTask(store, id);
  const refusal = moveRefusal(task, "review", "submit", who, ctx);
  if (refusal) throw new Refused(refusal);
  const branch = git(worktree, "rev-parse", "--abbrev-ref", "HEAD");
  const pattern = team.roles[who]?.branch;
  if (pattern && !new RegExp(pattern).test(branch))
    throw new Refused(`name your branch to match ${pattern} first (git branch -m ${branchFor(task, who, team.branchPrefix)})`);
  if (ticketOf(branch, team.branchPrefix) !== task.id)
    throw new Refused(`the branch carries the task's number, so the merge closes it: git branch -m ${branchFor(task, who, team.branchPrefix)}`);
  if (git(worktree, "status", "--porcelain", "--untracked-files=normal") !== "") throw new Refused("commit your changes first, new files included");
  const base = baseRef(team, worktree);
  if (Number(git(worktree, "rev-list", "--count", `${base}..HEAD`)) === 0)
    throw new Refused(`${branch} has nothing beyond ${team.branch}; release the task instead (e9g task release ${task.id} --blocked "…")`);
  const sha = git(worktree, "rev-parse", "HEAD");
  if (task.rounds > 0 && task.sha === sha)
    throw new Refused(`this is the commit the reviewer asked changes on (${sha.slice(0, 9)}); make the changes in its notes, then submit`);
  // What it touches, for the reviewer and the planner: UI (a view check is due) and the team's critical paths.
  let touches: Pick<Task, "ui" | "critical"> = { ui: null, critical: [] };
  try {
    const radius = blastRadius(worktree, { base, critical: team.critical });
    touches = { ui: radius.ui, critical: radius.critical };
  } catch {}
  // On a team on several machines the branch goes to the remote, wherever it was built: the lead merges from there,
  // and a rework on another machine starts from it.
  if (multiMachine(team)) {
    const problem = pushTaskBranch(worktree, team, branch);
    if (problem) throw new Refused(`${problem}; the task stays yours, try again`);
  }
  await update(store.tasks, task.id, (t) =>
    move(t, "review", "submit", who, ctx, {
      fields: { branch, sha, ...touches },
      by: `${who}@${machineName()}`,
      why: `${branch} at ${sha.slice(0, 9)}`,
      sha,
    })
  );
  rmSync(claimMark(run, worktree), { force: true });
  console.info(`task ${task.id}: submitted ${branch} at ${sha.slice(0, 9)}; the planner has it reviewed and merged.`);
  return 0;
};

// The lead: a task's branch as its submit pushed it, fetched for review, and the commit to review.
const fetchBranch: Handler = async ({ home, team, store, who }, [id]) => {
  if (!may(who, ["planner", "reviewer"])) throw new Refused("the planner and the reviewer fetch a task's branch");
  const task = await getTask(store, id);
  if (!task.branch) throw new Refused(`task ${task.id} has no branch yet`);
  if (!multiMachine(team)) {
    console.info(`task ${task.id}: ${task.branch} is on this machine (the team runs on one)`);
    return 0;
  }
  const from = branchRef(home, team, task.branch);
  if (!from.ok) throw new Refused(from.said);
  const tip = git(home, "rev-parse", from.ref);
  console.info(
    `task ${task.id}: review ${from.ref.replace("refs/remotes/", "")} at ${tip}${task.sha && task.sha !== tip ? ` (it was submitted at ${task.sha.slice(0, 9)}; review what's there now)` : ""}`
  );
  return 0;
};

const graph: Handler = async ({ home, team, run, store, who }, _positional, options) => {
  const all = await store.tasks.all();
  const out = resolve(optionText(options["out"]) ?? join(run, "task-graph.json"));
  // An agent's graph goes in the run folder or a scratch folder, never over a file of the team's.
  const within = (dir: string): boolean => out.startsWith(`${dir}/`);
  const scratch = ["/tmp", "/private/tmp", realpathSync(tmpdir())].some(within) && !within(realpathSync(home));
  if (who !== OPERATOR && !within(realpathSync(run)) && !scratch) throw new Refused("--out goes in the run folder or /tmp");
  writeFileSync(out, `${JSON.stringify(betterDiagram(all, { title: team.title, all: Boolean(options["all"]) }), null, 2)}\n`);
  console.info(`task graph: ${out} (${all.length} tasks). Open it with npx @mosphere/better-diagrams ${out}`);
  return 0;
};

const importTasks: Handler = async ({ home, run, team, store, who }) => {
  need(who, ["planner"], "importing the board");
  const ids = await importBoard(store, boardDir(home), run, team.name, who);
  console.info(ids.length ? `imported ${ids.length} tickets: ${ids.map((id) => `#${id}`).join(" ")}` : "nothing new to import");
  return 0;
};

// The operator's: the whole graph into the other store (lib/tasks/migrate.ts). The file store moved from is marked,
// so it's never written again; team.json, which commands never edit, is the operator's to change after.
const migrateTasks: Handler = async ({ team, run, store, who }, _positional, options) => {
  if (who !== OPERATOR) throw new Refused("moving the task graph is the operator's");
  const to = oneOf(optionText(options["to"]), ["mongo", "files"] as const, "--to");
  if (!to) throw new Refused("which store? --to mongo or --to files");
  if (to === store.kind) throw new Refused(`this team's task graph is in ${to} already (team.json tasks.store)`);
  const { countsOf, markMoved, migrate, movedMark } = await import("../tasks/migrate.ts");
  const target =
    to === "mongo"
      ? await (await import("../tasks/mongo.ts")).mongoStore({ name: team.name, tasks: { ...team.tasks, store: "mongo" } })
      : (await import("../tasks/files.ts")).fileStore(run, team.name);
  const said = (counts: Record<string, number>) =>
    Object.entries(counts)
      .map(([name, n]) => `${n} ${name}`)
      .join(", ");
  try {
    if (options["dry-run"]) {
      console.info(`would copy ${said(await countsOf(store))} from ${store.kind} to ${to}; ${to} has ${said(await countsOf(target))} of this team's now`);
      return 0;
    }
    const copied = await migrate(store, target);
    if (store.kind === "files") markMoved(run, to);
    else rmSync(movedMark(run), { force: true });
    console.info(
      [
        `copied ${said(copied)} from ${store.kind} to ${to}.`,
        `Now set team.json "tasks": {"store": "${to}"${to === "mongo" && team.tasks.lead ? `, "lead": "${team.tasks.lead}"` : ""}} and run e9g register again${to === "mongo" ? " on each machine" : ""}.`,
        store.kind === "files" ? "The file store is marked moved: commands refuse it from now on." : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
    return 0;
  } finally {
    await target.close();
  }
};

// The options each subcommand reads.
const OPTIONS: Record<string, string[]> = {
  add: ["kind", "sev", "body", "body-file", "area", "files", "parent", "after", "request", "approved"],
  list: ["status", "kind", "all", "claimable", "json"],
  show: ["json"],
  note: ["text"],
  edit: ["title", "body", "body-file", "kind", "sev", "area", "files", "parent", "after"],
  score: [...DIMENSIONS, "confidence", "size", "why", "asked", "simplify", "simplest"],
  status: ["reason"],
  approve: ["note"],
  reject: ["reason"],
  research: ["note"],
  escalate: ["reason"],
  claim: ["kind"],
  release: ["blocked"],
  submit: [],
  fetch: [],
  graph: ["out", "all"],
  import: [],
  migrate: ["to", "dry-run"],
};

const COMMANDS: Record<string, Handler> = {
  add,
  list: listTasks,
  show,
  note,
  edit,
  score,
  status: setStatus,
  approve,
  reject: proposalVerdict("rejected", "reject", "reason"),
  research: proposalVerdict("researching", "research", "note"),
  escalate: proposalVerdict("question", "escalate", "reason"),
  claim,
  release,
  submit,
  graph,
  fetch: fetchBranch,
  import: importTasks,
  migrate: migrateTasks,
};

export async function task(argv: string[]): Promise<number> {
  const [sub = "help", ...rest] = argv;
  const handler = COMMANDS[sub];
  if (!handler) {
    console.info(USAGE);
    return sub === "help" || sub === "--help" ? 0 : 2;
  }
  const { positional, options } = parseArgs(rest, { booleans: ["all", "json", "claimable", "approved", "dry-run", "help"] });
  if (options["help"] === true) {
    console.info(USAGE);
    return 0;
  }
  try {
    // An option a subcommand doesn't read is refused rather than dropped (e9g task status 3 proposed --sev minor would
    // otherwise change the status and nothing else).
    const known = OPTIONS[sub] ?? [];
    const unknown = Object.keys(options).filter((key) => key !== "--" && !known.includes(key));
    if (unknown.length)
      throw new Refused(
        `e9g task ${sub} takes ${known.length ? known.map((k) => `--${k}`).join(", ") : "no options"}, not ${unknown.map((k) => `--${k}`).join(", ")}`
      );
    return await withStore((ctx) => handler(ctx, positional, options), { importFirst: sub !== "import" });
  } catch (error) {
    if (error instanceof Refused) {
      console.error(`task: ${error.message}`);
      return 2;
    }
    throw error;
  }
}
