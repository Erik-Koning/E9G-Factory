// Decisions on proposals: approving, rejecting, sending back for research and escalating to the operator. The CLI
// (e9g task approve/reject/research/escalate) and the web app both decide through here, by the move table in model.ts
// (who may decide what, from where), with the team's approval rules; each is checked again as it's written.
import { type ApprovalRules, type Actor, move, moveRefusal, nowIso, Refused, type Status, type Task, type Via } from "./model.ts";
import { type Store, update } from "./store.ts";

export type Decision = "approve" | "reject" | "research" | "escalate";
const TO: Record<Decision, Status> = { approve: "approved", reject: "rejected", research: "researching", escalate: "question" };

// `who` decides on task `id`. An approval may carry a note; the others need one (why it's rejected, what to find
// out, what the operator has to decide). Throws a Refused saying why when it can't.
export async function decide(
  store: Store,
  id: string,
  decision: Decision,
  { who, approval, text = "" }: { who: Actor; approval: ApprovalRules; text?: string }
): Promise<Task> {
  const task = await store.tasks.get(id.replace(/^#/, ""));
  if (!task) throw new Refused(`no task ${id}`);
  const to = TO[decision];
  const via: Via = decision;
  const ctx = { all: await store.tasks.all(), approval };
  const refusal = moveRefusal(task, to, via, who, ctx);
  if (refusal) throw new Refused(refusal);
  if (decision !== "approve" && !text.trim()) throw new Refused("say why");
  return update(store.tasks, task.id, (t) =>
    decision === "approve"
      ? move(t, to, via, who, ctx, { fields: { approval: { by: who, at: nowIso(), note: text } }, why: text || undefined })
      : move(t, to, via, who, ctx, { fields: { notes: [...t.notes, { at: nowIso(), by: who, text }] }, why: text })
  );
}
