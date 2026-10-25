# Changelog

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
- **T3 Code as a dependency.** One adapter (`lib/t3.mjs`) and a declared supported range (`e9g.t3code`), checked by
  `doctor` and `register`.
- **Versions.** Releases install into `~/.e9g/versions/<version>`. Each team pins one, and `e9g upgrade` moves it.
- **Isolation.** Agents load only project settings: none of the operator's personal skills, plugins or hooks. Members
  other than the planner get only T3 Code's tools.
- **Engine.** The merge queue, page checks, metrics and the watchdog are rewritten in Node and share one config
  loader. They come with a test suite.
