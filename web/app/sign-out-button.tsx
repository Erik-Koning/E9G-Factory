"use client";
import { useState } from "react";
import { authClient } from "./auth-client.ts";

export function SignOutButton({ label = "Sign out", className = "linkish" }: { label?: string; className?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={className}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await authClient.signOut();
        window.location.assign("/sign-in");
      }}
    >
      {label}
    </button>
  );
}
