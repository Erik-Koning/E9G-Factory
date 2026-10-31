// The pieces of admins' two-factor sign-in that are pure: whether a passkey verified the person, and the
// authenticator's codes create-admin and the end-to-end tests compute.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isAdminRole, userVerified } from "../../server/auth.ts";
import { totpCode } from "../../server/totp.ts";

// authenticatorData: a 32-byte RP ID hash, a flags byte, a 4-byte counter.
const assertion = (flags: number) => ({
  response: { authenticatorData: Buffer.concat([Buffer.alloc(32, 7), Buffer.from([flags]), Buffer.alloc(4)]).toString("base64url") },
});

test("a passkey counts as a second factor only when the authenticator verified the person (the UV flag)", () => {
  assert.equal(userVerified(assertion(0x05)), true); // user present and verified
  assert.equal(userVerified(assertion(0x45)), true);
  assert.equal(userVerified(assertion(0x01)), false); // present only
  assert.equal(userVerified(assertion(0x00)), false);
  assert.equal(userVerified({ response: { authenticatorData: "AAAA" } }), false); // too short
  assert.equal(userVerified({}), false);
  assert.equal(userVerified(null), false);
  assert.equal(userVerified({ response: { authenticatorData: 42 } }), false);
});

test("the admin role, as Better Auth's admin plugin keeps it", () => {
  assert.equal(isAdminRole("admin"), true);
  assert.equal(isAdminRole("user,admin"), true);
  assert.equal(isAdminRole("user"), false);
  assert.equal(isAdminRole("administrator"), false);
  assert.equal(isAdminRole(null), false);
  assert.equal(isAdminRole(undefined), false);
});

test("authenticator codes match RFC 6238's test vectors", () => {
  // The RFC's SHA-1 secret, "12345678901234567890", in base32.
  const uri = "otpauth://totp/E9G:test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8&period=30";
  assert.equal(totpCode(uri, 59_000), "94287082");
  assert.equal(totpCode(uri, 1_111_111_109_000), "07081804");
  assert.equal(totpCode(uri, 1_234_567_890_000), "89005924");
  assert.equal(totpCode(uri.replace("&digits=8", ""), 59_000), "287082");
  assert.throws(() => totpCode("https://example.com/?secret=AAAA"));
});
