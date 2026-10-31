"use server";
// People, the admins': invite, set a role per team, remove from a team, ban and unban. Each checks the admin and
// their second factor first (allowed), then Better Auth's admin plugin, called on the server with the admin's own
// session, does the account's part.
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { withNotice } from "../../../components/ui.tsx";
import { invitationProblem, isTeamRole, LIMITS, TEAM_PARAM } from "../../../server/access.ts";
import { auth, isAdminRole } from "../../../server/auth.ts";
import { Refused, teamDoc } from "../../../server/factory.ts";
import { changeRole, removeMembership, setMembership } from "../../../server/people.ts";
import { allowed, NotAllowed } from "../../../server/viewer.ts";

const BACK = "/admin/people";
const text = (form: FormData, key: string): string => {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
};
function reasonOf(error: unknown): string {
  if (error instanceof NotAllowed || error instanceof Refused) return error.message;
  const message = (error as { body?: { message?: string }; message?: string })?.body?.message;
  if (message) return message;
  console.error(error);
  return "Something went wrong; try again.";
}
async function run(work: () => Promise<string>): Promise<never> {
  let notice: { ok?: string; error?: string };
  try {
    await allowed("people:manage");
    notice = { ok: await work() };
  } catch (error) {
    notice = { error: reasonOf(error) };
  }
  redirect(withNotice(BACK, notice));
}

const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
async function userById(id: string): Promise<{ id: string; name: string; email: string; role?: string | null; banned?: boolean | null }> {
  if (!USER_ID.test(id)) throw new Refused("No such person.");
  const found = await (await auth().$context).internalAdapter.findUserById(id);
  if (!found) throw new Refused("No such person.");
  return found as { id: string; name: string; email: string; role?: string | null; banned?: boolean | null };
}

// Invites someone to a team: their account when new (no password: they sign in by email or a passkey), their role
// and stakeholder record on the team, and for a new account an invitation with a sign-in link.
export async function inviteAction(form: FormData): Promise<void> {
  await run(async () => {
    const email = text(form, "email").toLowerCase();
    const name = text(form, "name");
    const team = text(form, "team");
    const role = text(form, "role");
    const label = text(form, "label") || "stakeholder";
    const problem = invitationProblem({ email, name, team, role, label });
    if (problem || !isTeamRole(role)) throw new Refused(problem ?? "Choose member or contributor.");
    const settings = await teamDoc(team);
    if (!settings) throw new Refused("No such team.");
    const context = await auth().$context;
    const known = (await context.internalAdapter.findUserByEmail(email))?.user as { id: string; name: string; email: string; role?: string } | undefined;
    const user = known ?? (await auth().api.createUser({ body: { email, name, role: "user" }, headers: await headers() })).user;
    await setMembership({ userId: user.id, name: user.name, email: user.email }, team, role, label);
    if (known) return `${known.email} is now a ${role} of ${team}.`;
    await auth().api.signInMagicLink({ body: { email, callbackURL: `/t/${team}`, metadata: { team: settings.title || team } }, headers: await headers() });
    return `Invited ${email} to ${team} as a ${role}; they have a sign-in link by email.`;
  });
}

export async function changeRoleAction(form: FormData): Promise<void> {
  await run(async () => {
    const user = await userById(text(form, "userId"));
    const team = text(form, "team");
    const role = text(form, "role");
    if (!TEAM_PARAM.test(team) || !isTeamRole(role)) throw new Refused("Choose member or contributor.");
    if (!(await changeRole(user.id, team, role))) throw new Refused(`${user.email} isn't on ${team}.`);
    return `${user.email} is now a ${role} of ${team}.`;
  });
}

export async function removeAction(form: FormData): Promise<void> {
  await run(async () => {
    const user = await userById(text(form, "userId"));
    const team = text(form, "team");
    if (!TEAM_PARAM.test(team)) throw new Refused("No such team.");
    await removeMembership(user.id, team);
    return `${user.email} is no longer on ${team}.`;
  });
}

// A ban ends every session the person has and keeps them from signing in; admins are managed by create-admin.
export async function banAction(form: FormData): Promise<void> {
  await run(async () => {
    const user = await userById(text(form, "userId"));
    if (isAdminRole(user.role)) throw new Refused("Admins aren't banned from here; remove one with create-admin on the operator's machine.");
    const reason = text(form, "reason").slice(0, LIMITS.label) || "removed by an admin";
    await auth().api.banUser({ body: { userId: user.id, banReason: reason }, headers: await headers() });
    return `${user.email} is banned and signed out everywhere.`;
  });
}

export async function unbanAction(form: FormData): Promise<void> {
  await run(async () => {
    const user = await userById(text(form, "userId"));
    await auth().api.unbanUser({ body: { userId: user.id }, headers: await headers() });
    return `${user.email} can sign in again.`;
  });
}
