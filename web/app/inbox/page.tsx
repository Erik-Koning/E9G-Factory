import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { TeamInbox } from "../../components/inbox.tsx";
import { Chip, Notice, type SearchParams } from "../../components/ui.tsx";
import { can } from "../../server/access.ts";
import { allTeams, storeFor } from "../../server/factory.ts";
import { inbox } from "../../server/inbox.ts";
import { requireViewer } from "../../server/viewer.ts";

export const metadata: Metadata = { title: "Waiting on you" };

// Everything waiting on the operator, on every team they decide for: the teams with something first.
export default async function InboxPage({ searchParams }: { searchParams: SearchParams }) {
  const viewer = await requireViewer();
  const teams = (await allTeams()).filter((team) => can(viewer, "proposals:decide", team.name));
  if (!teams.length && !viewer.admin) notFound();
  const boxes = await Promise.all(
    teams.map(async (team) => {
      const tasks = await storeFor(team.name).tasks.all();
      const box = inbox(tasks);
      return { team, box, tasks, open: box.questions.length + box.blocked.length };
    })
  );
  const waiting = boxes.filter((b) => b.open || b.box.answered.length).sort((a, b) => b.open - a.open);
  const quiet = boxes.filter((b) => !b.open && !b.box.answered.length);
  const total = waiting.reduce((n, b) => n + b.open, 0);
  const across = waiting.filter((b) => b.open).length;
  return (
    <>
      <h1>Waiting on you</h1>
      <p className="lede">
        {total
          ? `${total} waiting for your answer${across > 1 ? `, across ${across} teams` : ""}. The teams keep working on everything else meanwhile.`
          : "Nothing is waiting on you. The teams ask here when they need a decision."}{" "}
        <Link href="/account/notifications">Notifications</Link> say how you hear about new ones.
      </p>
      <Notice searchParams={searchParams} />
      {waiting.map(({ team, box, tasks, open }) => (
        <section key={team.name} className="team-inbox" aria-labelledby={`team-${team.name}`}>
          <div className="head">
            <h2 id={`team-${team.name}`} className="title">
              <Link href={`/t/${team.name}/inbox`}>{team.title || team.name}</Link>
            </h2>
            <Chip>{team.status?.state ?? "no status yet"}</Chip>
            <span className="muted small">{open ? `${open} waiting` : "all answered"}</span>
          </div>
          <TeamInbox team={team.name} box={{ ...box, settled: [] }} back="/inbox" titles={new Map(tasks.map((t) => [t.id, t.title]))} />
        </section>
      ))}
      {quiet.length ? (
        <p className="small muted">
          Nothing waiting on{" "}
          {quiet.map(({ team }, i) => (
            <span key={team.name}>
              {i ? ", " : ""}
              <Link href={`/t/${team.name}`}>{team.title || team.name}</Link>
            </span>
          ))}
          .
        </p>
      ) : null}
      {!teams.length ? (
        <p className="panel empty">No team has published its settings yet: a6g register publishes a team whose tasks are in Mongo.</p>
      ) : null}
    </>
  );
}
