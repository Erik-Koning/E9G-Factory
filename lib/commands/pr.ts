// e9g pr --title "<what it holds>" --body-file <file>: the planner's pull request, from the branch it pushes into the
// one the operator promotes into (team.json push.pullRequest). It opens one, or updates the one that's open, so the
// operator has one to read at a time, and merging it is their promotion (Article 3). It says which commit it holds,
// asking the remote itself: run it after git push. The factory runs gh here, so the team needs no github policy,
// which would also let it merge pull requests, run workflows and change settings.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PLANNER_TAG } from "../labels.ts";
import { inTeam, teamSession } from "../session.ts";
import { parseArgs, text } from "../util.ts";

const USAGE = 'usage: e9g pr --title "<what it holds>" --body-file <file> (or --body "<text>")';

// The repository gh names (owner/name, or host/owner/name on GitHub Enterprise) from a remote's URL: https, ssh:// or
// scp-like. A host without a dot is an SSH alias (Host github-bot in ~/.ssh/config), taken to be github.com. null
// when it isn't GitHub.
export function githubRepo(url: string): string | null {
  const match =
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url) ??
    /^(?:[^@/]+@)?([^/:]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!match) return null;
  const [, rawHost = "", owner, name] = match;
  const host = rawHost.toLowerCase();
  if (!host.includes(".") || ["github.com", "www.github.com", "ssh.github.com"].includes(host)) return `${owner}/${name}`;
  return host.includes("github") ? `${host}/${owner}/${name}` : null;
}

// A remote's URL to print, without any user or token in it (https://x-access-token:…@github.com/…).
export const shownUrl = (url: string): string => url.replace(/^([a-z+]+:\/\/)[^@/]+@/i, "$1");

// The remote's URL as configured, before git's insteadOf rewrites it.
export function remoteUrl(home: string, remote: string): string | null {
  const result = spawnSync("git", ["config", "--get", `remote.${remote}.url`], { cwd: home, encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

const fail = (message: string, code = 2): number => {
  console.error(`pr: ${message}`);
  return code;
};

export function pr(argv: string[]): number {
  // Belt and braces with the guard: on a team, only the planner opens the pull request.
  if (inTeam() && process.env.E9G_ROLE !== "planner") return fail("only the planner does this");
  const { options } = parseArgs(argv);
  const title = text(options["title"])?.trim();
  const bodyFile = text(options["body-file"]);
  let body = text(options["body"]);
  if (bodyFile !== undefined) {
    if (bodyFile !== "-" && !existsSync(bodyFile)) return fail(`no file ${bodyFile}`);
    body = readFileSync(bodyFile === "-" ? 0 : bodyFile, "utf8");
  }
  if (!title || !body?.trim()) {
    console.error(USAGE);
    return 2;
  }

  const { home, team, run } = teamSession();
  const push = team.push;
  if (!push?.pullRequest) return fail("this team opens no pull request (team.json push.pullRequest names the branch it goes into)");
  const into = push.pullRequest;
  const url = remoteUrl(home, push.remote);
  if (!url) return fail(`the checkout has no remote ${push.remote} (team.json push.remote)`);
  const repo = githubRepo(url);
  if (!repo) return fail(`${push.remote} (${shownUrl(url)}) isn't a GitHub repository, so there's nowhere to open a pull request`);

  // What the pull request holds is what the remote has, which only the planner's pushes change.
  const remote = spawnSync("git", ["ls-remote", "--exit-code", push.remote, `refs/heads/${push.branch}`], {
    cwd: home,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (remote.status === 2) return fail(`${push.branch} isn't on ${push.remote} yet: git push ${push.remote} ${push.branch} first`);
  const pushed = /^([0-9a-f]{7,64})\s/.exec(remote.stdout ?? "")?.[1];
  if (remote.status !== 0 || !pushed)
    return fail(`couldn't read ${push.branch} on ${push.remote}: ${(remote.stderr || remote.error?.message || "").trim()}`, 1);
  const local = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${push.branch}^{commit}`], {
    cwd: home,
    encoding: "utf8",
  }).stdout.trim();
  const count = local && local !== pushed ? spawnSync("git", ["rev-list", "--count", `${pushed}..${local}`], { cwd: home, encoding: "utf8" }) : null;
  const unpushed = count?.status === 0 ? Number(count.stdout.trim()) : 0;

  let subject = title;
  for (const prefix of [PLANNER_TAG, `[${team.title}]`]) if (subject.startsWith(prefix)) subject = subject.slice(prefix.length).trim();
  const threadFile = join(run, "planner-thread");
  const thread = existsSync(threadFile) ? readFileSync(threadFile, "utf8").trim() : "";
  const footer = [
    "---",
    `Holds \`${push.branch}\` at ${pushed.slice(0, 9)}${unpushed ? `; ${unpushed} newer commit(s) on the team's machine aren't pushed yet` : ""}. Merging it promotes the team's work into \`${into}\`, which the team never merges into itself.`,
    "",
    `— planner · ${thread || "thread unknown"}`,
  ].join("\n");
  const fullTitle = `${PLANNER_TAG} [${team.title}] ${subject}`;
  const fullBody = `${body.trim()}\n\n${footer}\n`;

  const gh = (args: string[], input?: string) =>
    spawnSync("gh", args, { cwd: home, encoding: "utf8", timeout: 60_000, ...(input === undefined ? {} : { input }) });
  const why = (result: ReturnType<typeof gh>): string => (result.error ? result.error.message : (result.stderr || result.stdout).trim());
  const open = gh(["pr", "list", "--repo", repo, "--head", push.branch, "--base", into, "--state", "open", "--json", "number,url", "--limit", "1"]);
  if ((open.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return fail("gh isn't installed (brew install gh, then gh auth login)", 1);
  if (open.status !== 0) return fail(`gh couldn't list ${repo}'s pull requests: ${why(open)}`, 1);
  let existing: { number?: number; url?: string } | undefined;
  try {
    existing = (JSON.parse(open.stdout || "[]") as { number?: number; url?: string }[])[0];
  } catch {
    return fail(`gh's list of pull requests didn't read as JSON: ${open.stdout.trim().slice(0, 200)}`, 1);
  }

  if (existing?.number) {
    const edit = gh(["pr", "edit", String(existing.number), "--repo", repo, "--title", fullTitle, "--body-file", "-"], fullBody);
    if (edit.status !== 0) return fail(`gh couldn't update #${existing.number}: ${why(edit)}`, 1);
    console.info(`pr: updated #${existing.number}, ${push.branch} into ${into}: ${existing.url ?? ""}`.trim());
  } else {
    const create = gh(["pr", "create", "--repo", repo, "--head", push.branch, "--base", into, "--title", fullTitle, "--body-file", "-"], fullBody);
    if (create.status !== 0) return fail(`gh couldn't open the pull request: ${why(create)}`, 1);
    console.info(`pr: opened ${push.branch} into ${into}: ${create.stdout.trim().split("\n").pop() ?? ""}`);
  }
  if (unpushed) console.info(`pr: ${unpushed} newer commit(s) on ${push.branch} aren't pushed yet; the pull request says so`);
  return 0;
}
