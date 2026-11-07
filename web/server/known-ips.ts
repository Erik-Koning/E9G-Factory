// The IP addresses each person has confirmed they use. A session used from any other address can do nothing until the
// person confirms it from their email: a link to a page that asks "was this you?". Yes remembers the address; "it
// wasn't me" ends every session they have. Signing in by an email link confirms the address it's opened from at once,
// since opening it already proves the inbox.
//
// An address is as Better Auth reads it from the CDN's viewer-IP header (auth.ts clientIp): an IPv4 address whole, an
// IPv6 one by its /64, the block one connection's addresses rotate within.
import { createHash, randomBytes } from "node:crypto";
import { audit } from "./audit.ts";
import { config } from "./config.ts";
import { authDb } from "./db.ts";
import { deviceOf } from "./device.ts";
import { sendMail } from "./mail.ts";

export type KnownVia = "email link" | "confirmed by email" | "invitation";
interface KnownIp {
  _id: string;
  userId: string;
  ip: string;
  via: KnownVia;
  confirmedAt: Date;
  lastSeenAt: Date;
}
interface Challenge {
  _id: string;
  userId: string;
  email: string;
  ip: string;
  userAgent: string | null;
  createdAt: Date;
  expiresAt: Date;
  answeredAt: Date | null;
  answer: "confirmed" | "denied" | null;
}

// A confirmation link works once, for 30 minutes; a new one goes out at most every 10 minutes per address.
const LINK_MINUTES = 30;
const RESEND_MINUTES = 10;
// Where an address can't be read (it never happens behind the CDN), it's this, which is never remembered.
export const UNKNOWN_IP = "unknown";

const known = () => authDb().collection<KnownIp>("known_ips");
const challenges = () => authDb().collection<Challenge>("ip_challenges");
const key = (userId: string, ip: string) => `${userId}|${ip}`;
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

let indexed: Promise<unknown> | null = null;
export function ensureIndexes(): Promise<unknown> {
  indexed ??= Promise.all([
    known().createIndex({ userId: 1, lastSeenAt: -1 }),
    challenges().createIndex({ userId: 1, ip: 1, createdAt: -1 }),
    challenges().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 7 * 86_400 }),
  ]).catch(() => {});
  return indexed;
}

// Every request asks, so it's one read: seeing the address again is noted at most hourly, without waiting for it.
export async function isKnownIp(userId: string, ip: string | null): Promise<boolean> {
  if (!ip || ip === UNKNOWN_IP) return false;
  void ensureIndexes();
  const found = await known().findOne({ _id: key(userId, ip) }, { projection: { lastSeenAt: 1 } });
  if (!found) return false;
  if (found.lastSeenAt.getTime() < Date.now() - 3_600_000)
    void known()
      .updateOne({ _id: key(userId, ip) }, { $set: { lastSeenAt: new Date() } })
      .catch(() => {});
  return true;
}

export async function rememberIp(userId: string, ip: string | null, via: KnownVia): Promise<void> {
  if (!ip || ip === UNKNOWN_IP) return;
  const now = new Date();
  await known().updateOne({ _id: key(userId, ip) }, { $set: { lastSeenAt: now }, $setOnInsert: { userId, ip, via, confirmedAt: now } }, { upsert: true });
}

export async function knownIps(userId: string): Promise<{ ip: string; via: KnownVia; confirmedAt: Date; lastSeenAt: Date }[]> {
  const rows = await known().find({ userId }).sort({ lastSeenAt: -1 }).limit(50).toArray();
  return rows.map(({ ip, via, confirmedAt, lastSeenAt }) => ({ ip, via, confirmedAt, lastSeenAt }));
}

export async function forgetIp(userId: string, ip: string): Promise<boolean> {
  return (await known().deleteOne({ _id: key(userId, ip) })).deletedCount === 1;
}

// Asks `email` to confirm a session from `ip`, unless a link for that address went out in the last ten minutes.
export async function challenge({
  userId,
  email,
  ip,
  userAgent,
  sessionId,
}: {
  userId: string;
  email: string;
  ip: string | null;
  userAgent: string | null;
  sessionId?: string | null;
}): Promise<"sent" | "recent"> {
  void ensureIndexes();
  const address = ip || UNKNOWN_IP;
  const now = new Date();
  const recent = await challenges().countDocuments(
    { userId, ip: address, answeredAt: null, createdAt: { $gt: new Date(now.getTime() - RESEND_MINUTES * 60_000) } },
    { limit: 1 }
  );
  if (recent) return "recent";
  const token = randomBytes(32).toString("base64url");
  await challenges().insertOne({
    _id: hash(token),
    userId,
    email,
    ip: address,
    userAgent,
    createdAt: now,
    expiresAt: new Date(now.getTime() + LINK_MINUTES * 60_000),
    answeredAt: null,
    answer: null,
  });
  const link = `${config().baseURL}/sign-in/confirm?token=${token}`;
  const where = address === UNKNOWN_IP ? "an IP address we couldn't read" : `the IP address ${address}`;
  await sendMail({
    to: email,
    subject: "Confirm it's you signing in to Anything Factory",
    text: [
      `Someone signed in to your Anything Factory account from ${where}, on ${deviceOf(userAgent)}, at ${now.toUTCString()}.`,
      `If it was you, open this link within ${LINK_MINUTES} minutes and confirm it: ${link}`,
      "If it wasn't you, open the link and choose “It wasn't me”: every session on your account ends at once. Then tell the operator.",
    ].join("\n\n"),
    link,
  });
  await audit({ action: "ip.challenged", outcome: "ok", userId, email, ip: address, userAgent, sessionId: sessionId ?? null });
  return "sent";
}

export interface OpenChallenge {
  userId: string;
  email: string;
  ip: string;
  userAgent: string | null;
  createdAt: Date;
}

// The challenge a link's token names, while it can still be answered.
export async function readChallenge(token: string): Promise<OpenChallenge | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const found = await challenges().findOne({ _id: hash(token), answeredAt: null, expiresAt: { $gt: new Date() } });
  return found ? { userId: found.userId, email: found.email, ip: found.ip, userAgent: found.userAgent, createdAt: found.createdAt } : null;
}

// Answers a challenge once: "confirmed" remembers the address; "denied" ends every session the person has. Returns
// what it answered, or null when the link was used, expired or never was. `from` is where the answer came from.
export async function answerChallenge(
  token: string,
  answer: "confirmed" | "denied",
  from: { ip: string | null; userAgent: string | null }
): Promise<OpenChallenge | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const now = new Date();
  const taken = await challenges().findOneAndUpdate(
    { _id: hash(token), answeredAt: null, expiresAt: { $gt: now } },
    { $set: { answeredAt: now, answer } },
    { returnDocument: "after" }
  );
  if (!taken) return null;
  if (answer === "confirmed") {
    await rememberIp(taken.userId, taken.ip, "confirmed by email");
  } else {
    // Lazily, as auth.ts imports this module.
    const { auth } = await import("./auth.ts");
    await (await auth().$context).internalAdapter.deleteUserSessions(taken.userId);
  }
  await audit({
    action: answer === "confirmed" ? "ip.confirmed" : "ip.denied",
    outcome: "ok",
    userId: taken.userId,
    email: taken.email,
    // The address the answer is about; where it was answered from is in the detail.
    ip: taken.ip,
    userAgent: taken.userAgent,
    detail: `answered from ${from.ip ?? UNKNOWN_IP} on ${deviceOf(from.userAgent)}${answer === "denied" ? "; every session ended" : ""}`,
  });
  return { userId: taken.userId, email: taken.email, ip: taken.ip, userAgent: taken.userAgent, createdAt: taken.createdAt };
}
