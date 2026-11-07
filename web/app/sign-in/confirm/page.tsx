import type { Metadata } from "next";
import Link from "next/link";
import { SubmitButton } from "../../../components/submit-button.tsx";
import { param, type SearchParams } from "../../../components/ui.tsx";
import { deviceOf } from "../../../server/device.ts";
import { readChallenge, UNKNOWN_IP } from "../../../server/known-ips.ts";
import { answerAction } from "./actions.ts";

export const metadata: Metadata = { title: "Was this you?" };

// The page a confirmation email links to: what signed in, from where, and two answers.
export default async function ConfirmPage({ searchParams }: { searchParams: SearchParams }) {
  const token = param((await searchParams)["token"]);
  const found = await readChallenge(token);
  if (!found)
    return (
      <div className="narrow stack">
        <h1>This link has expired</h1>
        <p>It works once, for 30 minutes. Sign in again and we&apos;ll email a new one.</p>
        <p>
          <Link href="/sign-in">Sign in</Link>
        </p>
      </div>
    );
  return (
    <div className="narrow stack">
      <h1>Was this you?</h1>
      <p>Someone signed in to your Anything Factory account from a new IP address.</p>
      <dl className="facts">
        <dt>Account</dt>
        <dd>{found.email}</dd>
        <dt>IP address</dt>
        <dd>{found.ip === UNKNOWN_IP ? "couldn't be read" : found.ip}</dd>
        <dt>Device</dt>
        <dd>{deviceOf(found.userAgent)}</dd>
        <dt>When</dt>
        <dd>
          <time dateTime={found.createdAt.toISOString()}>{found.createdAt.toUTCString()}</time>
        </dd>
      </dl>
      <div className="inline">
        <form action={answerAction}>
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="answer" value="confirmed" />
          <SubmitButton className="primary">Yes, it was me</SubmitButton>
        </form>
        <form action={answerAction}>
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="answer" value="denied" />
          <SubmitButton className="danger">It wasn&apos;t me: sign out everywhere</SubmitButton>
        </form>
      </div>
      <p className="hint">“It wasn&apos;t me” ends every session on your account at once, this address&apos;s too. Then tell the operator.</p>
    </div>
  );
}
