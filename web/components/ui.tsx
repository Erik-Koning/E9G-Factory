// Small pieces every page uses: the result of an action, status chips, times.
import type { ReactNode } from "react";

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;
export const param = (value: string | string[] | undefined): string => (Array.isArray(value) ? (value[0] ?? "") : (value ?? ""));

// What an action came back with (?ok=… or ?error=…), said once at the top of the page.
export async function Notice({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const ok = param(params["ok"]).slice(0, 300);
  const error = param(params["error"]).slice(0, 500);
  if (error)
    return (
      <p className="notice error" role="alert">
        {error}
      </p>
    );
  if (ok)
    return (
      <p className="notice ok" role="status">
        {ok}
      </p>
    );
  return null;
}

const TONE: Record<string, string> = {
  done: "ok",
  approved: "ok",
  promoted: "ok",
  built: "ok",
  active: "ok",
  complete: "ok",
  blocked: "warn",
  question: "warn",
  rejected: "warn",
  paused: "caution",
  proposed: "caution",
  researching: "caution",
  new: "caution",
};
export function Chip({ children, tone }: { children: ReactNode; tone?: string }) {
  const text = typeof children === "string" ? children : "";
  const cls = tone ?? TONE[text] ?? "";
  return <span className={`chip ${cls}`.trim()}>{children}</span>;
}

// "3 min ago", from an ISO time; the exact time is in the element's title and datetime.
export function Ago({ at }: { at: string | null | undefined }) {
  if (!at) return <span className="muted">never</span>;
  const then = Date.parse(at);
  if (Number.isNaN(then)) return <span className="muted">unknown</span>;
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  const text =
    seconds < 60
      ? "just now"
      : seconds < 3600
        ? `${Math.round(seconds / 60)} min ago`
        : seconds < 86_400
          ? `${Math.round(seconds / 3600)} h ago`
          : `${Math.round(seconds / 86_400)} d ago`;
  return (
    <time dateTime={at} title={new Date(then).toUTCString()}>
      {text}
    </time>
  );
}

export const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// A path with ?ok= or ?error=, for an action's redirect.
export function withNotice(path: string, notice: { ok?: string; error?: string }): string {
  const query = new URLSearchParams();
  if (notice.error) query.set("error", notice.error.slice(0, 500));
  else if (notice.ok) query.set("ok", notice.ok.slice(0, 300));
  return `${path}?${query}`;
}
