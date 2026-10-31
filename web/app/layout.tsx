import type { Metadata, Viewport } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { blockedAdmin } from "../server/access.ts";
import { getViewer } from "../server/viewer.ts";
import { SignOutButton } from "./sign-out-button.tsx";
import "./globals.css";

// Every page is the signed-in person's own, from live data: never prerendered or cached.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "E9G", template: "%s · E9G" },
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

export default async function RootLayout({ children }: { children: ReactNode }) {
  const viewer = await getViewer();
  const signedIn = viewer !== null && !blockedAdmin(viewer);
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main">
          Skip to the content
        </a>
        <header className="top">
          <div className="top-inner">
            <Link className="brand" href="/">
              E9G
            </Link>
            {signedIn ? (
              <nav aria-label="Main">
                <Link href="/">Teams</Link>
                {viewer.admin ? <Link href="/admin/people">People</Link> : null}
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
