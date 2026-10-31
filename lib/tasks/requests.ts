// Stakeholders' feature requests, as the factory's commands and its web app both take them in: who a request is from
// is a stakeholder id; names and email addresses stay on the stakeholder (Article 8). Free of the CLI, so the web app
// runs the same code.
import { createHash } from "node:crypto";
import { type FeatureRequest, nowIso, type Stakeholder } from "./model.ts";
import type { Store } from "./store.ts";

// A stakeholder's link key, as kept: the hash, never the key itself.
export const keyHash = (key: string): string => createHash("sha256").update(key).digest("hex");

// A stakeholder by email, made when new: the same person's requests share one id.
export async function stakeholderFor(
  store: Store,
  team: string,
  { name, email, role }: { name: string; email: string; role: string }
): Promise<Stakeholder> {
  const known = (await store.stakeholders.all()).find((s) => s.email.toLowerCase() === email.toLowerCase());
  if (known) return known;
  return store.stakeholders.create({ team, name, email, role, createdAt: nowIso() });
}

// A request as the agents see it: the stakeholder's id and role, nothing that names them.
export async function forAgents(store: Store, request: FeatureRequest): Promise<FeatureRequest & { fromRole: string | null }> {
  const from = request.from ? await store.stakeholders.get(request.from) : null;
  return { ...request, fromRole: from?.role ?? null };
}

export async function addRequest(
  store: Store,
  team: string,
  { title, body, from, by }: { title: string; body: string; from: string | null; by: string }
): Promise<FeatureRequest> {
  const at = nowIso();
  return store.requests.create({
    team,
    title,
    body,
    from,
    status: "new",
    tasks: [],
    notes: [],
    createdAt: at,
    updatedAt: at,
    history: [{ at, by, what: "requested" }],
  });
}
