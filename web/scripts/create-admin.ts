// npm run create-admin -- --email you@example.com [--name "Your Name"]
// The first admin (or another, or one starting afresh), on the operator's own machine, against the app's database
// (MONGODB_URI, AUTH_DATABASE, BETTER_AUTH_SECRET and BETTER_AUTH_URL, from the environment or web/.env.local).
// It prints the password, the authenticator's setup link and the backup codes once.
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";

const envFile = new URL("../.env.local", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { values } = parseArgs({ options: { email: { type: "string" }, name: { type: "string" }, help: { type: "boolean" } }, strict: true });
if (values.help || !values.email) {
  console.info('usage: npm run create-admin -- --email you@example.com [--name "Your Name"]');
  process.exit(values.help ? 0 : 2);
}

const { createAdmin } = await import("../server/bootstrap.ts");
const { closeMongo } = await import("../server/db.ts");
try {
  const admin = await createAdmin({ email: values.email, name: values.name });
  console.info(
    [
      `${admin.created ? "Made" : "Started afresh"} the admin ${admin.email}.`,
      "",
      `Password: ${admin.password}`,
      "",
      "Add this to your authenticator app (paste it, or make a QR code of it on this machine):",
      `  ${admin.totpURI}`,
      "",
      "Backup codes, each good once (keep them somewhere safe, apart from the password):",
      ...admin.backupCodes.map((code) => `  ${code}`),
      "",
      "Sign in with the password and a code from the authenticator; then add a passkey from your account page if you like.",
      "Every earlier session, passkey and authenticator of this account has ended.",
    ].join("\n")
  );
} catch (error) {
  console.error(`create-admin: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await closeMongo();
}
