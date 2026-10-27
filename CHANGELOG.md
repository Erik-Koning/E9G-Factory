# Changelog

## Unreleased

- **The planner decides from the operator's direction, and asks for direction when it must ask.** A team's
  `.e9g/direction.md` (new, the operator's, with a starter from `e9g init` and a draft from setup) holds the
  standing direction: what the product is for, who it serves, what wins when goals conflict, what to decide without
  asking and what always to ask. The planner turns it into feature-by-feature decisions (Article 3). It looks a
  product question up, derives what the operator would choose, decides whatever a revert could undo before
  promotion, and records each decision with the direction it follows in `.e9g/decisions.md` (in its lane now).
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
  and `e9g check` shows it. The watchdog reads the setting from the registry, so `e9g register` passes on a change; a team registered
  on an older version keeps getting each message as it goes until it is upgraded.
- **Email from the factory, both ways.** `e9g connect email` keeps the operator's own Resend API key in the macOS
  Keychain, once a test email has gone through. The watchdog then emails its alerts (a planner waiting, stuck or
  unable to start; T3 Code down) and the planner's outbox, so they reach the operator away from the Mac. With a
  full-access key and the account's receiving domain, each email about a team can be answered: the watchdog reads
  what Resend received and passes to that team's planner only replies from the operator's address that its domain
  signed (DKIM) or that pass DMARC. Planners use the outbox while the operator's connection works (their context
  says so, from the watchdog's last send), and the operator gets a Mac notification when it doesn't. The outbox's
  emails are labelled like the planner's Gmail, `[E9G-Planner] [<team title>] …`; the watchdog's own alerts are
  `[<team title>] …`. `e9g doctor` shows the connection. The guard refuses agents `connect` and the Keychain
  commands.
- **WhatsApp, one way.** `e9g connect whatsapp` sends the same alerts and outbox from the operator's own WhatsApp
  Business number on Meta's Cloud API. It adds a utility template, `e9g_update`, to the account (a business may
  message someone first only with an approved one), keeps the access token in the Keychain, and sends a test once
  Meta approves the template. A planner's messages are about `E9G-Planner · <team title>` (the template's first
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
    shell, input redirects, `sh -c` anywhere, and wrapped commands (`pnpm --filter … exec`, `e9g lock … --`,
    `yarn workspace`, …); it judges each command in the directory it runs in; it keeps free text (commit messages,
    issue bodies) out of the factory's command rules, while a team's own rules still read it; it guards Monitor; and it covers more secret files and the factory's own
    folders (`~/.e9g`, `~/.claude`, T3 Code's home). Pausing a team stops new members and merges.
  - **No work is deleted.** Finished worktrees are removed only when git shows nothing in them to lose, by git
    itself; interrupted or failed members' are kept a week. The merge queue clears them too, since the launchd
    watchdog can't read a checkout in `~/Documents`. T3 Code is restarted only after two failed checks.
  - **T3 Code's settings are left alone** except the team's own instances and setup script: no forced model
    selection or auto-resume, and writes are locked.
  - **Setup works for any repository.** Drafted adapters parse (`e9g check` runs `bash -n`), drafts pin their
    version and keep tickets local, `--in-place` makes the integration branch, `e9g upgrade` runs in the version it
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
  - an older self-install no longer strands agents on this release (`bin/e9g.mjs`).
- **What the planner sends is labelled `E9G-Planner`:** the GitHub issues it opens carry the label, and its email
  subjects start with `[E9G-Planner]`, which the guard and `e9g check` hold it to (`lib/labels.ts`).
- **Fixed on the way:** `e9g metrics --team`, a dev checkout running its own code, `e9g env` arguments, `e9g lock`
  durations, `pages done` with nothing to check, the launcher and watchdog surviving a Homebrew node upgrade.

## 0.2.0: E9G Factory

The first release under this name. It grew out of a working kit ("t3-loop") that had run two teams: a
completeness loop on a production web app and a two-page concept build.

- **Two sources.** Everything generic is in the factory; everything about one repository is in its `.e9g/` folder
  (`team.json`, brief, notes, adapters). Nothing is copied into a repository any more:
  - the hooks and role prompts load from the factory as a Claude Code plugin (`--plugin-dir`, `--agent e9g:<role>`);
  - the engine runs as `e9g` commands.
- **The constitution.** [CONSTITUTION.md](CONSTITUTION.md) holds the purpose, the principles, and the articles every
  agent works under. The articles are compiled into each agent's system prompt with its team's rules, which are
  rendered from `team.json`, so prose and enforcement can't disagree.
- **Policies.** Outward-facing actions are denied by default and unlocked per team: deploy, cloud, hosted-data,
  publish, github, messages and payments. Adding dependencies is allowed unless a team denies it. Core rules are
  never unlocked.
- **Setup.** `e9g init` detects what it can, makes the team's own checkout, writes a draft `.e9g/`, and opens a setup
  agent that interviews the operator. `e9g check` proves the setup with a guard self-test generated from the rules,
  and `e9g doctor` checks the machine.
- **T3 Code as a dependency.** One adapter (`lib/t3.mjs`, now `lib/t3.ts`) and a declared supported range (`e9g.t3code`), checked by
  `doctor` and `register`.
- **Versions.** Releases install into `~/.e9g/versions/<version>`. Each team pins one, and `e9g upgrade` moves it.
- **Isolation.** Agents load only project settings: none of the operator's personal skills, plugins or hooks. Members
  other than the planner get only T3 Code's tools.
- **Engine.** The merge queue, page checks, metrics and the watchdog are rewritten in Node and share one config
  loader. They come with a test suite.
