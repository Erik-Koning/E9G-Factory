import type { ReactNode } from "react";
import { Tabs } from "../../../components/tabs.tsx";
import { Chip } from "../../../components/ui.tsx";
import { can } from "../../../server/access.ts";
import { teamFor } from "./team.ts";

export default async function TeamLayout({ children, params }: { children: ReactNode; params: Promise<{ team: string }> }) {
  const { team: name } = await params;
  const { viewer, team, role } = await teamFor(name);
  const base = `/t/${team.name}`;
  return (
    <>
      <div className="head">
        <h1>{team.title || team.name}</h1>
        <Chip>{team.status?.state ?? "no status yet"}</Chip>
        <span className="muted small">you: {role}</span>
      </div>
      <Tabs
        links={[
          { href: base, label: "Overview", exact: true },
          { href: `${base}/requests`, label: "Requests" },
          ...(can(viewer, "proposals:decide", team.name) ? [{ href: `${base}/proposals`, label: "Decisions" }] : []),
        ]}
      />
      {children}
    </>
  );
}
