"use client";
import { useState } from "react";
import { authClient, problemOf } from "../auth-client.ts";

type Step = "choose" | "sent" | "code";

export function SignInForm({ next }: { next: string }) {
  const [step, setStep] = useState<Step>("choose");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [backup, setBackup] = useState(false);
  const done = () => window.location.assign(next);
  const attempt = async (work: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "That didn't work; try again.");
    } finally {
      setBusy(false);
    }
  };

  if (step === "sent")
    return (
      <section className="panel" aria-live="polite">
        <h2>Check your email</h2>
        <p>If that address has an account, a sign-in link is on its way. It works once, for 15 minutes.</p>
        <button type="button" className="linkish" onClick={() => setStep("choose")}>
          Use another way
        </button>
      </section>
    );

  if (step === "code")
    return (
      <section className="panel">
        <h2>{backup ? "A backup code" : "Your authenticator's code"}</h2>
        {problem ? (
          <p className="notice error" role="alert">
            {problem}
          </p>
        ) : null}
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            const code = String(new FormData(event.currentTarget).get("code") ?? "").trim();
            void attempt(async () => {
              const { error } = backup ? await authClient.twoFactor.verifyBackupCode({ code }) : await authClient.twoFactor.verifyTotp({ code });
              if (error) throw new Error(problemOf(error, "That code isn't right."));
              done();
            });
          }}
        >
          <label>
            {backup ? "Backup code" : "6-digit code"}
            <input
              name="code"
              required
              autoFocus
              autoComplete="one-time-code"
              inputMode={backup ? "text" : "numeric"}
              pattern={backup ? undefined : "[0-9]{6}"}
              maxLength={backup ? 32 : 6}
            />
          </label>
          <div>
            <button type="submit" className="primary" disabled={busy}>
              Verify
            </button>
          </div>
          <button type="button" className="linkish" onClick={() => setBackup(!backup)}>
            {backup ? "Use the authenticator instead" : "Use a backup code instead"}
          </button>
        </form>
      </section>
    );

  return (
    <>
      {problem ? (
        <p className="notice error" role="alert">
          {problem}
        </p>
      ) : null}
      <section className="panel">
        <h2>With a passkey</h2>
        <p className="small muted">Your device&apos;s fingerprint, face or PIN. Add one from your account page once you&apos;re in.</p>
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() =>
            attempt(async () => {
              const result = await authClient.signIn.passkey();
              if (result?.error) throw new Error(problemOf(result.error, "No passkey signed you in."));
              done();
            })
          }
        >
          Sign in with a passkey
        </button>
      </section>
      <section className="panel">
        <h2>With a link by email</h2>
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            const email = String(new FormData(event.currentTarget).get("email") ?? "").trim();
            void attempt(async () => {
              const { error } = await authClient.signIn.magicLink({ email, callbackURL: next, errorCallbackURL: "/sign-in" });
              if (error) throw new Error(problemOf(error, "That didn't send; try again."));
              setStep("sent");
            });
          }}
        >
          <label>
            Email
            <input name="email" type="email" required autoComplete="email" />
          </label>
          <div>
            <button type="submit" disabled={busy}>
              Email me a link
            </button>
          </div>
        </form>
      </section>
      <section className="panel">
        <details>
          <summary>Admins: password and authenticator</summary>
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              void attempt(async () => {
                const { data: result, error } = await authClient.signIn.email({
                  email: String(data.get("email") ?? "").trim(),
                  password: String(data.get("password") ?? ""),
                });
                if (error) throw new Error(problemOf(error, "That email and password don't match."));
                if (result && "twoFactorRedirect" in result && result.twoFactorRedirect) return setStep("code");
                done();
              });
            }}
          >
            <label>
              Email
              <input name="email" type="email" required autoComplete="username" />
            </label>
            <label>
              Password
              <input name="password" type="password" required autoComplete="current-password" />
            </label>
            <div>
              <button type="submit" disabled={busy}>
                Continue
              </button>
            </div>
            <p className="hint">Admins never get a link by email: they sign in with a passkey, or a password and their authenticator&apos;s code.</p>
          </form>
        </details>
      </section>
    </>
  );
}
