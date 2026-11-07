import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SubmitButton } from "../../components/submit-button.tsx";
import { Notice, type SearchParams } from "../../components/ui.tsx";
import { pendingStep } from "../../server/access.ts";
import { challenge, UNKNOWN_IP } from "../../server/known-ips.ts";
import { getViewer, STEP_PAGE } from "../../server/viewer.ts";
import { SignOutButton } from "../sign-out-button.tsx";
import { resendAction } from "./actions.ts";

export const metadata: Metadata = { title: "Confirm it's you" };

// Where a session lands that's used from an IP address its person hasn't confirmed: at sign-in, or when a session
// moves to a new address. Nothing else opens until they confirm it from their email.
export default async function ConfirmSignInPage({ searchParams }: { searchParams: SearchParams }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/sign-in");
  const step = pendingStep(viewer);
  if (step !== "confirm-ip") redirect(step ? STEP_PAGE[step] : "/");
  // A session that moved to this address mid-way has had no email yet; one that signed in here has (this sends none).
  await challenge({
    userId: viewer.userId,
    email: viewer.email,
    ip: viewer.ip,
    userAgent: (await headers()).get("user-agent"),
    sessionId: viewer.sessionId,
  });
  return (
    <div className="narrow stack">
      <h1>Confirm it&apos;s you</h1>
      <p>
        This is the first time you&apos;ve used Anything Factory from{" "}
        {viewer.ip && viewer.ip !== UNKNOWN_IP ? (
          <>
            the IP address <b>{viewer.ip}</b>
          </>
        ) : (
          "this network"
        )}
        . We&apos;ve emailed <b>{viewer.email}</b> a link to confirm it was you.
      </p>
      <ol>
        <li>Open the email &ldquo;Confirm it&apos;s you signing in to Anything Factory&rdquo;, on any device.</li>
        <li>Choose &ldquo;Yes, it was me&rdquo;.</li>
        <li>
          Come back and <Link href="/">continue</Link>.
        </li>
      </ol>
      <Notice searchParams={searchParams} />
      <form action={resendAction}>
        <SubmitButton>Email the link again</SubmitButton>
      </form>
      <p>
        <SignOutButton label="Sign out instead" className="linkish" />
      </p>
      <p className="hint">The link works once, for 30 minutes. If you didn&apos;t sign in just now, open it and choose &ldquo;It wasn&apos;t me&rdquo;.</p>
    </div>
  );
}
