import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { param, type SearchParams } from "../../components/ui.tsx";
import { blockedAdmin } from "../../server/access.ts";
import { getViewer } from "../../server/viewer.ts";
import { SignInForm } from "./sign-in-form.tsx";

export const metadata: Metadata = { title: "Sign in" };

// Only a path on this site (never //elsewhere or a scheme), for after signing in.
const safeNext = (value: string): string => (/^\/(?![/\\])[\w\-./?=&%#~]*$/.test(value) ? value : "/");

const ERRORS: Record<string, string> = {
  INVALID_TOKEN: "That sign-in link has expired or was used already. Ask for a new one.",
  EXPIRED_TOKEN: "That sign-in link has expired. Ask for a new one.",
  failed_to_create_session: "That link doesn't sign this account in. Admins sign in with a passkey, or their password and authenticator.",
  new_user_signup_disabled: "There's no account for that address: it's by invitation only.",
};

export default async function SignInPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const viewer = await getViewer();
  const next = safeNext(param(params["next"]));
  if (viewer && !blockedAdmin(viewer)) redirect(next);
  const error = param(params["error"]);
  return (
    <div className="narrow">
      <h1>Sign in</h1>
      <p className="lede">E9G is by invitation. Use the address you were invited with.</p>
      {error ? (
        <p className="notice error" role="alert">
          {ERRORS[error] ?? "That didn't sign you in. Try again."}
        </p>
      ) : null}
      <SignInForm next={next} />
    </div>
  );
}
