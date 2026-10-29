// What the factory's own processes do to the task graph, besides the commands members run: the merge queue closes
// what it merged and moves finished journeys to verify, a review that asks for changes sends its task back, the
// heartbeat renews a member's claim and the watchdog returns expired ones, a files board is imported, and the
// planner's context gets a summary.
import { existsSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { basename, join } from "node:path";
import { acquireSlot } from "../lock.ts";
import { hash, readJson, writeJson } from "../util.ts";
import {
  type Actor,
  type FeatureRequest,
  heldHere,
  journeyDue,
  KINDS,
  type Kind,
  MERGE,
  nowIso,
  newTask,
  SEVERITIES,
  type Severity,
  type Status,
  type Task,
  UNAPPROVED,
  WATCHDOG,
  withEvent,
} from "./model.ts";
import type { Team } from "../config.ts";
import { machineName } from "../machine.ts";
import { boardDir } from "../paths.ts";
import { openStore, type Store, update } from "./store.ts";

// The merge queue: each task the merge closes is done, and a journey whose children are all done moves to verify.
// What it doesn't close is named in `skipped`, with why: a task someone is building (not closed out from under them),
// a journey (done once verified) and a task never approved (approved before it's built). Ids that aren't tasks are
// passed over.
export async function closeMerged(
  store: Store,
  ids: string[],
  { branch, sha, tip }: { branch: string; sha: string; tip?: string }
): Promise<{ closed: string[]; skipped: string[] }> {
  const closed: string[] = [];
  const skipped: string[] = [];
  const parents = new Set<string>();
  for (const id of ids) {
    if (!(await store.tasks.get(id))) continue;
    let why: string | null = null;
    const task = await update(store.tasks, id, (t) => {
      why =
        t.status === "building"
          ? `#${t.id} is being built by the ${t.claim?.role ?? "a member"}${t.claim ? ` on ${t.claim.machine}` : ""}`
          : t.kind === "journey"
            ? `#${t.id} is a journey, done once it's verified`
            : UNAPPROVED.includes(t.status)
              ? `#${t.id} is ${t.status}, never approved`
              : t.status === "rejected"
                ? `#${t.id} was rejected`
                : // The branch's own task is done when what it submitted is what merged.
                  tip && t.branch === branch && t.sha && t.sha !== tip
                  ? `#${t.id} was submitted at ${t.sha.slice(0, 9)}, and ${tip.slice(0, 9)} merged`
                  : null;
      if (why || t.status === "done") return t;
      return withEvent({ ...t, status: "done", sha, branch: t.branch ?? branch, claim: null }, MERGE, `${t.status} → done: merged ${branch} at ${sha}`);
    });
    if (why) skipped.push(why);
    else closed.push(task.id);
    if (task.parent) parents.add(task.parent);
  }
  await moveDueJourneys(store, [...parents]);
  return { closed, skipped };
}

// Journeys whose tasks are all done or rejected, at least one done, move to verify.
export async function moveDueJourneys(store: Store, ids: string[], by: Actor = MERGE): Promise<string[]> {
  const moved: string[] = [];
  for (const id of ids) {
    const all = await store.tasks.all();
    const journey = all.find((t) => t.id === id);
    if (!journey || !journeyDue(journey, all)) continue;
    let due = false;
    await update(store.tasks, id, (t) => {
      due = journeyDue(t, all);
      return due ? withEvent({ ...t, status: "verify" }, by, `${t.status} → verify: every task in the journey is done or rejected`) : t;
    });
    if (due) moved.push(id);
  }
  return moved;
}

// A review that asks for changes: the task in review goes back to be claimed again on the same branch, one round
// more; past the team's limit of rounds it's blocked for the planner to split or decide. A task that isn't in review
// (being reworked already, merged, rejected) is left as it is: the verdict is recorded, and `skipped` says why.
export async function changesRequested(
  store: Store,
  id: string,
  { branch, note, maxRounds, by }: { branch: string; note: string; maxRounds: number; by: Actor }
): Promise<{ task: Task | null; skipped: string | null }> {
  if (!(await store.tasks.get(id))) return { task: null, skipped: null };
  let skipped: string | null = null;
  const task = await update(store.tasks, id, (t) => {
    skipped =
      t.status !== "review"
        ? `task ${t.id} is ${t.status}, not in review`
        : t.branch && t.branch !== branch
          ? `task ${t.id} was submitted on ${t.branch}, not ${branch}`
          : null;
    if (skipped) return t;
    const rounds = t.rounds + 1;
    const blocked = rounds > maxRounds;
    const to: Status = blocked ? "blocked" : "approved";
    const text = `changes requested (round ${rounds} of ${maxRounds}): ${note}`;
    return withEvent(
      { ...t, status: to, rounds, branch, claim: null, notes: [...t.notes, { at: nowIso(), by, text }] },
      by,
      `${t.status} → ${to}: ${blocked ? `more than ${maxRounds} rounds of changes; split it or decide` : text}`
    );
  });
  return { task, skipped };
}

// --- Claims --------------------------------------------------------------------------------------------------------

// Members' claims are marked in the run folder by the worktree that holds them (claims/<worktree>.json), so the
// heartbeat hook renews them without reading the store on every tool call.
// Named for the worktree's folder and a hash of its whole path, so two worktrees with one folder name don't share a mark.
export const claimMark = (run: string, worktree: string): string =>
  join(run, "claims", `${basename(worktree).replace(/[^\w.-]/g, "_")}-${hash(worktree).slice(0, 8)}.json`);
export const markClaim = (run: string, worktree: string, ids: string[]): void => writeJson(claimMark(run, worktree), { worktree, ids });
// A claim's lease: watchdog.stuckAfter, never shorter than ten minutes; the heartbeat renews it as the member works.
export const leaseMinutes = (stuckAfterMin: number): number => Math.max(10, stuckAfterMin);
// Often enough that a lease can't run out between two renewals, however short the team makes it.
const renewEveryMs = (leaseMin: number): number => Math.min(5 * 60_000, (leaseMin * 60_000) / 3);

// The heartbeat: the claims this worktree holds get a fresh lease, at most every five minutes. A mark whose claims are
// all gone (expired, released, handed in elsewhere) is removed.
export async function renewClaims(openStore: () => Promise<Store>, run: string, worktree: string, leaseMin: number): Promise<number> {
  const mark = claimMark(run, worktree);
  if (!existsSync(mark) || Date.now() - statSync(mark).mtimeMs < renewEveryMs(leaseMin)) return 0;
  const { ids = [] } = readJson<{ ids?: string[] }>(mark, {});
  const now = new Date();
  utimesSync(mark, now, now);
  const store = await openStore();
  const machine = machineName();
  let renewed = 0;
  try {
    for (const id of ids) {
      const task = await store.tasks.get(id);
      if (!task || task.status !== "building" || !heldHere(task.claim, worktree, machine)) continue;
      const claim = task.claim;
      const written = await store.tasks.replace({ ...task, claim: { ...claim, until: new Date(Date.now() + leaseMin * 60_000).toISOString() } });
      // Changed meanwhile (released, expired, submitted): the next heartbeat looks again.
      if (written) renewed++;
    }
    if (!renewed && !(await store.tasks.all()).some((t) => t.status === "building" && heldHere(t.claim, worktree, machine))) rmSync(mark, { force: true });
  } finally {
    await store.close();
  }
  return renewed;
}

// The watchdog: a claim whose lease ran out goes back to approved, for another member to take, and its mark goes.
export async function expireClaims(store: Store, now = Date.now(), run?: string): Promise<string[]> {
  const expired: string[] = [];
  for (const task of await store.tasks.all()) {
    const claim = task.claim;
    if (task.status !== "building" || !claim || Date.parse(claim.until) > now) continue;
    // Renewed or handed in since it was read: left as it is.
    const written = await store.tasks.replace(
      withEvent(
        { ...task, status: "approved", claim: null },
        WATCHDOG,
        `building → approved: ${claim.role}@${claim.machine}'s claim ran out without a heartbeat`
      )
    );
    if (!written) continue;
    expired.push(task.id);
    if (run) rmSync(claimMark(run, claim.worktree), { force: true });
  }
  return expired;
}

// --- Importing a files board ---------------------------------------------------------------------------------------

const STATUS_OF: Record<string, Status> = {
  triage: "triage",
  ready: "approved",
  building: "approved",
  review: "review",
  blocked: "blocked",
  question: "question",
  done: "done",
  closed: "done",
  proposal: "proposed",
  proposed: "proposed",
  rejected: "rejected",
  wontfix: "rejected",
};
const KIND_OF: Record<string, Kind> = { audit: "ux", env: "chore", question: "research", proposal: "feature" };

// The tickets of a 0.3 files board (.e9g/run/board/<n>-<slug>.md, and members' f-<time>-<slug>.md findings) as tasks.
// Numbered tickets keep their numbers, so their branches still close them; findings get new ones. Each file is
// imported once (tasks/.imported.json lists them), under a lock, so two commands starting at once can't both import it.
export async function importBoard(store: Store, board: string, run: string, team: string, by: Actor): Promise<string[]> {
  if (!existsSync(board)) return [];
  const markFile = join(run, "tasks", ".imported.json");
  const pending = (): string[] => {
    const done = new Set(readJson<string[]>(markFile, []));
    return readdirSync(board).filter((name) => name.endsWith(".md") && !done.has(name));
  };
  if (!pending().length) return [];
  const release = await acquireSlot([join(run, "tasks", ".import-lock")], { waitMin: 2, holder: "board import", pollMs: 50 });
  if (!release) throw new Error("another command has been importing the old board for two minutes");
  try {
    const order = (name: string) => Number(/^(\d+)-/.exec(name)?.[1] ?? Infinity);
    const files = pending().sort((a, b) => order(a) - order(b) || a.localeCompare(b));
    const imported: string[] = [];
    const all = files.length ? await store.tasks.all() : [];
    const existing = new Map(all.map((t) => [t.id, t]));
    const done = new Set(readJson<string[]>(markFile, []));
    for (const name of files) {
      const text = readFileSync(join(board, name), "utf8");
      const field = (key: string): string | undefined => new RegExp(`^${key}:\\s*(.+)$`, "mi").exec(text.split("\n").slice(0, 12).join("\n"))?.[1]?.trim();
      const raw = /^(\d+)-/.exec(name)?.[1];
      const number = raw === undefined ? undefined : String(Number(raw));
      const source = `imported from .e9g/run/board/${name}`;
      // Already here from an earlier import that stopped before it noted the file: noted now, not imported twice.
      const already = all.find((t) => t.history.some((e) => e.what.startsWith(source)));
      if (already) {
        done.add(name);
        writeJson(markFile, [...done]);
        continue;
      }
      const status = STATUS_OF[(field("status") ?? "triage").toLowerCase()] ?? "triage";
      const rawKind = (field("kind") ?? "bug").toLowerCase();
      const kind: Kind = (KINDS as readonly string[]).includes(rawKind) ? (rawKind as Kind) : (KIND_OF[rawKind] ?? "chore");
      const rawSev = (field("sev") ?? field("severity") ?? "").toLowerCase();
      const severity = (SEVERITIES as readonly string[]).includes(rawSev) ? (rawSev as Severity) : null;
      const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
      const title =
        heading ??
        name
          .replace(/\.md$/, "")
          .replace(/^(f-\d{8}-\d{4}-|\d+-)/, "")
          .replaceAll("-", " ");
      const area = field("page") ?? field("journey") ?? field("area") ?? null;
      const body = text
        .split("\n")
        .filter((line) => !/^(status|kind|sev|severity|page|journey|area):/i.test(line))
        .join("\n")
        .trim();
      const fields = newTask({ team, title, kind, status, severity, body, area, by });
      if (status === "approved") fields.approval = { by: "import", at: nowIso(), note: `imported as ${field("status")} from the 0.3 board` };
      fields.history = [{ at: nowIso(), by, what: `${source} (${field("status") ?? "no status"})` }];
      // Numbered tickets keep their numbers where they're free; the store numbers later tasks after them.
      const kept = number && !existing.has(number) ? await store.tasks.createAs(number, fields) : null;
      const task = kept ?? (await store.tasks.create(fields));
      existing.set(task.id, task);
      imported.push(task.id);
      done.add(name);
      writeJson(markFile, [...done]);
    }
    return imported;
  } finally {
    release();
  }
}

// The team's store, with a 0.3 files board brought across first: what every command in the team's checkout opens (the
// watchdog, which can't read the checkout, opens the store itself).
export async function openTeamStore(team: Pick<Team, "name" | "tasks">, run: string, home: string): Promise<Store> {
  const store = await openStore(team, run);
  try {
    await importBoard(store, boardDir(home), run, team.name, "import");
  } catch (error) {
    await store.close();
    throw error;
  }
  return store;
}

// --- The planner's view ----------------------------------------------------------------------------------------------

// A few lines for the planner's context: counts by status, what's due, what's claimed. Kept short: hook context is
// shown in full only under about 10,000 characters.
export function summary(
  all: Task[],
  { now = Date.now(), approval, requests = [] }: { now?: number; approval: string; requests?: FeatureRequest[] }
): string {
  const by = (status: Status) => all.filter((t) => t.status === status);
  const counts = (["triage", "proposed", "researching", "approved", "building", "review", "verify", "question", "blocked"] as Status[])
    .map((s) => [s, by(s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${s} ${n}`)
    .join(", ");
  const line = (t: Task) => `#${t.id} ${t.title.slice(0, 70)}`;
  const parts = [`Task graph: ${counts || "empty"} (done ${by("done").length}).`];
  const building = by("building");
  if (building.length)
    parts.push(
      `Building: ${building
        .map(
          (t) =>
            `${line(t)} (${t.claim ? `${t.claim.role}@${t.claim.machine}, lease ${Math.max(0, Math.round((Date.parse(t.claim.until) - now) / 60_000))} min` : "no claim"})`
        )
        .join("; ")}.`
    );
  const review = by("review");
  if (review.length) parts.push(`Waiting for review: ${review.map((t) => `${line(t)}${t.branch ? ` [${t.branch}]` : ""}`).join("; ")}.`);
  const verify = by("verify");
  if (verify.length) parts.push(`Journeys due their verification: ${verify.map(line).join("; ")}.`);
  // An approved journey with nothing left open and nothing done never comes due by itself: it needs tasks or an end.
  const OPEN: Status[] = ["triage", "proposed", "researching", "approved", "building", "review", "blocked", "question"];
  const empty = by("approved").filter(
    (j) => j.kind === "journey" && !all.some((t) => t.parent === j.id && (OPEN.includes(t.status) || t.status === "done"))
  );
  if (empty.length) parts.push(`Journeys with no tasks left (add tasks or reject them): ${empty.map(line).join("; ")}.`);
  const fresh = requests.filter((r) => r.status === "new");
  if (fresh.length)
    parts.push(
      `New feature requests: ${fresh
        .slice(0, 8)
        .map((r) => `${r.id} ${r.title.slice(0, 50)}`)
        .join("; ")}${fresh.length > 8 ? ` and ${fresh.length - 8} more` : ""} (e9g request list).`
    );
  const proposed = [...by("proposed"), ...by("researching")];
  if (proposed.length)
    parts.push(
      `${approval === "operator" ? "Proposals waiting for the operator" : "Proposals for the approver"}: ${proposed.length} (${proposed
        .slice(0, 5)
        .map((t) => `#${t.id}${t.score ? "" : " unscored"}`)
        .join(", ")}).`
    );
  if (by("triage").length)
    parts.push(
      `Findings to triage: ${by("triage")
        .map((t) => `#${t.id}`)
        .slice(0, 12)
        .join(", ")}.`
    );
  const blocked = by("blocked");
  if (blocked.length) parts.push(`Blocked: ${blocked.map(line).slice(0, 6).join("; ")}.`);
  return parts.join("\n");
}
