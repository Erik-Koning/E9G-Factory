# Plan: the task graph, feature requests, cycles and review (0.4.0)

Status: built and audited (see Audit). The checklist at the end records what's done.

## Why

E9G Factory 0.3 runs a project that ends: a brief, a finish line, then a nightly tick. Its board is free-text
tickets the planner retypes into every brief, review is the same for every change, and nothing knows what was
built, what it touches or what matters most. The operator wants open-ended building: stakeholders feed a request
stack, the planner researches and prioritises, an approver releases work, builders pull it, machines share it,
journeys get polished as wholes, and review persists until the work is right.

## Decisions (operator, 2026-10-27)

1. **One document per task.** Local JSON files by default; a MongoDB adapter for teams that want one. Each task has
   a `status` and a `claim` saying who is building it and on which machine. The graph view is generated from the
   tasks (BetterDiagrams JSON), never edited by hand.
2. **Merging across machines:** the machine designated always-on (the lead) merges; a laptop is fine when a team runs
   on one machine. No separate lock: only the lead merges, enforced by machine name.
3. **The planner owns the task graph.** A separate feature-request stack takes stakeholders' requests (in Mongo, from
   a web form, when the team has a database; local otherwise). The planner researches requests and promotes them.
4. **Cycles** are a team setting (`mode: "cycles"`); finish-line teams keep working as they do.
5. **Approval** is configurable: by the operator, by an approver within thresholds, or by the approver with full
   agency ("full send").
6. **Scoring** uses business-innovation dimensions (below).
7. **No hand-kept area map**: the blast radius of a change is computed from the code and its history.
8. **A persistent review skill** in the factory's plugin: the work looks pixel perfect, meets its goals, handles edge
   cases, works with tangential code without breaking its connections, and has appropriate unit, e2e or Playwright
   tests.
9. **Existing teams:** a files board is imported into tasks; `board: {github}` keeps working as it is.

Defaults taken: a web form served by `e9g serve` on the lead machine; full send never covers privacy, policy unlocks,
promotion or rule changes; stakeholders appear to agents as an id and a role, never a name or email; three rounds of
review changes, then the task is blocked for the planner to split or decide.

## Architecture

```
 stakeholders ──(e9g serve form, or e9g request add)──▶ REQUESTS ──┐
                                                                    │ planner: research, Musk gate, score
 innovator, testers, UX, reviewer ──(e9g task add: triage)──▶ ──────┤
                                                                    ▼
                                                     TASKS (one document each)
          proposed ──approver or operator──▶ approved ──e9g task claim──▶ building ──e9g task submit──▶ review
              ▲                                                                          │ reviewer (skill),
              └──────── researching ◀── approver asks for research                       │ e9g verdict review
                                                     merge queue (lead machine) ◀────────┘
                                                        │ done; last child done → journey due
                                                        ▼
                                               journey polish cycle → done → cycle report
```

- **Store:** `lib/tasks/` holds the model (`model.ts`: types, statuses, transitions, priority, claim choice), the
  store interface (`store.ts`) with a file store (`files.ts`, in `~/.e9g/runs/<team>/tasks/`) and a Mongo store
  (`mongo.ts`). The run folder, not the checkout: the watchdog runs under launchd, which can't read a checkout in
  `~/Documents`, and the guard already refuses agents writing there except through the factory's commands.
- **Every change goes through a command** (`e9g task …`, `e9g request …`). The command checks the caller's role and
  the transition, writes with optimistic concurrency (a `version` per document), and appends a history event.
  Agents never edit task files or the database themselves.
- **Rules are code:** which role may move which status, approval thresholds, claim eligibility, review rounds and
  view checks are enforced by the commands and the merge queue; prompts carry the judgment.

## The task document

```jsonc
{
  "id": "142", // numeric, per team; builders' branches carry it (e9g/b142-…)
  "team": "refdocs-voice",
  "title": "Resume a paused recording after reload",
  "kind": "feature", // feature | bug | ux | test | test-infra | chore | research | journey
  "status": "approved", // see below
  "severity": "major", // blocker | major | minor (bugs and findings)
  "body": "Outcome, what done looks like, repro…",
  "area": "recording", // the page, journey or area, as text
  "files": ["src/recording/"], // where the work is expected to land (claim conflicts)
  "parent": "130", // the journey it belongs to
  "after": ["139"], // dependencies: these must be done before it can be claimed
  "request": "r12", // the feature request it came from
  "gate": { "asked": "…", "simplify": "…", "simplest": "…" }, // the Musk gate
  "score": {
    "pain": 3,
    "reach": 2,
    "revenue": 1,
    "wow": 2,
    "distribution": 1,
    "leverage": 2,
    "urgency": 1,
    "risk": 0,
    "confidence": "asks",
    "size": "M",
    "why": "…",
  },
  "priority": 24, // computed by code from score and team.json weights
  "research": { "needed": true, "market": false },
  "notes": [{ "at": "…", "by": "approver", "text": "…" }],
  "claim": { "role": "builder", "machine": "studio", "worktree": "/…/t3-1a2b", "at": "…", "until": "…" },
  "branch": "e9g/b142-resume-recording",
  "sha": "…",
  "rounds": 1, // review rounds that asked for changes
  "ui": true,
  "critical": false, // from the blast radius at submit
  "version": 7,
  "createdAt": "…",
  "updatedAt": "…",
  "by": "planner",
  "history": [{ "at": "…", "by": "builder@studio", "what": "approved → building" }],
}
```

### Statuses and who moves them

| From → to                                            | Who                                                   | How                                                                                                 |
| ---------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| (new) → triage                                       | any member                                            | `e9g task add` (a finding or proposal)                                                              |
| (new) → proposed                                     | planner                                               | `e9g task add`, then `e9g task score` at once                                                       |
| triage → proposed, rejected, question                | planner                                               | `e9g task edit` (severity, area, files), then `e9g task status`                                     |
| proposed → researching, approved, rejected, question | approver (proposed only), or the operator             | `e9g task research/approve/reject/escalate`; none for the approver when `approval.mode` is operator |
| researching → proposed                               | planner                                               | after `e9g task note` with the findings and a new score                                             |
| approved → building                                  | builder or tester                                     | `e9g task claim` (atomic; best eligible task; whoever sees a clash on the same files gives way)     |
| building → approved, blocked                         | the claimant, or the planner for a member that's gone | `e9g task release [--blocked "…"]`; the Stop hook releases as blocked when it lets a member stop    |
| building → review                                    | the claimant                                          | `e9g task submit` (branch, commit, UI and critical paths; a rework must be a new commit)            |
| review → approved (rework)                           | reviewer (or the operator)                            | `e9g verdict review … changes` (rounds + 1; blocked past `review.maxRounds`); only a task in review |
| review (or an approved task `--closes` names) → done | merge queue                                           | `e9g merge --closes`; not a task being built, a journey, or one never approved                      |
| journey: approved → done                             | planner                                               | once it's due (its tasks all done or rejected, one done: worked out, never stored) and verified     |
| any → blocked, question, rejected; reopen            | planner                                               | `e9g task status` (never building or approved; done only for research, and journeys once due)       |
| back to triage, proposed or researching; a new score | —                                                     | the approval is cleared: it's approved again before it's built                                      |

The planner never approves its own proposals and never marks code done: approval is the approver's or the
operator's, and code is done when the merge queue merges it.

### Priority

Scores are 0–3 against written anchors (in the planner's prompt):

| Dimension    | Asks                                                                            | From                        |
| ------------ | ------------------------------------------------------------------------------- | --------------------------- |
| pain         | How important is the job, and how badly is it served today?                     | Ulwick, opportunity scoring |
| reach        | How many target users meet it each month?                                       | RICE                        |
| revenue      | Does it win, expand or keep paying customers?                                   | MBA basics                  |
| wow          | A delighter, ten times better than the alternative, worth a demo?               | Kano, first principles      |
| distribution | Will people show it to others; is there a launch story?                         | growth                      |
| leverage     | Does it unlock other work or compound (data, network effects, switching costs)? | WSJF enablement, 7 Powers   |
| urgency      | Does its value decay if late?                                                   | cost of delay               |
| risk         | Does it remove security, reliability or tech-debt risk?                         | WSJF risk reduction         |

`priority = round(100 × Σ(weight × score) / (3 × Σweight) × confidence ÷ size)` with confidence hunch 0.5, asks
0.8, data 1.0 and size S 1, M 2, L 4, XL 8. Weights default to pain 3; reach, revenue, wow and leverage 2;
distribution, urgency and risk 1 (`team.json` `priorities.weights`). Before scoring, the **Musk gate** records who
asked and why, what could be deleted or simplified instead, and the simplest version; the score is for that version.
Claim order: blockers, then majors, then the rest by priority with minor findings last, then the oldest.

### Claims

`e9g task claim [<id>] [--kind k]` takes, atomically, the best approved task whose `after` are all done, whose kind
fits the role (testers take test and test-infra; builders the rest), and whose `files` and `area` overlap no task
being built. It records role, machine, worktree and a lease (`watchdog.stuckAfter`, 45 min). The heartbeat hook
renews leases held by its worktree at most every five minutes; the watchdog returns expired claims to `approved`.
On a worker machine, claim also fetches the remote and makes the task's branch from the remote integration branch
(or the task's existing branch, for rework).

## Feature requests

A request: `{ id: "r12", title, body, from: "s3", status: new|researching|promoted|rejected, tasks: [ids], notes,
history }`. Stakeholders live apart (`stakeholders` collection or `stakeholders.json`): name, email and role, which
only the operator's own commands and `e9g serve` show. Agents see `from: s3 (role)`.

- `e9g request add` (the operator, or the web form); `list`, `show`, `note`; `reject --reason` (planner; a promoted
  request once its tasks are rejected).
- `e9g task add --request r12` links a task and marks the request promoted.
- New requests clear a cycles team's idle marker and wake the planner (the watchdog, on its next run); the planner's
  context lists the new ones.

`e9g serve [--port 4600] [--host 127.0.0.1] [--token …]`: a small web app on the lead machine with the request form,
the requests, the board by status, the generated graph, and the operator's approve and reject for proposals. Off
loopback it requires the token.

## Approval

`team.json` `approval: { "mode": "operator" | "thresholds" | "full", "maxSize": "M" }`, default thresholds.

- **operator:** proposals wait for the operator (`e9g task approve` run by a person, or `e9g serve`).
- **thresholds:** the approver role approves proposals up to `maxSize` (a journey only groups tasks and needs no approval of its own); anything larger it
  escalates (status question), which reaches the operator in the planner's next message.
- **full:** the approver approves anything, scope included. Never delegable: privacy and personal data, policy
  unlocks, promotion to production, changes to the rules or the constitution.

The approver (`plugin/agents/approver.md`) is read-only, may research on the web, and judges proposals against the
direction, the decisions and the score.

## Cycles and journeys

`team.json` `mode: "finish"` (default) or `"cycles"`. In cycles mode the planner works in cycles: refresh the
backlog (requests, findings, innovator proposals), propose and score, get approval, build, verify journeys whose
children are done (UX audit at every viewport, an end-to-end spec of the whole journey, polish rounds), sweep
regressions, consolidate `decisions.md` and lessons, and close the cycle with `e9g cycle close "<report>"`, which
records it and drafts the cycle report for the operator. When nothing is approved, proposed or requested, the planner
writes `$E9G_RUN/idle` and the watchdog drops to the done-tick until a request or a task arrives.

A journey is a task of kind `journey`; its children name it as `parent`. When its last child is done, the journey is due
its verification, worked out from its children wherever it's shown (the planner's context, `e9g task list`, the
graph) rather than stored; polish is more children; the planner marks it done once verified.

## Review

- `plugin/skills/review/SKILL.md` (the reviewer loads it as `e9g:review`): blast radius first, then the ticket's
  goals, edge cases, tangential code (read and run the tests of what imports the change), tests that fail without the
  change, and for UI a before-and-after look at every affected page at desktop and phone, light and dark.
- **View checks are the reviewer's judgment** (operator, 2026-10-28): the skill says when to look (anything that
  could change what a person sees, however few lines); `--shots <dir>` records what it read, and an approval of a UI
  change without it is said so.
- **Risk, judged after the work is done:** the reviewer says how much the change could break with its approval
  (`--risk low|medium|high`, required). A high-risk change carries its own tests in the same branch, and the merge
  queue refuses it otherwise.
- **Rounds:** `review.maxRounds` (3). A changes verdict on a task's branch counts a round; at the limit the task is
  blocked for the planner.

## Blast radius

`e9g blast [<ref>] [--base <branch>] [--json]`: the files a change touches, what imports them (JS and TS, two levels,
relative imports and `tsconfig` paths), what usually changes with them (git history: at least 3 shared commits and 30%
of the file's commits), the tests among those, whether it touches UI, and which `team.json` `critical` paths it
reaches. `e9g task submit` stores `ui` and `critical` on the task; the reviewer and testers start from it.

## Across machines

`team.json` `tasks: { "store": "mongo", "database": "e9g", "lead": "<machine>" }`, with `e9g connect mongo` on each
machine (the connection string in the Keychain; the machine's name in `~/.e9g/machine.json`).

- **The lead** runs the planner, approver, reviewer, UX specialist and the merge queue. `e9g merge` refuses on any
  other machine. After each merge the lead pushes the integration branch, so workers build on it.
- **Workers** register with `e9g register --worker`: builders only (testers test on the lead, where the environment
  runs), no planner. Exactly one lead, by setup discipline (operator, 2026-10-28). Their watchdog
  fills free slots from approved tasks (`t3 thread start --worktree`), each member claiming its own. `e9g task
submit` on a worker pushes the task's branch; the lead fetches it for review and merge.

Agents never get the connection string; the hosted-data policy refuses direct Mongo tools.

## Constitution

Article 1 (cycles), 2 (claiming; the watchdog starts members on workers), 3 (approval modes and what's never
delegable), 4 (the approver), 8 (stakeholders), 10 (questions include escalated proposals), 11 (tasks and their
history).

## Out of scope for 0.4.0

Interrupting members; GitHub-native merging; per-role models; a hosted request form; mutation testing.

## Checklist

### Phase 1: the task store and commands

- [x] `lib/tasks/model.ts`, `store.ts`, `files.ts`; `lib/commands/task.ts`
- [x] `team.json`: `board: "tasks"` (`"files"` is the same), `tasks`, `priorities`, `approval`, `mode`, `review.maxRounds`, `critical`; schema
- [x] guard: task, request and blast commands per role; `serve` is the operator's
- [x] merge queue closes tasks; journeys come due; verdict counts rounds
- [x] heartbeat renews claims; watchdog expires them; wake and session context summarise the graph
- [x] import of a files board; `e9g task graph` (BetterDiagrams)
- [x] prompts: the board section, commands; planner, builder, tester, reviewer, UX, innovator prompts
- [x] tests

### Phase 2: requests, approval, scoring, cycles

- [x] `lib/commands/request.ts`, `e9g request`; stakeholders kept apart
- [x] approver role and prompt; approval modes in code
- [x] scoring, Musk gate, priority
- [x] cycles mode: `e9g cycle close`, idle, watchdog
- [x] `e9g serve`
- [x] tests

### Phase 3: review and blast radius

- [x] `lib/blast.ts`, `e9g blast`; submit stores ui and critical
- [x] `plugin/skills/review/SKILL.md`; reviewer prompt; rounds in code
- [x] view checks in `e9g verdict` (needs `lib/blast.ts`)
- [x] tests

### Phase 4: Mongo and machines

- [x] `lib/tasks/mongo.ts` (optional `mongodb` dependency, loaded only when used); `e9g connect mongo`
- [x] machine identity; lead-only merges; worker registration and slot filling; submit pushes, lead fetches
- [x] self-install copies production dependencies
- [x] tests (a fake collection)

### Phase 5: documents and release

- [x] constitution, README, docs/team.md, CHANGELOG, setup agent, templates, `e9g check` cases and summary
- [x] version 0.4.0 in package.json and plugin.json
- [x] full suite (326 tests)
- [x] audit (three independent auditors; findings fixed below)

## Audit

Three independent audits (the task graph core; Mongo, machines and installing; blast radius, `e9g serve`, the guard,
the prompts and the documents) found 31 bugs and a set of gaps. Fixed, each with a test where it can have one:

- **Races:** the board import (under a lock, and never twice from one file); claims on the same files (whoever sees
  the clash gives way); every task change re-checks its rule as it's written.
- **Status rules:** the merge queue doesn't close a task someone is building; a changes verdict applies only to a
  task in review; approval is cleared when a task goes back or is re-scored; journeys are due only when approved and
  done only once verified; nobody sets building by hand; zero-padded ticket numbers.
- **Machines:** branches are synced forward only, and only members' branches; every submit on a team on several
  machines pushes; a rework whose branch isn't on the remote fails loudly; the lead pushes before it closes tasks;
  workers count the threads they started, start at most one per slot each half hour, prune and trim their logs;
  `e9g upgrade` keeps a worker a worker; the lead's name is checked and kept.
- **Security and privacy:** `e9g serve` always asks for a token (made at start, or `E9G_SERVE_TOKEN`, never an
  argument); stakeholders live beside the run folder, refused by the guard by any path or glob; `--out` can't
  overwrite the team's files; connection strings are never shown with their password.
- **Review:** the view check fails closed and wants screenshots taken since the commit; the UI rule no longer counts
  API routes or models; the review skill's "fails without the change" step works; leases renew often enough
  however short they are.
- **Prompts and documents:** every command a prompt names exists and its role may run it; cycles teams get no
  finish line; the schema knows the approver.

### Second audit: each step of the plan against the code

Three more reviews (requests, serve and cycles; machines and Mongo; review and blast radius) and a read of the core
checked every claim above. Fixed, each with a test:

- **Separation of duties:** a member can't pose as the operator by clearing its `E9G_` variables; an approved task
  edited in what it is goes back for approving; a journey's tasks are approved after the journey (an approver can't
  release the tasks of a journey it may not approve), and a journey is done only once its tasks are and it's verified;
  `--closes` never closes a journey or a task never approved, and closes a branch's task only at the commit it
  submitted.
- **Journeys, requests and cycles:** a journey approved or unblocked after its tasks are done is due at once; one
  with no tasks left is named in the planner's context, which lists new requests too; a promoted request whose tasks
  were all rejected can be rejected; a cycle counts a task once, in the cycle it was done; the idle rule names only
  work the team can act on.
- **Machines:** the lead brings a branch to the remote's tip before it reviews or merges it (detaching a finished
  worktree that holds it), and refuses when it can't; it refuses to merge while the remote's integration branch has
  commits it doesn't; a merge whose push fails leaves its tasks open until one pushes; a worker's claim continues a
  branch with earlier work rather than resetting it, and fetches the integration branch for rework too; claims are
  matched by machine as well as worktree; the lease the heartbeat renews is the one the claim made; a lead with the
  file store is a problem, not a warning; Mongo tools and hosted connection strings fall under `hosted-data`.
- **Review:** pages under `routes/` (SvelteKit, Remix), plain-JS components, themes, the Tailwind config, styles
  modules and SVGs are UI; critical paths are reached through importers too; screenshots count only from when the
  task was handed in; the skill's "fails without the change" step starts from the merge base and handles renames and
  deletions.

## Revisions (operator, 2026-10-28)

- **Tests travel with risky code.** The reviewer judges each approved change's risk; a high-risk branch merges only
  with its own tests. No separate test tasks after the merge.
- **View checks** are the reviewer's judgment, by the skill, not a line count in code.
- **One lead** by setup discipline: no lease or machines collection.
- **Workers** run builders only.
- **Findings** other members file are the planner's to approve (`approval.findings`).
- **`e9g task migrate`** moves a graph between stores; a file store moved from is refused afterwards.
- **Stakeholder links:** each stakeholder's own link opens only the form and their own requests; the operator's token
  is the only one that approves or shows names.
- **Architecture:** every move is one table (`RULES` in `lib/tasks/model.ts`, walked whole by a test); history events
  record from, to and the commit; a journey's due date is computed; on several machines the lead reviews and merges
  the remote's copy of a branch and keeps none of its own. Not adopted: proving the operator by a terminal (agents'
  commands and yours run without one; the guard refuses a command that changes the `E9G_` variables instead).

## Spin test (2026-10-29)

A real team on a throwaway CLI (`tally`: --top, --csv, Unicode words, a stakeholder's request for leaving out common
words), factory 0.4.0, on this Mac's T3 Code. It ran unattended to done in 47 minutes:

- **What it did:** 18 agents, 216 model requests, about 121k output tokens, 44 agent-minutes. Eight tasks:
  - the brief's journey and its three tasks;
  - three findings members filed, one of them major (files that aren't UTF-8 were silently miscounted);
  - the tester's end-to-end spec of the journey.

  The finish line held, and the team stopped on its own. The planner recorded eight product decisions and kept
  polish to one round. The reviewer rated the critical path's changes high-risk, each with tests that fail without
  them. The guard refused agents once (email with no owner set).

- **What got in the way, now changed:**
  - The approver couldn't approve the brief's own journey, so the whole brief waited for the operator (8 minutes
    here; hours in a digest). A journey only groups tasks, so it needs no approval or score of its own; each of its
    tasks is approved as before.
  - `init` gave a command-line tool an environment, so every merge printed a failed restart. A tool with no app now
    gets none.
  - The rules named `CLAUDE.md` though the repository had none.
  - `--help` on a subcommand was refused.
  - A title starting with `--` was read as a flag.
- **Not changed:** the prompts. The planner, builders and reviewer made good calls on their own, and nothing in the
  run came from a prompt being too strict. Two planner lines that restated what the code enforces are gone.

## T3 Code 0.1.4 (2026-10-29)

T3 Code now delegates to linked machines, runs scheduled tasks and webhooks, gives agents a preview browser and
devices, and links and watches pull requests. The factory leans on it where that's simpler, and keeps what's its own:

- **Done:**
  - Members look at pages in T3 Code's browser.
  - The planner watches its pull request.
  - T3's tools are allowed by role, from a list.
  - The factory requires T3 Code 0.1.4 or newer.
- **Kept, with reasons:**
  - **Mongo stays the shared graph** for several machines and for a web view where others follow and contribute work
    (operator, 2026-10-29). Starting workers' builders through `delegate_task`'s `target.environmentId` instead of
    the workers' watchdog is the next step, to be tried on two machines.
  - **The watchdog keeps the planner's ticks.** They depend on the planner's state:
    - none while it's busy;
    - every 10 minutes when it's quiet;
    - the idle team woken by new work;
    - nightly when it's idle or done;
    - environment and stuck-member notes.

    A T3 scheduled task fires on a timer, and launchd has to stay anyway to watch T3 itself, the outbox and claims.

  - **The adapter keeps reading T3's database** for live threads and running members. `t3 thread … --json` now
    covers the same fields, but a CLI read that failed for a moment once started a second planner. `e9g doctor`'s
    contract check catches a schema change first.

## Third audit (2026-10-29)

Two reviews (the multi-machine path run end to end with a bare remote, two machine names and a fake Mongo; the core
rules against the commit before). Fixed, each with a test:

- **Separation of duties:**
  - a finding the planner rewrote is its own proposal;
  - nobody counts as the operator while any of a member's identity variables is set, and the guard's rule covers
    `/usr/bin/env`, `--unset`, `exec -c` and `cross-env` (and only the identity variables);
  - the approver has nothing to decide about a journey;
  - the operator setting a task approved approves it.
- **Work kept, never lost:**
  - a task being built or reviewed isn't re-scored;
  - releasing a claim always returns it;
  - on several machines every claim prepares its branch from the remote, and a rework refuses a copy that diverged;
  - submit builds on the last round;
  - conflicts go back as reworks;
  - approvals record their commit, so a merge after a re-review closes its task;
  - `e9g merge --push` closes what a failed push held.
- **Workers:**
  - their checkout catches up on claim;
  - their watchdog-started members' worktrees are pruned;
  - T3's own worktree cleanup is off for team projects;
  - delegating to another machine is refused until it's built.
- **Detection and docs:**
  - `init` drafts an environment unless a package says it's a tool or library;
  - tests in Go, Python, Ruby and Java count;
  - a document in a test folder doesn't;
  - a stakeholder link is made only for the person already on file at that address;
  - the prompts point the lead at `origin/<branch>` and describe the new conflict flow.
