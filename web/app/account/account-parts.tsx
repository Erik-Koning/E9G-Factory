"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient, problemOf } from "../auth-client.ts";

export function Passkeys({ passkeys }: { passkeys: { id: string; name: string; createdAt: string }[] }) {
  const router = useRouter();
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (work: () => Promise<{ error?: { message?: string; status?: number } | null } | undefined>, fallback: string) => {
    setBusy(true);
    setProblem(null);
    const result = await work().catch((error: unknown) => ({ error: { message: error instanceof Error ? error.message : fallback } }));
    setBusy(false);
    if (result?.error) setProblem(problemOf(result.error, fallback));
    else router.refresh();
  };
  return (
    <>
      {problem ? (
        <p className="notice error" role="alert">
          {problem}
        </p>
      ) : null}
      {passkeys.length ? (
        <ul className="plain rows">
          {passkeys.map((p) => (
            <li key={p.id} className="head">
              <span className="title">{p.name}</span>
              <span className="muted small">added {new Date(p.createdAt).toLocaleDateString("en")}</span>
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => act(() => authClient.passkey.deletePasskey({ id: p.id }), "It wasn't removed.")}
              >
                Remove {p.name}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty">No passkeys yet.</p>
      )}
      <form
        className="inline"
        onSubmit={(event) => {
          event.preventDefault();
          const name = String(new FormData(event.currentTarget).get("name") ?? "").trim() || "Passkey";
          void act(() => authClient.passkey.addPasskey({ name }), "No passkey was added.");
        }}
      >
        <label>
          Name it
          <input name="name" maxLength={60} placeholder="This laptop" autoComplete="off" />
        </label>
        <button type="submit" disabled={busy}>
          Add a passkey
        </button>
      </form>
    </>
  );
}

export function BackupCodes() {
  const [codes, setCodes] = useState<string[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      {problem ? (
        <p className="notice error" role="alert">
          {problem}
        </p>
      ) : null}
      {codes ? (
        <div className="notice ok" role="status">
          <p>Your new backup codes. Keep them somewhere safe: each works once, and the old ones no longer do.</p>
          <div className="codes">
            {codes.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
        </div>
      ) : null}
      <form
        className="inline"
        onSubmit={async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const password = String(new FormData(form).get("password") ?? "");
          setBusy(true);
          setProblem(null);
          const { data, error } = await authClient.twoFactor.generateBackupCodes({ password });
          setBusy(false);
          if (error || !data) return setProblem(problemOf(error, "No new codes were made."));
          form.reset();
          setCodes(data.backupCodes);
        }}
      >
        <label>
          Your password
          <input name="password" type="password" required autoComplete="current-password" />
        </label>
        <button type="submit" disabled={busy}>
          Make new backup codes
        </button>
      </form>
    </>
  );
}
