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
  operator's own dev server and databases. A command-line tool or a library has none: `environment.script` and
  `afterMerge` stay `null` (the draft says so when it found nothing to run; check it's right).
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

Then ask for the standing direction, also in plain chat: what the product is for and who it serves, what wins when
goals conflict, and which kinds of question they want to decide themselves. The planner derives its product
decisions from this, so every principle they give here is a question it won't need to ask. Offer a draft from the
repository's docs and the goal for them to correct, rather than a blank page.

Then ask the rest with the AskUserQuestion tool:

- up to four questions per call;
- each with options;
- the option you recommend first and marked "(Recommended)";
- your detected value in its description.

Skip a question whose answer is obvious from the repository: state the assumption in a sentence instead. Ask
about a dozen questions at most, in this order:

| Topic        | What to settle                                                                                                                                                                                                 | Default                                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| How it works | A finish line the team works to and stops at, or open-ended building in cycles (`mode`)                                                                                                                        | A finish line, unless the goal is ongoing                                                                             |
| Finish line  | How done is proven: end-to-end journeys, page checks (`e9g pages`), the test suite passing, an empty ticket list, or a command of theirs                                                                       | From the goal                                                                                                         |
| Scope        | What the team may change, and what must stay untouched                                                                                                                                                         | The whole repository except the factory's files                                                                       |
| Team         | Which roles, and how many at once                                                                                                                                                                              | Planner, 2 builders, 1 reviewer, an approver; a UX specialist if there's a UI; a tester if there are end-to-end tests |
| Budget       | A cap on agent-hours or tokens, or a deadline: guidance for the planner in `brief.md`, which nothing enforces                                                                                                  | None, but show what similar runs cost (`e9g metrics` on other teams)                                                  |
| Branch       | The integration branch (never a protected one), its base, how often it's pushed, and a pull request to merge (`push.pullRequest`)                                                                              | A local branch, never pushed                                                                                          |
| Board        | The task graph (in the run folder, or Mongo for several machines), or GitHub issues with a label (posted where people read them; needs `gh`)                                                                   | The task graph; offer GitHub when the repository is on GitHub                                                         |
| Data         | What data the team may use, and whether it may reach outside APIs                                                                                                                                              | Seed or made-up data only, no real keys                                                                               |
| Contact      | Who hears from the team, and what's worth an interruption                                                                                                                                                      | The operator's email: done, and the questions the direction doesn't settle, together in one message                   |
| Taste        | A style guide, a rubric or reference pages                                                                                                                                                                     | The repository's design docs                                                                                          |
| Dependencies | May the team add packages?                                                                                                                                                                                     | Allowed                                                                                                               |
| Approval     | Who approves the planner's proposals: the operator, the approver up to a size, or the approver alone (`approval`)                                                                                              | The approver, up to size M; larger work to the operator                                                               |
| Machines     | One machine, or several sharing a task graph in Mongo with an always-on lead that merges (`tasks`, `push`): then `e9g connect mongo --machine <name>` on each, and `e9g register --worker` on all but the lead | One machine                                                                                                           |
| Critical     | Code whose every change gets the full review: auth, money, data, anything `CLAUDE.md` guards (`critical`)                                                                                                      | From `CLAUDE.md` and the docs                                                                                         |
| Policies     | Show the deny list, with what you detected marked, and ask what to unlock                                                                                                                                      | Everything outward stays denied                                                                                       |

Nothing enforces the budget. Say so when you ask: the planner reads it as guidance, and the operator watches
`e9g metrics` and pauses the team (`e9g pause`) when it's spent.

The policies are deploy, cloud, hosted-data, publish, github, messages and payments. Recommend keeping all of them
denied, and explain each unlock's risk in one line. Unlocking is the operator's call (Article 3); don't argue,
but say what a mistake would cost.

## 3. Write the team

In `.e9g/`, write:

- **`team.json`:** the rules. Use `docs/team.md`'s shape exactly, and keep the `factory` pin the draft wrote.
- **`brief.md`:** the operator's direction in their words, then what "done" means, the budget if they gave one,
  then what the team decides itself.
- **`direction.md`:** the standing direction from the interview, in the starter file's sections: principles, not
  features, each settling a family of questions. Don't tell the planner in the brief or its notes to send product
  questions to the operator as a rule; Article 3 and the direction already say which ones go.
- **`notes.md`:** what any member needs to know to work here: the environment, ports, commands, conventions and
  traps you found.
- **`rubric.md`:** a short UX rubric, if the product has a UI.
- **`roles/<role>.md`:** only for something one role needs that doesn't belong in `notes.md`.
- **`adapters/`:**
  - `env.sh` (`up`, `down`, `status`, `reset` and `restart` for the team's own environment);
  - `gate.sh` (what CI runs; `--quick` for the subset);
  - `after-merge.sh` (rebuild and recheck after a merge).

  Make them executable. `e9g check` runs `bash -n` on each, so a script that doesn't parse fails there, not
  mid-merge.

Keep facts in one place: limits, lanes and policies live in `team.json` only, and the compiled prompts carry them
to every agent.

## 4. Prove it

1. Commit `.e9g/` on the integration branch: `git add .e9g && git commit -m "E9G team: <name>"`. Members'
   worktrees, and the gate's, are made from that branch, so they need the rules and the adapters committed.
2. Run `e9g check --run` and fix what it reports until it passes, committing each fix. It validates the rules
   and the adapters, checks that they're committed, runs the guard's self-test, starts and stops the
   environment, and runs the gate on a fresh worktree of the integration branch.
3. Show the operator the summary it prints: what the team may and may not do.
4. Ask whether to start now. If yes, run `e9g register` and then `e9g start <name>`, and tell them how to watch it:
   `e9g status`, the T3 Code window, `e9g metrics`.

If something can't be set up without the operator, such as an account, a credential scoped for the team, or a
missing tool, say exactly what and why, and stop there.
