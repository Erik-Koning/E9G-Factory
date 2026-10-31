import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SubmitButton } from "../../../../components/submit-button.tsx";
import { Chip, clip, Notice, type SearchParams } from "../../../../components/ui.tsx";
import { DIMENSIONS } from "../../../../../lib/tasks/model.ts";
import { can, LIMITS } from "../../../../server/access.ts";
import { storeFor, type Task } from "../../../../server/factory.ts";
import { proposals } from "../../../../server/views.ts";
import { decideAction } from "../actions.ts";
import { teamFor } from "../team.ts";

export const metadata: Metadata = { title: "Decisions" };

const HEADINGS: Record<string, string> = { question: "Escalated to you", proposed: "Proposed", researching: "Being researched" };

export default async function ProposalsPage({ params, searchParams }: { params: Promise<{ team: string }>; searchParams: SearchParams }) {
  const { team: name } = await params;
  const { viewer, team } = await teamFor(name);
  if (!can(viewer, "proposals:decide", team.name)) notFound();
  const waiting = proposals(await storeFor(team.name).tasks.all());
  const groups = Object.keys(HEADINGS)
    .map((status) => ({ status, tasks: waiting.filter((t) => t.status === status) }))
    .filter((g) => g.tasks.length);
  const approval = team.approval;
  return (
    <>
      <Notice searchParams={searchParams} />
      <p className="lede small">
        You decide as the operator, by the same rules as <code>e9g task approve</code>.{" "}
        {approval
          ? approval.mode === "operator"
            ? "This team's proposals all wait for you."
            : approval.mode === "full"
              ? "This team's approver decides on its own; what it escalates comes to you."
              : `This team's approver decides up to size ${approval.maxSize}; larger ones and what it escalates come to you.`
          : ""}
      </p>
      {groups.length ? (
        groups.map((g) => (
          <section key={g.status} className="panel" aria-labelledby={`h-${g.status}`}>
            <h2 id={`h-${g.status}`}>
              {HEADINGS[g.status]} <span className="muted">{g.tasks.length}</span>
            </h2>
            <ul className="plain rows">
              {g.tasks.map((t) => (
                <Proposal key={t.id} team={team.name} task={t} />
              ))}
            </ul>
          </section>
        ))
      ) : (
        <p className="panel empty">Nothing is waiting for a decision.</p>
      )}
    </>
  );
}

function Proposal({ team, task: t }: { team: string; task: Task }) {
  const last = t.notes.at(-1);
  return (
    <li id={`task-${t.id}`}>
      <div className="head">
        <span className="id">#{t.id}</span>
        <h3 className="title">{t.title}</h3>
        <Chip>{t.status}</Chip>
        <Chip tone="">{t.kind}</Chip>
        {t.severity ? <Chip tone="">{t.severity}</Chip> : null}
        {t.priority !== null ? <Chip tone="">{`p${t.priority}`}</Chip> : null}
      </div>
      {t.gate ? (
        <dl className="facts small">
          <dt>Who asked, why</dt>
          <dd>{t.gate.asked}</dd>
          <dt>Delete or simplify</dt>
          <dd>{t.gate.simplify}</dd>
          <dt>Simplest version</dt>
          <dd>{t.gate.simplest}</dd>
        </dl>
      ) : (
        <p className="small muted">No gate yet.</p>
      )}
      {t.score ? (
        <>
          <p className="small">
            <b>Score:</b> {t.score.why}{" "}
            <span className="muted">
              (confidence {t.score.confidence}, size {t.score.size})
            </span>
          </p>
          <ul className="score small" aria-label="Score by dimension, 0 to 3">
            {DIMENSIONS.map((d) => (
              <li key={d}>
                <Chip tone="">{`${d} ${t.score?.[d] ?? 0}`}</Chip>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="small muted">Not scored yet{t.severity ? "" : ": it needs a score before it can be approved"}.</p>
      )}
      {t.body ? <p className="text small">{clip(t.body, 900)}</p> : null}
      {t.request ? (
        <p className="small">
          From request <Link href={`/t/${team}/requests/${t.request}`}>{t.request}</Link>
        </p>
      ) : null}
      {last ? (
        <p className="small muted">
          {last.by}: {clip(last.text, 400)}
        </p>
      ) : null}
      <div className="verdicts">
        <Verdict team={team} id={t.id} decision="approve" label="Approve" field="Note (optional)" required={false} className="approve" />
        <Verdict team={team} id={t.id} decision="reject" label="Reject" field="Why it's rejected" required className="reject" />
      </div>
      {/* A proposal is one of question, proposed and researching, so one of these is always open to it. */}
      <details className="more">
        <summary>{`Research or escalate #${t.id} instead`}</summary>
        <div className="verdicts">
          {t.status !== "researching" ? <Verdict team={team} id={t.id} decision="research" label="Research it" field="What to find out" required /> : null}
          {t.status !== "question" ? <Verdict team={team} id={t.id} decision="escalate" label="Escalate" field="What has to be decided" required /> : null}
        </div>
      </details>
    </li>
  );
}

function Verdict(props: { team: string; id: string; decision: string; label: string; field: string; required: boolean; className?: string }) {
  const { team, id, decision, label, field, required, className } = props;
  const input = `${decision}-${id}`;
  return (
    <form action={decideAction}>
      <input type="hidden" name="team" value={team} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="decision" value={decision} />
      <label htmlFor={input}>{field}</label>
      <input id={input} name="text" required={required} maxLength={LIMITS.note} autoComplete="off" />
      <div>
        <SubmitButton className={className}>{`${label} #${id}`}</SubmitButton>
      </div>
    </form>
  );
}
