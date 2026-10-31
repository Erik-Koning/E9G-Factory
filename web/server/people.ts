// People: their roles per team (the memberships collection in the accounts database), the stakeholder record each
// has on a team they belong to (in the task graph, by the factory's stakeholderFor, linked by their account's id), and
// the daily limit on their requests. The callers check who may do this (viewer.ts); scripts and tests call it as is.
import type { TeamRole } from "./access.ts";
import { authDb } from "./db.ts";
import { stakeholderOf, unlinkStakeholder } from "./factory.ts";

export interface Membership {
  _id: string;
  userId: string;
  team: string;
  role: TeamRole;
  // What the person is to the team's agents (customer, sales, support…): their stakeholder record's role.
  label: string;
  at: Date;
}

const collection = () => authDb().collection<Membership>("memberships");
const key = (userId: string, team: string): string => `${userId}:${team}`;

export const memberships = (filter: Partial<Pick<Membership, "userId" | "team">> = {}): Promise<Membership[]> =>
  collection().find(filter).sort({ team: 1 }).toArray();

// Puts the person on `team` as `role`, and links their stakeholder record there (made when new).
export async function setMembership(
  person: { userId: string; name: string; email: string },
  team: string,
  role: TeamRole,
  label = "stakeholder"
): Promise<void> {
  await stakeholderOf(team, person, label);
  await collection().updateOne(
    { _id: key(person.userId, team) },
    { $set: { userId: person.userId, team, role }, $setOnInsert: { label, at: new Date() } },
    { upsert: true }
  );
}

export async function changeRole(userId: string, team: string, role: TeamRole): Promise<boolean> {
  return (await collection().updateOne({ _id: key(userId, team) }, { $set: { role } })).matchedCount === 1;
}

export async function removeMembership(userId: string, team: string): Promise<void> {
  await collection().deleteOne({ _id: key(userId, team) });
  await unlinkStakeholder(team, userId);
}

export async function removeAllMemberships(userId: string): Promise<void> {
  for (const m of await memberships({ userId })) await removeMembership(userId, m.team);
}

// --- At most LIMITS.requestsPerDay requests a day per person ------------------------------------------------------

interface DailyCount {
  _id: string;
  n: number;
  expiresAt: Date;
}
let expiryIndexed = false;

// Counts one more request from `userId` today (UTC), atomically; false when that's over `limit`.
export async function takeRequestAllowance(userId: string, limit: number, now = new Date()): Promise<boolean> {
  const counts = authDb().collection<DailyCount>("request_counts");
  if (!expiryIndexed) {
    await counts.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {});
    expiryIndexed = true;
  }
  const day = now.toISOString().slice(0, 10);
  const row = await counts.findOneAndUpdate(
    { _id: `${userId}:${day}` },
    { $inc: { n: 1 }, $setOnInsert: { expiresAt: new Date(Date.parse(day) + 2 * 86_400_000) } },
    { upsert: true, returnDocument: "after" }
  );
  return (row?.n ?? 1) <= limit;
}
