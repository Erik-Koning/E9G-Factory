// An admin, made on the operator's own machine (npm run create-admin): the account with a new password, and its
// authenticator enrolled at once through Better Auth's own endpoints, so an admin never exists with only a password.
// Run again for the same address, it starts the admin afresh: a new password and authenticator, new backup codes, no
// passkeys and no sessions (for a lost authenticator, or to make an existing person an admin).
import { randomBytes } from "node:crypto";
import { auth } from "./auth.ts";
import { totpCode } from "./totp.ts";

export interface NewAdmin {
  email: string;
  password: string;
  totpURI: string;
  backupCodes: string[];
  created: boolean;
}

export async function createAdmin({ email, name }: { email: string; name?: string | undefined }): Promise<NewAdmin> {
  const address = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new Error(`not an email address: ${email}`);
  const a = auth();
  const context = await a.$context;
  const password = randomBytes(18).toString("base64url");
  const found = await context.internalAdapter.findUserByEmail(address, { includeAccounts: true });
  let userId: string;
  if (!found) {
    const made = await a.api.createUser({
      body: { email: address, password, name: name || address.split("@")[0] || address, role: "admin", data: { emailVerified: true } },
    });
    userId = made.user.id;
  } else {
    userId = found.user.id;
    await context.internalAdapter.updateUser(userId, {
      role: "admin",
      emailVerified: true,
      twoFactorEnabled: false,
      banned: false,
      ...(name ? { name } : {}),
    });
    const hash = await context.password.hash(password);
    if (found.accounts.some((account) => account.providerId === "credential")) await context.internalAdapter.updatePassword(userId, hash);
    else await context.internalAdapter.linkAccount({ userId, providerId: "credential", accountId: userId, password: hash });
    for (const model of ["passkey", "twoFactor"]) await context.adapter.deleteMany({ model, where: [{ field: "userId", value: userId }] });
    await context.internalAdapter.deleteUserSessions(userId);
  }
  // Enrol and confirm the authenticator as the admin, then end the session that did it.
  const signedIn = await a.api.signInEmail({ body: { email: address, password }, returnHeaders: true });
  const cookie = signedIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const as = new Headers({ cookie });
  const enrolled = await a.api.enableTwoFactor({ body: { password }, headers: as });
  if (!("totpURI" in enrolled) || !enrolled.totpURI) throw new Error("the authenticator wasn't enrolled");
  await a.api.verifyTOTP({ body: { code: totpCode(enrolled.totpURI) }, headers: as });
  await context.internalAdapter.deleteUserSessions(userId);
  return { email: address, password, totpURI: enrolled.totpURI, backupCodes: enrolled.backupCodes ?? [], created: !found };
}
