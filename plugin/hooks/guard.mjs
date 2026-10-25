#!/usr/bin/env node
// PreToolUse guard for every agent on an E9G team. It keeps each role in its lane, keeps the whole team away from
// what its policies deny (deploys, hosted data, publishing, payments, messages, secrets), and enforces what the
// planner would otherwise only remember: members per role, who records verdicts, who merges, the push cadence.
// Rules come from the team's .e9g/team.json in its checkout, never a worktree's copy, so a branch can't change
// the rules it runs under. In setup (E9G_SETUP=1) the setup agent may write only .e9g/. Inert for everyone else.
// Exit 2 refuses the tool call and tells the agent why.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { FACTORY_PATH, instanceId, laneAllows, normalize as normalizeTeam, roleForInstance } from "../../lib/config.mjs";
import { commandRules, isSecretFile, OPERATOR_COMMANDS } from "../../lib/policies.mjs";
import { inSetup, inTeam, teamSession } from "../../lib/session.mjs";
import { runningByInstance, TOOLS } from "../../lib/t3.mjs";
import { escapeRegex } from "../../lib/util.mjs";

if (!inTeam() && !inSetup()) process.exit(0);

const input = JSON.parse(readFileSync(0, "utf8"));
const tool = input.tool_name ?? "";
const args = input.tool_input ?? {};
const setup = !inTeam() && inSetup();
let role = setup ? "setup" : "";

function refuse(reason) {
  process.stderr.write(`Refused by the E9G guard (${role || "no role"}): ${reason}`);
  process.exit(2);
}

let session;
try {
  session = setup
    ? {
        home: resolve(process.env.E9G_HOME_DIR ?? process.env.CLAUDE_PROJECT_DIR ?? input.cwd),
        team: normalizeTeam({ name: "setup", branch: "setup" }).team,
        run: null,
      }
    : teamSession({ cwd: input.cwd, agentType: input.agent_type });
} catch (error) {
  // A team whose rules don't load can still read, never write or run anything.
  if (["Read", "Grep", "Glob"].includes(tool)) process.exit(0);
  refuse(`the team's rules don't load, so nothing runs until the operator fixes them: ${String(error.message).split("\n").slice(0, 4).join(" ")}`);
}
const { home, team, run } = session;
if (!setup) role = session.role;
const root = resolve(process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd());
const work = join(home, ".e9g", "run");
const lane = team.roles[role];
// A role the team doesn't have (a native subagent such as Explore, or a misconfigured instance) writes nothing.
const readOnly = setup ? false : !lane || lane.readOnly;

// --- Files -------------------------------------------------------------------------------------------------

const scratchDirs = ["/tmp/", "/private/tmp/", process.env.TMPDIR && `${resolve(process.env.TMPDIR)}/`].filter(Boolean);
const inside = (absolute, dir) => absolute === dir || absolute.startsWith(`${dir}/`);

// Inside the team's run folder in its checkout (.e9g/run/): state and locks belong to the factory's commands; the
// board's tickets to the planner; anyone may add a finding (f-*.md) or use scratch/ and shots/.
function checkWork(absolute) {
  const rel = relative(work, absolute);
  if (/^(state|locks|merge)(\/|$)/.test(rel)) refuse(`.e9g/run/${rel} is written by the factory's commands only.`);
  if (/^board\//.test(rel)) {
    if (role === "planner" || /^board\/f-[\w.-]+\.md$/.test(rel)) return;
    refuse("only the planner edits tickets; file what you found as a new board/f-<yyyymmdd-hhmm>-<slug>.md.");
  }
  if (/^(scratch|shots)(\/|$)/.test(rel)) return;
  refuse(`.e9g/run/${rel} isn't yours to write; use .e9g/run/scratch/ or /tmp.`);
}

// Only a lane rule naming the path itself lets a role write one of the factory's files (the planner's lessons).
const explicitlyAllowed = (rel) => (lane?.write ?? []).some((rule) => rule !== "*" && new RegExp(rule).test(rel));

function checkPath(absolute, { viaShell = false } = {}) {
  if (inside(absolute, work)) return checkWork(absolute);
  for (const rule of team.protect)
    if (new RegExp(rule).test(relative(home, absolute))) refuse(`${relative(home, absolute)} is written by the team's scripts only.`);
  const rel = relative(root, absolute);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    if (scratchDirs.some((dir) => absolute.startsWith(dir))) return;
    if (role === "planner" && run && inside(absolute, join(run, "outbox"))) return;
    if (viaShell) return; // a shell write outside the checkout (a build cache, a log): the guard only watches lanes
    refuse(`${absolute} is outside your checkout.`);
  }
  if (setup) {
    if (!/^\.e9g\//.test(rel)) refuse("setup writes only the team's .e9g/ folder; the repository itself is the team's to change, once it runs.");
    return;
  }
  if (viaShell && ignored(rel)) return;
  if (FACTORY_PATH.test(rel) && !explicitlyAllowed(rel))
    refuse(`${rel} is the team's rules or the factory's own files, which the operator changes (Article 12).`);
  if (!laneAllows(team, role, rel)) refuse(`the ${role || "unnamed"} role doesn't write ${rel}; it's outside its lane (Article 6).`);
}

function checkWrite(path) {
  checkPath(isAbsolute(path) ? path : resolve(input.cwd ?? root, path));
}

function checkRead(path) {
  if (path && isSecretFile(path)) refuse(`${path} holds secrets; agents never read them. The team's environment has what it needs.`);
}

// --- Commands ----------------------------------------------------------------------------------------------

// Global options that don't change what a command does: git -C dir / -c key=val / --git-dir…, line continuations,
// and the factory's CLI called by its path, so each reads as the plain command the rules name.
function normalize(command) {
  let out = command.replace(/\\\n/g, " ");
  for (let previous = ""; previous !== out;) {
    previous = out;
    out = out.replace(/\bgit\s+(?:-C\s+\S+|-c\s+\S+|--git-dir(?:=|\s+)\S+|--work-tree(?:=|\s+)\S+|--no-pager|--no-replace-objects|-P)\s+/g, "git ");
  }
  return out.replace(/(?:\bnode\s+)?["']?\S*\/(?:bin\/e9g(?:\.mjs)?)["']?(?=\s|$)/g, "e9g");
}

// [regex, roles allowed, reason]: commands only some roles run.
const OWNED = [
  [/\be9g\s+(merge|log|drain)\b/, ["planner"], "the planner merges, keeps the log and drains the environment."],
  [/\be9g\s+env\s+(up|reset|restart|down)\b/, ["planner"], "only the planner starts, resets or stops the team's environment."],
  [/\be9g\s+pages\s+run\b/, ["planner"], "the planner records page results; use e9g pages shots to check anything yourself."],
  [/\be9g\s+verdict\s+review\b/, ["reviewer"], "only a reviewer records a review (Article 4)."],
  [/\be9g\s+verdict\s+ux\b/, ["ux-specialist"], "only the UX specialist records a UX verdict (Article 4)."],
  // The environment script itself, called by its path (scripts/loop/env.sh reset), is the planner's too.
  ...(team.environment.script
    ? [
        [
          new RegExp(`(?:^|[\\s;&|(/"'])${escapeRegex(team.environment.script.split(/\s+/)[0].split("/").pop())}\\s+(up|reset|restart|down)\\b`),
          ["planner"],
          "only the planner starts, resets or stops the team's environment (e9g env …).",
        ],
      ]
    : []),
  ...team.commandOwners.map(({ rule, roles, reason }) => [new RegExp(rule), roles, reason ?? "that command belongs to another role."]),
];

function pushAllowed(command) {
  const push = team.push;
  if (role !== "planner" || !push) return `${push ? "only the planner pushes" : "this team pushes nothing"}; everything stays on this machine.`;
  const exact = new RegExp(`\\bgit\\s+push\\s+${escapeRegex(push.remote)}\\s+${escapeRegex(push.branch)}\\s*($|[;&|])`);
  if (!exact.test(command)) return `the planner pushes only ${push.branch}: git push ${push.remote} ${push.branch}.`;
  if (run && push.everyMin) {
    const stamp = join(run, "last-push");
    const minutes = existsSync(stamp) ? (Date.now() - statSync(stamp).mtimeMs) / 60_000 : Number.POSITIVE_INFINITY;
    if (minutes < push.everyMin)
      return `${push.branch} was pushed ${(minutes / 60).toFixed(1)} h ago; pushes are at most every ${(push.everyMin / 60).toFixed(1)} h.`;
    mkdirSync(run, { recursive: true });
    writeFileSync(stamp, new Date().toISOString());
  }
  return null;
}

function checkCommand(raw) {
  const command = normalize(raw);
  const rules = setup ? commandRules(team).filter(({ rule }) => rule !== OPERATOR_COMMANDS) : commandRules(team);
  for (const { rule, reason } of rules) if (rule.test(command)) refuse(reason);
  if (setup) {
    if (/(?<![\w./-])e9g\s+(?!(?:check|register|start|doctor|prompt|teams|status)\b)[a-z][\w-]*/.test(command))
      refuse("setup runs e9g check, register, start, doctor, prompt, teams and status only.");
  } else {
    for (const [rule, roles, reason] of OWNED) if (rule.test(command) && !roles.includes(role)) refuse(reason);
  }
  const protectedAlt = team.protectedBranches.map(escapeRegex).join("|");
  if (new RegExp(`\\bgit\\s+push\\b[^;&|]*\\b(${protectedAlt})\\b`).test(command)) refuse(`nothing is pushed to ${team.protectedBranches.join(" or ")}.`);
  if (/\bgit\s+push\b/.test(command)) {
    const problem = setup ? "setup pushes nothing." : pushAllowed(command);
    if (problem) refuse(problem);
  }
  const integration = escapeRegex(team.branch);
  if (new RegExp(`\\bgit\\s+(branch\\s+(-[a-zA-Z]*[fdDmM][a-zA-Z]*|--force|--delete|--move)|update-ref)\\b[^;&|]*\\b${integration}\\b`).test(command))
    refuse(`${team.branch} changes only through e9g merge.`);
  if (
    role === "planner" &&
    inside(resolve(input.cwd ?? root), home) &&
    /\bgit\s+(merge(?!\s+--abort)|pull|rebase|cherry-pick|revert|am|reset\s+--(hard|merge|keep))\b/.test(command)
  )
    refuse(`${team.branch} changes only through e9g merge, and a builder rebases its own branch.`);
  if (readOnly && !setup) {
    const branchList = /\bgit\s+branch(\s+(-a|-r|-v|-vv|--list|--show-current|--contains\s+\S+|--merged(\s+\S+)?|--no-merged(\s+\S+)?))*\s*($|[;&|])/;
    if (
      /\bgit\s+(checkout|switch|stash|reset|restore|clean|commit|merge|rebase|cherry-pick|revert|pull|am|apply|tag|branch|push|mv|rm)\b/.test(command) &&
      !branchList.test(command)
    )
      refuse(
        `the ${role || "unnamed"} role changes nothing in the checkout; inspect branches with git show, git diff, or git worktree add --detach /tmp/<name> <branch>.`
      );
  }
  for (const target of writeTargets(command)) checkPath(isAbsolute(target) ? target : resolve(input.cwd ?? root, target), { viaShell: true });
}

// The paths a shell command writes: redirect targets, tee, sed -i/perl -i operands, the destination of cp, mv, ln
// and install, and the operands of rm, touch, truncate, mkdir and git rm/mv/checkout/restore. Approximate on
// purpose: it catches the ordinary ways round the file tools, and the merge queue checks every lane again.
function writeTargets(command) {
  const targets = [];
  const paths = (words) => words.filter((word) => word && !word.startsWith("-") && !/^\d*>|^&/.test(word));
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    for (const match of segment.matchAll(/(?:^|[^\d&>])\d?>>?\s*([^\s&;|<>]+)/g)) if (!match[1].startsWith("&")) targets.push(match[1]);
    const words = segment
      .replace(/\d?>>?\s*\S+/g, " ")
      .trim()
      .split(/\s+/)
      .map((word) => word.replace(/^["']|["']$/g, ""));
    // The command word: skip VAR=value assignments and wrappers like env, nohup, time, command, xargs.
    let at = 0;
    while (at < words.length && (/^\w+=/.test(words[at]) || /^(env|nohup|time|command|sudo|xargs|exec)$/.test(words[at]))) at++;
    if (at >= words.length || !/^(tee|sed|perl|cp|mv|ln|install|rm|touch|truncate|mkdir|git)$/.test(words[at].split("/").pop())) continue;
    const verb = words[at].split("/").pop();
    const rest = words.slice(at + 1);
    if (verb === "tee" || ["rm", "touch", "truncate", "mkdir"].includes(verb)) targets.push(...paths(rest));
    else if (verb === "sed" && rest.some((word) => /^-[a-zA-Z]*i/.test(word))) targets.push(...paths(rest).slice(1));
    else if (verb === "perl" && rest.some((word) => /^-[a-zA-Z]*i/.test(word))) targets.push(...paths(rest).slice(1));
    else if (["cp", "mv", "ln", "install"].includes(verb)) targets.push(...paths(rest).slice(-1));
    else if (verb === "git" && /^(rm|mv|checkout|restore)$/.test(rest[0] ?? ""))
      targets.push(...paths(rest.slice(1)).filter((word) => word.includes("/") || word.includes(".")));
  }
  return targets.filter((target) => !/[$`*]/.test(target) && target !== "/dev/null");
}

function ignored(rel) {
  if (/^(\.git|node_modules)(\/|$)/.test(rel)) return true;
  // A directory that doesn't exist yet only matches "dir/" patterns with its slash.
  for (const path of [rel, `${rel}/`]) {
    try {
      execFileSync("git", ["check-ignore", "-q", path], { cwd: root, stdio: "ignore" });
      return true;
    } catch {}
  }
  return false;
}

// --- Outside tools -----------------------------------------------------------------------------------------

function checkMcp() {
  if (tool.startsWith(TOOLS.prefix)) {
    if (role !== "planner") refuse("only the planner starts and manages members (Article 2).");
    if (tool === TOOLS.delegate) checkDelegate();
    return;
  }
  const allowed = setup ? [] : (lane?.mcp ?? []);
  if (!allowed.includes(tool)) refuse(`the team doesn't use ${tool}; outside tools stay off${allowed.length ? ` except ${allowed.join(", ")}` : ""}.`);
  if (/__(send_message|create_draft|send_email|send|reply|forward)$/.test(tool)) {
    const owner = (team.owner ?? "").toLowerCase();
    const recipients =
      JSON.stringify([args.to, args.cc, args.bcc])
        .toLowerCase()
        .match(/[^\s"',<>[\]]+@[^\s"',<>[\]]+/g) ?? [];
    if (!owner || !recipients.length || recipients.some((address) => address !== owner))
      refuse(`email from the team goes only to the operator (${owner || "no owner is set in team.json"}).`);
  }
}

// The planner's limits, enforced: one of this team's instances, no more members of a role than team.json allows,
// and none of a draining role while the environment resets.
function checkDelegate() {
  const instance = args.target?.providerInstanceId ?? args.providerInstanceId;
  const childRole = roleForInstance(team, instance);
  const known = Object.keys(team.roles)
    .filter((r) => r !== "planner")
    .map((r) => instanceId(team, r));
  if (!childRole) refuse(`start members only on this team's instances (${known.join(", ")}); ${instance ?? "none"} gives no role.`);
  if (childRole === "planner") refuse("there is one planner.");
  const drain = join(work, "state", "drain");
  if (existsSync(drain) && readFileSync(drain, "utf8").split(/\s+/).includes(childRole))
    refuse(`the environment is draining for a reset; start no ${childRole} until e9g drain off.`);
  const limit = team.roles[childRole].limit;
  const ids = [
    instanceId(team, childRole),
    ...Object.entries(team.legacyInstances)
      .filter(([, r]) => r === childRole)
      .map(([id]) => id),
  ];
  const counts = runningByInstance(ids);
  if (!counts) return; // T3's database unreadable: don't stop the team on the guard's own blind spot
  const running = Object.values(counts).reduce((sum, n) => sum + n, 0);
  if (running >= limit) refuse(`${running} ${childRole} members are running and the limit is ${limit}; start the next one when one finishes.`);
}

// -----------------------------------------------------------------------------------------------------------

if (tool === "Bash") checkCommand(String(args.command ?? ""));
else if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) checkWrite(String(args.file_path ?? args.notebook_path ?? ""));
else if (tool === "Read") checkRead(String(args.file_path ?? ""));
else if (tool === "Grep") for (const path of [args.path, args.glob]) checkRead(String(path ?? ""));
else if (tool.startsWith("mcp__")) checkMcp();
process.exit(0);
