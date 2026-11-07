import type { Metadata, Viewport } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { blocked, can } from "../server/access.ts";
import { allTeams, storeFor } from "../server/factory.ts";
import { waitingCount } from "../server/inbox.ts";
import { getViewer, type Person } from "../server/viewer.ts";
import { SignOutButton } from "./sign-out-button.tsx";
import "./globals.css";

// Every page is the signed-in person's own, from live data: never prerendered or cached.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "Anything Factory", template: "%s · Anything Factory" },
  description: "Requests, decisions and each team's state",
  robots: { index: false, follow: false },
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#1a1a1d" },
  ],
};

// What waits on an admin, on every team they decide for: the header says how much on every page, and never fails one.
async function waitingFor(viewer: Person): Promise<number> {
  try {
    const teams = (await allTeams()).filter((team) => can(viewer, "proposals:decide", team.name));
    const counts = await Promise.all(teams.map(async (team) => waitingCount(await storeFor(team.name).tasks.all())));
    return counts.reduce((n, count) => n + count, 0);
  } catch {
    return 0;
  }
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const viewer = await getViewer();
  const signedIn = viewer !== null && !blocked(viewer);
  const waiting = signedIn && viewer.admin ? await waitingFor(viewer) : 0;
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main">
          Skip to the content
        </a>
        <header className="top">
          <div className="top-inner">
            <Link className="brand" href="/">
              Anything Factory
            </Link>
            {signedIn ? (
              <nav aria-label="Main">
                <Link href="/">Teams</Link>
                {viewer.admin ? (
                  <Link href="/inbox" className={waiting ? "attention" : undefined}>
                    Waiting on you
                    {waiting ? (
                      <>
                        {" "}
                        <span className="badge">{waiting}</span>
                      </>
                    ) : null}
                  </Link>
                ) : null}
                {viewer.admin ? <Link href="/admin/people">People</Link> : null}
                {viewer.admin ? <Link href="/admin/audit">Audit</Link> : null}
                <Link href="/account">Account</Link>
              </nav>
            ) : (
              <span className="spacer" />
            )}
            {viewer ? (
              <span className="who">
                {viewer.name || viewer.email}
                {viewer.admin ? " · admin" : ""} · <SignOutButton />
              </span>
            ) : null}
          </div>
        </header>
        <main id="main" tabIndex={-1}>
          {children}
        </main>
      </body>
    </html>
  );
}
