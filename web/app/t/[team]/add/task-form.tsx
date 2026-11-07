"use client";
import { useActionState, useEffect, useRef, useState } from "react";
import { KINDS, type Kind, SEVERITIES } from "../../../../../lib/tasks/model.ts";
import { LIMITS, SUGGESTED_KINDS } from "../../../../server/access.ts";
import { addTaskAction, type TaskFormState } from "../actions.ts";

const EMPTY: TaskFormState = { error: null, title: "", body: "", kind: "feature", severity: "", parent: "", after: "", approved: false };

const KIND_LABEL: Record<Kind, string> = {
  feature: "Feature",
  bug: "Bug",
  ux: "UX problem",
  chore: "Chore",
  research: "Research",
  test: "Test",
  "test-infra": "Test infrastructure",
  journey: "Journey (groups tasks)",
};

// An admin adds a task as the operator; anyone else suggests one for the planner to triage.
export function TaskForm({ team, admin, journeys }: { team: string; admin: boolean; journeys: { id: string; title: string }[] }) {
  const [state, action, pending] = useActionState(addTaskAction, EMPTY);
  const [kind, setKind] = useState(state.kind);
  const [length, setLength] = useState(state.body.length);
  const finding = kind === "bug" || kind === "ux";
  const alert = useRef<HTMLParagraphElement>(null);
  // After a refusal the form is made again, so focus goes to what went wrong rather than nowhere.
  useEffect(() => {
    if (state.error) alert.current?.focus();
  }, [state]);
  return (
    // Made again from each answer, so the lists keep what was chosen too (React resets a form after its action, and a
    // select goes back to the default it was made with).
    <form key={JSON.stringify(state)} action={action} className="stack" aria-describedby="task-hint">
      {state.error ? (
        <p className="notice error" role="alert" tabIndex={-1} ref={alert}>
          {state.error}
        </p>
      ) : null}
      <input type="hidden" name="team" value={team} />
      <label>
        Title
        <input
          name="title"
          required
          maxLength={LIMITS.title}
          defaultValue={state.title}
          placeholder="What should be true when it's done"
          autoComplete="off"
        />
      </label>
      <div className="inline">
        <label>
          Kind
          <select name="kind" defaultValue={state.kind} onChange={(event) => setKind(event.target.value)}>
            {(admin ? KINDS : SUGGESTED_KINDS).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        {admin || finding ? (
          <label>
            {admin ? "How bad it is (bugs and UX)" : "How bad it is"}
            <select name="severity" defaultValue={state.severity} required={!admin}>
              <option value="">{admin ? "Not a bug" : "Choose…"}</option>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      <label>
        {admin ? "Description" : finding ? "What happened, and what should happen (with steps)" : "What's needed, and why"}
        <textarea
          name="body"
          rows={6}
          maxLength={LIMITS.body}
          defaultValue={state.body}
          required={!admin}
          minLength={admin ? undefined : 20}
          aria-describedby="task-body-count"
          onChange={(event) => setLength(event.target.value.length)}
        />
      </label>
      <p id="task-body-count" className="hint">
        {admin
          ? `${length.toLocaleString("en")} of ${LIMITS.body.toLocaleString("en")} characters`
          : `${length.toLocaleString("en")} characters${length < 20 ? ", at least 20" : ""}`}
      </p>
      {admin ? (
        <>
          <div className="inline">
            <label>
              Journey
              <select name="parent" defaultValue={state.parent}>
                <option value="">None</option>
                {journeys.map((j) => (
                  <option key={j.id} value={j.id}>
                    #{j.id} {j.title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Comes after (task numbers)
              <input name="after" defaultValue={state.after} placeholder="3, 5" autoComplete="off" />
            </label>
          </div>
          <label className="check">
            <input type="checkbox" name="approved" value="yes" defaultChecked={state.approved} />
            Approve it now, without a score or the approver
          </label>
        </>
      ) : null}
      <div>
        <button type="submit" className="primary" disabled={pending}>
          {pending ? "Adding…" : admin ? "Add the task" : "Suggest the task"}
        </button>
      </div>
      <p id="task-hint" className="hint">
        {admin
          ? "You add it as the operator, like a6g task add: a proposal for the planner to score and the approver (or you) to decide, unless you approve it now."
          : `It goes to triage: the planner reads it, then proposes it, folds it into other work or turns it down. The team's agents see your role, never your name or email. At most ${LIMITS.requestsPerDay} requests and suggestions a day.`}
      </p>
    </form>
  );
}
