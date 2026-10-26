# E9G Factory

E9G Factory provisions a software engineering team of Claude Code agents in any code repository, fast. You give
as much direction as the project needs. A planner then runs builders, a reviewer, a UX specialist, testers and an
innovator until a checkable finish line holds. The team contacts you only when the work is done, or when a
decision would change the outcome a lot.

It's built on [T3 Code](https://github.com/pingdotgg/t3code), which runs the agents' threads, gives each one its own
worktree, and wakes the planner when a member finishes. Claude Code is each agent. E9G Factory adds the roles, the
rules that hold them (enforced by hooks and scripts, not just prompts), the merge queue, the finish line, a
watchdog that keeps teams alive, and measurement. [CONSTITUTION.md](CONSTITUTION.md) is its purpose, principles and
the articles every agent works under.

## Quick start

```bash
git clone https://github.com/Erik-Koning/E9G-Factory && cd E9G-Factory
npm install && node bin/e9g.ts self-install     # installs ~/.e9g and links `e9g` into ~/.local/bin (keep that on PATH)
e9g doctor                                       # tools, T3 Code's version and contract, the watchdog

e9g init ~/code/my-app                           # detect, make the team's checkout, then interview you
```

`init` does the following:

1. Detects what it can about the repository: its scripts, what CI runs, its tests and UI, and every way it can
   reach outside the machine (deploy targets, hosted databases, publishing, payments).
2. Makes the team's own checkout beside yours (`~/code/my-app-e9g`, on a new branch `e9g/next`).
3. Writes a draft `.e9g/`, pinned to the factory version that wrote it.
4. Opens the **setup agent**. It asks you only what it couldn't detect: the goal, how done is proven, the team,
   a budget, branches, the board, data, contact, taste, and which policies to unlock. The budget goes into the
   brief as guidance for the planner; nothing enforces it, so watch `e9g metrics` and pause the team when it's
   spent. It finishes `.e9g/`, commits it on the integration branch (members' worktrees are made from it), and
   proves it with `e9g check --run`. If you say so, it registers and starts the team.

`e9g init --no-interview` writes the draft only, and prints the same steps for you to do by hand.

To watch a team:

```bash
e9g teams                  # every team on this Mac, its version, and whether it's active, paused or complete
e9g status                 # each team: planner, members running, whether its environment answers, what's drained
e9g metrics --team my-app  # agents, runs, model requests, tokens and time per role
e9g pause my-app           # and e9g resume my-app; e9g rotate my-app for a fresh planner
```

You can also watch a team in the T3 Code window: one planner thread, with a child thread per member.

To hear from your teams away from this Mac, and answer them:

```bash
e9g connect email          # your address and your own Resend API key (free); it sends a test email first
e9g connect whatsapp       # or as well: from your WhatsApp Business number, through Meta's Cloud API
```

With email connected, planners write to you through the watchdog, under `[E9G-Planner] [<team title>]` like
everything else they send. It also emails you when a planner is waiting for your answer, looks stuck or can't start,
or T3 Code is down (each at most every 6 hours). With a full-access key and your Resend receiving address, a reply
goes to that team's planner; the watchdog passes on only mail from your address that its domain signed or that
passes DMARC. The key stays in the macOS Keychain. The guard refuses agents the commands that read or change it, but
any code running as you can reach it, so give the key no more access than you use: sending access only, unless you
want replies. `e9g connect` shows what's connected, and `e9g disconnect email` turns it off. Without email
connected, a planner emails you through the claude.ai Gmail connector, when it has one.

WhatsApp is one way. A business may message you first only with a template Meta has approved, so
`e9g connect whatsapp` adds a utility template, `e9g_update`, to your WhatsApp Business account, and every message
goes through it (Meta charges each one at its utility rate); a planner's messages are about "E9G-Planner · <team
title>". Your replies on WhatsApp don't reach the teams: they arrive at the number's webhook, which belongs to
whatever else uses the number.

## How it works

```
 you ◀── email (the operator only) ──────────────────────────────────────┐
                                                                         │
 launchd ─ watchdog (every 5 min, every team) ─── tick ───▶ PLANNER (a T3 Code thread)
            restarts T3, Docker · stuck? · prunes worktrees              │ delegate_task (the guard counts the limits)
                                                                         ▼
          builders and testers (own worktrees) · reviewer · UX specialist · innovator
                    │ a branch                     │ e9g verdict … @ the exact commit
                    ▼                              ▼
   e9g merge --queue: lane ✓ · approval of this commit ✓ · full gate on the merged result ✓
   → fast-forward the integration branch → close tickets → rebuild and recheck → wake the planner
                                                                         │
                           the finish line (a command that exits 0) ─────┘
```

Each team member is a T3 Code thread running Claude Code, launched like this:

```
claude --agent e9g:<role>                                 the role's prompt, from the factory's plugin
       --plugin-dir ~/.e9g/versions/<v>/plugin            the hooks: guard, stop gate, context, heartbeat
       --append-system-prompt-file ~/.e9g/runs/<team>/prompts/<role>.md
                                                          the constitution's articles + the team's rules
       --setting-sources project [--strict-mcp-config]    none of your personal skills, plugins or connectors
```

The appended prompt is **compiled**, never written by hand. It combines:

- the constitution's articles;
- the team's rules, rendered from `team.json`: lanes, limits, commands, board, policies and documents;
- the operator's notes for the role;
- the planner's lessons.

The prose therefore can't disagree with what the guard enforces. When a source changes, the next session
recompiles it.

**The guard** runs before every tool call. It enforces:

- each role's lane;
- the policies (below);
- protected branches and the push cadence;
- who records verdicts and who merges;
- members per role, counted live from T3 Code's database;
- which outside tools each role may use; the planner may email only you.

**The stop gate** keeps a builder or tester from finishing with uncommitted work, a misnamed branch, or a failing
quick gate. **The merge queue** (`e9g merge`) is the only way into the integration branch.

## The two places you edit

| Where                                                  | What                                                                                                                                                                                                                                                              |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The factory** (this repository)                      | Everything generic: the [constitution](CONSTITUTION.md), the role prompts (`plugin/agents/`), the hooks (`plugin/hooks/`), the policies (`lib/policies.ts`), the engine (`lib/`), the setup agent and the starter files (`templates/`)                            |
| **The team's `.e9g/`** (in the repository it works on) | Everything about one repository: `team.json` (the rules, [reference](docs/team.md)), `brief.md`, `notes.md`, an optional rubric and style guide, `roles/<role>.md` additions, the planner's `lessons.md`, and `adapters/` (`env.sh`, `gate.sh`, `after-merge.sh`) |

Everything else is generated from these two, and nothing in it is edited by hand:

- the compiled prompts;
- T3 Code's provider instances;
- the registry in `~/.e9g/teams/`;
- the watchdog's launchd job.

## Policies

Local and reversible work is allowed. Outward-facing and irreversible actions are denied until you unlock them in
`team.json` (`"policies": {"deploy": "allow"}`):

| Policy         | Denied by default                                                                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy`       | Hosting and app-store CLIs (Vercel, Netlify, Fly, Wrangler, SST, SAM, Firebase, Convex, EAS, …), and package scripts or turbo/nx tasks named deploy, release or publish |
| `cloud`        | aws, gcloud, az, terraform, pulumi, kubectl, helm, …                                                                                                                    |
| `hosted-data`  | Linking, pushing, migrating or dumping hosted databases (Supabase, Prisma migrate deploy, PlanetScale, Neon, Turso, …)                                                  |
| `publish`      | npm, pnpm, yarn, lerna, cargo, gem and twine publishing; docker, podman and buildah push (including docker image and compose push)                                      |
| `github`       | gh beyond issues, labels, search and reading PRs and runs (no workflows, API, PRs, releases or settings)                                                                |
| `messages`     | mail, Slack or Discord webhooks, SMS and email APIs from the shell. The planner emails only you, through its email tool                                                 |
| `payments`     | The Stripe CLI and live payment keys                                                                                                                                    |
| `dependencies` | (allowed by default) adding packages                                                                                                                                    |

Never unlocked: secrets and env files, the machine's services, force pushes and rewritten history, protected
branches, and the factory's own files. A team adds its own rules in `never`, each with an example command that
`e9g check` proves is refused.

## Commands

`e9g help` lists them all.

| For                                                    | Commands                                                                                                                                                                                                                     |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The operator**                                       | `doctor`, `init`, `check`, `register` (alias `sync`), `start`, `pause`, `resume`, `rotate`, `status`, `teams`, `metrics`, `prompt`, `upgrade`, `unregister`, `watchdog`, `connect`, `disconnect`, `self-install`, `versions` |
| **Team members** (the guard decides who may run which) | `merge`, `verdict`, `log`, `lock`, `drain`, `gate`, `env`, `finish`, `progress`, `pages`                                                                                                                                     |

## T3 Code and Claude Code

T3 Code is a dependency, not a fork:

- Everything that depends on its internals is in one file, `lib/t3.ts`: its data paths, the tables and columns
  the factory reads, the CLI commands it runs, the settings it writes, and the planner's tool names.
- `package.json` declares the T3 Code versions this release supports (`"e9g": {"t3code": ">=0.1.2 <0.2.0"}`), and
  the Claude Code versions it's tested with.
- `e9g doctor` and `e9g register` check the installed T3 Code against that range and against what the adapter
  reads (its contract).

When T3 Code updates (`t3 update`), run `e9g doctor`:

- **In range, contract holds:** nothing to do.
- **Otherwise:** adjust `lib/t3.ts`, widen the range, and release a new factory version.

## Versions

- **Releases:** `e9g self-install` installs this checkout's version into `~/.e9g/versions/<version>` and makes it
  current. An installed release doesn't change under a running team. An older version than the current one is only
  added, for teams to pin (`--force` makes it current): the launcher is shared, and an older one doesn't know the
  newer releases. An install that was interrupted is put right by the next one.
- **Pins:** each team pins one release in `team.json` (`"factory": "0.3.0"`; `e9g init` writes the version that
  drafted it), and its agents run that release. A team without a pin runs whichever version registers it.
- **Upgrading:** `e9g upgrade <team> [version]` registers the team with the target version first, and moves the pin
  only once that worked (`--force` registers even when T3 Code doesn't meet the contract). A running planner keeps
  its old prompt until `e9g rotate <team>`.
- **Development:** `self-install --link` adds `versions/dev`, pointing at this checkout, for teams that should pick
  up changes immediately.
- **Which code runs:** the installed `e9g` hands a team's commands to the version the team pins. A source checkout
  (`node bin/e9g.ts …`) never hands over: it runs its own code, whatever the team pins.

## Repository layout

```
CONSTITUTION.md        the purpose, principles and the articles every agent works under
bin/e9g.ts             the CLI (bin/e9g.mjs runs it, for the launchers of versions before 0.3.0)
lib/                   config, policies, prompts, the T3 Code adapter, locks, detection, and the commands
plugin/                the Claude Code plugin every agent loads: agents/ (roles and setup), hooks/
templates/team/        the starter .e9g/ that init writes
schema/                team.schema.json, for editors
docs/team.md           the team.json reference; docs/architecture.json is the architecture as a BetterDiagram
examples/              team.json for a page-building team, a journeys team, and a minimal one
test/                  node --test
```

The factory is TypeScript, written the way T3 Code's own is: Node (22.18 or newer) runs the `.ts` files as they
are, so there's no build step, and `tsc` only checks them, with T3 Code's compiler settings (`tsconfig.json`). The
hooks and the launcher run with Node's compile cache on, so stripping the types costs nothing after the first run.

## Development

```bash
npm test                         # type-check, then the suite: policies, config, prompts, guard, merge queue, locks
node bin/e9g.ts check <dir>     # any team's setup, with this checkout's code (whatever the team pins)
node bin/e9g.ts self-install --link
```

To make a release:

1. Bump `version` in `package.json` and `plugin/.claude-plugin/plugin.json` (a test keeps them equal).
2. Note it in `CHANGELOG.md`.
3. Run `e9g self-install`.
4. Run `e9g upgrade <team>` for each team that should move.

## Known limits

- **The guard is a seatbelt for agents that follow instructions, not a sandbox.** A determined shell command can
  get past a pattern. For hard guarantees, scope the credentials on the machine (for example, a GitHub token that
  can only read code and write issues) and protect production with required reviewers. See the constitution's
  Part IV.
- **Platform:** macOS only for now. The watchdog is a launchd job, notifications use `osascript`, and the email
  key is kept in the Keychain.
- **No interrupt:** T3 Code 0.1.x has no command to interrupt a thread, so the watchdog notifies you instead.
- **One shared environment per team:** full runs and rebuilds are serialised by locks, not isolated.

## License

No license has been chosen yet, so all rights are reserved.
