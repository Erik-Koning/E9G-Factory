// Who's asking: the session's person, their roles per team, and whether the session began with a second factor.
// Every page and server action starts here; access.ts says what they may do.
import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { type Ability, blockedAdmin, can, isTeamRole, type TeamRole, type Viewer } from "./access.ts";
import { auth, isAdminRole } from "./auth.ts";
import { memberships } from "./people.ts";

export interface Person extends Viewer {
  name: string;
  email: string;
  sessionId: string;
}

export const getViewer = cache(async (): Promise<Person | null> => {
  const requestHeaders = await headers();
  const current = await auth().api.getSession({ headers: requestHeaders });
  if (!current) return null;
  const teams: Record<string, TeamRole> = {};
  for (const m of await memberships({ userId: current.user.id })) if (isTeamRole(m.role)) teams[m.team] = m.role;
  return {
    userId: current.user.id,
    name: current.user.name,
    email: current.user.email,
    admin: isAdminRole(current.user.role),
    secondFactor: current.session.secondFactor === true,
    sessionId: current.session.id,
    teams,
  };
});

// For pages: the signed-in person, or off to sign in (an admin without the second factor, to say so).
export async function requireViewer(): Promise<Person> {
  const viewer = await getViewer();
  if (!viewer) redirect("/sign-in");
  if (blockedAdmin(viewer)) redirect("/second-factor");
  return viewer;
}

// What a server action refuses with: the browser is sent back to `back` with the reason.
export class NotAllowed extends Error {}

// For server actions: the person, when they may do `ability` (on `team`); otherwise NotAllowed, before anything is read
// or written.
export async function allowed(ability: Ability, team?: string): Promise<Person> {
  const viewer = await getViewer();
  if (!viewer) throw new NotAllowed("Sign in first.");
  if (blockedAdmin(viewer)) throw new NotAllowed("Sign in again with your authenticator or a passkey first.");
  if (!can(viewer, ability, team)) throw new NotAllowed("You can't do that here.");
  return viewer;
}
