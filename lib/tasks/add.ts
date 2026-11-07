// Adding a task to the graph, as the factory's commands and its web app both do: the planner's work and the operator's
// are proposals (the operator's may go in approved), and everyone else's goes to triage for the planner, with a
// severity when it's a bug or a UX finding and a body that says what happened. Free of the CLI, so the web app runs the
// same code.
import {
  type Actor,
  type FeatureRequest,
  type Kind,
  newTask,
  nowIso,
  OPERATOR,
  Refused,
  type Severity,
  type Status,
  type Task,
  withEvent,
} from "./model.ts";
import { type Store, update } from "./store.ts";

export interface TaskInput {
  title: string;
  kind: Kind;
  severity?: Severity | null;
  body?: string;
  area?: string | null;
  files?: string[];
  parent?: string | null;
  after?: string[];
  request?: string | null;
  // The operator's own task, approved as it's added (a6g task add --approved).
  approved?: boolean;
  // The person who added or suggested it from the web app, as their stakeholder id, never a name (Article 8).
  from?: string | null;
}

// Who proposes work rather than filing it for triage.
export const proposes = (who: Actor): boolean => who === OPERATOR || who === "planner";

// The status a task `who` adds starts in.
export const startsAs = (who: Actor, approved = false): Status => (proposes(who) ? (who === OPERATOR && approved ? "approved" : "proposed") : "triage");

// `who` adds a task to `team`'s graph. Throws a Refused saying why when it can't.
export async function addTask(store: Store, team: string, input: TaskInput, who: Actor): Promise<Task> {
  const title = input.title.trim();
  if (!title) throw new Refused("give the task a title: what should be true");
  const status = startsAs(who, input.approved);
  const severity = input.severity ?? null;
  const body = input.body ?? "";
  // A member's finding goes to triage, and says how bad it is and what happened; the planner's work is a proposal.
  if (!proposes(who) && ["bug", "ux"].includes(input.kind) && !severity) throw new Refused("a finding says how bad it is: --sev blocker|major|minor");
  if (!proposes(who) && body.length < 20) throw new Refused("say what happened and what should happen, with steps: --body or --body-file");
  const all = await store.tasks.all();
  const byId = new Map(all.map((t) => [t.id, t]));
  const parent = input.parent?.replace(/^#/, "") || null;
  if (parent && byId.get(parent)?.kind !== "journey")
    throw new Refused(`--parent names a journey; #${parent} ${byId.has(parent) ? "isn't one" : "doesn't exist"}`);
  const after = [...new Set((input.after ?? []).map((id) => id.replace(/^#/, "")).filter(Boolean))];
  for (const id of after) if (!byId.has(id)) throw new Refused(`--after: no task ${id}`);
  const request = input.request ?? null;
  let promoted: FeatureRequest | null = null;
  if (request) {
    if (!proposes(who)) throw new Refused(`promoting a feature request is the planner's; you're the ${who}`);
    promoted = await store.requests.get(request);
    if (!promoted) throw new Refused(`no feature request ${request}`);
  }
  const fields = newTask({
    team,
    title,
    kind: input.kind,
    status,
    severity,
    body,
    area: input.area ?? null,
    files: input.files ?? [],
    parent,
    after,
    request,
    by: who,
    ...(input.from ? { from: input.from } : {}),
  });
  if (status === "approved") fields.approval = { by: OPERATOR, at: nowIso(), note: "added approved by the operator" };
  // Who it came from, in its history too: the history is what the planner and the operator read back.
  if (input.from) fields.history = fields.history.map((e) => ({ ...e, what: `${e.what}, from the web app by stakeholder ${input.from}` }));
  const task = await store.tasks.create(fields);
  if (promoted)
    await update(store.requests, promoted.id, (r) =>
      withEvent({ ...r, status: "promoted", tasks: [...new Set([...r.tasks, task.id])] }, who, `${r.status} → promoted: task ${task.id}`, {
        from: r.status,
        to: "promoted",
      })
    );
  return task;
}
