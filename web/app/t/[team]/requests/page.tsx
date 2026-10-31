import type { Metadata } from "next";
import Link from "next/link";
import { Ago, Chip, clip, Notice, type SearchParams } from "../../../../components/ui.tsx";
import { can, canSeeRequest, senderLabel } from "../../../../server/access.ts";
import { linkedStakeholder, storeFor } from "../../../../server/factory.ts";
import { requestState } from "../../../../server/views.ts";
import { teamFor } from "../team.ts";
import { RequestForm } from "./request-form.tsx";

export const metadata: Metadata = { title: "Requests" };

export default async function RequestsPage({ params, searchParams }: { params: Promise<{ team: string }>; searchParams: SearchParams }) {
  const { team: name } = await params;
  const { viewer, team } = await teamFor(name);
  const store = storeFor(team.name);
  const all = can(viewer, "requests:all", team.name);
  const [requests, tasks, stakeholders, own] = await Promise.all([
    store.requests.all(),
    store.tasks.all(),
    // Who sent what is read only for those who may see every request.
    all ? store.stakeholders.all() : Promise.resolve([]),
    linkedStakeholder(team.name, viewer.userId),
  ]);
  const ownId = own?.id ?? null;
  const shown = requests.filter((r) => canSeeRequest(viewer, team.name, r, ownId)).reverse();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const people = new Map(stakeholders.map((s) => [s.id, s]));
  return (
    <>
      <Notice searchParams={searchParams} />
      <div className="grid">
        <section className="panel" aria-labelledby="new-request">
          <h2 id="new-request">Send a request</h2>
          {can(viewer, "requests:send", team.name) ? <RequestForm team={team.name} /> : <p className="empty">You can&apos;t send requests here.</p>}
        </section>
        <section className="panel" aria-labelledby="list">
          <h2 id="list">{all ? "All requests" : "Your requests"}</h2>
          {shown.length ? (
            <ul className="plain rows">
              {shown.map((r) => (
                <li key={r.id}>
                  <div className="head">
                    <span className="id">{r.id}</span>
                    <Link className="title" href={`/t/${team.name}/requests/${r.id}`}>
                      {r.title}
                    </Link>
                    <Chip>{requestState(r, byId)}</Chip>
                  </div>
                  <p className="small muted">
                    from {senderLabel(viewer, team.name, (r.from ? people.get(r.from) : null) ?? (r.from === ownId ? own : null), ownId)} ·{" "}
                    <Ago at={r.createdAt} />
                    {r.tasks.length ? ` · ${r.tasks.length} task${r.tasks.length === 1 ? "" : "s"}` : ""}
                  </p>
                  {r.body ? <p className="small">{clip(r.body, 240)}</p> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">{all ? "No requests yet." : "You haven't sent any yet."}</p>
          )}
        </section>
      </div>
    </>
  );
}
