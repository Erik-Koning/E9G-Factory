"use client";
import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

// A form's submit button, disabled while its server action runs.
export function SubmitButton({ children, className, name, value }: { children: ReactNode; className?: string; name?: string; value?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} name={name} value={value} disabled={pending} aria-disabled={pending}>
      {pending ? "Working…" : children}
    </button>
  );
}
