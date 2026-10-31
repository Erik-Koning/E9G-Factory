# E9G web app

A small Next.js app, on the same MongoDB as the teams' task graphs, where people beyond the operator's machine send
**requests** to a team and follow its work, and where the operator **decides on proposals** from anywhere. The plan is
[docs/plans/web-app.md](../docs/plans/web-app.md).

It has no rules of its own. It imports the factory's task code from `../lib/tasks/` (no copies) and writes only through
it: a request is the factory's `addRequest`, a person's stakeholder record its `stakeholderFor`, and an admin's decision
its `decide`, as the operator, with the team's approval rules from the `teams` document `e9g register` publishes. An
approval from the web is exactly `e9g task approve` by the operator.

## Who sees what

| Role                        | Sees and does                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **admin** (the operator)    | everything, on every team; decides proposals; invites, changes and removes people; sees senders' names and emails |
| **member** (of a team)      | the board, journeys, the graph, recent merges and every request (senders by role, never by name); sends requests  |
| **contributor** (to a team) | the team's overview (status, journeys, progress counts) and their own requests; sends requests                    |

Roles are per team (a member of one team can be a contributor to another). The rules are in `server/access.ts`; every
page and server action asks there, and `tests/unit/access.test.ts` proves them. The team's agents still see a request's
stakeholder id and role only: names and emails live in the accounts and the stakeholder records, never in a task or a
request (Article 8).

## Pages

- `/` Teams: the teams you can see, each with its state, planner, members at work, aim, last merge.
- `/t/<team>` Overview: status, progress, journeys (and which are due their verification); for members and admins the
  board, the graph (the factory's own `layout`, as SVG) and recent merges.
- `/t/<team>/requests` and `/t/<team>/requests/<id>`: the form, the list, and each request with its status, the tasks
  it became and theirs, notes and the reason when it's turned down. Contributors see their own.
- `/t/<team>/proposals` (admins): proposals with their gate and score; approve with a note, reject with a reason, send
  back for research, escalate.
- `/admin/people` (admins): invite by email with a role on a team, change a role, remove from a team, ban and unban.
- `/account`: passkeys, backup codes (admins), where you're signed in, sign out.

## Signing in, and admins' two factors

Invite only: nobody signs up. An admin invites someone by email from People; the app makes the account (Better Auth's
admin plugin), gives it its role on the team and a stakeholder record there, and emails a sign-in link.

- **Everyone** signs in with a **passkey** or a **magic link** by email (15 minutes, once).
- **Admins sign in with two factors, by design.** Better Auth enforces two-factor only on email-and-password sign-in,
  so the app makes that the admins' way in and closes the others:
  - An admin is made by `npm run create-admin` on the operator's machine, which creates the account with a password
    **and enrols its authenticator (TOTP) at once**, printing the setup link and ten backup codes. No admin account
    exists with only a password.
  - An admin signs in with **password + authenticator code** (or a backup code), or with a **passkey whose
    authenticator verified them** (PIN or biometrics: the UV flag of the signed assertion, checked on the server; a
    passkey that didn't verify them gives no second factor).
  - **No magic link for admins**: none is sent to an admin's address, and a session from one is refused for an admin.
- Each session records **whether it began with a second factor** (`session.secondFactor`, set by the server as the
  session is made, from how it was made; the client can't set it). Every admin page and every server action checks it
  on the server, along with the person's role for the team (`server/viewer.ts`, `server/access.ts`). An admin whose
  session lacks it is sent to `/second-factor` and can do nothing until they sign in again with one.
- Over HTTP, an admin session without its second factor may only look at itself, sign out or sign in again, so it
  can't enrol a passkey or new backup codes to raise itself. Better Auth's own admin endpoints (`/api/auth/admin/*`)
  and turning the authenticator on or off are never served over HTTP; the app calls the admin plugin from its server
  actions after its own checks. (`server/auth.ts` has all of this in one place.)
- Sessions are revocable from the account page; a ban ends all of a person's sessions and keeps them out.
- Rate limits: Better Auth's, kept in the database so they hold across serverless instances (from one IP address, 5
  password sign-ins, 5 link requests and 5 two-factor tries a minute; 100 auth requests a minute in all), plus
  Better Auth's own lockout after repeated wrong codes; and at most 20 requests a day per person.

## Running it locally

You need Node 22.18 or later and a MongoDB **replica set** (Better Auth's Mongo adapter uses transactions): an Atlas
development cluster, or a local one (`mongod --replSet rs0` then `rs.initiate()`). Never point a local run at the
teams' production database by accident: use your own cluster or a local one.

```sh
cd web
npm install
# web/.env.local, with the variables below (BETTER_AUTH_URL=http://localhost:3000)
npm run create-admin -- --email you@example.com --name "Your Name"
npm run dev            # http://localhost:3000
```

Without `RESEND_API_KEY`, sign-in links and invitations are printed to the dev server's console (`[mail] to=… link=…`).
A team shows up once its settings are in the `teams` collection: `e9g register` publishes them for a team whose tasks
are in Mongo (team.json `tasks.store: "mongo"`), and the lead's watchdog keeps its status current.

### Environment variables

| Variable             | Needed         | What                                                                                                                   |
| -------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `MONGODB_URI`        | yes            | The connection string (`mongodb+srv://…`), the app's own database user                                                 |
| `E9G_DATABASE`       | no (`e9g`)     | The task graphs' database (team.json `tasks.database`)                                                                 |
| `AUTH_DATABASE`      | no (`e9g_web`) | The app's accounts (Better Auth's users, sessions, passkeys, two-factor, rate limits; memberships)                     |
| `BETTER_AUTH_SECRET` | yes            | At least 32 random characters (`openssl rand -base64 32`); signs cookies, encrypts TOTP secrets                        |
| `BETTER_AUTH_URL`    | yes            | The app's address (`https://e9g.example.com`): email links, and the passkeys' relying party and origin                 |
| `RESEND_API_KEY`     | production     | Resend's API key, for sign-in links and invitations                                                                    |
| `MAIL_FROM`          | production     | The sender, on a domain verified in Resend (`E9G <e9g@example.com>`)                                                   |
| `MAIL_LOG`           | no             | `1` prints emails to the console when there's no Resend key (on by default in development; never on Vercel production) |

`.env.local` is ignored by git. The connection string, the secret and the Resend key are the app's, never a team's.

### Tests

```sh
npm test               # tsc, then the unit tests (node --test): access rules, the UV check, TOTP, views, import boundaries
npm run test:e2e       # next build, then Playwright against a local MongoDB
```

The end-to-end tests start a MongoDB replica set with `mongodb-memory-server` from the mongod binary already on this
machine (`MONGOMS_SYSTEM_BINARY`, by default `~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6`; nothing is
downloaded), seed it with the factory's own functions (`tests/e2e/seed.ts`), run `next start` against it with
`MAIL_LOG=1`, and read sign-in links from its log. They cover an admin's sign-in with the authenticator and with a
backup code; an invitation; a contributor's magic link, request and what they can and can't see; a member's board and
requests (senders by role); approving and rejecting (checked in the task documents); a contributor and an admin
session without its second factor calling admin server actions directly (refused, nothing changes); passkeys with and
without user verification; the daily limit; phone width; and the sign-in rate limit. Playwright's Chromium must be
installed (`npx playwright install chromium`).

## The first admin

```sh
cd web
npm run create-admin -- --email you@example.com --name "Your Name"
```

Run it on your own machine with `web/.env.local` pointing at the production database (or the variables in the
environment). It prints, once: the password, an `otpauth://` link for your authenticator app (paste it in, or make a
QR code of it locally), and ten backup codes. Keep the backup codes apart from the password.

Run it again for the same address to start that admin afresh: a new password, authenticator and backup codes, and every
earlier session and passkey ended (a lost authenticator; or to make an existing person an admin). There's no way to
make an admin from the web.

## Deploying: Vercel and MongoDB Atlas

The operator deploys the app; teams never do (Article 7).

### Atlas

1. **A database user for the app alone**, with a custom role that gives only what it needs (Database Access → Custom
   Roles). On the task graphs' database (`e9g`):
   - `find` on the whole database;
   - `insert` and `update` on `requests`, `stakeholders` and `counters` (new ids come from the counters);
   - `update` on `tasks` (decisions; the app's code changes only a task's status, approval and notes, through the
     factory's move table: MongoDB can't scope a role to fields);
   - `createIndex` on `tasks`, `requests`, `stakeholders` and `cycles` (the store asks for its index; refused, it
     carries on).

   And on the accounts database (`e9g_web`): the built-in `readWrite`. Nothing else: no `remove` on `e9g`, nothing on
   other databases, no admin roles. Give it a long random password.

2. **Network access**: Vercel's functions don't have fixed addresses unless your plan gives the project static egress
   IPs; if it does, allow only those. Otherwise allow `0.0.0.0/0`, and let the narrow role, the long password and TLS
   (always on with Atlas) carry the protection.
3. The connection string is the cluster's `mongodb+srv://` one with this user: `MONGODB_URI`.

### Vercel

1. Import the repository as a project with **Root Directory `web`**, and keep **"Include files outside the root
   directory in the Build Step"** on (the app compiles `../lib/tasks/*.ts`). The framework is detected as Next.js;
   the build is `npm run build`. Node.js 22.x or later.
2. Environment variables (Production, and Preview if you use one, with its own database): `MONGODB_URI`,
   `E9G_DATABASE`, `AUTH_DATABASE`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (the production domain, `https://…`),
   `RESEND_API_KEY`, `MAIL_FROM`. Don't set `MAIL_LOG`.
3. In Resend, verify the domain `MAIL_FROM` sends from.
4. Deploy, then run `npm run create-admin` locally against the production database for the first admin, and sign in.

`next.config.ts` sets `turbopack.root` and `outputFileTracingRoot` to the repository, so the factory's files compile
and nothing outside `web/` is traced into the function. Passkeys are bound to `BETTER_AUTH_URL`'s host: changing the
domain means adding passkeys again.

## The code

- `server/access.ts`: who may see and do what (pure).
- `server/auth.ts`: Better Auth: plugins, the second-factor rule, the HTTP guard, emails.
- `server/viewer.ts`: the signed-in person, their roles and second factor, for pages and actions.
- `server/factory.ts`: the bridge to `../lib/tasks` (`storeOver` over the app's MongoClient, `addRequest`,
  `stakeholderFor`, `decide`); `server/views.ts`: what the pages work out from a graph.
- `server/people.ts`: memberships, stakeholder links, the daily request limit. `server/bootstrap.ts`: create-admin.
- `app/`: the pages; `app/t/[team]/actions.ts`, `app/admin/people/actions.ts`, `app/account/actions.ts`: every write.
- `proxy.ts`: a nonce-based Content Security Policy, and anyone without a session cookie off to sign in.

The app imports only `model`, `store` (for `update`), `mongo`, `requests`, `decide`, `teams` and `graph` from
`lib/tasks`; never the file store, the Keychain, migrations or machines, and it never calls `openStore`
(`tests/unit/boundaries.test.ts` keeps it so).
