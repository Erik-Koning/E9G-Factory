// The team a page under /t/<team> is about, for someone who may see it; otherwise not found (whether it exists or
// not, so nobody learns of teams they don't follow).
import "server-only";
import { notFound } from "next/navigation";
import { cache } from "react";
import { roleIn, TEAM_PARAM, type TeamRole } from "../../../server/access.ts";
import { teamDoc, type TeamDoc } from "../../../server/factory.ts";
import { type Person, requireViewer } from "../../../server/viewer.ts";

export const teamFor = cache(async (name: string): Promise<{ viewer: Person; team: TeamDoc; role: "admin" | TeamRole }> => {
  const viewer = await requireViewer();
  if (!TEAM_PARAM.test(name)) notFound();
  const role = roleIn(viewer, name);
  if (!role) notFound();
  const team = await teamDoc(name);
  if (!team) notFound();
  return { viewer, team, role };
});
