"use client";
import { useActionState, useState } from "react";
import { LIMITS } from "../../../../server/access.ts";
import { type RequestFormState, sendRequestAction } from "../actions.ts";

const EMPTY: RequestFormState = { error: null, title: "", body: "" };

export function RequestForm({ team }: { team: string }) {
  const [state, action, pending] = useActionState(sendRequestAction, EMPTY);
  const [length, setLength] = useState(state.body.length);
  return (
    <form action={action} className="stack" aria-describedby="request-privacy">
      {state.error ? (
        <p className="notice error" role="alert">
          {state.error}
        </p>
      ) : null}
      <input type="hidden" name="team" value={team} />
      <label>
        Title
        <input name="title" required maxLength={LIMITS.title} defaultValue={state.title} placeholder="What should be possible" autoComplete="off" />
      </label>
      <label>
        What you need, and why
        <textarea
          name="body"
          rows={6}
          maxLength={LIMITS.body}
          defaultValue={state.body}
          placeholder="Who needs it, what they do today, and why it matters"
          aria-describedby="body-count"
          onChange={(event) => setLength(event.target.value.length)}
        />
      </label>
      <p id="body-count" className="hint">
        {length.toLocaleString("en")} of {LIMITS.body.toLocaleString("en")} characters
      </p>
      <div>
        <button type="submit" className="primary" disabled={pending}>
          {pending ? "Sending…" : "Send the request"}
        </button>
      </div>
      <p id="request-privacy" className="hint">
        The team&apos;s agents read your words and see your role, never your name or email. At most {LIMITS.requestsPerDay} requests a day.
      </p>
    </form>
  );
}
