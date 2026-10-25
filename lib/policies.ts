import type { Team } from "./config.ts";
import { lines, parseShell, type ShellCommand } from "./shell.ts";

// What a team may not do. Two kinds:
// - Policies: outward-facing or irreversible actions, denied by default. An operator unlocks one per team in
//   team.json ("policies": {"deploy": "allow"}); "dependencies" starts allowed and can be denied the same way.
// - Core rules: never unlocked. Secrets, the machine's services, rewritten history, the factory's own controls.
// Each rule is a regex over one simple command as the guard reads it (lib/shell.ts lines(): as written and with
// each wrapper taken off, without its free text) and the reason the agent is told.
// These are a seatbelt for agents that follow instructions, not a sandbox: see CONSTITUTION.md, Part IV.

// A command word in command position: at the start, past any VAR=value assignments and wrappers (env, nohup, time,
// xargs, …), with or without a path (./node_modules/.bin/vercel). Package runners in front of it (npx, pnpm dlx,
// bunx, …) don't hide it. `grep vercel` is not a deploy, and neither is a quoted 'vercel deploy' in a message.
export const START = String.raw`(?:^|[;&|(\x60]|\$\()\s*(?:\w+=\S*\s+)*(?:(?:env|nohup|time|exec|xargs|nice|caffeinate(?:\s+-\w+)*|timeout\s+\S+|(?:ba|z)?sh\s+-\w*c\w*)\s+(?:-\S+\s+)*)*(?:\S*/)?`;
const VIA = String.raw`(?:(?:npx|bunx|pnpm(?:\s+(?:dlx|exec))?|yarn(?:\s+dlx)?|bun(?:\s+x)?|npm\s+exec(?:\s+--)?)\s+(?:-\S+\s+)*(?:\S*/)?)?`;
export const END = String.raw`(?=$|[\s;&|)\x60])`;
// A tool may carry a version (npx vercel@latest).
const AT = String.raw`(?:@[\w.^~<>=-]+)?`;
const word = (alternatives: string): RegExp => new RegExp(`${START}${VIA}(?:${alternatives})${AT}${END}`);
// Options before the subcommand may take a value (supabase --workdir x db push).
const sub = (command: string, subcommands: string): RegExp =>
  new RegExp(`${START}${VIA}(?:${command})${AT}\\s+(?:-\\S+\\s+(?:[^-\\s]\\S*\\s+)?)*(?:${subcommands})${END}`);
const anywhere = (pattern: string): RegExp => new RegExp(pattern);
const ASK = "If the work needs it, the planner asks the operator.";

export type PolicyState = "allow" | "deny";
export interface Policy {
  id: string;
  // Commands the policy must stop: e9g check and the tests prove each one is refused.
  examples: string[];
  default: PolicyState;
  summary: string;
  reason: string;
  rules: RegExp[];
}
// A rule in force: the regex over the guard's reading of a command, what the agent is told, and where it came from.
export interface CommandRule {
  rule: RegExp;
  reason: string;
  source: string;
}

export const POLICIES: Policy[] = [
  {
    id: "deploy",
    examples: [
      "vercel deploy --prod",
      "npx wrangler deploy",
      "pnpm run deploy:prod",
      "cd app && fly deploy",
      "cd app\nvercel deploy --prod",
      "pnpm vercel deploy",
      "npx vercel@latest deploy",
      "npm exec vercel",
      "timeout 600 vercel deploy",
      'sh -c "cd app && vercel deploy"',
      'echo "$(vercel whoami)"',
      "pnpm --filter @app/web exec vercel deploy --prod",
      "pnpm -r run deploy",
      "yarn workspace web deploy",
      "turbo run deploy",
      "sam deploy",
      "/bin/bash -c 'vercel deploy'",
    ],
    default: "deny",
    summary: "deploying: hosting and app-store CLIs, and package scripts named deploy, release or publish",
    reason: `deploys go out from a person, not the team. ${ASK}`,
    rules: [
      word("vercel|fly|flyctl|railway|heroku|surge|eas|sst"),
      sub("netlify", "deploy|link|unlink|sites:\\S*|env:\\S*|api|init"),
      sub("wrangler", "deploy|publish|secret|versions|rollback|delete|r2|d1|kv\\S*|queues|pages\\s+deploy"),
      sub("serverless|sls", "deploy|remove"),
      sub("firebase", "deploy|hosting:\\S*|functions:delete|database:\\S*|firestore:delete"),
      sub("convex", "deploy|dev|run|env|import|export|data|logs"),
      sub("amplify", "publish|push"),
      sub("expo", "publish"),
      sub("cdk", "deploy|destroy"),
      sub("sam", "deploy|delete|sync"),
      anywhere(String.raw`${START}(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:deploy|release|publish|ship)[\w:-]*${END}`),
      // A monorepo's task runner running a deploy task: turbo run deploy, turbo run web#deploy, nx run app:deploy.
      anywhere(String.raw`${START}${VIA}(?:turbo|nx)\s+(?:\S+\s+)*?(?:[\w@/.-]+[#:])?(?:deploy|release|publish|ship)[\w:-]*${END}`),
    ],
  },
  {
    id: "cloud",
    examples: ["aws s3 ls", "terraform apply -auto-approve", "kubectl apply -f k8s/"],
    default: "deny",
    summary: "cloud and infrastructure CLIs (aws, gcloud, az, terraform, pulumi, kubectl, helm, …)",
    reason: `cloud accounts and infrastructure are off limits. ${ASK}`,
    rules: [word("aws|gcloud|gsutil|bq|az|doctl|terraform|tofu|pulumi|kubectl|helm|eksctl|hcloud|linode-cli|vultr-cli")],
  },
  {
    id: "hosted-data",
    examples: [
      "supabase db push",
      "pnpm exec supabase link --project-ref abcdefgh",
      "npx prisma migrate deploy",
      "pnpm supabase db push",
      "npx supabase@latest db push",
      "if true; then supabase db push; fi",
      "npx prisma db push",
      "pnpm drizzle-kit push",
      "e9g lock app -- npx supabase db push",
      "pnpm -C packages/db exec drizzle-kit push",
      "supabase --workdir app db push",
    ],
    default: "deny",
    summary: "hosted databases and data services (linking, pushing, migrating, dumping, project keys)",
    reason: `hosted data is off limits: work against the team's local environment. ${ASK}`,
    rules: [
      sub(
        "supabase",
        "link|unlink|projects|secrets|branches|orgs|functions\\s+deploy|db\\s+(?:push|pull|dump)|config\\s+push|migration\\s+repair|storage"
      ),
      anywhere(String.raw`(?:^|\s)--(?:project-ref|linked)(?=$|[\s=])`),
      sub("prisma", "migrate\\s+deploy|db\\s+push"),
      sub("drizzle-kit", "push"),
      word("pscale|neonctl|turso|atlas|planetscale"),
      anywhere(String.raw`\bmongodb\+srv://`),
    ],
  },
  {
    id: "publish",
    examples: [
      "npm publish",
      "docker push example/app:latest",
      "pnpm -r publish",
      "lerna publish",
      "yarn npm publish",
      "npm -w app publish",
      "docker image push x",
      "docker compose push",
    ],
    default: "deny",
    summary: "publishing packages and images (npm publish, docker push, cargo publish, …)",
    reason: `publishing is done by a person. ${ASK}`,
    rules: [
      anywhere(String.raw`${START}(?:npm|pnpm|yarn|bun)\s+(?:-\S+\s+)*publish${END}`),
      sub("docker|podman|buildah", "push|image\\s+push|compose\\s+(?:-\\S+\\s+(?:[^-\\s]\\S*\\s+)?)*push"),
      sub("docker-compose", "push"),
      sub("lerna", "publish|version"),
      anywhere(String.raw`${START}docker\s+buildx\s+build\b[^;&|]*\s--push${END}`),
      sub("cargo", "publish"),
      sub("twine", "upload"),
      sub("gem", "push"),
      sub("changeset", "publish"),
      sub("vsce|ovsx", "publish"),
      word("goreleaser"),
    ],
  },
  {
    id: "github",
    examples: ["gh workflow run deploy.yml", "gh pr merge 12 --squash", "gh api repos/o/r/actions/secrets"],
    default: "deny",
    summary: "gh beyond issues, labels, search and reading pull requests and runs (no workflows, API, PRs, releases or settings)",
    reason:
      "the team uses gh for issues and labels (gh issue …, gh label …) and reads PRs and runs; workflows, the API, PRs, releases and settings reach hosted systems.",
    // Past gh's global -R/--repo (all of them, as an atomic group: (?=(…))\1), so gh -R owner/app issue list is an
    // issue command.
    rules: [
      anywhere(
        String.raw`${START}gh\s+(?=((?:(?:-R|--repo)\s+\S+\s+|--repo=\S+\s+)*))\1(?!(?:issue|label|search|status)\b|(?:pr|run)\s+(?:view|list|diff|checks)\b|repo\s+view\b)[a-z-]+`
      ),
    ],
  },
  {
    id: "messages",
    examples: ["curl -X POST https://hooks.slack.com/services/T0/B0/x -d hi", "sendmail someone@example.com < note.txt"],
    default: "deny",
    summary: "messaging people from the shell (mail, Slack/Discord webhooks, SMS and email APIs)",
    reason: "the team messages nobody but the operator, and only the planner does, with its email tool.",
    rules: [
      word("sendmail|mail|mailx|mutt|msmtp|swaks"),
      anywhere(
        String.raw`\b(?:hooks\.slack\.com|slack\.com/api|discord(?:app)?\.com/api/webhooks|api\.telegram\.org|api\.twilio\.com|api\.sendgrid\.com|api\.postmarkapp\.com|api\.resend\.com|api\.mailgun\.net)`
      ),
    ],
  },
  {
    id: "payments",
    examples: ["stripe charges create --amount 100"],
    default: "deny",
    summary: "payments: the Stripe CLI and live payment keys",
    reason: `nothing the team does moves money. ${ASK}`,
    rules: [word("stripe"), anywhere(String.raw`\b[rs]k_live_[A-Za-z0-9]`)],
  },
  {
    id: "dependencies",
    examples: ["pnpm add left-pad", "npm install left-pad"],
    default: "allow",
    summary: "adding dependencies (pnpm add, npm install <pkg>, pip install, cargo add, go get)",
    reason: "this team adds no dependencies; build with what the project has.",
    rules: [
      anywhere(String.raw`${START}(?:pnpm|yarn|bun)\s+(?:-\S+\s+)*add\s`),
      anywhere(String.raw`${START}npm\s+(?:i|install|add)\s+(?:-\S+\s+)*[^-\s]`),
      sub("pip|pip3|uv\\s+pip|poetry", "install|add"),
      sub("cargo", "add"),
      sub("go", "get"),
    ],
  },
];

// The factory's own commands, which only a person (or the setup agent, for check, register and start) runs.
export const OPERATOR_COMMANDS = new RegExp(
  `${START}e9g\\s+(?:init|register|sync|upgrade|self-install|watchdog|start|pause|resume|rotate|stop|unregister)${END}`
);

// Never unlocked.
export const CORE: [RegExp, string][] = [
  [/\bgit\s+push\b[^;&|]*(\s--force(-with-lease)?\b|\s-f\b|\s\+\S|\s--mirror\b|\s--delete\b|\s-d\b)/, "no force pushes, mirrors or remote deletes."],
  [/\bgit\s+(filter-branch|filter-repo|replace)\b|\bgit\s+config\s+--(global|system)\b/, "that rewrites history or changes git for everyone."],
  [
    word("launchctl|crontab|t3|sudo|osascript|shutdown|reboot|systemctl"),
    "the machine's services and T3 threads are managed by the watchdog and the planner's tools, not by commands.",
  ],
  [/\bbrew\s+(install|uninstall|upgrade|services)\b|\bdefaults\s+write\b/, "the team doesn't change the machine."],
  [/\b(npm|pnpm|yarn|bun)\s+[^;&|]*\s(-g|--global)\b|\bpnpm\s+add\s+-g\b/, "the team installs nothing globally."],
  [/\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+(-[a-zA-Z]+\s+)*(\/|~|\$HOME|\/Users\/[^/\s]+)\/?(\s|$)/, "that would delete far too much."],
  [
    /(^|[\s'"=/<])\.env(?!(?:\.[\w-]+)*\.(?:example|sample|template)(?=$|[\s'";|&)>]))(\.[A-Za-z0-9_.-]+)?(?=$|[\s'";|&)>])/,
    "env files hold secrets; agents never read or write them. The team's environment has what it needs.",
  ],
  [/\bsecurity\s+(find|dump|export)-|\bgh\s+auth\s+token\b|\.ssh\/id_|\baws\s+configure\s+get\b/, "credentials are never read by the team."],
  [OPERATOR_COMMANDS, "the operator runs the factory's own commands; the team uses merge, verdict, log, lock, gate, env, finish and pages."],
];

// The secret files no agent reads or writes, by the file tools or the shell, as regexes over a path.
export const SECRET_FILES = [
  /(^|\/)\.env(\.[^/]*)?$/,
  /(^|\/)\.envrc$/,
  /(^|\/)\.dev\.vars$/,
  /\.(pem|p12|key)$/,
  /(^|\/)\.ssh\//,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.git-credentials$/,
  /(^|\/)\.aws\/credentials$/,
  /(^|\/)\.config\/gh\/hosts\.ya?ml$/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)[^/]*service[-_]?account[^/]*\.json$/i,
  /(^|\/)\.secrets?(\/|$)/,
  /(^|\/)secrets?\.(json|ya?ml|env|txt)$/,
];
export const SECRET_OK = /(^|\/)\.env(\.[\w-]+)*\.(example|sample|template)$/;
export const isSecretFile = (path: string): boolean => SECRET_FILES.some((rule) => rule.test(path)) && !SECRET_OK.test(path);
// A shell word that names a secret file. A name that's a secret only by its extension (server.key) counts when it
// has a directory or the file exists: in grep -n item.key src/ it's a property.
export const isSecretWord = (word: string, exists: (word: string) => boolean): boolean =>
  isSecretFile(word) && (!/\.(pem|p12|key)$/.test(word) || word.includes("/") || exists(word));

export function policyStates(team: Pick<Team, "policies">): (Policy & { state: PolicyState })[] {
  return POLICIES.map((policy) => ({ ...policy, state: team.policies?.[policy.id] ?? policy.default }));
}

// Commands no policy should stop: check (and the tests) use these to catch a rule that's too broad.
export const ALLOWED_EXAMPLES = [
  "grep -rn vercel docs/",
  "cat sst.config.ts",
  "gh issue list --label e9g --state open",
  "gh pr view 12",
  "pnpm install --frozen-lockfile",
  "git log --oneline -5",
  "npx playwright test e2e/x.spec.ts",
  "echo deploying is off",
];

// The rule a shell command breaks, or null: each of its commands read the way the guard reads them (lib/shell.ts).
export function refusal(team: Team, command: string): CommandRule | null {
  for (const parsed of parseShell(command)) {
    const broken = brokenRule(commandRules(team), parsed);
    if (broken) return broken;
  }
  return null;
}

// The first rule one command breaks. The factory's rules read it without its free text (a commit message that
// mentions vercel deploy deploys nothing); a team's own rules read that text too, as they always have.
export function brokenRule(rules: CommandRule[], command: ShellCommand): CommandRule | null {
  const plain = lines(command);
  const all = [...new Set([...plain, ...lines(command, { withText: true })])];
  return rules.find((rule) => (rule.source === "team" ? all : plain).some((line) => rule.rule.test(line))) ?? null;
}

// Every command rule in force for a team: core, the policies it denies, and its own `never` list.
export function commandRules(team: Team): CommandRule[] {
  const rules: CommandRule[] = CORE.map(([rule, reason]) => ({ rule, reason, source: "core" }));
  for (const policy of policyStates(team)) {
    if (policy.state !== "deny") continue;
    for (const rule of policy.rules) rules.push({ rule, reason: policy.reason, source: `policy ${policy.id}` });
  }
  for (const { rule, reason } of team.never) rules.push({ rule: new RegExp(rule), reason, source: "team" });
  return rules;
}
