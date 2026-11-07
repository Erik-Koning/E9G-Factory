import type { Metadata } from "next";
import Link from "next/link";
import { param, type SearchParams } from "../../../../components/ui.tsx";

export const metadata: Metadata = { title: "Thanks" };

const SAID = {
  yes: { title: "Confirmed", text: "That IP address is yours now. Go back to where you were signing in and continue." },
  no: {
    title: "Every session has ended",
    text: "Nobody is signed in to your account any more. Sign in again yourself, and tell the operator someone else got in.",
  },
  gone: { title: "This link has expired", text: "It works once, for 30 minutes. Sign in again and we'll email a new one." },
} as const;

export default async function DonePage({ searchParams }: { searchParams: SearchParams }) {
  const result = param((await searchParams)["result"]);
  const said = SAID[result === "yes" || result === "no" ? result : "gone"];
  return (
    <div className="narrow stack">
      <h1>{said.title}</h1>
      <p role="status">{said.text}</p>
      <p>
        <Link href="/">Go to Anything Factory</Link>
      </p>
    </div>
  );
}
