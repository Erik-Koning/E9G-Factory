"use server";
// A team's writes. Each checks the session and the person's role for the team (an admin's second factor too) before
// it reads or writes anything, then calls the factory's own code.
import { redirect } from "next/navigation";
import { withNotice } from "../../../components/ui.tsx";
import { decisionProblem, isDecision, LIMITS, requestProblem, TASK_ID, TEAM_PARAM } from "../../../server/access.ts";
import { decideAsOperator, Refused, sendRequest, stakeholderOf, teamDoc } from "../../../server/factory.ts";
import { memberships, takeRequestAllowance } from "../../../server/people.ts";
import { allowed, NotAllowed } from "../../../server/viewer.ts";

const text = (form: FormData, key: string): string => {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
};

// A refusal in words; anything else is logged and said plainly.
function reasonOf(error: unknown): string {
  if (error instanceof NotAllowed || error instanceof Refused) return error.message;
  console.error(error);
  return "Something went wrong; try again.";
}

export interface RequestFormState {
  error: string | null;
  title: string;
  body: string;
}

// A request from the form, from the person's own stakeholder record on the team.
export async function sendRequestAction(_previous: RequestFormState, form: FormData): Promise<RequestFormState> {
  const team = text(form, "team");
  const title = text(form, "title");
  const body = text(form, "body");
  const again = (error: string): RequestFormState => ({ error, title, body });
  let id: string;
  try {
    if (!TEAM_PARAM.test(team)) return again("No such team.");
    const viewer = await allowed("requests:send", team);
    const problem = requestProblem(title, body);
    if (problem) return again(problem);
    if (!(await teamDoc(team))) return again("No such team.");
    if (!(await takeRequestAllowance(viewer.userId, LIMITS.requestsPerDay)))
      return again(`You've sent ${LIMITS.requestsPerDay} requests today, the most a day; send this one tomorrow.`);
    const label = viewer.admin ? "operator" : ((await memberships({ userId: viewer.userId, team }))[0]?.label ?? "stakeholder");
    const from = await stakeholderOf(team, viewer, label);
    id = (await sendRequest(team, { title, body, from: from.id, admin: viewer.admin })).id;
  } catch (error) {
    return again(reasonOf(error));
  }
  redirect(withNotice(`/t/${team}/requests/${id}`, { ok: "Request sent. The planner reads it and answers here." }));
}

const DONE: Record<string, string> = { approve: "approved", reject: "rejected", research: "sent back for research", escalate: "escalated" };

// An admin decides on a proposal, as the operator, by the factory's move table and the team's approval rules.
export async function decideAction(form: FormData): Promise<void> {
  const team = text(form, "team");
  const id = text(form, "id");
  const decision = text(form, "decision");
  const note = text(form, "text");
  if (!TEAM_PARAM.test(team)) redirect("/");
  const back = `/t/${team}/proposals`;
  let notice: { ok?: string; error?: string };
  try {
    await allowed("proposals:decide", team);
    if (!TASK_ID.test(id) || !isDecision(decision)) throw new Refused("That isn't a decision on a task.");
    const problem = decisionProblem(decision, note);
    if (problem) throw new Refused(problem);
    const task = await decideAsOperator(team, id, decision, note);
    notice = { ok: `#${task.id} ${DONE[decision]}.` };
  } catch (error) {
    notice = { error: reasonOf(error) };
  }
  redirect(withNotice(back, notice));
}
