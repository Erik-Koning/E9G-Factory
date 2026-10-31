import type { Metadata } from "next";
import { headers } from "next/headers";
import { SubmitButton } from "../../components/submit-button.tsx";
import { Ago, Chip, Notice, type SearchParams } from "../../components/ui.tsx";
import { auth } from "../../server/auth.ts";
import { requireViewer } from "../../server/viewer.ts";
import { SignOutButton } from "../sign-out-button.tsx";
import { BackupCodes, Passkeys } from "./account-parts.tsx";
import { revokeOtherSessionsAction, revokeSessionAction } from "./actions.ts";

export const metadata: Metadata = { title: "Account" };

// A rough name for a browser, from its user agent.
const deviceOf = (agent: string | null | undefined): string => {
  if (!agent) return "Unknown device";
  const browser = /Edg\//.test(agent)
    ? "Edge"
    : /Firefox\//.test(agent)
      ? "Firefox"
      : /Chrome\//.test(agent)
        ? "Chrome"
        : /Safari\//.test(agent)
          ? "Safari"
          : "A browser";
  const os = /iPhone|iPad/.test(agent)
    ? "iOS"
    : /Android/.test(agent)
      ? "Android"
      : /Mac OS X/.test(agent)
        ? "macOS"
        : /Windows/.test(agent)
          ? "Windows"
          : /Linux/.test(agent)
            ? "Linux"
            : "";
  return os ? `${browser} on ${os}` : browser;
};

export default async function AccountPage({ searchParams }: { searchParams: SearchParams }) {
  const viewer = await requireViewer();
  const requestHeaders = await headers();
  const [passkeys, sessions, current] = await Promise.all([
    auth().api.listPasskeys({ headers: requestHeaders }),
    auth().api.listSessions({ headers: requestHeaders }),
    auth().api.getSession({ headers: requestHeaders }),
  ]);
  const teams = Object.entries(viewer.teams);
  return (
    <>
      <h1>Account</h1>
      <p className="lede">
        {viewer.name} · {viewer.email}
        {viewer.admin ? " · admin" : ""}
      </p>
      <Notice searchParams={searchParams} />
      <div className="grid">
        <section className="panel" aria-labelledby="passkeys">
          <h2 id="passkeys">Passkeys</h2>
          <p className="hint">
            Sign in with your device instead of an email link.
            {viewer.admin ? " As an admin, a passkey counts once it checks it's you (PIN, fingerprint or face)." : ""}
          </p>
          <Passkeys passkeys={passkeys.map((p) => ({ id: p.id, name: p.name || "Passkey", createdAt: new Date(p.createdAt).toISOString() }))} />
        </section>
        {viewer.admin ? (
          <section className="panel" aria-labelledby="authenticator">
            <h2 id="authenticator">Authenticator and backup codes</h2>
            <p>
              <Chip tone={current?.user.twoFactorEnabled ? "ok" : "warn"}>{current?.user.twoFactorEnabled ? "authenticator on" : "no authenticator"}</Chip>
            </p>
            <p className="hint">
              Your authenticator was set up by create-admin; running it again replaces it. Backup codes sign you in once each when the authenticator
              isn&apos;t at hand.
            </p>
            <BackupCodes />
          </section>
        ) : (
          <section className="panel" aria-labelledby="teams">
            <h2 id="teams">Your teams</h2>
            {teams.length ? (
              <ul className="plain">
                {teams.map(([team, role]) => (
                  <li key={team}>
                    {team}: {role}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty">None yet.</p>
            )}
          </section>
        )}
      </div>
      <section className="panel" aria-labelledby="sessions">
        <h2 id="sessions">Where you&apos;re signed in</h2>
        <ul className="plain rows">
          {sessions.map((s) => (
            <li key={s.id} className="head">
              <span className="title">{deviceOf(s.userAgent)}</span>
              <span className="muted small">
                signed in <Ago at={new Date(s.createdAt).toISOString()} />
              </span>
              {s.id === viewer.sessionId ? (
                <Chip tone="ok">this one</Chip>
              ) : (
                <form action={revokeSessionAction}>
                  <input type="hidden" name="id" value={s.id} />
                  <SubmitButton className="danger">{`End the session on ${deviceOf(s.userAgent)}`}</SubmitButton>
                </form>
              )}
            </li>
          ))}
        </ul>
        <div className="inline">
          {sessions.length > 1 ? (
            <form action={revokeOtherSessionsAction}>
              <SubmitButton>End every other session</SubmitButton>
            </form>
          ) : null}
          <SignOutButton label="Sign out" className="button" />
        </div>
      </section>
    </>
  );
}
