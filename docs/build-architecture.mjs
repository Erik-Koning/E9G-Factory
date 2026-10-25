// E9G Factory's architecture as a BetterDiagram (docs/architecture.json), validated with the BetterDiagrams
// contract. Open it with `npx @mosphere/better-diagrams docs/architecture.json`.
//
//   BETTER_DIAGRAMS=<better-diagrams package dist folder> node docs/build-architecture.mjs [<svg out>]
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BD = process.env.BETTER_DIAGRAMS;
if (!BD) {
  console.error("set BETTER_DIAGRAMS to the better-diagrams package's dist folder (contract.js, better-diagrams.js)");
  process.exit(2);
}
const contract = await import(`${BD}/contract.js`);
const lib = await import(`${BD}/better-diagrams.js`);
const W = 176,
  H = 80;
const n = (id, label, kind, icon, x, y, extra = {}) => ({ id, label, kind, icon, x, y, w: W, h: H, ...extra });
let k = 0;
const e = (source, target, label, extra = {}) => ({ id: `e${++k}`, source, target, label, ...extra });
const c = (i) => 24 + i * 200;
const doc = {
  version: 1,
  meta: { title: "E9G Factory: a software engineering team in any repository, on T3 Code", routing: "orthogonal", versionTag: "0.2" },
  zones: [{ id: "mac", label: "Your Mac", shape: "rounded", x: 0, y: 0, w: 1440, h: 1300, provider: "onprem", providers: ["onprem"], outline: "dashed" }],
  nodes: [
    { id: "t3", label: "T3 Code server · 127.0.0.1:3773", kind: "group", icon: "server", x: 40, y: 40, w: 1040, h: 330, zoneId: "mac" },
    n("planner", "Planner", "service", "robot", c(2), 56, { parentId: "t3", description: "one per team" }),
    n("builder", "Builders", "service", "code", c(0), 216, { parentId: "t3", description: "own worktrees" }),
    n("reviewer", "Reviewer", "service", "search", c(1), 216, { parentId: "t3", description: "approves a commit" }),
    n("ux", "UX specialist", "service", "eye", c(3), 216, { parentId: "t3", description: "verdict per page" }),
    n("tester", "Testers", "service", "check", c(4), 216, { parentId: "t3", description: "and an innovator" }),

    { id: "checkout", label: "The team's checkout", kind: "group", icon: "branch", x: 40, y: 420, w: 1040, h: 330, zoneId: "mac" },
    n("checker", "Finish line", "service", "activity", c(0), 56, { parentId: "checkout", description: "a command, exit 0" }),
    n("env", "Team's app", "service", "window", c(1), 56, { parentId: "checkout", description: "own ports, data" }),
    n("queue", "Merge queue", "service", "gear", c(2), 56, { parentId: "checkout", description: "e9g merge --queue" }),
    n("branch", "Integration", "database", "branch", c(3), 56, { parentId: "checkout", description: "e9g/next, …" }),
    n("sources", ".e9g/", "io", "doc", c(4), 56, { parentId: "checkout", description: "team.json, brief" }),
    n("state", "Run state", "database", "folder", c(0), 216, { parentId: "checkout", description: "verdicts, results" }),
    n("board", "Board", "io", "doc", c(1), 216, { parentId: "checkout", description: "issues or files" }),
    n("locks", "Locks", "service", "lock", c(2), 216, { parentId: "checkout", description: "gate, merge, app" }),

    { id: "factory", label: "E9G Factory · ~/.e9g", kind: "group", icon: "layers", x: 40, y: 800, w: 1040, h: 220, zoneId: "mac" },
    n("plugin", "Plugin", "io", "folder", c(0), 56, { parentId: "factory", description: "roles and hooks" }),
    n("guard", "Guard", "service", "shield", c(1), 56, { parentId: "factory", description: "lanes, policies" }),
    n("prompts", "Prompts", "io", "doc", c(2), 56, { parentId: "factory", description: "compiled per role" }),
    n("cli", "e9g CLI", "service", "gear", c(3), 56, { parentId: "factory", description: "init, check, register" }),
    n("constitution", "Constitution", "io", "doc", c(4), 56, { parentId: "factory", description: "articles for agents" }),

    n("watchdog", "Watchdog", "service", "clock", 1180, 180, { zoneId: "mac", description: "launchd, 5 min" }),
    n("t3db", "T3 state DB", "database", "database", 1180, 476, { zoneId: "mac", description: "threads, tokens" }),
    n("worktrees", "Worktrees", "database", "folder", 1180, 660, { zoneId: "mac", description: "pruned when done" }),
    n("hosted", "Hosted systems", "external", "cloud", 1180, 860, { zoneId: "mac", description: "denied by policy", status: "dark" }),

    n("gmail", "Gmail", "external", "mail", 1520, 56, { description: "done or a decision" }),
    n("owner", "You", "client", "user", 1520, 260, { description: "direct, decide, promote" }),
  ],
  edges: [
    e("planner", "builder", "delegate_task"),
    e("planner", "reviewer", "review"),
    e("planner", "ux", "audit"),
    e("reviewer", "state", "approve @ commit", { color: "emerald" }),
    e("ux", "board", "findings", { style: "dashed", color: "amber" }),
    e("planner", "queue", "queue; woken after", { direction: "both", color: "emerald" }),
    e("queue", "locks", "takes"),
    e("queue", "branch", "fast-forward", { color: "emerald" }),
    e("queue", "env", "rebuild", { color: "emerald" }),
    e("checker", "env", "checks"),
    e("checker", "state", "results"),
    e("sources", "cli", "register"),
    e("constitution", "prompts", "articles"),
    e("cli", "prompts", "compiles"),
    e("prompts", "planner", "system prompt", { style: "dashed" }),
    e("plugin", "guard", "every tool call"),
    e("guard", "t3db", "count members", { style: "dashed", color: "sky" }),
    e("watchdog", "planner", "tick when idle", { style: "dashed" }),
    e("watchdog", "t3db", "reads"),
    e("watchdog", "worktrees", "prunes", { style: "dashed" }),
    e("planner", "gmail", "asks, reports", { color: "violet" }),
    e("gmail", "owner", "email", { color: "violet" }),
    e("owner", "sources", "directs", { color: "violet" }),
  ],
  paths: [
    {
      id: "ticket-to-merge",
      title: "A ticket becomes a merge",
      steps: ["planner", "builder", "reviewer", "state", "queue", "branch", "env", "checker"],
      color: "emerald",
    },
    { id: "rules", title: "Rules are compiled and enforced", steps: ["owner", "sources", "cli", "prompts", "planner"], color: "sky" },
    { id: "keep-running", title: "Keeping it running", steps: ["watchdog", "planner", "gmail", "owner"], color: "violet" },
  ],
};
const report = contract.validateTemplateReport(doc);
console.info(`${doc.nodes.length} nodes, ${doc.edges.length} edges; validator issues: ${JSON.stringify(report.issues).slice(0, 800)}`);
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "architecture.json"), `${JSON.stringify(doc, null, 2)}\n`);
if (process.argv[2])
  writeFileSync(process.argv[2], lib.renderTemplateToSvg(report.template, lib.createRegistry(), lib.LIGHT_EXPORT_PALETTE, { mode: "marketing" }));
