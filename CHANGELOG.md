# Changelog

## 0.3.0: TypeScript, and a second audit

- **TypeScript, the way T3 Code writes it.** Node (22.18 or newer) runs the `.ts` files as they are, with no build
  step; `tsc` 7 checks them with T3 Code's compiler settings, before the tests. The launcher, hooks and watchdog run
  with Node's compile cache, so a guard call costs what it did. Versions before this one are `.mjs`; the launcher,
  the hand-over to a pinned version and the watchdog find either.
- **Three independent audits** (the guard, the engine, setup) found 64 defects, reproduced most of them, and each
  has a regression test (`test/audit-guard.test.ts`, `audit-engine.test.ts`, `audit-setup.test.ts`; 161 tests).
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
    issue bodies) out of the rules; it guards Monitor; and it covers more secret files and the factory's own
    folders (`~/.e9g`, `~/.claude`, T3 Code's home). Pausing a team stops new members and merges.
  - **No work is deleted.** Finished worktrees are removed only when git shows nothing in them to lose, by git
    itself; interrupted or failed members' are kept a week. The merge queue clears them too, since the launchd
    watchdog can't read a checkout in `~/Documents`. T3 Code is restarted only after two failed checks.
  - **T3 Code's settings are left alone** except the team's own instances and setup script: no forced model
    selection or auto-resume, and writes are locked.
  - **Setup works for any repository.** Drafted adapters parse (`e9g check` runs `bash -n`), drafts pin their
    version and keep tickets local, `--in-place` makes the integration branch, `e9g upgrade` runs in the version it
    moves to, `self-install` replaces a release by rename, and normalize checks every key the way the schema does.
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
