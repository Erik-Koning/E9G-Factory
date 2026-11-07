# Changelog

## 0.5.0: Anything Factory

- **The factory has a new name.** It's Anything Factory, and its CLI is `a6g`. The name changed everywhere it's used,
  so every one of these moves with it: the home (`~/.a6g`) and the launcher, a team's `.a6g/` folder and its
  `a6g/next` branch and `a6g/` branch prefix, the `A6G_*` environment variables, the plugin (`a6g:review`), the watchdog
  (`ca.a6g.watchdog`), T3 instances (`a6g-<team>-<role>`), Keychain entries, the task graph's and the web app's databases
  (`a6g`, `a6g_web`), the web app's headers (`x-a6g-*`) and its SST app (`a6g-web`). Nothing moves by itself: an
  existing team, install or deployed stage has to be moved to the new names before it runs this release. Releases before
  this one can't share a home with it, so the launcher no longer falls back to a JavaScript entry point (`bin/a6g.ts` only).
- **Nothing reaches the operator without a reason and a recommendation.** Moving a task to `question` (`a6g task
status`, the approver's `escalate`) refuses without `--reason` and `--recommend`; the task keeps both (`ask`), and
  `a6g task ask` gives them to one raised before. A blocked task is the planner's to sort unless it's raised with a
  recommendation. The web app's inbox lists only what was raised, and always shows why and what the team recommends
  (saying so when an older task has neither).
- **Tasks that wait on others settle themselves.** `a6g task status <id> blocked --waits-on <ids> --then
close|resume`: once they're done the task closes (folded into them) or goes back to work, and once one is rejected
  it goes back to the planner, by the merge queue as it merges and by the watchdog every minute (`settleWaits`). A
  blocked task can say again what it's blocked on, in place.

- **Waiting on you, in the web app.** Every question the planner or the approver puts to the operator, and every
  blocked task, on one page per team and one for all of them, counted in the header of every page. A question shows why
  it's the operator's, its options read out of it as choices with the team's recommendation marked, what it holds up and
  the other questions it mentions. The answer (`lib/tasks/answer.ts`) is a note by the operator marked as one, leaving
  the task where it is; the watchdog passes new answers to the planner within a minute (`lib/answers.ts`, on its
  every-minute run too), and the planner's prompt says they're on the task already.
- **Notifications.** Each person chooses what they're emailed about (questions, blocked work, journeys done, a team
  pausing or finishing, merges, their requests): at once, in a daily digest at their hour and time zone, or not at all,
  per team, with defaults by role and a test email. The web app's notifier works the events out of each team's
  history, queues each once per person, and sends under a lease, one container at a time.

## 0.4.0: The task graph, feature requests, cycles and machines

- **The board is a task graph.** Every piece of work is a task, one document each (`board: "tasks"`; `"files"` means
  the same), with a status, who holds it on which machine, and its history. `a6g task` adds, shows, edits, scores,
  moves, approves, claims, submits and graphs them, each verb checked against the caller's role and the task's status
  in code (the guard holds the roles too), and every write is refused if the task changed since it was read. Tasks
  live in the run folder (`~/.a6g/runs/<team>/tasks/`), where the launchd watchdog can read them and agents can't
  write. A 0.3 files board is imported ticket by ticket the first time a command opens the graph, keeping its numbers.
  `a6g task graph` writes a BetterDiagrams document: a band per journey, columns by dependency.
- **Proposals are scored and approved.** The planner passes new work through a gate (who asked and why, what could be
  deleted or simplified instead, the simplest version) and scores it 0–3 on pain, reach, revenue, wow, distribution,
  leverage, urgency and risk, with a confidence and a size; the command computes the priority from `priorities`
  weights. A new role, the **approver**, approves, rejects, sends back for research or escalates proposals, within
  `approval`: `"thresholds"` (the default, up to `maxSize`; a journey only groups tasks, so it needs no approval of its own), `"operator"` or `"full"`. The planner
  never approves its own, and approves the findings other members file (`approval.findings`, `"approver"` to send them
  with the proposals). Every move of a task, by whom and from where, is one table (`lib/tasks/model.ts`), and each
  history event records the statuses it went between.
- **Members claim their work.** Builders and testers run `a6g task claim`: the next approved task their role builds,
  blockers then majors then priority, never two on the same files, with dependencies (`--after`) done first. A lease
  (`watchdog.stuckAfter`) is renewed by the heartbeat hook and expired by the watchdog. `a6g task submit` hands it in
  for review; the Stop hook won't let a member finish holding a claim. The merge queue marks what it merges done, and a
  journey whose tasks are all done is due its verification (worked out from them, never stored). A task edited in what it is (its title,
  body or kind) or scored again is approved again before it's built, and a finding the planner rewrote is its own
  proposal, for the approver.
- **Review persists.** A review skill ships in the plugin (`a6g:review`): blast radius first, then goals, edge cases,
  tangential code, tests that fail without the change, a before-and-after look at anything a person sees (the
  reviewer judges when; `--shots` records what it read), and how much the change could break. `a6g blast` computes the
  blast radius: importers (two levels, relative imports and tsconfig paths), files that usually change together,
  their tests, UI and `critical` paths. An approval says its risk (`--risk low|medium|high`), and the merge queue
  merges a high-risk change only with its own tests in the branch; a changes verdict sends a task in review back for
  rework, and blocks it after `review.maxRounds` (3) rounds.
- **Feature requests.** `a6g request` keeps stakeholders' requests; the planner researches each and promotes it into
  tasks (`a6g task add --request`) or rejects it. Stakeholders' names and addresses stay with the operator: agents see
  an id and a role (Article 8). `a6g serve` is the operator's page: the request form, proposals to approve, the board
  and the graph, behind the operator's token. Each stakeholder can have a link of their own (`a6g request stakeholders
add`), which opens only the form and their own requests and attributes what they send.
- **Cycles.** `mode: "cycles"` takes away the finish line: the planner builds, verifies journeys, sweeps for
  regressions and closes each cycle with `a6g cycle close`, whose report goes to the operator; an idle team is woken by
  new requests and tasks.
- **Several machines.** `tasks.store: "mongo"` keeps the graph in MongoDB (`a6g connect mongo`; the optional
  `mongodb` driver loads only then). With `tasks.lead`, the lead merges and pushes the integration branch; workers
  (`a6g register --worker`) run builders that their watchdog starts, which make their branches from the remote and
  push them on submit. The lead reviews and merges the remote's copy of each branch (it keeps none of its own),
  refuses to merge while the remote's integration branch has commits it doesn't, and closes a merge's tasks only once
  it's pushed. `a6g task migrate --to mongo` moves a team's graph there, ids and all.
- **The constitution** gains the task graph, approval and cycles: Articles 1, 2, 3, 4, 8, 10 and 11.
- `a6g self-install` copies every production dependency it finds installed, without needing npm.
- **T3 Code 0.1.4 or newer.** Its tools are allowed by role, from a list: every member may look with T3 Code's
  preview browser, devices and HTML previews (the review skill, the builder and the UX specialist look at pages
  there, at each size and theme, with `a6g pages shots` as the fallback); the planner also runs its members through
  `delegate_task` and watches its pull request, so the operator's comments and reviews wake it. T3 Code's own
  worktree cleanup is off for team projects: the factory keeps the worktrees that hold work. Nobody starts threads around the team's limits (`create_threads`, `t3_thread_launch`),
  schedules work, changes projects, environments or threads' settings, or asks the operator for a secret.
- **On several machines,** every claim makes its branch from the remote, on the lead too, and a rework refuses a
  local copy that went its own way; submit refuses a rework that doesn't build on its last round, and pushes only
  over the copy the claim fetched. A branch that conflicts sends its task back to be claimed and rebased; a review
  approval records the commit it approved, so merging it (or its rebase, `--rebased-from`) closes the task;
  `a6g merge --push` closes what a failed push held open. A worker's claim brings its checkout up to the remote's
  integration branch, and its watchdog's members' worktrees are pruned like any others. `a6g task migrate` wants
  the team paused. The guard refuses `delegate_task` to another machine for now.
- `a6g init` gives a library or command-line tool (no UI, no dev or start script, no HTML) no environment and no
  after-merge restart; the rules name `CLAUDE.md` only when the repository has one; `--help` works on every `a6g task`
  and `a6g request` command; and text that starts with `--` (a title like "--skip-common leaves out common words")
  is read as text.
- The guard refuses a command that sets, unsets or clears the `A6G_` variables a member is known by (without them,
  the factory's commands would take it for the operator), and, under the `hosted-data` policy, Mongo tools and
  connection strings for a hosted server.
- `a6g serve` always asks for a token (made at start, or `A6G_SERVE_TOKEN`), so agents on the same machine can't
  approve their own work through it; stakeholders' details live beside the run folder, where the guard refuses them.

### Also in this release: the planner's pull request, and a heartbeat

- **The planner opens a pull request for the operator to merge.** `team.json` `push.pullRequest` (`true` for
  `base`, or a branch name) gives the planner `a6g pr --title "…" --body-file <file>`. After a push, it opens a
  pull request from the pushed branch into that one, or updates the open one, so the operator has one to read at a
  time and merging it is their promotion (Article 3). Its title carries `[A6G-Planner] [<team title>]`, and its body
  ends with the commit it holds (read from the remote, with any newer commits not yet pushed), and with the
  planner's thread. The factory runs `gh` for it, so the `github` policy stays denied: `gh pr create` and
  everything else gh does beyond issues stay refused. Only the planner runs it (the guard, and the command itself).
  Its rules describe it, the Done report links it, each cycle's close updates it, and `a6g check` proves who may run
  it, and warns when the remote isn't GitHub or `gh` is missing. A pull request the operator opened (no
  `[A6G-Planner]` in its title) keeps their title and description, and the planner's report goes in a comment; a
  fork's pull request from a branch of the same name is left alone. On several machines, where the lead pushes after
  every merge, its footer says when it was written, and `push.branch` must be the integration branch.
- **A heartbeat, for when the Mac itself stops.** `a6g connect heartbeat <url>` keeps a check's ping URL
  (healthchecks.io, or any service like it) once a test ping goes through. The watchdog pings it at the end of every
  run of every team in which T3 Code answers. When the pings stop, because the Mac is off, asleep or at the login
  screen, the watchdog stopped, or T3 Code won't start, the service alerts the operator: the one alert the factory
  can't send itself. A failing ping is logged at most hourly. `a6g connect` and `a6g doctor` show when it last
  went through, and `a6g disconnect heartbeat` turns it off. It says the Mac's watchdog runs, not that every team is
  well, and each machine needs a check of its own.

## 0.3.1: The planner decides from direction, and writes less often

- **The planner decides from the operator's direction, and asks for direction when it must ask.** A team's
  `.a6g/direction.md` (new, the operator's, with a starter from `a6g init` and a draft from setup) holds the
  standing direction: what the product is for, who it serves, what wins when goals conflict, what to decide without
  asking and what always to ask. The planner turns it into feature-by-feature decisions (Article 3). It looks a
  product question up, derives what the operator would choose, decides whatever a revert could undo before
  promotion, and records each decision with the direction it follows in `.a6g/decisions.md` (in its lane now).
  A question it does ask also asks for the principle behind the answer, with candidate principles, so the next
  question like it is settled without asking. Questions open together go in one message, not one each
  (Article 10). The operator's answers go in `decisions.md` in their words, and the planner re-checks its open
  questions against each. Both files are compiled into every member's prompt (the starter's comments aren't), and
  the Done report lists the calls the planner made so the operator can overturn any before promoting.
- **How often the planner writes: digest or priority.** `team.json` `contact` sets it. `"digest"` (the default):
  at most one message per `every` (default `4h`), with every open question in it. A subject starting `Urgent:` goes
  at once, one per window, and `Done` always goes. `"priority"`: each message goes as soon as the planner sends it.
  The guard refuses the planner's own Gmail before the window opens, and a new hook (`sent.ts`) records only the
  sends that went. The watchdog holds outbox drafts until the window opens, then sends them as one message (one Mac
  notification for them all). The planner's context says when the next message can go, its rules carry the mode,
  and `a6g check` shows it. The watchdog reads the setting from the registry, so `a6g register` passes on a change; a team registered
  on an older version keeps getting each message as it goes until it is upgraded.
- **Email from the factory, both ways.** `a6g connect email` keeps the operator's own Resend API key in the macOS
  Keychain, once a test email has gone through. The watchdog then emails its alerts (a planner waiting, stuck or
  unable to start; T3 Code down) and the planner's outbox, so they reach the operator away from the Mac. With a
  full-access key and the account's receiving domain, each email about a team can be answered: the watchdog reads
  what Resend received and passes to that team's planner only replies from the operator's address that its domain
  signed (DKIM) or that pass DMARC. Planners use the outbox while the operator's connection works (their context
  says so, from the watchdog's last send), and the operator gets a Mac notification when it doesn't. The outbox's
  emails are labelled like the planner's Gmail, `[A6G-Planner] [<team title>] …`; the watchdog's own alerts are
  `[<team title>] …`. `a6g doctor` shows the connection. The guard refuses agents `connect` and the Keychain
  commands.
- **WhatsApp, one way.** `a6g connect whatsapp` sends the same alerts and outbox from the operator's own WhatsApp
  Business number on Meta's Cloud API. It adds a utility template, `a6g_update`, to the account (a business may
  message someone first only with an approved one), keeps the access token in the Keychain, and sends a test once
  Meta approves the template. A planner's messages are about `A6G-Planner · <team title>` (the template's first
  parameter, so the approved template stays as it is). The `messages` policy now also refuses the Graph API's
  messages from the shell.

## 0.3.0: TypeScript, and a second audit

- **TypeScript, the way T3 Code writes it.** Node (22.18 or newer) runs the `.ts` files as they are, with no build
  step; `tsc` 7 checks them with T3 Code's compiler settings, before the tests. The launcher, hooks and watchdog run
  with Node's compile cache, so a guard call costs what it did. Versions before this one are `.mjs`; the launcher,
  the hand-over to a pinned version and the watchdog find either.
- **Three independent audits** (the guard, the engine, setup) found 64 defects, reproduced most of them, and each
  has a regression test (`test/audit-guard.test.ts`, `audit-engine.test.ts`, `audit-setup.test.ts`).
  - **Members start in their own worktree.** The planner was never told to pass `isolation: "worktree"` to
    `delegate_task`, so T3 Code ran some builders in the team's own checkout; one renamed a team's integration
    branch. The prompt says so now, the guard refuses a builder or tester started without it, and nobody on a team
    renames, deletes or resets the integration branch.
  - **Nothing unreviewed merges.** A review verdict names the commit the reviewer read (`--sha`) and must be the
    branch's tip; `--rebased-from` checks every git call and the approved commit; diffs are read whole and paths
    with `-z`; symlinks into the factory's files and changes to `protect` paths are refused; two merges can't share
    a lock slot.
  - **The guard fails closed.** Any error in it refuses the call. It reads shell comments, here-documents fed to a
    shell, input redirects, `sh -c` anywhere, and wrapped commands (`pnpm --filter … exec`, `a6g lock … --`,
    `yarn workspace`, …); it judges each command in the directory it runs in; it keeps free text (commit messages,
    issue bodies) out of the factory's command rules, while a team's own rules still read it; it guards Monitor; and it covers more secret files and the factory's own
    folders (`~/.a6g`, `~/.claude`, T3 Code's home). Pausing a team stops new members and merges.
  - **No work is deleted.** Finished worktrees are removed only when git shows nothing in them to lose, by git
    itself; interrupted or failed members' are kept a week. The merge queue clears them too, since the launchd
    watchdog can't read a checkout in `~/Documents`. T3 Code is restarted only after two failed checks.
  - **T3 Code's settings are left alone** except the team's own instances and setup script: no forced model
    selection or auto-resume, and writes are locked.
  - **Setup works for any repository.** Drafted adapters parse (`a6g check` runs `bash -n`), drafts pin their
    version and keep tickets local, `--in-place` makes the integration branch, `a6g upgrade` runs in the version it
    moves to, `self-install` replaces a release by rename, and normalize checks every key the way the schema does.
- **A review of those fixes** by three more reviewers found 38 more, fixed with tests too (`test/review-*.test.ts`,
  `test/shell.test.ts`; 239 tests in all). Among them:
  - the guard's hook blocks when it fails or times out (`onFailure: "block"`);
  - operator commands refuse inside a team;
  - live keys and hosted database addresses are caught in free text, and a team's own rules read free text again;
  - the prune never deletes untracked work, and the launchd watchdog never reaches into a checkout (the merge queue
    clears finished worktrees instead);
  - lock takeover is independent of the time zone, and verdicts take commit ids only;
  - team.json that 0.2.0 loaded loads again (number vars, unknown nested keys as warnings);
  - an older self-install no longer strands agents on this release (`bin/a6g.mjs`).
- **What the planner sends is labelled `A6G-Planner`:** the GitHub issues it opens carry the label, and its email
  subjects start with `[A6G-Planner]`, which the guard and `a6g check` hold it to (`lib/labels.ts`).
- **Fixed on the way:** `a6g metrics --team`, a dev checkout running its own code, `a6g env` arguments, `a6g lock`
  durations, `pages done` with nothing to check, the launcher and watchdog surviving a Homebrew node upgrade.

## 0.2.0: Anything Factory

The first release under this name. It grew out of a working kit ("t3-loop") that had run two teams: a
completeness loop on a production web app and a two-page concept build.

- **Two sources.** Everything generic is in the factory; everything about one repository is in its `.a6g/` folder
  (`team.json`, brief, notes, adapters). Nothing is copied into a repository any more:
  - the hooks and role prompts load from the factory as a Claude Code plugin (`--plugin-dir`, `--agent a6g:<role>`);
  - the engine runs as `a6g` commands.
- **The constitution.** [CONSTITUTION.md](CONSTITUTION.md) holds the purpose, the principles, and the articles every
  agent works under. The articles are compiled into each agent's system prompt with its team's rules, which are
  rendered from `team.json`, so prose and enforcement can't disagree.
- **Policies.** Outward-facing actions are denied by default and unlocked per team: deploy, cloud, hosted-data,
  publish, github, messages and payments. Adding dependencies is allowed unless a team denies it. Core rules are
  never unlocked.
- **Setup.** `a6g init` detects what it can, makes the team's own checkout, writes a draft `.a6g/`, and opens a setup
  agent that interviews the operator. `a6g check` proves the setup with a guard self-test generated from the rules,
  and `a6g doctor` checks the machine.
- **T3 Code as a dependency.** One adapter (`lib/t3.mjs`, now `lib/t3.ts`) and a declared supported range (`a6g.t3code`), checked by
  `doctor` and `register`.
- **Versions.** Releases install into `~/.a6g/versions/<version>`. Each team pins one, and `a6g upgrade` moves it.
- **Isolation.** Agents load only project settings: none of the operator's personal skills, plugins or hooks. Members
  other than the planner get only T3 Code's tools.
- **Engine.** The merge queue, page checks, metrics and the watchdog are rewritten in Node and share one config
  loader. They come with a test suite.
