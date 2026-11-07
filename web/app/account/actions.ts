"use server";
// One's own account: sessions (ended by id, so session tokens never reach the page), the IP addresses one has
// confirmed, and an authenticator for anyone who isn't an admin (an admin's comes from create-admin and stays on).
import { redirect } from "next/navigation";
import QRCode from "qrcode";
import { withNotice } from "../../components/ui.tsx";
import { pendingStep } from "../../server/access.ts";
import { auth } from "../../server/auth.ts";
import { forgetIp } from "../../server/known-ips.ts";
import { checkCode } from "../../server/step-up.ts";
import { authHeaders as headers, getViewer, record, STEP_PAGE } from "../../server/viewer.ts";

const BACK = "/account";

async function self() {
  const viewer = await getViewer();
  if (!viewer) redirect("/sign-in");
  const step = pendingStep(viewer);
  if (step) redirect(STEP_PAGE[step]);
  return viewer;
}

export async function revokeSessionAction(form: FormData): Promise<void> {
  const viewer = await self();
  const id = form.get("id");
  const sessions = await auth().api.listSessions({ headers: await headers() });
  const target = sessions.find((s) => s.id === id);
  if (!target) redirect(withNotice(BACK, { error: "That session has ended already." }));
  if (target.id === viewer.sessionId) redirect(withNotice(BACK, { error: "That's this session: sign out instead." }));
  await auth().api.revokeSession({ body: { token: target.token }, headers: await headers() });
  redirect(withNotice(BACK, { ok: "That session has ended." }));
}

export async function revokeOtherSessionsAction(): Promise<void> {
  await self();
  await auth().api.revokeOtherSessions({ headers: await headers() });
  redirect(withNotice(BACK, { ok: "Every other session has ended." }));
}

// Forgets a confirmed address: the next session from it asks by email again. Not the one this request comes from.
export async function forgetIpAction(form: FormData): Promise<void> {
  const viewer = await self();
  const ip = String(form.get("ip") ?? "");
  if (ip === viewer.ip) redirect(withNotice(BACK, { error: "That's the address you're using now." }));
  if (!(await forgetIp(viewer.userId, ip))) redirect(withNotice(BACK, { error: "That address isn't on your list." }));
  await record(viewer, { action: "ip.forgotten", outcome: "ok", target: ip });
  redirect(withNotice(BACK, { ok: `${ip} is forgotten: a sign-in from it will ask by email again.` }));
}

export interface AuthenticatorState {
  stage: "idle" | "scan" | "done";
  error: string | null;
  // While scanning: the QR code (an SVG made here), the key to type instead, and the backup codes to show once it's on.
  qr: string | null;
  key: string | null;
  backupCodes: string[];
}

// A QR code for an authenticator's key: an SVG made here, never one a browser sent back.
const BASE32 = /^[A-Z2-7]{16,128}=*$/;
async function qrFor(key: string, email: string): Promise<string | null> {
  if (!BASE32.test(key)) return null;
  const uri = `otpauth://totp/${encodeURIComponent(`Anything Factory:${email}`)}?secret=${key}&issuer=Anything%20Factory`;
  return QRCode.toString(uri, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
}
const codesOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((c): c is string => typeof c === "string" && /^[\w-]{4,40}$/.test(c)).slice(0, 20) : [];

// Turning on an authenticator, in two steps: "start" makes its secret (Better Auth, unconfirmed until a code proves the
// app has it), "confirm" checks a code from the app, which turns it on.
export async function authenticatorAction(previous: AuthenticatorState, form: FormData): Promise<AuthenticatorState> {
  const viewer = await self();
  const idle: AuthenticatorState = { stage: "idle", error: null, qr: null, key: null, backupCodes: [] };
  if (viewer.admin) return { ...idle, error: "An admin's authenticator comes from create-admin." };
  if (viewer.twoFactor) return { ...idle, stage: "done" };
  const requestHeaders = await headers();
  if (form.get("step") === "start") {
    const made = await auth().api.enableTwoFactor({ body: {}, headers: requestHeaders });
    if (!("totpURI" in made) || !made.totpURI) return { ...idle, error: "The authenticator couldn't be set up; try again." };
    const qr = await QRCode.toString(made.totpURI, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    return { stage: "scan", error: null, qr, key: new URL(made.totpURI).searchParams.get("secret"), backupCodes: made.backupCodes ?? [] };
  }
  // What came back from the browser is only redrawn: the key as a QR code made here, the codes as text.
  const key = typeof previous.key === "string" ? previous.key : "";
  const scanning: AuthenticatorState = { stage: "scan", error: null, qr: await qrFor(key, viewer.email), key, backupCodes: codesOf(previous.backupCodes) };
  const wrong = await checkCode(viewer.userId, String(form.get("code") ?? "").replace(/\s+/g, ""), requestHeaders);
  if (wrong) return { ...scanning, error: wrong };
  await record(viewer, { action: "authenticator.on", outcome: "ok" });
  return { stage: "done", error: null, qr: null, key: null, backupCodes: scanning.backupCodes };
}

// Turning it off takes a code from it, so a session left open somewhere can't quietly remove it.
export async function turnOffAuthenticatorAction(form: FormData): Promise<void> {
  const viewer = await self();
  if (viewer.admin) redirect(withNotice(BACK, { error: "An admin's authenticator stays on." }));
  const requestHeaders = await headers();
  const wrong = await checkCode(viewer.userId, String(form.get("code") ?? "").replace(/\s+/g, ""), requestHeaders);
  if (wrong) {
    await record(viewer, { action: "authenticator.off", outcome: "failed", detail: wrong });
    redirect(withNotice(BACK, { error: `${wrong} The authenticator is still on.` }));
  }
  await auth().api.disableTwoFactor({ body: {}, headers: requestHeaders });
  await record(viewer, { action: "authenticator.off", outcome: "ok" });
  redirect(withNotice(BACK, { ok: "The authenticator is off. Sign-ins need only your passkey or an email link again." }));
}

export interface BackupCodesState {
  error: string | null;
  codes: string[];
}

// New backup codes, the old ones void: a current code first (and an admin's password, which Better Auth asks of anyone
// who has one), so a stolen session can't mint a way back in.
export async function backupCodesAction(_previous: BackupCodesState, form: FormData): Promise<BackupCodesState> {
  const viewer = await self();
  if (!viewer.twoFactor) return { error: "Turn on an authenticator first.", codes: [] };
  const requestHeaders = await headers();
  const wrong = await checkCode(viewer.userId, String(form.get("code") ?? "").replace(/\s+/g, ""), requestHeaders);
  if (wrong) return { error: wrong, codes: [] };
  const password = String(form.get("password") ?? "");
  try {
    const made = await auth().api.generateBackupCodes({ body: viewer.admin ? { password } : {}, headers: requestHeaders });
    await record(viewer, { action: "backup-codes.new", outcome: "ok" });
    return { error: null, codes: made.backupCodes };
  } catch {
    await record(viewer, { action: "backup-codes.new", outcome: "failed", detail: "password" });
    return { error: "That password isn't right.", codes: [] };
  }
}
