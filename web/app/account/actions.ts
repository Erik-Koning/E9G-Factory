"use server";
// One's own sessions: ended by id, so session tokens never reach the page.
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { withNotice } from "../../components/ui.tsx";
import { blockedAdmin } from "../../server/access.ts";
import { auth } from "../../server/auth.ts";
import { getViewer } from "../../server/viewer.ts";

const BACK = "/account";

async function self() {
  const viewer = await getViewer();
  if (!viewer) redirect("/sign-in");
  if (blockedAdmin(viewer)) redirect("/second-factor");
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
