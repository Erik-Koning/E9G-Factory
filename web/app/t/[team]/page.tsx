import type { Metadata } from "next";
import { TaskGraph } from "../../../components/task-graph.tsx";
import { Ago, Chip, Notice, type SearchParams } from "../../../components/ui.tsx";
import { can } from "../../../server/access.ts";
import { storeFor, type Task } from "../../../server/factory.ts";
import { board, journeys, merges, progress } from "../../../server/views.ts";
import { teamFor } from "./team.ts";

export const metadata: Metadata = { title: "Overview" };

export default async function OverviewPage({ params, searchParams }: { params: Promise<{ team: string }>; searchParams: SearchParams }) {
  const { team: name } = await params;
  const { viewer, team } = await teamFor(name);
  const store = storeFor(team.name);
  const [tasks, cycles] = await Promise.all([store.tasks.all(), team.mode === "cycles" ? store.cycles.all() : Promise.resolve([])]);
  const status = team.status;
  const atWork = status ? Object.entries(status.members).filter(([, n]) => n > 0) : [];
  const details = can(viewer, "team:board", team.name);
  const shownJourneys = journeys(tasks);
  return (
    <>
      <Notice searchParams={searchParams} />
      <div className="grid">
        <section className="panel" aria-labelledby="status">
          <h2 id="status">Status</h2>
          <dl className="facts">
            <dt>State</dt>
            <dd>
              <Chip>{status?.state ?? "no status yet"}</Chip>
            </dd>
            <dt>Planner</dt>
            <dd>{status?.planner ?? "not running"}</dd>
            <dt>At work</dt>
            <dd>{atWork.length ? atWork.map(([role, n]) => `${n} ${role}${n === 1 ? "" : "s"}`).join(", ") : "nobody"}</dd>
            <dt>Aim</dt>
            <dd>{team.mode === "cycles" ? `cycles: cycle ${cycles.length + 1}${cycles.length ? `, ${cycles.length} closed` : ""}` : "its finish line"}</dd>
            <dt>Updated</dt>
            <dd>
              <Ago at={status?.at} />
            </dd>
          </dl>
        </section>
        <section className="panel" aria-labelledby="progress">
          <h2 id="progress">Progress</h2>
          <ul className="counts">
            {progress(tasks).map(({ label, count }) => (
              <li key={label}>
                <b>{count}</b>
                <span className="small muted">{label}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="panel" aria-labelledby="journeys">
        <h2 id="journeys">Journeys</h2>
        {shownJourneys.length ? (
          <ul className="plain rows">
            {shownJourneys.map((j) => (
              <li key={j.id}>
                <div className="head">
                  <span className="id">#{j.id}</span>
                  <span className="title">{j.title}</span>
                  <Chip>{j.status}</Chip>
                  {j.due ? <Chip tone="caution">due its verification</Chip> : null}
                </div>
                <p className="small muted">
                  {j.done} of {j.total} task{j.total === 1 ? "" : "s"} done
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">No journeys yet.</p>
        )}
      </section>

      {details ? (
        <>
          <section className="panel" aria-labelledby="board">
            <h2 id="board">Board</h2>
            <Board tasks={tasks} />
          </section>
          <section className="panel" aria-labelledby="graph">
            <h2 id="graph">Graph</h2>
            <TaskGraph tasks={tasks} />
          </section>
          <section className="panel" aria-labelledby="merges">
            <h2 id="merges">Recent merges</h2>
            {merges(tasks).length ? (
              <ul className="plain rows">
                {merges(tasks).map(({ task, at }) => (
                  <li key={task.id}>
                    <span className="id">#{task.id}</span> {task.title}{" "}
                    <span className="muted small">
                      · <Ago at={at} />
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty">Nothing merged yet.</p>
            )}
          </section>
        </>
      ) : null}
    </>
  );
}

function Board({ tasks }: { tasks: Task[] }) {
  const columns = board(tasks);
  if (!columns.length) return <p className="empty">No tasks yet.</p>;
  return (
    <div className="board">
      {columns.map(({ status, tasks: list }) => {
        const cards = (
          <ul className="plain">
            {list.map((t) => (
              <li key={t.id} className={`card status-${t.status}`}>
                <div>
                  <span className="id">#{t.id}</span> {t.title}
                </div>
                <div className="small muted">{[t.kind, t.severity, t.priority === null ? null : `p${t.priority}`].filter(Boolean).join(" · ")}</div>
                {t.claim ? (
                  <div className="claim">
                    {t.claim.role} on {t.claim.machine}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        );
        return (
          <div key={status} className="column">
            <h3>
              {status} <span className="muted">{list.length}</span>
            </h3>
            {status === "done" || status === "rejected" ? (
              <details>
                <summary>Show</summary>
                {cards}
              </details>
            ) : (
              cards
            )}
          </div>
        );
      })}
    </div>
  );
}
