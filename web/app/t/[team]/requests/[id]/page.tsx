import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Ago, Chip, Notice, type SearchParams } from "../../../../../components/ui.tsx";
import { canSeeRequest, REQUEST_ID, senderLabel } from "../../../../../server/access.ts";
import { linkedStakeholder, storeFor } from "../../../../../server/factory.ts";
import { rejectionOf, requestState } from "../../../../../server/views.ts";
import { teamFor } from "../../team.ts";

export const metadata: Metadata = { title: "Request" };

export default async function RequestPage({ params, searchParams }: { params: Promise<{ team: string; id: string }>; searchParams: SearchParams }) {
  const { team: name, id } = await params;
  const { viewer, team } = await teamFor(name);
  if (!REQUEST_ID.test(id)) notFound();
  const store = storeFor(team.name);
  const [request, own] = await Promise.all([store.requests.get(id), linkedStakeholder(team.name, viewer.userId)]);
  const ownId = own?.id ?? null;
  // Someone else's request is as missing as one that isn't there.
  if (!request || !canSeeRequest(viewer, team.name, request, ownId)) notFound();
  const [sender, tasks] = await Promise.all([request.from ? store.stakeholders.get(request.from) : null, store.tasks.all()]);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const became = request.tasks.map((tid) => ({ id: tid, task: byId.get(tid) ?? null }));
  const rejection = rejectionOf(request);
  return (
    <>
      <p className="small">
        <Link href={`/t/${team.name}/requests`}>← Requests</Link>
      </p>
      <Notice searchParams={searchParams} />
      <article className="panel" aria-labelledby="request-title">
        <div className="head">
          <span className="id">{request.id}</span>
          <h2 id="request-title" className="title">
            {request.title}
          </h2>
          <Chip>{requestState(request, byId)}</Chip>
        </div>
        <p className="small muted">
          from {senderLabel(viewer, team.name, sender, ownId)} · sent <Ago at={request.createdAt} /> · updated <Ago at={request.updatedAt} />
        </p>
        {request.body ? <p className="text">{request.body}</p> : <p className="empty">No description.</p>}
      </article>

      {rejection ? (
        <section className="panel" aria-labelledby="rejected">
          <h2 id="rejected">Why it was turned down</h2>
          <p className="text">{rejection}</p>
        </section>
      ) : null}

      <div className="grid">
        <section className="panel" aria-labelledby="tasks">
          <h2 id="tasks">The tasks it became</h2>
          {became.length ? (
            <ul className="plain rows">
              {became.map(({ id: tid, task }) => (
                <li key={tid}>
                  <span className="id">#{tid}</span> {task ? task.title : "(gone)"} {task ? <Chip>{task.status}</Chip> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">{request.status === "rejected" ? "None." : "None yet: the planner turns a request into tasks once it's researched."}</p>
          )}
        </section>
        <section className="panel" aria-labelledby="notes">
          <h2 id="notes">Notes and history</h2>
          {request.notes.length ? (
            <ul className="plain rows">
              {request.notes.map((n, i) => (
                <li key={`n${i}`}>
                  <p className="small muted">
                    {n.by} · <Ago at={n.at} />
                  </p>
                  <p className="text">{n.text}</p>
                </li>
              ))}
            </ul>
          ) : null}
          <details>
            <summary>History</summary>
            <ul className="plain small">
              {request.history.map((e, i) => (
                <li key={`h${i}`}>
                  <Ago at={e.at} /> · {e.by}: {e.what}
                </li>
              ))}
            </ul>
          </details>
        </section>
      </div>
    </>
  );
}
