import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { SubmitButton } from "../../../components/submit-button.tsx";
import { Chip, Notice, type SearchParams } from "../../../components/ui.tsx";
import { can, LIMITS, TEAM_ROLES } from "../../../server/access.ts";
import { auth, isAdminRole } from "../../../server/auth.ts";
import { allTeams } from "../../../server/factory.ts";
import { type Membership, memberships } from "../../../server/people.ts";
import { requireViewer } from "../../../server/viewer.ts";
import { banAction, changeRoleAction, inviteAction, removeAction, unbanAction } from "./actions.ts";

export const metadata: Metadata = { title: "People" };

interface Account {
  id: string;
  name: string;
  email: string;
  role?: string | null;
  banned?: boolean | null;
}

export default async function PeoplePage({ searchParams }: { searchParams: SearchParams }) {
  const viewer = await requireViewer();
  if (!can(viewer, "people:manage")) notFound();
  const [teams, listed, all] = await Promise.all([
    allTeams(),
    auth().api.listUsers({ query: { limit: 500, sortBy: "email", sortDirection: "asc" }, headers: await headers() }),
    memberships(),
  ]);
  const users = listed.users as Account[];
  const byUser = new Map<string, Membership[]>();
  for (const m of all) byUser.set(m.userId, [...(byUser.get(m.userId) ?? []), m]);
  return (
    <>
      <h1>People</h1>
      <p className="lede">Invite people to a team, set their role there, and remove them. Admins are made with create-admin.</p>
      <Notice searchParams={searchParams} />
      <section className="panel" aria-labelledby="invite">
        <h2 id="invite">Invite someone</h2>
        {teams.length ? (
          <form action={inviteAction} className="stack">
            <div className="inline">
              <label>
                Email
                <input name="email" type="email" required maxLength={LIMITS.email} autoComplete="off" />
              </label>
              <label>
                Name
                <input name="name" required maxLength={LIMITS.name} autoComplete="off" />
              </label>
            </div>
            <div className="inline">
              <div className="field">
                <label htmlFor="invite-team">Team</label>
                <select id="invite-team" name="team" required>
                  {teams.map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.title || t.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="invite-role">Role</label>
                <select id="invite-role" name="role" defaultValue="contributor">
                  {TEAM_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
              <label>
                What they are to the team&apos;s agents
                <input name="label" maxLength={LIMITS.label} placeholder="customer, sales, support…" autoComplete="off" />
              </label>
            </div>
            <p className="hint">
              A contributor sends requests and sees their own, and the team&apos;s overview. A member sees the board, the graph and every request (senders
              by role). Agents see the role you give here, never a name or email.
            </p>
            <div>
              <SubmitButton className="primary">Invite</SubmitButton>
            </div>
          </form>
        ) : (
          <p className="empty">No team has published its settings yet.</p>
        )}
      </section>
      <section className="panel" aria-labelledby="everyone">
        <h2 id="everyone">Everyone</h2>
        <ul className="plain rows">
          {users.map((u) => {
            const admin = isAdminRole(u.role);
            const theirs = byUser.get(u.id) ?? [];
            return (
              <li key={u.id}>
                <div className="head">
                  <span className="title">{u.name}</span>
                  <span className="muted">{u.email}</span>
                  {admin ? <Chip tone="ok">admin</Chip> : null}
                  {u.banned ? <Chip tone="warn">banned</Chip> : null}
                </div>
                {theirs.length ? (
                  <ul className="plain small">
                    {theirs.map((m) => (
                      <li key={m.team} className="inline">
                        <form action={changeRoleAction} className="inline">
                          <input type="hidden" name="userId" value={u.id} />
                          <input type="hidden" name="team" value={m.team} />
                          <div className="field">
                            <label htmlFor={`role-${u.id}-${m.team}`}>{`${u.email}'s role on ${m.team}`}</label>
                            <select id={`role-${u.id}-${m.team}`} name="role" defaultValue={m.role}>
                              {TEAM_ROLES.map((r) => (
                                <option key={r} value={r}>
                                  {r}
                                </option>
                              ))}
                            </select>
                          </div>
                          <SubmitButton>{`Save ${u.email}'s role on ${m.team}`}</SubmitButton>
                        </form>
                        <form action={removeAction}>
                          <input type="hidden" name="userId" value={u.id} />
                          <input type="hidden" name="team" value={m.team} />
                          <SubmitButton className="danger">{`Remove ${u.email} from ${m.team}`}</SubmitButton>
                        </form>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="small muted">{admin ? "Sees every team." : "On no team."}</p>
                )}
                {!admin && u.id !== viewer.userId ? (
                  u.banned ? (
                    <form action={unbanAction}>
                      <input type="hidden" name="userId" value={u.id} />
                      <SubmitButton>{`Unban ${u.email}`}</SubmitButton>
                    </form>
                  ) : (
                    <form action={banAction} className="inline">
                      <input type="hidden" name="userId" value={u.id} />
                      <label>
                        {`Why ban ${u.email} (optional)`}
                        <input name="reason" maxLength={LIMITS.label} autoComplete="off" />
                      </label>
                      <SubmitButton className="danger">Ban and sign out</SubmitButton>
                    </form>
                  )
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}
