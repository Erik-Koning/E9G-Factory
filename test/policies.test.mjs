import "./helpers.mjs";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { normalize } from "../lib/config.mjs";
import { ALLOWED_EXAMPLES, isSecretFile, POLICIES, policyStates, refusal } from "../lib/policies.mjs";

const team = (raw = {}) => normalize({ name: "fixture", branch: "e9g/next", ...raw }).team;
const refused = (t, command) => refusal(t, command);

describe("policies", () => {
  test("every policy's examples are refused when it's denied", () => {
    const all = team({ policies: Object.fromEntries(POLICIES.map((p) => [p.id, "deny"])) });
    for (const policy of POLICIES) for (const example of policy.examples) assert.ok(refused(all, example), `${policy.id}: ${example}`);
  });

  test("ordinary commands pass even with every policy denied", () => {
    const all = team({ policies: Object.fromEntries(POLICIES.map((p) => [p.id, "deny"])) });
    for (const example of ALLOWED_EXAMPLES) assert.equal(refused(all, example), null, example);
  });

  test("commands match only in command position", () => {
    const t = team();
    for (const command of ["grep vercel package.json", "cat sst.config.ts", "rg -n stripe src/", "git log --grep terraform"])
      assert.equal(refused(t, command), null, command);
    for (const command of [
      "cd app && vercel deploy",
      "./node_modules/.bin/vercel --prod",
      "npx wrangler deploy",
      'sh -c "vercel deploy"',
      "FOO=1 vercel",
      "pnpm dlx vercel",
      "nohup terraform apply",
    ])
      assert.ok(refused(t, command), command);
  });

  test("an unlocked policy no longer refuses its examples", () => {
    const t = team({ policies: { deploy: "allow" } });
    assert.equal(policyStates(t).find((p) => p.id === "deploy").state, "allow");
    for (const example of POLICIES.find((p) => p.id === "deploy").examples) assert.equal(refused(t, example), null, example);
    assert.ok(refused(t, "terraform apply"), "other policies still apply");
  });

  test("dependencies start allowed and can be denied", () => {
    assert.equal(refused(team(), "pnpm add left-pad"), null);
    assert.ok(refused(team({ policies: { dependencies: "deny" } }), "pnpm add left-pad"));
    assert.equal(refused(team({ policies: { dependencies: "deny" } }), "pnpm install --frozen-lockfile"), null);
  });

  test("core rules always apply", () => {
    const t = team({ policies: Object.fromEntries(POLICIES.map((p) => [p.id, "allow"])) });
    for (const command of [
      "git push --force origin x",
      "git filter-branch",
      "launchctl list",
      "t3 thread list",
      "cat .env.local",
      "sudo rm x",
      "e9g register",
      "rm -rf ~",
      "npm i -g pnpm",
    ])
      assert.ok(refused(t, command), command);
    assert.equal(refused(t, "cat .env.example"), null);
  });

  test("a team's never rules come with their reasons", () => {
    const t = team({ never: [["\\bmake\\s+release\\b", "releases are the operator's"], { rule: "\\bdb:reset\\b", reason: "the shared database" }] });
    assert.equal(refused(t, "make release").reason, "releases are the operator's");
    assert.equal(refused(t, "pnpm db:reset").source, "team");
  });

  test("secret files", () => {
    for (const path of [".env", "app/.env.local", "certs/key.pem", "/Users/x/.ssh/id_ed25519", ".npmrc", "config/secrets.json", ".secrets/a", ".dev.vars"])
      assert.ok(isSecretFile(path), path);
    for (const path of [".env.example", "app/.env.sample", ".env.local.example", "src/env.ts", "docs/environment.md", "src/lib/secrets/index.ts"])
      assert.ok(!isSecretFile(path), path);
  });
});
