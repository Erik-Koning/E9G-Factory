// This machine's MongoDB connection string, kept in the Keychain by `a6g connect mongo`; agents never see it. The
// connection string holds its password and characters the Keychain item's text can't take as it is, so it's kept
// base64url-encoded.
import { forgetSecret, hasSecret, readSecret, storeSecret } from "../keychain.ts";

export const MONGO_SERVICE = "a6g-mongo";
export const MONGO_ACCOUNT = "uri";
export const storeUri = (uri: string): boolean =>
  storeSecret(MONGO_SERVICE, MONGO_ACCOUNT, "Anything Factory: MongoDB", Buffer.from(uri).toString("base64url"));
export function readUri(): string | null {
  const stored = readSecret(MONGO_SERVICE, MONGO_ACCOUNT);
  return stored ? Buffer.from(stored, "base64url").toString("utf8") : null;
}
export const hasUri = (): boolean => hasSecret(MONGO_SERVICE, MONGO_ACCOUNT);
export const forgetUri = (): void => forgetSecret(MONGO_SERVICE, MONGO_ACCOUNT);
