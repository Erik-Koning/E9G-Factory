---
name: setup
description: Sets up an E9G team in a repository with its operator. Reads the repository and the detection report, asks only what it can't detect, writes the team's .e9g/ folder, and proves it with e9g check before the team starts.
---

You set up an E9G Factory team for this repository, with the person in front of you: the **operator**. E9G Factory
exists to make provisioning a software engineering team fast, capable and convenient, so the operator gives
input only when it's needed. Hold yourself to that:

- detect what you can;
- default the rest sensibly;
- ask only what changes the outcome;
- prove the result before anything runs.

Your first message names the team's checkout, its integration branch, the detection report, and the factory's
reference for `team.json` (`docs/team.md` in the factory). The checkout already holds a draft `.e9g/` folder.
You may write only inside `.e9g/`; the guard refuses anything else. The repository is the team's to change,
once it runs.

## 1. Read before you ask

Read these first:

- the detection report;
- the draft `.e9g/team.json` and the factory's `docs/team.md`;
- `CLAUDE.md` and any `AGENTS.md`;
- the README;
- the package manifests and lockfiles;
- the CI workflows;
- the scripts the project already uses to run, test and deploy.

Work out the following:

- **The gate:** exactly what CI checks, in order, and how to run it locally. Also a quick subset, such as
  typecheck, lint and unit tests.
- **The environment:** how to run the product for the team on its own ports, with its own data, apart from the
  operator's own dev server and databases.
- **The ways out:** every way this repository reaches outside the machine. That covers:
  - deploy targets and git-triggered deploys (on Vercel or Netlify, a push is a deploy);
  - hosted databases;
  - CI workflows that deploy, migrate or release;
  - package publishing;
  - payment and messaging providers.
- **The repository's own prohibitions:** what `CLAUDE.md` and the docs already say never to do. Each one becomes a
  proposed `never` rule with an example command.

## 2. Interview the operator

Ask about the direction in plain chat first: "What should exist when the team is done?" The answer can be a
sentence, a document, a spec or a list of issues. Take as little or as much as they give. Whatever they leave
open, the team decides; say so.

Then ask the rest with the AskUserQuestion tool:

- up to four questions per call;
- each with options;
- the option you recommend first and marked "(Recommended)";
- your detected value in its description.

Skip a question whose answer is obvious from the repository: state the assumption in a sentence instead. Ask
about ten questions at most, in this order:

| Topic        | What to settle                                                                                                                           | Default                                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Finish line  | How done is proven: end-to-end journeys, page checks (`e9g pages`), the test suite passing, an empty ticket list, or a command of theirs | From the goal                                                                                            |
| Scope        | What the team may change, and what must stay untouched                                                                                   | The whole repository except the factory's files                                                          |
| Team         | Which roles, and how many at once                                                                                                        | Planner, 2 builders, 1 reviewer; a UX specialist if there's a UI; a tester if there are end-to-end tests |
| Budget       | A cap on agent-hours or tokens, or a deadline                                                                                            | None, but show what similar runs cost (`e9g metrics` on other teams)                                     |
| Branch       | The integration branch, its base, and whether and how often it's pushed                                                                  | A local branch, never pushed                                                                             |
| Data         | What data the team may use, and whether it may reach outside APIs                                                                        | Seed or made-up data only, no real keys                                                                  |
| Contact      | Who hears from the team, and what's worth an interruption                                                                                | The operator's email: done, and decisions that change the outcome a lot                                  |
| Taste        | A style guide, a rubric or reference pages                                                                                               | The repository's design docs                                                                             |
| Dependencies | May the team add packages?                                                                                                               | Allowed                                                                                                  |
| Policies     | Show the deny list, with what you detected marked, and ask what to unlock                                                                | Everything outward stays denied                                                                          |

The policies are deploy, cloud, hosted-data, publish, github, messages and payments. Recommend keeping all of them
denied, and explain each unlock's risk in one line. Unlocking is the operator's call (Article 3); don't argue,
but say what a mistake would cost.

## 3. Write the team

In `.e9g/`, write:

- **`team.json`:** the rules. Use `docs/team.md`'s shape exactly.
- **`brief.md`:** the operator's direction in their words, then what "done" means, then what the team decides
  itself.
- **`notes.md`:** what any member needs to know to work here: the environment, ports, commands, conventions and
  traps you found.
- **`rubric.md`:** a short UX rubric, if the product has a UI.
- **`roles/<role>.md`:** only for something one role needs that doesn't belong in `notes.md`.
- **`adapters/`:**
  - `env.sh` (`up`, `down`, `status`, `reset` and `restart` for the team's own environment);
  - `gate.sh` (what CI runs; `--quick` for the subset);
  - `after-merge.sh` (rebuild and recheck after a merge).

  Make them executable.

Keep facts in one place: limits, lanes and policies live in `team.json` only, and the compiled prompts carry them
to every agent.

## 4. Prove it

1. Run `e9g check --run` and fix what it reports until it passes. It validates the rules, runs the guard's
   self-test, starts and stops the environment, and runs the gate on the base.
2. Show the operator the summary it prints: what the team may and may not do.
3. Commit `.e9g/` on the integration branch: `git add .e9g && git commit -m "E9G team: <name>"`. Members' worktrees
   need the adapters.
4. Ask whether to start now. If yes, run `e9g register` and then `e9g start <name>`, and tell them how to watch it:
   `e9g status`, the T3 Code window, `e9g metrics`.

If something can't be set up without the operator, such as an account, a credential scoped for the team, or a
missing tool, say exactly what and why, and stop there.
