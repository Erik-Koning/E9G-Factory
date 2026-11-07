// Behind the CDN: only requests carrying its secret reach the app, and the settings that make that so are checked.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig } from "../../server/config.ts";
import { deviceOf } from "../../server/device.ts";
import { ORIGIN_HEADER, originAllowed } from "../../server/origin-check.ts";

const SECRET = "s".repeat(40);
const base = {
  MONGODB_URI: "mongodb://localhost:27017/?replicaSet=rs0",
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "https://a6g.example.com",
  NODE_ENV: "production" as const,
  RESEND_API_KEY: "re_test",
};

test("a request reaches the app only with the CDN's secret, when one is set", () => {
  assert.equal(originAllowed(new Headers({ [ORIGIN_HEADER]: SECRET }), SECRET), true);
  assert.equal(originAllowed(new Headers({ [ORIGIN_HEADER]: `${SECRET}x` }), SECRET), false);
  assert.equal(originAllowed(new Headers({ [ORIGIN_HEADER]: "s".repeat(39) }), SECRET), false);
  assert.equal(originAllowed(new Headers(), SECRET), false);
  // Nothing in front (development, tests): every request.
  assert.equal(originAllowed(new Headers(), null), true);
  assert.equal(originAllowed(new Headers(), ""), true);
});

test("served for real, the app needs the CDN's secret, its IP header and email; on this machine, none of them", () => {
  const behind = { ...base, CLIENT_IP_HEADER: "X-A6G-Viewer-IP", ORIGIN_SECRET: SECRET };
  const ok = readConfig({ ...behind, AUDIT_RETENTION_DAYS: "90" });
  assert.deepEqual([ok.ipHeader, ok.originSecret, ok.auditDays, ok.mailLog], ["x-a6g-viewer-ip", SECRET, 90, false]);
  assert.throws(() => readConfig({ ...behind, ORIGIN_SECRET: "" }), /ORIGIN_SECRET/);
  assert.throws(() => readConfig({ ...behind, ORIGIN_SECRET: "short" }), /ORIGIN_SECRET/);
  assert.throws(() => readConfig({ ...behind, CLIENT_IP_HEADER: "" }), /CLIENT_IP_HEADER/);
  assert.throws(() => readConfig({ ...behind, CLIENT_IP_HEADER: "x forwarded" }), /CLIENT_IP_HEADER/);
  assert.throws(() => readConfig({ ...behind, AUDIT_RETENTION_DAYS: "7" }), /AUDIT_RETENTION_DAYS/);
  // No email, no sign-in; and links never go to a log there, whatever MAIL_LOG says.
  assert.throws(() => readConfig({ ...behind, RESEND_API_KEY: "", MAIL_LOG: "1" }), /RESEND_API_KEY, or SES_REGION/);
  // SES, with all three or not at all.
  const ses = readConfig({ ...behind, RESEND_API_KEY: "", SES_REGION: "us-east-2", SES_ACCESS_KEY_ID: "AKIDEXAMPLE", SES_SECRET_ACCESS_KEY: "x" });
  assert.deepEqual([ses.resendKey, ses.ses?.region, ses.mailLog], [null, "us-east-2", false]);
  assert.throws(() => readConfig({ ...behind, SES_REGION: "us-east-2" }), /all three/);
  // This machine (development, the end-to-end tests): links to the console, nothing in front required.
  const local = readConfig({ ...base, NODE_ENV: "production", BETTER_AUTH_URL: "http://localhost:3100", RESEND_API_KEY: "", MAIL_LOG: "1" });
  assert.deepEqual([local.mailLog, local.originSecret, local.ipHeader], [true, null, "x-forwarded-for"]);
  assert.equal(readConfig({ ...base, NODE_ENV: "development", BETTER_AUTH_URL: "http://localhost:3000", RESEND_API_KEY: "" }).mailLog, true);
});

test("a device reads as its browser and system", () => {
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
  assert.equal(deviceOf(mac), "Safari on macOS");
  assert.equal(deviceOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile Safari/604.1"), "Safari on iOS");
  assert.equal(deviceOf(null), "Unknown device");
});
