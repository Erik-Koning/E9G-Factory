# Plan: the web app (requests, decisions and the team's state)

Status: built and tested locally (phases 0–5); not deployed. Hosting, roles and sign-in decided by the operator on 2026-10-30.

## Why

`e9g serve` is a page on the lead machine: one operator token, loopback by default, and a link per stakeholder. The
operator wants people beyond this Mac to send requests and follow the work, and to decide on proposals from anywhere,
with real accounts and two-factor sign-in. A team on several machines already keeps its task graph in MongoDB, so a
hosted app can read and write the same documents.

Decided (operator, 2026-10-29): Better Auth on MongoDB; people send **requests only** (the planner turns them into
tasks); the app is for sending and managing requests and viewing the team's state.

## What it is

A Next.js app (`web/` in this repository) on the same MongoDB as the teams' task graphs:

```
 people ──(passkey / magic link; admins also an authenticator code)──▶ web app (Next.js, Better Auth)
                                                                         │ reads tasks, requests, cycles, team status
                                                                         │ writes requests, and admins' decisions
                                                                         ▼
                                                   MongoDB: e9g (task graphs)   e9g_web (accounts, sessions)
                                                                         ▲
 lead machine: planner, merge queue, watchdog ──(e9g task …, publishes team status)──┘
```

The app never invents its own rules: it calls the factory's task code (`lib/tasks/`), the same move table the CLI
uses, so an approval from the web is exactly `e9g task approve` by the operator.

## Who sees what

| Role                     | Can                                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| **admin** (the operator) | everything below; approve or reject proposals; invite, change and remove people; see names and emails |
| **member**               | see the board, journeys, the graph, every request and the team's status; send requests                |
| **contributor**          | send requests; see their own requests and how each is going, and the team's overview **(to decide)**  |

Access is per team: a person is a member of one team and a contributor to another. Agents still see a stakeholder's
id and role, never a name or address (Article 8).

## Signing in

- **Invite only.** Nobody signs up; an admin invites by email (Better Auth's admin plugin creates the account, and a
  magic link sends the invitation through Resend).
- **Everyone:** a passkey (`@better-auth/passkey`), or a magic link by email.
- **Admins:** two-factor is required. Better Auth enforces it only on email-and-password sign-in, so the app does:
  an admin without a verified authenticator (`twoFactorEnabled`) is sent to set one up before any page, and every
  admin action checks it on the server. Backup codes are issued at setup; trusted devices last 30 days.
- Sessions are revocable from the account page; an admin can ban (revoke) a person, which ends their sessions.

## Pages

- **Teams** (`/`): the teams a person can see, each with its state (planner running, members at work, the finish line
  or the current cycle, the last merge).
- **Overview** (`/t/<team>`): the board by status, journeys and which are due their verification, the graph (the
  factory's own layout, drawn as SVG like `e9g serve`'s), and recent merges.
- **Requests** (`/t/<team>/requests`): the form (title, what they need and why), the list, and each request with its
  status, the tasks it became and theirs, and the reason when it's rejected. Contributors see their own.
- **Decisions** (`/t/<team>/proposals`, admins): proposals with their gate and score; approve with a note, reject with
  a reason; escalated questions.
- **People** (`/admin/people`): invite, set each person's role per team, remove.
- **Account** (`/account`): passkeys, the authenticator, backup codes, sessions.

## Data

- **`e9g` database (the task graphs):** the documents the factory already keeps (tasks, requests, stakeholders,
  cycles, counters), plus a new **`teams`** collection the lead publishes: each team's name, title, approval rules,
  mode, and a status snapshot (planner and members running, finish line, cycle, last merge, time). `e9g register`
  writes it, and the lead's watchdog refreshes the status every run.
- **`e9g_web` database (accounts):** Better Auth's collections (users, sessions, accounts, verifications, two-factor,
  passkeys), through `@better-auth/mongo-adapter` with the client passed for transactions.
- **The link between them:** a stakeholder document (per team) carries the account's `userId`; its name, email and
  role come from the account. A request from the web is from that stakeholder.

## Writes, all through the factory's code

| From the web                 | The factory code it calls                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| a request                    | `addRequest` (moved to `lib/tasks/requests.ts`)                                                                                                  |
| an admin approves or rejects | `decide` (moved to `lib/tasks/decide.ts`): `move()` through the table, as the operator, with the team's approval rules from its `teams` document |
| an invitation or a role      | the stakeholder record, by `stakeholderFor` (in `lib/tasks/requests.ts`)                                                                         |

Nothing else changes the graph from the web. A new request wakes an idle team through the lead's watchdog, as now.

## Hosting **(to decide)**

Recommended: Vercel for the app (its root `web/`), MongoDB Atlas for the database, with the app's own database user:

- on `e9g`, read everything, insert and update requests and stakeholders, and update tasks (the app's code allows only
  decisions; Mongo can't scope a role to fields);
- read and write on `e9g_web`; nothing else.

The connection string, the auth secret and the Resend key are the app's environment variables, never the team's. The
operator deploys it; teams never do (Article 7).

## Security

- Invite only, admins with two factors, passkeys preferred.
- Every write is a server action that checks the session, the person's role for that team and, for admins, the
  second factor, then calls the factory's code.
- Rate limits: Better Auth's on sign-in; requests at most 20 a day per person.
- Request text is data: the planner treats it as a stakeholder's words, never as instructions (its prompt says so).
- Names and emails live only in the accounts and the stakeholder records; the factory's commands keep showing agents an
  id and a role.

## Changes to the factory first

1. `lib/tasks/requests.ts`: `addRequest`, `stakeholderFor`, `forAgents` and `keyHash`, out of `lib/commands/request.ts`.
2. `lib/tasks/decide.ts`: the approve and reject logic out of `lib/commands/task.ts`, taking the actor and the team's
   approval rules as arguments.
3. `lib/tasks/mongo.ts` without the Keychain: the connection string comes in as an argument (the CLI reads the
   Keychain in `connect.ts`; the web app reads its environment).
4. The `teams` collection: `e9g register` writes a team's document; the lead's watchdog keeps its status current.
5. The planner's prompt: request text is a stakeholder's words, not instructions.

## Checklist

- [x] Phase 0: the factory changes above, with tests
- [x] Phase 1: `web/` (Next.js 16, React 19, Better Auth 1.7, the Mongo adapter, passkeys, two-factor, magic links,
      the admin plugin); invite, sign in, roles per team; admins' two factors enforced
- [x] Phase 2: Teams and Overview (board, journeys, graph, status)
- [x] Phase 3: Requests (form, list, detail; contributors' own)
- [x] Phase 4: Decisions and People (admins)
- [x] Phase 5: tests (the shared code with `node --test`; the app's flows with Playwright against a local MongoDB);
      a security review; the README and a deploy guide
- [ ] Phase 6: deploy (Vercel, Atlas user), and an end-to-end run with a team on Mongo

## Out of scope

Filing tasks from the web (requests only); editing tasks, scores or the brief; starting or stopping members; chat with
the planner; a public request page.
