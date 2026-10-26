import { basename } from "node:path";
import type { Team } from "./config.ts";
import { lines, NAMES_ONLY, parseShell, type ShellCommand, withoutExcludes } from "./shell.ts";

// What a team may not do. Two kinds:
// - Policies: outward-facing or irreversible actions, denied by default. An operator unlocks one per team in
//   team.json ("policies": {"deploy": "allow"}); "dependencies" starts allowed and can be denied the same way.
// - Core rules: never unlocked. Secrets, the machine's services, rewritten history, the factory's own controls.
// Each rule is a regex over one simple command as the guard reads it (lib/shell.ts lines(): as written and with
// each wrapper taken off, without its free text) and the reason the agent is told. A few are code where a regex
// can't say it well, and the rules for data that reaches outside wherever it's written (a live key) read the free
// text too.
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

// A rule's test over one line: a regex, or code where a regex can't say it well (runsDeployTask, namesEnvFile).
export interface Matcher {
  test(line: string): boolean;
}

export type PolicyState = "allow" | "deny";
export interface Policy {
  id: string;
  // Commands the policy must stop: e9g check and the tests prove each one is refused.
  examples: string[];
  default: PolicyState;
  summary: string;
  reason: string;
  // Over a command without its free text: mostly a command word in command position.
  rules: Matcher[];
  // Over its free text too: data that reaches outside wherever it's written (a live key, a hosted database's address,
  // a webhook), as much in what echo writes or a message says as in a command.
  text?: Matcher[];
}
// A rule in force: its test over the guard's reading of a command, what the agent is told, where it came from, and
// whether it reads free text too (the policies' text rules and a team's own rules do).
export interface CommandRule {
  rule: Matcher;
  reason: string;
  source: string;
  text: boolean;
}

// A deploy task in a monorepo's task runner: turbo run deploy, turbo web#deploy, turbo deploy:prod, nx deploy web,
// nx run web:deploy, nx run-many -t deploy, nx release. Only task positions count, and a name only when it ends
// there or at a separator, so a project, a filter or an option's value that starts with one doesn't (nx test
// shipping-api, turbo run dev --filter publisher-web, turbo run build -- --mode release).
const TASK = /^(?:deploy|release|publish|ship)(?:$|[:#-])/;
const TURBO_VALUED =
  /^(?:-F|--filter|--concurrency|--cache-dir|--cwd|--env-mode|--log-order|--log-prefix|--output-logs|--heap|--profile|--anon-profile|--cache|--api|--team|--token|--login|--remote-cache-timeout|--root-turbo-json|--cache-workers|--global-deps|--env|--pass-through-env|--ui|--scope|--since|--ignore)$/;
const TURBO_COMMANDS =
  /^(?:prune|gen|generate|login|logout|link|unlink|daemon|ls|info|query|telemetry|bin|completion|docs|boundaries|scan|devtools|config|clean|help)$/;
const NX_VALUED = /^(?:-c|--configuration|--base|--head|--files|--output-style|--runner|--parallel|--maxParallel|--max-parallel|--batch)$/;
const NX_COMMANDS =
  /^(?:g|generate|run-many|affected|graph|dep-graph|show|list|add|init|migrate|report|reset|repair|format|format:check|format:write|sync|sync:check|watch|exec|daemon|connect|connect-to-nx-cloud|login|logout|view-logs|import|print-affected|workspace-lint|mcp|configure-ai-agents|register|activate-powerpack|record|start-ci-run|fix-ci)$/;

function turboTasks(args: string[]): string[] {
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (!arg.startsWith("-")) positional.push(arg);
    else if (!arg.includes("=") && TURBO_VALUED.test(arg)) i++;
  }
  const [first, ...rest] = positional;
  const tasks = first === "run" || first === "watch" ? rest : first === undefined || TURBO_COMMANDS.test(first) ? [] : positional;
  return tasks.map((task) => task.slice(task.lastIndexOf("#") + 1));
}

function nxTargets(args: string[]): string[] {
  const targets: string[] = [];
  const positional: string[] = [];
  // Until the next option: nx run-many -t build test -p web api.
  const values = (i: number, into: string[]): number => {
    while (args[i + 1] !== undefined && !(args[i + 1] as string).startsWith("-")) into.push(...(args[++i] as string).split(","));
    return i;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const [option = "", inline] = arg.split(/=(.*)/s, 2);
    if (/^(?:-t|--targets?)$/.test(option)) {
      if (inline === undefined) i = values(i, targets);
      else targets.push(...inline.split(","));
    } else if (/^(?:-p|--projects?|--exclude)$/.test(option)) {
      if (inline === undefined) i = values(i, []);
    } else if (arg.startsWith("-")) {
      if (inline === undefined && NX_VALUED.test(arg)) i++;
    } else positional.push(arg);
  }
  // A target as nx names it: deploy, or web:deploy[:production].
  const target = (spec: string): string => spec.split(":")[spec.includes(":") ? 1 : 0] ?? "";
  const [first = "", second] = positional;
  if (first === "release") return ["release"];
  if (first === "run") return second === undefined ? [] : [target(second)];
  if (first === "" || NX_COMMANDS.test(first)) return targets;
  return [target(first)];
}

const RUNNER = new RegExp(String.raw`${START}${VIA}(turbo|nx)${AT}(?=\s|$)(.*)$`);
export const runsDeployTask: Matcher = {
  test(line: string): boolean {
    const match = RUNNER.exec(line);
    if (!match) return false;
    const args = (match[2] ?? "").split(/\s+/).filter(Boolean);
    const own = args.includes("--") ? args.slice(0, args.indexOf("--")) : args;
    return (match[1] === "turbo" ? turboTasks(own) : nxTargets(own)).some((task) => TASK.test(task));
  },
};

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
      "nx run web:deploy",
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
      // A package script named for one, ending there or at a separator: deploy, deploy:prod, release-notes; not shipping.
      anywhere(String.raw`${START}(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:deploy|release|publish|ship)(?:[:#-][\w:#-]*)?${END}`),
      runsDeployTask,
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
      anywhere(String.raw`(?:^|\s)--linked(?=$|[\s=])`),
      sub("prisma", "migrate\\s+deploy|db\\s+push"),
      sub("drizzle-kit", "push"),
      word("pscale|neonctl|turso|atlas|planetscale"),
    ],
    text: [anywhere(String.raw`(?:^|\s)--project-ref(?=$|[\s=])`), anywhere(String.raw`\bmongodb\+srv://`)],
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
    rules: [word("sendmail|mail|mailx|mutt|msmtp|swaks")],
    text: [
      anywhere(
        String.raw`\b(?:hooks\.slack\.com|slack\.com/api|discord(?:app)?\.com/api/webhooks|api\.telegram\.org|api\.twilio\.com|api\.sendgrid\.com|api\.postmarkapp\.com|api\.resend\.com|api\.mailgun\.net)`
      ),
    ],
  },
  {
    id: "payments",
    examples: ["stripe charges create --amount 100", "echo 'STRIPE_SECRET_KEY=sk_live_abc123' >> /tmp/e9g-check.txt"],
    default: "deny",
    summary: "payments: the Stripe CLI and live payment keys",
    reason: `nothing the team does moves money. ${ASK}`,
    rules: [word("stripe")],
    text: [anywhere(String.raw`\b[rs]k_live_[A-Za-z0-9]`)],
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

// An env file named in a command it reads or writes. Not in what only lists names (ls -la .env*), and not in what
// keeps files out (--exclude=.env*, rg -g '!.env*', git's ':!.env').
const ENV_FILE = /(^|['"=/<])\.env(?!(?:\.[\w-]+)*\.(?:example|sample|template)(?=$|['";|&)>]))(\.[A-Za-z0-9_.-]+)?(?=$|['";|&)>])/;
const namesEnvFile: Matcher = {
  test(line: string): boolean {
    const words = line.split(/\s+/).filter(Boolean);
    return !NAMES_ONLY.test(basename(words[0] ?? "")) && withoutExcludes(words).some((word) => ENV_FILE.test(word));
  },
};

// Never unlocked.
export const CORE: [Matcher, string][] = [
  // git takes an unambiguous start of an option for the whole of it (--mir is --mirror, --del is --delete).
  [
    /\bgit\s+push\b[^;&|]*(\s--force(-with-lease)?\b|\s-f\b|\s\+\S|\s--mi(r(r(or?)?)?)?\b|\s--de(l(e(te?)?)?)?\b|\s-d\b)/,
    "no force pushes, mirrors or remote deletes.",
  ],
  [/\bgit\s+(filter-branch|filter-repo|replace)\b|\bgit\s+config\s+--(global|system)\b/, "that rewrites history or changes git for everyone."],
  [
    word("launchctl|crontab|t3|sudo|osascript|shutdown|reboot|systemctl"),
    "the machine's services and T3 threads are managed by the watchdog and the planner's tools, not by commands.",
  ],
  [/\bbrew\s+(install|uninstall|upgrade|services)\b|\bdefaults\s+write\b/, "the team doesn't change the machine."],
  [/\b(npm|pnpm|yarn|bun)\s+[^;&|]*\s(-g|--global)\b|\bpnpm\s+add\s+-g\b/, "the team installs nothing globally."],
  [/\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+(-[a-zA-Z]+\s+)*(\/|~|\$HOME|\/Users\/[^/\s]+)\/?(\s|$)/, "that would delete far too much."],
  [namesEnvFile, "env files hold secrets; agents never read or write them. The team's environment has what it needs."],
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

// The first rule one command breaks. Most of the factory's rules read it without its free text (a commit message
// that mentions vercel deploy deploys nothing); the rules for data that reaches outside (a live key) and a team's own
// rules read that text too.
export function brokenRule(rules: CommandRule[], command: ShellCommand): CommandRule | null {
  const plain = lines(command);
  const all = [...new Set([...plain, ...lines(command, { withText: true })])];
  return rules.find((rule) => (rule.text ? all : plain).some((line) => rule.rule.test(line))) ?? null;
}

// Every command rule in force for a team: core, the policies it denies, and its own `never` list.
export function commandRules(team: Team): CommandRule[] {
  const rules: CommandRule[] = CORE.map(([rule, reason]) => ({ rule, reason, source: "core", text: false }));
  for (const policy of policyStates(team)) {
    if (policy.state !== "deny") continue;
    for (const rule of policy.rules) rules.push({ rule, reason: policy.reason, source: `policy ${policy.id}`, text: false });
    for (const rule of policy.text ?? []) rules.push({ rule, reason: policy.reason, source: `policy ${policy.id}`, text: true });
  }
  for (const { rule, reason } of team.never) rules.push({ rule: new RegExp(rule), reason, source: "team", text: true });
  return rules;
}
