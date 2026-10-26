import "./helpers.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { normalize, type RawTeam, type Team } from "../lib/config.ts";
import { ALLOWED_EXAMPLES, commandRules, isSecretFile, POLICIES, policyStates, refusal } from "../lib/policies.ts";

const team = (raw: RawTeam = {}): Team => normalize({ name: "fixture", branch: "e9g/next", ...raw }, "").team;
const refused = (t: Team, command: string) => refusal(t, command);

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
    assert.equal(policyStates(t).find((p) => p.id === "deploy")?.state, "allow");
    for (const example of POLICIES.find((p) => p.id === "deploy")?.examples ?? []) assert.equal(refused(t, example), null, example);
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
    assert.equal(refused(t, "make release")?.reason, "releases are the operator's");
    assert.equal(refused(t, "pnpm db:reset")?.source, "team");
  });

  test("the rules for data that reaches outside read free text; command words don't", () => {
    const t = team();
    for (const command of [
      "echo 'STRIPE_SECRET_KEY=sk_live_abc123' >> src/config.ts",
      'gh issue comment 3 --body "key is rk_live_abc123"',
      'git commit -m "use mongodb+srv://u:p@cluster0.x.net"',
      "printf 'curl https://hooks.slack.com/services/T0/B0/x'",
    ])
      assert.ok(refused(t, command), command);
    for (const command of [
      'git commit -m "run vercel deploy and supabase db push by hand"',
      "echo stripe is off",
      'gh issue create --title "npm publish"',
    ])
      assert.equal(refused(t, command), null, command);
    const rules = commandRules(team({ never: [["\\bmake\\s+release\\b", "the operator's"]] }));
    assert.ok(rules.filter((rule) => rule.source === "core").every((rule) => !rule.text));
    assert.ok(rules.filter((rule) => rule.source === "team").every((rule) => rule.text));
    assert.deepEqual(
      rules.filter((rule) => rule.source === "policy payments").map((rule) => rule.text),
      [false, true]
    );
  });

  test("a task runner's deploy task, in task positions only", () => {
    const t = team();
    for (const command of ["turbo run deploy", "nx deploy web", "nx run web:deploy", "nx run-many -t deploy", "turbo run build web#publish"])
      assert.ok(refused(t, command), command);
    for (const command of [
      "nx test shipping-api",
      "turbo run dev --filter publisher-web",
      "pnpm nx g @nx/js:lib release-utils",
      "turbo prune web --docker",
    ])
      assert.equal(refused(t, command), null, command);
  });

  test("env files: what lists names or keeps them out reads none", () => {
    const t = team();
    for (const command of [
      "ls -la .env.local",
      "test -f .env",
      "tar --exclude=.env.local -czf /tmp/x.tgz .",
      "rg -g '!.env.local' X",
      "git diff -- . ':!.env'",
    ])
      assert.equal(refused(t, command), null, command);
    for (const command of ["cat .env.local", "source .env", "node --env-file=.env.local x.js", "tar -czf /tmp/x.tgz .env.local"])
      assert.ok(refused(t, command), command);
  });

  test("secret files", () => {
    for (const path of [".env", "app/.env.local", "certs/key.pem", "/Users/x/.ssh/id_ed25519", ".npmrc", "config/secrets.json", ".secrets/a", ".dev.vars"])
      assert.ok(isSecretFile(path), path);
    for (const path of [".env.example", "app/.env.sample", ".env.local.example", "src/env.ts", "docs/environment.md", "src/lib/secrets/index.ts"])
      assert.ok(!isSecretFile(path), path);
  });
});
