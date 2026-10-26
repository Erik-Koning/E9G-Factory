# `.e9g/team.json` reference

A team's rules, in its checkout. Every part of the factory reads this file through one loader (`lib/config.ts`),
which fills in the defaults below and refuses a file with problems (`e9g check` lists them): a value of the wrong
type, a duration it can't read, a pattern that isn't a valid regular expression. An unknown key is only a warning,
and is ignored. Agents can't change the file; the guard reads the team checkout's copy, never a branch's. Editors
can validate it with `schema/team.schema.json` (the `$schema` key), which checks the same things, except what
needs two keys at once (an integration branch that's protected, two pages with the same id).

Durations are written `45m`, `6h`, `2d`, or as a number of minutes.

## A minimal team

```json
{
  "$schema": "https://raw.githubusercontent.com/Erik-Koning/E9G-Factory/main/schema/team.schema.json",
  "name": "shop-redesign",
  "owner": "you@example.com",
  "branch": "e9g/next",
  "roles": { "planner": {}, "builder": { "limit": 2 }, "reviewer": { "limit": 1 } },
  "gate": { "full": ".e9g/adapters/gate.sh", "quick": ".e9g/adapters/gate.sh --quick" },
  "finish": "pnpm test"
}
```

## Keys

**Identity**

| Key       | Default                    | Meaning                                                                                                                                                                         |
| --------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`    | (required)                 | Lowercase letters, digits and dashes, up to 31 characters. Names the team in `e9g` commands, T3 instances (`e9g-<name>-<role>`) and `~/.e9g/runs/<name>`                        |
| `title`   | `name`                     | Shown in T3 Code, emails (`[<title>] …`) and prompts                                                                                                                            |
| `owner`   | none                       | The operator's email: the only address the planner may write to                                                                                                                 |
| `factory` | the version `e9g init` ran | The E9G Factory version the team runs (`e9g versions`); `"dev"` for a linked source checkout. `e9g upgrade` moves it. Without one, the team runs whichever version registers it |

**Branches**

| Key                 | Default                                 | Meaning                                                                                                                                                                                                                        |
| ------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `branch`            | (required)                              | The integration branch, never one of `protectedBranches`. It changes only through `e9g merge` and the planner's own commits of its lane. The team's checkout stays on it, and `.e9g/` is committed there (`e9g check` says so) |
| `base`              | `"main"`                                | What the integration branch started from; page checks compare against it unless `pages.base` says otherwise                                                                                                                    |
| `protectedBranches` | `["main","master","production","prod"]` | Never pushed to or merged into by the team. `[]` protects none                                                                                                                                                                 |
| `push`              | `null`                                  | `null` means nothing leaves the machine. Otherwise `{"remote": "origin", "branch": <branch>, "every": "6h"}`: only the planner pushes, only that branch, at most that often                                                    |
| `branchPrefix`      | `"e9g"`                                 | Builders' default branch pattern `^<prefix>/b\d+-` (the number is the ticket); testers' `^<prefix>/t-`                                                                                                                         |

**The team**

| Key                     | Default                    | Meaning                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `board`                 | `"files"`                  | `"files"`: tickets in `.e9g/run/board/`. `{"github": {"label": "e9g"}}`: GitHub issues with that label and `<label>:triage\|ready\|building\|review\|blocked\|question\|proposal`; the issues the planner opens also carry `E9G-Planner`, as its email subjects do (`[E9G-Planner] [<title>] …`), so you can filter what the team sends |
| `model`                 | `"claude-opus-5-5"`        | The model the planner starts members with                                                                                                                                                                                                                                                                                               |
| `roles`                 | planner, builder, reviewer | Which roles the team has, and each one's settings. See below                                                                                                                                                                                                                                                                            |
| `review.required`       | `["builder"]`              | Roles whose branches need a reviewer's approval of the exact commit                                                                                                                                                                                                                                                                     |
| `review.removedPattern` | assertions, with a tester  | A regex; a branch that removes a line matching it needs a review whatever its role. A team with a tester gets one for assertion calls (`expect(`, `assert…(`, `should…(`, matchers such as `.toBe(`); `null` turns it off                                                                                                               |
| `polishRounds`          | `1`                        | Rounds of minor fixes per page or journey before the last audit (Article 9)                                                                                                                                                                                                                                                             |

**Checks and environment**

| Key                       | Default                       | Meaning                                                                                                                                                            |
| ------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gate.full`               | none                          | The checks CI runs. The merge queue runs it on every merged result                                                                                                 |
| `gate.quick`              | `gate.full`                   | What a builder or tester must pass before it may stop                                                                                                              |
| `gate.concurrency`        | `2`                           | How many gates run at once, across all worktrees (at least 1)                                                                                                      |
| `environment.script`      | none                          | The team's environment (`up`, `down`, `restart`, `reset`, `status`), run by `e9g env` from the team's checkout                                                     |
| `environment.health`      | `[]`                          | `http://` or `https://` URLs the watchdog checks; `any:<url>` accepts any HTTP answer. When one is down, it tells the planner                                      |
| `environment.needsDocker` | `false`                       | The watchdog starts Docker when it isn't running                                                                                                                   |
| `afterMerge`              | none                          | Run after each merge, under the app lock, with `BEFORE`, `AFTER` and `E9G_LIGHT`. Lines starting with `after:`, `journeys:` or `pages:` go into the merge's report |
| `finish`                  | none                          | The finish line: a command that exits 0 only when the work is done                                                                                                 |
| `progress`                | `finish` with `done`→`status` | Where the work stands, for `e9g progress`                                                                                                                          |
| `pages`                   | none                          | For `e9g pages` (see below); required when `finish` runs `e9g pages done`                                                                                          |
| `worktreeSetup`           | none                          | Run by T3 Code in every new member worktree (install dependencies)                                                                                                 |

**Rules**

| Key             | Default                                    | Meaning                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policies`      | all outward denied; `dependencies` allowed | Unlock (or deny) a policy: `{"deploy": "allow", "dependencies": "deny"}`. The policies: `deploy`, `cloud`, `hosted-data`, `publish`, `github`, `messages`, `payments`, `dependencies` (`lib/policies.ts`)                                                                                                                                                                                                            |
| `never`         | `[]`                                       | The team's own command rules: `{"rule": "<regex>", "reason": "<what the agent is told>", "example": "<a command it must refuse>"}`. `e9g check` tests each example. A rule is matched against one command at a time (wrappers such as `env`, `npx` and `pnpm --filter … exec` unwrapped), free text included: what `echo` writes, commit messages and issue bodies (the policies' command rules leave that text out) |
| `commandOwners` | `[]`                                       | Commands only some roles run: `{"rule": "<regex>", "roles": ["ux-specialist"], "reason": "…"}`. The roles are role names                                                                                                                                                                                                                                                                                             |
| `protect`       | `[]`                                       | Regexes over paths (from the checkout's root) written by the team's scripts only, such as a test runner's results                                                                                                                                                                                                                                                                                                    |

**Context and isolation**

| Key               | Default                                                                                 | Meaning                                                                                                                                                                                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs`            | `[".e9g/brief.md", ".e9g/notes.md"]`                                                    | What every member reads first. `CLAUDE.md` is always in context                                                                                                                                                                                                                          |
| `context`         | `[]`                                                                                    | `{"title": "Journeys", "command": "…"}`: commands whose output the planner sees at every session start (kept short)                                                                                                                                                                      |
| `vars`            | `{}`                                                                                    | Extra environment variables for every member, as text; `${home}` and `${run}` are replaced with the checkout and run folder. Names can't start with `E9G_` or `CLAUDE_`, which the factory and Claude Code set                                                                           |
| `isolation`       | `"strict"`                                                                              | `"strict"`: members load only the project's settings (`--setting-sources project`), not your personal skills, plugins or hooks, and members other than the planner see only T3 Code's tools (`--strict-mcp-config`). `"user"` loads your user settings too                               |
| `watchdog`        | `{"tickEvery": "10m", "stuckAfter": "45m", "pruneAfter": "1h", "doneTickEvery": "24h"}` | How often an idle planner is ticked, when silence counts as stuck, when finished members' worktrees are removed (only clean ones of completed members; an interrupted, failed or cancelled member's are kept a week, and any with work in them stay), and the nightly tick once complete |
| `startPrompt`     | a standard one                                                                          | The planner's first message                                                                                                                                                                                                                                                              |
| `t3ProjectId`     | assigned by register                                                                    | Only to reuse an existing T3 Code project                                                                                                                                                                                                                                                |
| `legacyInstances` | `{}`                                                                                    | `{"<old instance id>": "<role>"}`, so metrics and limits count members started on instances from before a migration                                                                                                                                                                      |

## Roles

Each entry in `roles` takes:

| Key         | Meaning                                                                                                                                                                                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `limit`     | At most this many at once (not for the planner). The guard counts them live in T3 Code                                                                                                                                                                           |
| `write`     | Regexes over paths the role may write, or `"*"` for anything. The factory's own files (`.e9g/`, `.claude/settings*.json`, `.claude/hooks/`, `.claude/agents/`) stay closed unless a rule names the path itself, like the planner's default `^\.e9g/lessons\.md$` |
| `deny`      | Regexes the role may never write, even inside `write`                                                                                                                                                                                                            |
| `branch`    | The role's branch pattern (builders and testers)                                                                                                                                                                                                                 |
| `mcp`       | Outside tools the role may call. The planner has the Gmail tools by default; the guard lets email go only to `owner`                                                                                                                                             |
| `readOnly`  | Changes nothing in the checkout, not even its git state. The default for reviewer, ux-specialist and innovator                                                                                                                                                   |
| `compactAt` | (planner) T3 Code compacts the planner's context at this many tokens (default 160000)                                                                                                                                                                            |

The roles are planner, builder, tester, reviewer, ux-specialist and innovator. Their prompts are in the factory
(`plugin/agents/<role>.md`). What one team adds for a role goes in `.e9g/roles/<role>.md`, which is compiled into
that role's prompt.

## `pages`

For teams whose finish line is a set of pages (`"finish": "e9g pages done"`). `list` is required and names at least
one page; `e9g pages` refuses to call an empty list done.

```json
"pages": {
  "appUrl": "http://localhost:3200",
  "base": "main",
  "content": ["src/app/(concept)/", "src/components/concept/"],
  "allowedChanges": ["^src/app/\\(concept\\)/", "^src/components/concept/"],
  "list": [
    { "id": "landing", "path": "/concept", "title": "Landing", "exclude": ["settings/"] },
    { "id": "settings", "path": "/concept/settings" }
  ],
  "viewports": [{ "id": "desktop", "width": 1440, "height": 900 }],
  "schemes": ["light", "dark"],
  "ignoreConsole": ["/api/auth/get-session"],
  "settleMs": 1500
}
```

- **What a page's result depends on:** the files under `content`, minus its own `exclude`, so a change to one
  page doesn't make another's verdict stale.
- **A page:** `id` (letters, digits, `_` and `-`: it names the page's results, screenshots and UX verdict), `path`
  (from `/`), an optional `title`, and `exclude`.
- **`allowedChanges`:** where the branch may differ from `base` (`pages.base`, else the team's `base`). Anything
  else keeps the finish line from holding.
- **Defaults:** viewports are 1440, 1024 and 390 (the phone at device scale 2); schemes are light and dark
  (`no-preference` is the third).

## The `.e9g/` folder

| Path                    | Who writes it          | What it is                                                                             |
| ----------------------- | ---------------------- | -------------------------------------------------------------------------------------- |
| `team.json`             | the operator           | The rules                                                                              |
| `brief.md`              | the operator           | The direction, as long or short as the project needs                                   |
| `notes.md`              | the operator           | What any member needs to know: the environment, commands, conventions, traps           |
| `rubric.md`, `style.md` | the operator           | Taste: the UX rubric and style guide (listed in `docs`)                                |
| `roles/<role>.md`       | the operator           | Additions to one role's prompt                                                         |
| `lessons.md`            | the planner            | Durable lessons, compiled into every member's prompt                                   |
| `adapters/`             | the operator           | `env.sh`, `gate.sh`, `after-merge.sh`, and the team's own finish checker if it has one |
| `.gitignore`            | the factory            | Ignores `run/`                                                                         |
| `run/`                  | the factory's commands | State, the files board, locks, the merge worktree, screenshots, scratch                |
