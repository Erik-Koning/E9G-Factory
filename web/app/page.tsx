import type { Metadata } from "next";
import Link from "next/link";
import { Ago, Chip, Notice, type SearchParams } from "../components/ui.tsx";
import { can, roleIn } from "../server/access.ts";
import { allTeams, storeFor, type TeamDoc } from "../server/factory.ts";
import { waitingCount } from "../server/inbox.ts";
import { requireViewer } from "../server/viewer.ts";
import { merges, proposals } from "../server/views.ts";

export const metadata: Metadata = { title: "Teams" };

export default async function TeamsPage({ searchParams }: { searchParams: SearchParams }) {
  const viewer = await requireViewer();
  const teams = (await allTeams()).filter((team) => roleIn(viewer, team.name) !== null);
  const cards = await Promise.all(teams.map(async (team) => ({ team, ...(await summary(team)) })));
  const asking = cards.filter((c) => c.asks && can(viewer, "proposals:decide", c.team.name));
  const asks = asking.reduce((n, c) => n + c.asks, 0);
  return (
    <>
      <h1>Teams</h1>
      <p className="lede">{viewer.admin ? "Every team that has published its settings." : "The teams you follow."}</p>
      <Notice searchParams={searchParams} />
      {asks ? (
        <div className="notice attention inline">
          <span>
            <b>{asks === 1 ? "One thing is" : `${asks} things are`} waiting on you</b>
            {asking.length > 1 ? `, on ${asking.length} teams` : ` on ${asking[0]?.team.title || asking[0]?.team.name}`}: questions to answer or work
            that&apos;s blocked.
          </span>
          <Link className="button primary" href="/inbox">
            See what&apos;s waiting
          </Link>
        </div>
      ) : null}
      {cards.length ? (
        <ul className="cards">
          {cards.map(({ team, waiting, asks: teamAsks, cycles, lastMerge }) => {
            const role = roleIn(viewer, team.name);
            const status = team.status;
            const atWork = status ? Object.entries(status.members).filter(([, n]) => n > 0) : [];
            return (
              <li key={team.name}>
                <div className="head">
                  <h2 className="title">
                    <Link href={`/t/${team.name}`}>{team.title || team.name}</Link>
                  </h2>
                  <Chip>{status?.state ?? "no status yet"}</Chip>
                </div>
                <dl className="facts small">
                  <dt>Your role</dt>
                  <dd>{role}</dd>
                  <dt>Planner</dt>
                  <dd>{status?.planner ?? "not running"}</dd>
                  <dt>At work</dt>
                  <dd>{atWork.length ? atWork.map(([r, n]) => `${n} ${r}${n === 1 ? "" : "s"}`).join(", ") : "nobody"}</dd>
                  <dt>Aim</dt>
                  <dd>
                    {team.mode === "cycles" ? `cycle ${cycles + 1}` : status?.state === "complete" ? "finish line reached" : "working to its finish line"}
                  </dd>
                  <dt>Last merge</dt>
                  <dd>
                    <Ago at={lastMerge} />
                  </dd>
                  <dt>Updated</dt>
                  <dd>
                    <Ago at={status?.at} />
                  </dd>
                </dl>
                <p className="small">
                  <Link href={`/t/${team.name}`}>Overview</Link>
                  {can(viewer, "proposals:decide", team.name) ? (
                    <>
                      {" "}
                      · <Link href={`/t/${team.name}/inbox`}>Waiting on you{teamAsks ? ` (${teamAsks})` : ""}</Link>
                    </>
                  ) : null}
                  {can(viewer, "team:board", team.name) ? (
                    <>
                      {" "}
                      · <Link href={`/t/${team.name}/board`}>Board</Link>
                    </>
                  ) : null}{" "}
                  · <Link href={`/t/${team.name}/requests`}>Requests</Link>
                  {can(viewer, "proposals:decide", team.name) ? (
                    <>
                      {" "}
                      · <Link href={`/t/${team.name}/proposals`}>Decisions{waiting ? ` (${waiting})` : ""}</Link>
                    </>
                  ) : null}
                </p>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="panel empty">
          {viewer.admin
            ? "No team has published its settings yet: a6g register publishes a team whose tasks are in Mongo."
            : "You don't follow any team yet."}
        </p>
      )}
    </>
  );
}

async function summary(team: TeamDoc): Promise<{ waiting: number; asks: number; cycles: number; lastMerge: string | null }> {
  const store = storeFor(team.name);
  const [tasks, cycles] = await Promise.all([store.tasks.all(), team.mode === "cycles" ? store.cycles.all() : Promise.resolve([])]);
  return { waiting: proposals(tasks).length, asks: waitingCount(tasks), cycles: cycles.length, lastMerge: merges(tasks, 1)[0]?.at ?? null };
}
