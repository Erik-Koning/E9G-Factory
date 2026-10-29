// The heartbeat: an outside check the watchdog pings at the end of every run in which T3 Code answers, so the
// operator hears when this Mac stops. The check is a local server that counts pings and answers what a test says.
import assert from "node:assert/strict";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fakeWorld } from "./fake-t3.ts";

const check = { url: "", pings: [] as string[], status: 200 };
const server = createServer((request, response) => {
  check.pings.push(`${request.method} ${request.url} ${request.headers["user-agent"] ?? ""}`);
  response.writeHead(check.status).end("OK");
});
before(() =>
  new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done())).then(() => {
    check.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ping/0f6c-check`;
  })
);
after(() => server.close());
const read = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");

// One test at a time: they share the check's count.
describe("the heartbeat", () => {
  test("e9g connect heartbeat keeps a URL only once a ping goes through, and shows it without the check's id", async () => {
    const w = await fakeWorld();
    try {
      const help = await w.e9g("connect", "heartbeat");
      assert.equal(help.code, 2);
      assert.match(help.out, /healthchecks\.io/);
      assert.equal((await w.e9g("connect", "heartbeat", "hc-ping.com/abc")).code, 2, "not a URL");

      check.status = 404;
      const refused = await w.e9g("connect", "heartbeat", check.url);
      assert.equal(refused.code, 1);
      assert.match(refused.out, /the test ping to 127\.0\.0\.1:\d+ didn't go through: it answered 404\. Nothing was saved\./);
      assert.ok(!existsSync(join(w.e9gHome, "heartbeat.json")));

      check.status = 200;
      check.pings.length = 0;
      const connected = await w.e9g("connect", "heartbeat", check.url);
      assert.equal(connected.code, 0, connected.out);
      assert.equal(check.pings.length, 1);
      assert.match(check.pings[0] ?? "", /^GET \/ping\/0f6c-check e9g\//);
      const status = (await w.e9g("connect")).out;
      assert.match(status, /^heartbeat {2}pings 127\.0\.0\.1:\d+ each watchdog run, last \d{4}-\d\d-\d\d \d\d:\d\d/m);
      assert.doesNotMatch(status, /0f6c-check/, "the check's own address isn't shown");
      assert.equal((await w.e9g("connect", "heartbeat", "--test")).code, 0);
      assert.equal(check.pings.length, 2);

      const off = await w.e9g("disconnect", "heartbeat");
      assert.match(off.out, /the heartbeat is off\. Pause or delete the check at 127\.0\.0\.1:\d+/);
      assert.ok(!existsSync(join(w.e9gHome, "heartbeat.json")));
      assert.match((await w.e9g("connect")).out, /^heartbeat {2}not connected: e9g connect heartbeat <url>$/m);
    } finally {
      await w.close();
    }
  });

  test("the watchdog pings after a run of every team, not after one team's, and not while T3 Code is down", async () => {
    const w = await fakeWorld();
    try {
      writeFileSync(join(w.e9gHome, "heartbeat.json"), JSON.stringify({ url: check.url, connectedAt: new Date().toISOString() }));
      check.status = 200;
      check.pings.length = 0;
      assert.equal((await w.e9g("watchdog", "run")).code, 0);
      assert.equal(check.pings.length, 1, "a run of every team pings");
      await w.e9g("watchdog", "run", "fixture");
      assert.equal(check.pings.length, 1, "e9g start's run of one team doesn't");
      w.setUp(false);
      await w.e9g("watchdog", "run");
      assert.equal(check.pings.length, 1, "nor does a run that stops because T3 Code doesn't answer");
      w.setUp(true);

      // A check that refuses is logged, at most hourly; the service's own alert tells the operator.
      check.status = 500;
      await w.e9g("watchdog", "run");
      await w.e9g("watchdog", "run");
      const log = join(w.e9gHome, "watchdog.log");
      assert.equal(read(log).match(/couldn't ping the heartbeat at 127\.0\.0\.1:\d+: it answered 500/g)?.length, 1, read(log));
      const hourAgo = new Date(Date.now() - 61 * 60_000);
      utimesSync(join(w.e9gHome, ".stamp-heartbeat-failing"), hourAgo, hourAgo);
      await w.e9g("watchdog", "run");
      assert.equal(read(log).match(/couldn't ping the heartbeat/g)?.length, 2);
      check.status = 200;
      await w.e9g("watchdog", "run");
      assert.ok(!existsSync(join(w.e9gHome, ".stamp-heartbeat-failing")), "a ping that goes through clears it");
      assert.doesNotMatch(read(log), /0f6c-check/, "the log names the service, not the check");
    } finally {
      await w.close();
    }
  });
});
