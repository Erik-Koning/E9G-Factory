import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { blockedAdmin } from "../../server/access.ts";
import { getViewer } from "../../server/viewer.ts";
import { SignOutButton } from "../sign-out-button.tsx";

export const metadata: Metadata = { title: "Second factor needed" };

// Where an admin lands whose session began without a second factor (a passkey that didn't verify them, say): nothing
// else opens until they sign in again with one.
export default async function SecondFactorPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/sign-in");
  if (!blockedAdmin(viewer)) redirect("/");
  return (
    <div className="narrow">
      <h1>Sign in with your second factor</h1>
      <p>
        You&apos;re an admin, and this session began without a second factor. Admins sign in with their password and their authenticator&apos;s code (or a
        backup code), or with a passkey that checks it&apos;s you with a PIN, fingerprint or face.
      </p>
      <p>
        <SignOutButton label="Sign out and sign in again" className="primary" />
      </p>
      <p className="hint">Lost the authenticator and the backup codes? Run create-admin again on the operator&apos;s machine.</p>
    </div>
  );
}
