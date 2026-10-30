// What e9g init can learn about a repository without asking: its git setup, package manager and scripts, what CI
// runs, how it can reach outside the machine (deploy targets, hosted data, publishing), its tests and UI, and the
// agent configuration it already has. The setup agent starts from this, so the operator is asked only the rest.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RawTeam, RoleSettings } from "./config.ts";
import { PACKAGE } from "./paths.ts";
import { gitOk, git as gitRaw } from "./util.ts";

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  workspaces?: unknown;
  engines?: Record<string, string>;
}
interface Surface {
  id: string;
  policy: string;
  files: string[];
  deps?: string[];
  note: string;
}
export interface Workflow {
  file: string;
  name: string;
  runs: string[];
  outward: boolean;
  manual: boolean;
}
export type Detected = ReturnType<typeof detect>;

const git = (cwd: string, ...args: string[]): string | null => {
  try {
    return gitRaw(cwd, ...args);
  } catch {
    return null;
  }
};
const has = (root: string, ...paths: string[]): boolean => paths.some((path) => existsSync(join(root, path)));
const readText = (path: string): string => (existsSync(path) && statSync(path).isFile() ? readFileSync(path, "utf8") : "");
const json = (path: string): PackageJson | null => {
  try {
    return JSON.parse(readText(path)) as PackageJson;
  } catch {
    return null;
  }
};

// Where the repository can reach outside the machine, and the policy each falls under.
const SURFACES: Surface[] = [
  {
    id: "vercel",
    policy: "deploy",
    files: ["vercel.json", "vercel.ts", ".vercel/project.json"],
    note: "Vercel: with its Git integration, every pushed branch deploys a preview",
  },
  { id: "netlify", policy: "deploy", files: ["netlify.toml"], note: "Netlify: pushes deploy previews" },
  { id: "fly", policy: "deploy", files: ["fly.toml"], note: "Fly.io" },
  { id: "cloudflare", policy: "deploy", files: ["wrangler.toml", "wrangler.json", "wrangler.jsonc"], note: "Cloudflare Workers/Pages" },
  { id: "sst", policy: "deploy", files: ["sst.config.ts", "sst.config.js"], note: "SST (AWS): even sst dev deploys a stage" },
  { id: "serverless", policy: "deploy", files: ["serverless.yml", "serverless.ts"], note: "Serverless Framework" },
  { id: "firebase", policy: "deploy", files: ["firebase.json"], note: "Firebase" },
  { id: "amplify", policy: "deploy", files: ["amplify.yml", "amplify"], note: "AWS Amplify" },
  { id: "expo", policy: "deploy", files: ["eas.json"], note: "Expo EAS builds and updates" },
  { id: "heroku", policy: "deploy", files: ["Procfile", "app.json"], note: "Heroku (Procfile or app.json)" },
  { id: "railway", policy: "deploy", files: ["railway.json", "railway.toml"], note: "Railway" },
  { id: "render", policy: "deploy", files: ["render.yaml"], note: "Render" },
  { id: "convex", policy: "deploy", files: ["convex"], note: "Convex: convex dev pushes to a cloud deployment" },
  { id: "docker", policy: "publish", files: ["Dockerfile", "docker-compose.yml", "compose.yaml"], note: "Docker images (docker push publishes)" },
  { id: "terraform", policy: "cloud", files: ["main.tf", "terraform", "infra"], note: "Terraform or infrastructure code" },
  { id: "pulumi", policy: "cloud", files: ["Pulumi.yaml"], note: "Pulumi" },
  { id: "kubernetes", policy: "cloud", files: ["k8s", "helm", "charts", "kustomization.yaml"], note: "Kubernetes / Helm" },
  { id: "supabase", policy: "hosted-data", files: ["supabase/config.toml"], note: "Supabase: link, db push and config push reach hosted projects" },
  { id: "prisma", policy: "hosted-data", files: ["prisma/schema.prisma"], note: "Prisma: migrate deploy reaches whatever DATABASE_URL names" },
  { id: "drizzle", policy: "hosted-data", files: ["drizzle.config.ts", "drizzle.config.js"], note: "Drizzle: push reaches whatever database it's given" },
  { id: "stripe", policy: "payments", files: [], deps: ["stripe", "@stripe/stripe-js"], note: "Stripe" },
  {
    id: "email",
    policy: "messages",
    files: [],
    deps: ["resend", "@sendgrid/mail", "nodemailer", "postmark", "mailgun.js", "twilio"],
    note: "Email or SMS providers",
  },
];

function workflows(root: string): Workflow[] {
  const dir = join(root, ".github", "workflows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => {
      const text = readText(join(dir, name));
      const runs = [...text.matchAll(/^\s*(?:-\s*)?run:\s*(?:\|\s*\n((?:\s{6,}.+\n?)+)|(.+))$/gm)]
        .map((match) => (match[1] ?? match[2] ?? "").trim())
        .flatMap((block) => block.split("\n").map((line) => line.trim()))
        .filter(Boolean);
      const triggers = /\bon:\s*([\s\S]*?)\n\w/.exec(text)?.[1] ?? "";
      return {
        file: `.github/workflows/${name}`,
        name: /^name:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? name,
        runs,
        outward: /\b(deploy|release|publish|migrat|production|vercel|netlify|fly|wrangler|supabase\s+(db|link)|docker\s+push|npm\s+publish)/i.test(text),
        manual: /workflow_dispatch/.test(triggers) || /workflow_dispatch/.test(text),
      };
    });
}

// "never …", "don't …", "do not …" lines in the repository's own agent docs: candidate team rules.
function prohibitions(root: string): { file: string; line: string }[] {
  const lines: { file: string; line: string }[] = [];
  for (const file of ["CLAUDE.md", "AGENTS.md", ".github/copilot-instructions.md"]) {
    const text = readText(join(root, file));
    for (const line of text.split("\n")) if (/\b(never|don't|do not|must not)\b/i.test(line) && line.length < 400) lines.push({ file, line: line.trim() });
  }
  return lines.slice(0, 60);
}

export function detect(root: string) {
  const pkg = json(join(root, "package.json")) ?? {};
  const deps: Record<string, string> = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  // A monorepo's packages declare their own dependencies; read the first level of the usual folders.
  for (const folder of ["packages", "apps"]) {
    const dir = join(root, folder);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const child = json(join(dir, name, "package.json"));
      if (child) Object.assign(deps, child.dependencies ?? {}, child.devDependencies ?? {});
    }
  }
  const packageManager = has(root, "pnpm-lock.yaml")
    ? "pnpm"
    : has(root, "bun.lockb", "bun.lock")
      ? "bun"
      : has(root, "yarn.lock")
        ? "yarn"
        : has(root, "package-lock.json")
          ? "npm"
          : has(root, "pyproject.toml", "requirements.txt")
            ? "python"
            : has(root, "Cargo.toml")
              ? "cargo"
              : has(root, "go.mod")
                ? "go"
                : null;
  const installCommands: Record<string, string | null> = {
    pnpm: "pnpm install --frozen-lockfile --prefer-offline",
    bun: "bun install --frozen-lockfile",
    yarn: "yarn install --frozen-lockfile",
    npm: "npm ci",
    python: null,
    cargo: null,
    go: null,
  };
  const installCommand = packageManager ? (installCommands[packageManager] ?? null) : null;
  const origin = git(root, "remote", "get-url", "origin");
  const surfaces = SURFACES.filter((surface) => has(root, ...surface.files) || (surface.deps ?? []).some((dep) => dep in deps)).map(
    ({ id, policy, note }) => ({
      id,
      policy,
      note,
    })
  );
  const ui = [
    "next",
    "react",
    "vue",
    "svelte",
    "@sveltejs/kit",
    "astro",
    "solid-js",
    "@remix-run/react",
    "expo",
    "react-native",
    "nuxt",
    "@angular/core",
  ].filter((dep) => dep in deps);
  // A page of its own, served without a framework (index.html, public/index.html, …), outside docs.
  const html = (git(root, "ls-files", "--", "*.html") ?? "").split("\n").some((file) => file !== "" && !/(^|\/)(docs?|node_modules)\//.test(file));
  const e2e = ["@playwright/test", "playwright", "cypress", "@wdio/cli"].filter((dep) => dep in deps);
  const e2eDir = ["e2e", "tests/e2e", "test/e2e", "cypress", "playwright"].find((dir) => has(root, dir)) ?? null;

  return {
    root,
    git: {
      branch: git(root, "symbolic-ref", "--short", "HEAD"),
      defaultBranch:
        git(root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")?.replace(/^origin\//, "") ??
        ["main", "master"].find((name) => gitOk(root, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`)) ??
        git(root, "symbolic-ref", "--short", "HEAD"),
      origin,
      github: /github\.com[:/]([^/]+\/[^/.]+)/.exec(origin ?? "")?.[1] ?? null,
      dirty: Boolean(git(root, "status", "--porcelain")),
    },
    packageManager,
    installCommand,
    scripts: pkg.scripts ?? {},
    workspaces: Boolean(pkg.workspaces) || has(root, "pnpm-workspace.yaml"),
    engines: pkg.engines ?? null,
    ci: workflows(root),
    surfaces,
    ui,
    html,
    e2e,
    e2eDir,
    unitTests: ["vitest", "jest", "mocha", "ava"].filter((dep) => dep in deps),
    agentConfig: {
      claudeMd: has(root, "CLAUDE.md"),
      agentsMd: has(root, "AGENTS.md"),
      projectSettings: has(root, ".claude/settings.json"),
      // A person's own settings, which worktrees inherit and agents shouldn't: the team runs with
      // --setting-sources project, so these stay out.
      localSettings: has(root, ".claude/settings.local.json"),
      agents: existsSync(join(root, ".claude", "agents")) ? readdirSync(join(root, ".claude", "agents")) : [],
    },
    prohibitions: prohibitions(root),
  };
}

// A starting team.json from what was detected. The setup agent and the operator refine it. It pins the factory
// version that drafted it, and keeps tickets on the machine (the task graph, in the run folder): a GitHub board posts
// issues where people read them, so the setup interview offers it rather than assuming it. An approver decides on
// the planner's proposals within the default thresholds.
// Whether the repository has an app to run for the team (a UI, or a script that serves something), so it gets an
// environment and a restart after each merge. A library or a command-line tool has neither.
export const hasApp = (found: Detected): boolean =>
  found.ui.length > 0 || found.html || ["dev", "start", "serve", "preview"].some((script) => found.scripts[script]);

export function draftTeam(found: Detected, { name, branch, owner }: { name: string; branch: string; owner?: string | null | undefined }): RawTeam {
  const policies: Record<string, string> = {};
  const app = hasApp(found);
  const tests = found.e2eDir ? `^${found.e2eDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/` : null;
  const roles: Record<string, RoleSettings> = {
    planner: {},
    builder: { limit: 2 },
    reviewer: { limit: 1 },
    approver: { limit: 1 },
    ...(found.ui.length ? { "ux-specialist": { limit: 1 } } : {}),
    ...(found.e2e.length && tests ? { tester: { limit: 1, write: [tests] } } : {}),
  };
  if (roles["tester"] && roles["builder"] && tests) roles["builder"].deny = [tests];
  return {
    $schema: "https://raw.githubusercontent.com/Erik-Koning/E9G-Factory/main/schema/team.schema.json",
    name,
    title: name,
    factory: PACKAGE.version,
    ...(owner ? { owner } : {}),
    branch,
    ...(found.git.defaultBranch ? { base: found.git.defaultBranch } : {}),
    push: null,
    board: "tasks",
    roles,
    gate: { full: ".e9g/adapters/gate.sh", quick: ".e9g/adapters/gate.sh --quick", concurrency: 2 },
    environment: app
      ? { script: ".e9g/adapters/env.sh", health: [], needsDocker: found.surfaces.some((s) => s.id === "supabase") }
      : { script: null, health: [], needsDocker: false },
    afterMerge: app ? ".e9g/adapters/after-merge.sh" : null,
    finish: null,
    policies,
    never: [],
    docs: [".e9g/brief.md", ".e9g/notes.md", ...(found.ui.length ? [".e9g/rubric.md"] : [])],
    worktreeSetup: found.installCommand,
  };
}
