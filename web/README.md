# Anything Factory web app

A small Next.js app, on the same MongoDB as the teams' task graphs, where people beyond the operator's machine send
**requests** to a team and follow its work, members **suggest tasks** for the planner to triage, and the operator
**adds tasks**, **decides on proposals** and **answers what waits on them** from anywhere, switching between the teams
they run, and everyone chooses what they're **emailed** about. The plan is
[docs/plans/web-app.md](../docs/plans/web-app.md).

It has no rules of its own. It imports the factory's task code from `../lib/tasks/` (no copies) and writes only through
it: a request is the factory's `addRequest`, a person's stakeholder record its `stakeholderFor`, a task its `addTask`,
and an admin's decision its `decide`, as the operator, with the team's approval rules from the `teams` document
`a6g register` publishes. An approval from the web is exactly `a6g task approve` by the operator, and a task an admin
adds is exactly `a6g task add` by the operator (`--approved` when they approve it as they add it). A member's
suggestion is a task in `triage` by `stakeholder`. Either way the task records who added it, as their stakeholder id
(`from`, and in its first history event), never their name: the board shows them as "you", by name to an admin and by
role to anyone else.

## Who sees what

| Role                        | Sees and does                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **admin** (the operator)    | everything, on every team; adds tasks; decides proposals; invites, changes and removes people; sees senders' names and emails                          |
| **member** (of a team)      | the board, journeys, the graph, recent merges, each task and every request (senders by role, never by name); sends requests; suggests tasks for triage |
| **contributor** (to a team) | the team's overview (status, journeys, progress counts) and their own requests; sends requests                                                         |

Roles are per team (a member of one team can be a contributor to another). The rules are in `server/access.ts`; every
page and server action asks there, and `tests/unit/access.test.ts` proves them. The team's agents still see a request's
stakeholder id and role only: names and emails live in the accounts and the stakeholder records, never in a task or a
request (Article 8).

## Pages

- `/` Teams: the teams you can see, each with its state, planner, members at work by role, aim, last merge, and links
  to its pages.
- `/t/<team>` Overview: status, progress, journeys (and which are due their verification); for members and admins the
  graph (the factory's own `layout`, as SVG) and recent merges. For admins, **Pause and resume**: pause the team now,
  after the work under way, or after chosen journeys (they finish, verification and polish included, and nothing else
  starts); while it's pausing, what's still going and what can't move without you; once paused, the report of where it
  stands; and Resume, with feedback for the planner. Each asks for an authenticator code and goes in the audit log; the
  lead's watchdog applies it within a minute (until then the panel says it's waiting for the team's Mac). Then
  **Spend**: what its tokens would cost on the Claude API today, this week and in all (against the budget, when there
  is one), each of the last 14 days, and the journeys and tasks that cost the most; and the budget itself (a day, a
  week, in all, and whether a new day or week resumes a team it paused), set with an authenticator code like a pause.
- `/t/<team>/inbox` **Waiting on you** (admins), with its count on the tab, in the header on every page (all teams:
  `/inbox`), on the Teams page and at the top of the overview: each question the planner or the approver put to the
  operator, and each block raised to them (a block the team sorts out, or that waits on other tasks, isn't listed).
  Every one shows why it's theirs and what the team recommends (the task's `ask`, which raising it requires; from its
  own words for one raised before, or said to be missing), the task's options read out of it ("(a) … (b) …") as
  choices with the recommended one marked, what it holds up and the other questions it mentions. An
  answer is an option, the recommendation or the admin's own words, with anything added: the factory's `answer`
  (`lib/tasks/answer.ts`), a note by the operator marked as the answer, which leaves the task where it is. The lead's
  watchdog passes it to the planner within a minute, which records it in its decisions and moves the task on; until
  then it's under "Answered, with the planner" (marked when the planner hasn't acted for 15 minutes), and once it has,
  under "Settled this week". "Or decide it yourself" approves (scored work only, never a research question) or
  rejects, as on Decisions, and comes back here.
- `/t/<team>/board` Board (members and admins): a lane per step of a task's way through the team, left to right:
  Triage, Proposed (escalated and researching marked), Approved (in claim order, with what each waits for), Building
  (which role on which machine, and the lease left or run out), Review (branch, commit, rounds of changes), Blocked
  (only when something is) and Done (the newest eight, with a count of the rest and of what was rejected; "show them"
  opens `?done=all`, every done task and a Rejected lane). Each card says who it came from ("suggested by", "added
  by", "requested by" for work the planner made of a request, or the team role) and links its journey. Journeys aren't
  cards. The lanes run to the window's edge and scroll sideways when they don't fit. A team with no tasks yet gets one
  empty state. The board shows the work; moves stay with the team (claims, review, the merge queue) and the Decisions
  page.
- `/t/<team>/add`, from the board's button: Add a task (admins: a proposal, or approved as it's added, under a
  journey, after other tasks) or Suggest a task (members: title, kind, how bad it is for a bug or a UX problem, and
  what's needed, at least 20 characters; it goes to triage, and the planner never approves it itself: it makes it its
  own proposal for the approver or the operator).
- `/t/<team>/tasks/<id>` (members and admins): one task, as `a6g task show` prints it: where it stands, its journey and
  dependencies, who holds it, who it came from, its gate and score, notes and history (people in it said as you may
  read them). For an admin, a proposal or a task in triage has a Decide button. The board, journeys, merges, the
  Decisions page and a request's page link here.
- **Switch team**, beside each team's name: the other teams you follow and their state, keeping the page you're on.
- `/t/<team>/requests` and `/t/<team>/requests/<id>`: the form, the list, and each request with its status, the tasks
  it became and theirs, notes and the reason when it's turned down. Contributors see their own.
- `/t/<team>/proposals` (admins): proposals with who they came from, their gate and score; approve with a note, reject
  with a reason, send back for research, escalate. Tasks in triage come last, for when one can't wait for the planner.
- `/admin/people` (admins): invite by email with a role on a team, change a role, remove from a team, ban and unban.
- `/admin/audit` (admins): the audit log, newest first, filtered by what, how it went, who and IP address.
- `/account/notifications`: what the person is emailed about, for each kind of event they could see in the app
  (questions for them, blocked work, journeys done, a team pausing or finishing, work merged, their requests): at
  once, in a daily digest at the hour and time zone they choose (the browser's until they save one), or not at all;
  the teams they hear about; for admins, whether the digest also lists what still waits on them. Until they save,
  their role's defaults apply (an admin hears of questions and blocked work at once). It shows the last email sent and
  what's waiting to go, and sends a test email (three an hour).
- `/account`: passkeys; the authenticator (on for admins; anyone else turns it on or off) and backup codes; where
  you're signed in, with each session's address; the IP addresses you've confirmed; your recent activity; sign out.
- `/second-factor` and `/confirm-sign-in`: where a session waits for its authenticator's code, or for its new IP
  address to be confirmed by email; `/sign-in/confirm` is the email's page (“Was this you?”), no session needed.

## Signing in: two factors, new IP addresses, and the audit log

Invite only: nobody signs up. An admin invites someone by email from People; the app makes the account (Better Auth's
admin plugin), gives it its role on the team and a stakeholder record there, and emails a sign-in link.

- **Everyone** signs in with a **passkey** or a **magic link** by email (15 minutes, once).
- **Admins sign in with two factors, by design.** Better Auth enforces two-factor only on email-and-password sign-in,
  so the app makes that the admins' way in and closes the others:
  - An admin is made by `npm run create-admin` on the operator's machine, which creates the account with a password
    **and enrols its authenticator (TOTP) at once**, printing the setup link and ten backup codes. No admin account
    exists with only a password.
  - An admin signs in with **password + authenticator code** (or a backup code), or with a **passkey whose
    authenticator verified them** (PIN or biometrics: the UV flag of the signed assertion, checked on the server).
  - **No magic link for admins**: none is sent to an admin's address, and a session from one is refused for an admin.
- **Anyone else may turn on an authenticator** from their account page (a QR code, a code to prove it, ten backup
  codes shown once; Better Auth's two-factor plugin, passwordless). From then on every sign-in, by passkey or link,
  also asks for its code. Turning it off takes a current code.
- Each session records **whether it has its second factor** (`session.secondFactor`): set by the server from how the
  session was made, or once a code is entered for it at `/second-factor` (an admin whose passkey didn't verify them,
  anyone with an authenticator after a link). Five wrong codes end the session. The client can't set it.
- **A new IP address is confirmed by email.** Every session records its IP address, and each person has a list of the
  addresses they've confirmed (an IPv4 address whole, an IPv6 address by its /64). A session used from any other
  address, at sign-in or later (a cookie taken elsewhere), can do nothing until its person confirms it: they're
  emailed a link to a page that shows the address, device and time, with **Yes, it was me** (the address joins their
  list) and **It wasn't me** (every session on the account ends). A button answers, not the link, so a mail scanner
  that opens links answers nothing; the link works once, for 30 minutes, and a new one goes out at most every 10
  minutes. Signing in by an email link confirms the address it's opened from, since opening it already proves the
  inbox. The account page lists your addresses (with Forget) and each session's address.
- **The audit log** keeps every sign-in (by method, or why it failed), sign-out and ended session, second factor, new
  address (asked, confirmed, denied, forgotten), passkey and authenticator change, invitation, role change, removal,
  ban, request, task and decision: who, when, from which address and device, and how it went. It's in the accounts
  database (`audit`), written once and never changed, kept `AUDIT_RETENTION_DAYS` (400). Admins read and filter it at
  `/admin/audit`; each person sees their own recent activity on their account page. The team's agents never see it.
- Pages and server actions check all of this on the server (`server/viewer.ts`, `server/access.ts`): a session that
  owes its second factor or an address confirmation is sent to finish that and can do nothing else. Over HTTP it may
  only look at itself, sign out or sign in again, so it can't enrol a passkey or new backup codes to raise itself.
  Better Auth's own admin endpoints (`/api/auth/admin/*`) and turning the authenticator on or off are never served over
  HTTP; the app calls them from its server actions after its own checks. (`server/auth.ts` has the sign-in rules in
  one place.)
- **The viewer's address comes from the CDN**, never from what a browser says: CloudFront's function sets
  `x-a6g-viewer-ip` (`CLIENT_IP_HEADER`), and the app refuses every request without CloudFront's secret
  (`ORIGIN_SECRET`, sent as `x-a6g-origin`; `proxy.ts`), so nobody reaches it around CloudFront or makes the header up.
  Sessions, rate limits, the new-address check and the audit log all read the same address.
- Sessions are revocable from the account page; a ban ends all of a person's sessions and keeps them out.
- Rate limits: Better Auth's, kept in the database (from one IP address, 5 password sign-ins, 5 link requests and 5
  two-factor tries a minute; 100 auth requests a minute in all), plus Better Auth's own lockout after repeated wrong
  codes; and at most 20 requests and task suggestions a day per person.

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

Without a mail service, sign-in links and invitations are printed to the dev server's console (`[mail] to=… link=…`):
only while the app's address is this machine (`http://localhost`), never where a log could hand someone a link.
A team shows up once its settings are in the `teams` collection: `a6g register` publishes them for a team whose tasks
are in Mongo (team.json `tasks.store: "mongo"`), and the lead's watchdog keeps its status current.

### Environment variables

| Variable                                                   | Needed                      | What                                                                                                                  |
| ---------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `MONGODB_URI`                                              | yes                         | The connection string (`mongodb+srv://…`), the app's own database user                                                |
| `A6G_DATABASE`                                             | no (`a6g`)                  | The task graphs' database (team.json `tasks.database`)                                                                |
| `AUTH_DATABASE`                                            | no (`a6g_web`)              | The app's accounts (Better Auth's users, sessions, passkeys, two-factor, rate limits; memberships)                    |
| `BETTER_AUTH_SECRET`                                       | yes                         | At least 32 random characters (`openssl rand -base64 32`); signs cookies, encrypts TOTP secrets                       |
| `BETTER_AUTH_URL`                                          | yes                         | The app's address (`https://a6g.example.com`): email links, and the passkeys' relying party and origin                |
| `SES_REGION`, `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY` | served for real (or Resend) | Amazon SES and a key that may only send as the sender (`sst.config.ts` makes both)                                    |
| `RESEND_API_KEY`                                           | served for real (or SES)    | Resend's API key, instead of SES                                                                                      |
| `MAIL_FROM`                                                | served for real             | The sender, verified with the mail service (`Anything Factory <a6g@example.com>`)                                     |
| `MAIL_LOG`                                                 | no                          | `1` prints emails to the console when there's no mail service: only while `BETTER_AUTH_URL` is `http://localhost`     |
| `CLIENT_IP_HEADER`                                         | served for real             | The one header that carries the viewer's IP address (`x-a6g-viewer-ip` behind CloudFront; `x-forwarded-for` if unset) |
| `ORIGIN_SECRET`                                            | served for real             | At least 32 characters, the same as the CDN sends in `x-a6g-origin`; requests without it are refused                  |
| `AUDIT_RETENTION_DAYS`                                     | no (400)                    | How long the audit log keeps each event                                                                               |
| `NOTIFY_EVERY_SECONDS`                                     | no (60)                     | How often the notifier looks for what to email; `0` turns notifications off                                           |
| `NOTIFY_TIME_ZONE`                                         | no (`UTC`)                  | The daily digest's time zone for someone who hasn't chosen theirs (`America/Toronto`)                                 |

`.env.local` is ignored by git. The connection string, the secret and the mail key are the app's, never a team's.
Served anywhere but `http://localhost` with `NODE_ENV=production`, the app refuses to start without `ORIGIN_SECRET`,
`CLIENT_IP_HEADER` and a mail service: without the first two anyone could say what address they come from, and
without the last nobody could sign in.

### Tests

```sh
npm test               # tsc, then the unit tests (node --test): access rules, the UV check, TOTP, views, the origin check, import boundaries
npm run test:e2e       # next build, then Playwright against a local MongoDB
npm run test:e2e:atlas # the same against a real cluster, from the repository's .env (below)
npm run check:infra    # sst install, then tsc against SST's platform: the deployment (sst.config.ts) type-checks
```

The end-to-end tests start a MongoDB replica set with `mongodb-memory-server` from the mongod binary already on this
machine (`MONGOMS_SYSTEM_BINARY`, by default `~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6`; nothing is
downloaded), seed it with the factory's own functions (`tests/e2e/seed.ts`), run `next start` against it with
`MAIL_LOG=1`, and read sign-in links from its log. They cover an admin's sign-in with the authenticator and with a
backup code; an invitation; a contributor's magic link, request and what they can and can't see; a member's board and
requests (senders by role); approving and rejecting (checked in the task documents); a contributor and an admin
session without its second factor calling admin server actions directly (refused, nothing changes); passkeys with and
without user verification; the daily limit; phone width; and the sign-in rate limit. Its browsers send a viewer IP
address and the origin secret as CloudFront does (`playwright.config.ts`), and `security.spec.ts` covers the rest of
signing in: a request without the secret refused, an admin's new address confirmed by email (the link once), a session
taken elsewhere and “it wasn't me”, a member's authenticator and every sign-in after it asking for a code, and the
audit log. Playwright's Chromium must be installed (`npx playwright install chromium`).

`npm run test:e2e:atlas` runs the same suite against a real cluster: it reads `DB_USER`, `DB_PASSWORD` and `DB_HOST`
from the repository's `.env` (gitignored; or `E2E_MONGODB_URI`), and uses databases of its own, `a6g_e2e` and
`a6g_web_e2e`, which every run empties first (it refuses any name that doesn't end in `_e2e`, so it never touches the
app's own). It leaves them after the run, with that run's admin (the e2e user) in `web/.env.e2e`: its address,
password, authenticator link and unused backup codes, to sign in with `npm run dev` against the same databases. The
tests' sign-ins come from 198.51.100.7, so one from your own address asks for an email confirmation first (printed to
the dev server's console). Against a distant cluster each page waits on several round trips, so the run takes minutes
rather than one.

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

The admin's first sign-in comes from an address they haven't confirmed, so it asks them to confirm it by email: the
app's email (SES or Resend) must reach them before the first admin can get in.

## Deploying: Lightsail, behind CloudFront, by SST

The operator deploys the app; teams never do (Article 7). `sst.config.ts` (SST 4) makes all of it in one AWS account:

```
 viewer ──https──▶ CloudFront ──https + x-a6g-origin──▶ Lightsail container service ──▶ the app (Dockerfile)
                    │ its function sets x-a6g-viewer-ip and x-forwarded-host; /_next/static/* cached
```

- **The image** (`Dockerfile`, built from the repository's root since the app compiles `../lib/tasks`): Next's
  standalone server on Node 24 Alpine, as an unprivileged user, for `linux/amd64`, built into the local Docker engine
  and pushed into the container service's own registry (AWS's `lightsailctl` plugin). Not ECR: the organization's
  resource control policy refuses Lightsail's puller role, which belongs to AWS's account.
- **Lightsail**: a container service (`micro`, one container, by default) and a deployment of the newest image with the
  app's environment. Its health check calls `/api/health`, the one path open without the origin secret.
- **CloudFront** (SST's `Cdn`): everything passed through uncached with every viewer header but Host, except Next's
  hashed static files; HTTPS only; a viewer-request function that sets the viewer's address and the public host; the
  origin secret (made by SST, kept in its state) on every request to Lightsail. With `A6G_WEB_DOMAIN`, a certificate and
  DNS records for that domain in the account's Route 53 zone.

### Before the first deploy

1. **AWS**: credentials for the account (`aws configure` or SSO), AWS's `lightsailctl` plugin
   (`brew install aws/tap/lightsailctl`), and Docker running (SST builds the image). On an
   Apple-silicon Mac, run `scripts/rosetta-builder.sh` once and deploy with `BUILDX_BUILDER=a6g-rosetta`: the default
   builder emulates amd64 with QEMU, where `next build` hangs.
2. **MongoDB Atlas**: a database user for the app alone (below), and its `mongodb+srv://` connection string. Put the
   cluster in the same place as the app (an AWS cluster in `A6G_WEB_REGION`): every page waits on several round trips
   to it, a millisecond each next door and tens of milliseconds across a continent or between clouds.
3. **Email (Amazon SES)**: once per domain, not per stage, make the sender's domain an SES sender: with its Route 53
   zone in the account, `AWS_REGION=us-east-2 scripts/ses-domain.sh a6gfactory.dev` adds the SES identity with DKIM,
   its own MAIL FROM (`mail.<domain>`, for SPF) and a DMARC policy, so mail from it is signed, authorised and not spam.
   Each stage then sends from `A6G_WEB_SENDER` (`no-reply@a6gfactory.dev`) with an IAM user's key that may send from
   that address alone. Until the account has SES production access (asked for in the SES console), SES sends only to
   verified addresses, 200 a day: verify each person's address in SES meanwhile. Sign-in links, invitations and
   new-address confirmations all go by email; the first admin can't get in without them.
4. **The domain**: pick it now (`A6G_WEB_DOMAIN`, in a Route 53 hosted zone of the account). Passkeys belong to the
   domain they were made on, so moving later means everyone adds theirs again. Without one the app is on CloudFront's
   `*.cloudfront.net` address.
5. **The secrets**, per stage (SST keeps them encrypted in the account; never in the repository):

   ```sh
   cd web
   npx sst secret set MongodbUri --stage production < connection-string.txt   # or the value as an argument
   openssl rand -base64 32 | npx sst secret set BetterAuthSecret --stage production
   ```

6. **The indexes**, made once with an operator's database user (the app's own may not make any on the audit log):
   `npm run create-indexes` with that user's `MONGODB_URI` and the stage's `AUTH_DATABASE` in the environment.

### Deploying

```sh
cd web
A6G_WEB_SENDER=no-reply@a6gfactory.dev A6G_WEB_DOMAIN=app.a6gfactory.dev npx sst deploy --stage production
```

It prints the app's `url` and Lightsail's `origin`. Then make the first admin (above) against the production database
and sign in. A later deploy builds the image again and moves Lightsail to the new digest; the origin secret, the
certificate and the distribution stay. `A6G_WEB_REGION` (`us-east-2`, where the account's organization allows Lightsail, SSM and ECR), `A6G_WEB_POWER` (`micro`) and
`A6G_WEB_SCALE` (1) change where and how big it runs. The production stage is protected and retained: removing it
takes an explicit change.

Things to know:

- **Lightsail keeps a deployment's environment in the deployment**, readable by anyone with Lightsail access to the
  account: the connection string, the auth secret and the mailer's key included. Give that access to the operators only.
- **Lightsail's own address** (`*.cs.amazonlightsail.com`) answers anyone, but the app refuses every request there
  without CloudFront's secret, except `/api/health` (which says `ok` and nothing else).
- **Server actions** compare the browser's Origin with the public host CloudFront passes in `x-forwarded-host`. If a
  setup in front ever drops that header, list the public host in `SERVER_ACTIONS_ORIGINS` at build (the image build
  sets it to `A6G_WEB_DOMAIN`).

### Atlas

1. **A database user for the app alone**, with a custom role that gives only what it needs (Database Access → Custom
   Roles). On the task graphs' database (`a6g`):
   - `find` on the whole database;
   - `insert` on `requests` (the app only adds them; the planner changes them, through the factory's commands);
   - `insert` and `update` on `stakeholders` (linking a person's account) and `counters` (new ids come from them);
   - `insert` and `update` on `tasks` (an admin's tasks and members' suggestions, through the factory's `addTask`, and
     decisions; the app's code changes only a task's status, approval and notes, through the factory's move table).
     MongoDB can't scope a role to fields, so whoever holds this user's password can add and rewrite any team's tasks,
     which agents then act on: keep it only in the deployment's environment, and rotate it if it leaks;
   - `insert` on `controls` (an admin's pause, resume or budget: the app only adds them, never changes one, so they're
     also the record; the watchdog applies them);
   - `createIndex` on `tasks`, `requests`, `stakeholders`, `cycles` and `controls` (the store asks for its index;
     refused, it carries on).

   On the accounts database (`a6g_web`): `find`, `insert`, `update` and `remove` on each of Better Auth's collections
   and the app's own (`user`, `session`, `account`, `verification`, `twoFactor`, `passkey`, `rateLimit`, `memberships`,
   `request_counts`, `magic_link_sends`, `known_ips`, `ip_challenges`, `code_attempts`, and the notifier's
   `notification_prefs`, `notification_queue`, `notification_tests` and `notifier`), and only `find` and `insert`
   on `audit`, so the app can't change or delete what it recorded, nor add an index that would expire it early
   (MongoDB's own expiry still removes old events). The indexes are an operator's to make (`npm run create-indexes`);
   the app tries its own too and carries on when refused. Nothing else: no `remove` on `a6g`, nothing on other
   databases, no admin roles. Give it a long random password.

2. **Network access**: Lightsail containers have no fixed outbound address, so allow `0.0.0.0/0`, and let the narrow
   role, the long password and TLS (always on with Atlas) carry the protection.
3. The connection string is the cluster's `mongodb+srv://` one with this user: the `MongodbUri` secret.

`next.config.ts` sets `turbopack.root` and `outputFileTracingRoot` to the repository, so the factory's files compile
and nothing outside `web/` is traced into the standalone server. Passkeys are bound to `BETTER_AUTH_URL`'s host:
changing the domain means adding passkeys again.

## The code

- `server/access.ts`: who may see and do what (pure).
- `server/auth.ts`: Better Auth: plugins, the second-factor rule, the HTTP guard, emails.
- `server/viewer.ts`: the signed-in person, their roles and second factor, for pages and actions.
- `server/factory.ts`: the bridge to `../lib/tasks` (`storeOver` over the app's MongoClient, `addRequest`,
  `stakeholderFor`, `addTask`, `decide`); `server/views.ts`: what the pages work out from a graph (progress, journeys,
  merges, proposals, the board's lanes).
- `server/inbox.ts`: what waits on the operator, from a team's graph: the questions and blocked work, the options and
  recommendation read out of each, what's answered and what was settled (pure).
- `server/events.ts`, `server/notifications.ts`, `server/notifier.ts`, `instrumentation.ts`: notifications. The events
  are worked out from each team's history, never stored (pure); a person's settings and the emails' words; and the
  notifier, which the server starts (`instrumentation.ts`) and which runs every `NOTIFY_EVERY_SECONDS` under a lease in
  the accounts database, so one container sends. It queues an email per person and event (`notification_queue`, its id
  the person and the event, so each goes once, kept 30 days), sends what goes at once in one email per person a run,
  and each digest once its hour has come. A team it sees for the first time has no news; a person hears only of what
  they could open in the app (`access.ts`), and of a request only when it's theirs.
- `server/origin.ts`: who a task came from, as the person looking may read it, the same on every page.
- `server/auth-indexes.ts`: the indexes Better Auth's MongoDB adapter doesn't make (sessions by token, people by
  address, passkeys by credential, rate limits by key) and expiry for old sessions and verifications.
- `server/code-attempts.ts`: five authenticator or backup codes per person in 15 minutes, counted before each is
  checked; `scripts/create-indexes.ts`: the app's indexes, made by an operator.
- `server/audit.ts`: the audit log; `server/known-ips.ts`: confirmed addresses and the emails that confirm new ones;
  `server/origin-check.ts`: the CDN's secret; `server/device.ts`: a browser's name from its user agent.
- `server/people.ts`: memberships, stakeholder links, the daily limit on requests and suggestions. `server/bootstrap.ts`: create-admin.
- `app/`: the pages; `app/t/[team]/actions.ts`, `app/admin/people/actions.ts`, `app/account/actions.ts`: every write.
- `proxy.ts`: requests without the CDN's secret refused, a nonce-based Content Security Policy, and anyone without a
  session cookie off to sign in.
- `sst.config.ts`, `Dockerfile`: the deployment (Lightsail behind CloudFront); `tsconfig.infra.json` checks it.

The app imports only `model`, `store` (for `update`), `mongo`, `requests`, `decide`, `answer`, `add`, `teams`, `graph`
and `controls` from `lib/tasks`; never the file store, the Keychain, migrations or machines, and it never calls `openStore`
(`tests/unit/boundaries.test.ts` keeps it so).
