---
name: review
description: The E9G reviewer's procedure for one branch — blast radius first, then goals, edge cases, tangential code, tests, a before-and-after look at anything a person sees, and a judgment of how much it could break — persisting until each holds or the branch goes back with a numbered list. Use for every review on an E9G team.
---

# Reviewing a branch

You approve a branch only when every section below holds. Persistence is the job: a check you skip is a defect you
approve. Don't stop at the first problem: finish every section, then send the whole list back at once, so the next
round is the last. Work from the exact commit you review (`git rev-parse <branch>`, or the commit `e9g task fetch <id>` prints on a team on several machines, noted before
you start) in a
detached copy (`git worktree add --detach /tmp/review-<n> <sha>`), and remove the copy before you answer.

## 1. Know what it touches

Run `e9g blast <sha>` in the detached copy (`--json` for the whole lists): it reads the files there, so it sees the
commit you review. It lists the files changed, what imports
them (two levels), what usually changes with them, the tests among those, whether it touches UI and how much, and
which of the team's critical paths it reaches. Everything after this is scoped by it: the importers and related
files are the tangential code you check, and its tests are the ones you run. A change that reaches a critical path
gets every section in full, whatever its size.

## 2. It does what the task asks

Read the task (`e9g task show <id>`: the number in the branch's name): its outcome, what done looks like, its notes
(earlier rounds' findings, the approver's note) and the journey it belongs to. Check that every part is done, that
nothing unrelated came along, and that earlier rounds' findings are fixed rather than moved. A partial fix is
"changes".

## 3. It handles the edges

List the edge cases before you read the code, from the task, the documents and the domain: empty, one, many and too
many; missing, malformed and hostile input; slow, failing and repeated network calls; concurrent use; a second tab
or device; expired sessions and links; permissions (another role's URLs); time zones, locales and long text; phone
width and reduced motion. Then find where the code handles each, or doesn't. Exercise the risky ones in the detached
copy rather than reasoning about them.

## 4. It works with the code around it

For each importer and related file from the blast radius: does it still get what it expects (types, shapes, timing,
errors, events, side effects)? Read the call sites, not just the changed function. Run the tests that cover them
(the blast radius's tests, and the suite for any critical path) in the detached copy. A change that breaks a
connection, or changes a contract without updating every caller, is "changes", even when the gate passes.

## 5. It has the tests it needs

- New behaviour has tests at the right level: unit tests for logic, integration tests for wiring, and end-to-end or
  Playwright specs for a flow a person goes through. Bug fixes have a test that reproduces the bug.
- **The tests fail without the change.** In the detached copy, put the code back as the branch found it and keep the
  new tests. The branch's starting point is `base=$(git -C /tmp/review-<n> merge-base <integration> <sha>)` (not the
  integration branch's tip, which may have moved on). List what the branch changed, renames as a delete and an add:
  `git -C /tmp/review-<n> diff --name-status --no-renames $base <sha>`. For each file that isn't a test: `M` or `D`,
  `git -C /tmp/review-<n> checkout $base -- <file>`; `A`, delete it. Run the new tests: they must fail, for the right
  reason. Then put the branch back (`git -C /tmp/review-<n> reset -q --hard <sha> && git -C /tmp/review-<n> clean -fdq`).
  A test that passes on the old code proves nothing.
- Nothing is weakened: no skipped, loosened or deleted assertions, no longer timeouts to hide flakiness.

## 6. It looks right (anything a person sees)

Whether to look is your call, and it's rarely "no": look whenever the change could alter what a person sees (a
page, a component, styles, a theme or design tokens, copy, layout, an empty, loading or error state), however few
lines it is, since a two-line token change can restyle every page. Skip it only when you can say why nothing
visible changed (a comment, a test, server code no page renders differently), and say so in your note. Start the
app from the detached copy on a port of your own (the team's notes say how), and look at every affected page at the
base and at the branch, on desktop and phone, light and dark, in T3 Code's browser:

- `mcp__t3-code__preview_open`, then `preview_navigate` with `target: {kind: "environment-port", port: <yours>}`;
- `preview_resize` (`{mode: "freeform", width: 1280, height: 800}` for desktop, `{mode: "preset", …}` for a phone);
- `preview_set_appearance` `"light"` and `"dark"`;
- `preview_snapshot` with `save: true` for each, which returns the screenshot's path, and `preview_act` to reach
  the states that need a click or typing.

Without T3 Code's browser, `e9g pages shots --base <url> --out <dir>` takes the same screenshots. Look at every
screenshot, then compare the pairs:

- the change looks as the task and the rubric intend, pixel for pixel: alignment, spacing, type, colour and contrast
  in both themes, nothing clipped, overlapping or cut mid-word at any width;
- nothing else on the page moved that the task didn't ask for;
- states exist and read well: loading, empty, error, success, and long or missing content;
- keyboard focus is visible and the tab order makes sense.

Record what you looked at with your verdict (`--shots "<the screenshots' folder, or the pages, sizes and themes you
checked>"`); an approval of a UI change without it is said so to the planner.

## 7. The repository's own rules

`CLAUDE.md` above all its privacy, security, data and authorization rules; the lane (only the paths the builder's
lane allows, no new dependencies unless the team allows them); the codebase's way (helpers and components reused,
naming and comments like the code around them, no dead code, honest types); accessibility in the code (semantics,
labels, keyboard handling, reduced motion).

## 8. How much could break

Judge the change's risk now that you've read it, and say it with your approval:

- **high:** it touches money, sign-in or permissions, people's data or its migrations, concurrency or caching, code
  many files import, one of the team's critical paths, a flow people depend on, or code that has broken before
  (`git log` on it); or a mistake would be costly to notice late.
- **medium:** ordinary feature or fix code with a few callers, where a mistake shows quickly.
- **low:** copy, styles alone, a test, a comment, isolated code nothing else reads.

A high-risk change carries its own tests in the same branch: unit tests for its logic and an end-to-end or Playwright
spec for the flow, failing without the change (section 5). Without them it's "changes", and the merge queue refuses
it anyway.

## The verdict

- Every section holds: `e9g verdict review <branch> approve --sha <sha> --risk low|medium|high [--shots <dir>] --note
"<one line, with why that risk>"`.
- Otherwise: `e9g verdict review <branch> changes --sha <sha> --note "<the gist>"`, and answer with `VERDICT: changes`
  and a numbered list: each item with the file and line, what's wrong, why it matters, and what would fix it in the
  codebase's own terms. Order it by severity. Optional suggestions go after it, marked as such; don't ask for changes
  on taste alone.

The team's rules cap the rounds of changes a task gets; after that it goes to the planner. So make each round count:
a short list that misses a problem costs another round.

Problems outside the branch's scope are separate findings: file them (`e9g task add … --sev …`) rather than holding
up this branch.
